// Varsler på Viggos telefon og PC når en kunde bestiller time (eierens beslutning 2b), med standard Web Push:
//   RFC 8030  levering: vi POSTer meldingen til enhetens adresse hos nettleserens push-tjeneste;
//   RFC 8291  meldingen krypteres til enheten (aes128gcm, RFC 8188), så push-tjenesten ikke kan lese den;
//   RFC 8292  VAPID: et JWT signert med serverens nøkkel viser push-tjenesten at meldingen kommer fra oss.
//
// Nøkler og abonnementer ligger i timebokens egen lagring, så en forhåndsvisning har sine egne (F10):
//   VAPID_KEY  { publicKey, privateKey (JWK), createdAt }: lages én gang, av serveren selv, så ingen trenger å
//              skrive inn en hemmelighet. Den private nøkkelen forlater aldri serveren og skrives aldri til
//              loggen; nettleseren får bare den offentlige.
//   SUBS_KEY   { subs: [{ endpoint, p256dh, auth, createdAt, seenAt }] }: én per enhet, høyst MAX_DEVICES.
//
// Vi sender bare til adresser hos kjente push-tjenester (PUSH_SERVICES), aldri til en vilkårlig adresse en
// nettleser har oppgitt. Svarer tjenesten 404/410, er abonnementet borte for godt og slettes.
// Sending kaster aldri, har kort tidsfrist (PUSH_TIMEOUT_MS) og logger bare tjenestens navn og svaret: aldri
// adressen (den er selv en slags nøkkel), kundens navn eller noen nøkkel.
import { ECDH, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, createCipheriv, randomBytes, sign } from "node:crypto";
import { isDate, mutateJSON } from "./booking-core.mjs";

export const VAPID_KEY = "push/vapid";
export const SUBS_KEY = "push/subs";
export const MAX_DEVICES = 10;
export const PUSH_TIMEOUT_MS = 4000;          // én melding til én push-tjeneste
export const BOOKING_PUSH_WAIT_MS = 1500;     // så lenge venter en nettbestilling høyst på varslene (uten waitUntil)
export const PUSH_TTL_S = 24 * 60 * 60;       // push-tjenesten tar vare på meldingen et døgn hvis enheten er av
export const RECORD_SIZE = 4096;              // rs i aes128gcm-hodet; hele meldingen må også være ≤ 4096 byte
export const JWT_LIFETIME_S = 12 * 60 * 60;   // VAPID-JWT-et gjelder i 12 timer (tjenestene godtar høyst 24)
const MAX_ENDPOINT = 2048;

const b64u = (buf) => Buffer.from(buf).toString("base64url");

// ---------- Kjente push-tjenester ----------
// Nettleseren velger adressen. Vi godtar bare https på standardport hos disse, uten brukernavn i adressen.
export const PUSH_SERVICES = Object.freeze([
  { name: "Google FCM", hosts: ["fcm.googleapis.com"] },                           // Chrome, Edge på Android, Opera, Samsung
  { name: "Mozilla autopush", hosts: ["updates.push.services.mozilla.com"], subdomainsOf: "push.services.mozilla.com" },
  { name: "Apple", hosts: ["web.push.apple.com"], subdomainsOf: "push.apple.com" }, // Safari, iPhone/iPad (Apple: «*.push.apple.com»)
  { name: "Microsoft WNS", subdomainsOf: "notify.windows.com" },                  // Edge på Windows
]);

function parseEndpoint(endpoint) {
  // URL-leseren fjerner tabulator og linjeskift i stillhet: slike adresser er aldri ekte
  if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT || /[\s\u0000-\u001f\u007f]/.test(endpoint)) return null;
  let u;
  try { u = new URL(endpoint); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port !== "" || u.hash) return null;
  const host = u.hostname;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  const service = PUSH_SERVICES.find((s) => (s.hosts || []).includes(host) || (s.subdomainsOf && host.endsWith("." + s.subdomainsOf)));
  return service ? { url: u, service: service.name } : null;
}
// Navnet på push-tjenesten, eller null hvis adressen ikke er hos en vi kjenner
export const pushService = (endpoint) => { const p = parseEndpoint(endpoint); return p ? p.service : null; };
// Adressen i fast form (slik vi lagrer og sammenligner den), eller null
export const normalizeEndpoint = (endpoint) => { const p = parseEndpoint(endpoint); return p ? p.url.href : null; };

// ---------- Abonnementet fra nettleseren (PushSubscription.toJSON()) ----------
const decodeKey = (s, length) => {
  if (typeof s !== "string" || s.length > 200 || !/^[A-Za-z0-9_\-+/]+={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "base64url");
  return buf.length === length ? buf : null;
};
const onCurve = (point) => { try { ECDH.convertKey(point, "prime256v1"); return true; } catch { return false; } };
const usable = (s) => !!(s && typeof s === "object" && normalizeEndpoint(s.endpoint) === s.endpoint && decodeKey(s.p256dh, 65) && decodeKey(s.auth, 16));

// { endpoint, keys: { p256dh, auth } } → { value: { endpoint, p256dh, auth } } eller { error, code }
export function parseSubscription(input) {
  if (!input || typeof input !== "object") return { error: "Mangler abonnement fra nettleseren.", code: "bad_subscription" };
  const endpoint = normalizeEndpoint(input.endpoint);
  if (!endpoint) return { error: "Ukjent push-tjeneste. Bruk Safari, Chrome, Edge eller Firefox.", code: "unknown_push_service" };
  const keys = input.keys && typeof input.keys === "object" ? input.keys : {};
  const p256dh = decodeKey(keys.p256dh, 65);
  const auth = decodeKey(keys.auth, 16);
  if (!p256dh || p256dh[0] !== 4 || !onCurve(p256dh) || !auth) return { error: "Ugyldig abonnement fra nettleseren.", code: "bad_subscription" };
  return { value: { endpoint, p256dh: b64u(p256dh), auth: b64u(auth) } };
}

// ---------- Lagrede abonnementer (ett per enhet) ----------
const initSubs = (d) => (d && Array.isArray(d.subs) ? d : { subs: [] });
const newestFirst = (a, b) => (a.seenAt < b.seenAt ? 1 : a.seenAt > b.seenAt ? -1 : 0);

export async function readSubscriptions(store) {
  return initSubs(await store.get(SUBS_KEY, { type: "json" })).subs.filter(usable);
}

// Legger til (eller fornyer) en enhet. Er det flere enn MAX_DEVICES, går den som er sett minst nylig ut.
// Svarer { ok, created, devices } (eller { error, status } hvis lagringen ikke ble enig med seg selv).
export async function saveSubscription(store, sub, { now = new Date() } = {}) {
  let created = false;
  const r = await mutateJSON(store, SUBS_KEY, initSubs, (doc) => {
    const at = now.toISOString();
    const same = doc.subs.find((s) => s && s.endpoint === sub.endpoint);
    created = !same;
    if (same) Object.assign(same, { p256dh: sub.p256dh, auth: sub.auth, seenAt: at });
    else doc.subs.push({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, createdAt: at, seenAt: at });
    doc.subs = doc.subs.filter(usable).sort(newestFirst).slice(0, MAX_DEVICES);
    return { ok: true, devices: doc.subs.length };
  });
  return r.error ? r : { ok: true, created, devices: r.devices };
}

// Fjerner enhetene med disse adressene. Svarer { ok, removed, devices }.
export async function removeSubscriptions(store, endpoints) {
  const gone = new Set(endpoints.map(normalizeEndpoint).filter(Boolean));
  return mutateJSON(store, SUBS_KEY, initSubs, (doc) => {
    const before = doc.subs.length;
    doc.subs = doc.subs.filter((s) => !(s && gone.has(s.endpoint)));
    const devices = doc.subs.filter(usable).length;
    return doc.subs.length === before ? { ok: true, noWrite: true, removed: 0, devices } : { ok: true, removed: before - doc.subs.length, devices };
  });
}

// ---------- VAPID-nøkkelparet (RFC 8292) ----------
const coord = (s) => { const b = Buffer.from(s, "base64url"); return b.length >= 32 ? b.subarray(b.length - 32) : Buffer.concat([Buffer.alloc(32 - b.length), b]); };
const rawPublicKey = (jwk) => b64u(Buffer.concat([Buffer.from([4]), coord(jwk.x), coord(jwk.y)]));
function validVapid(k) {
  const p = k && typeof k === "object" && k.privateKey;
  if (!p || typeof k.publicKey !== "string" || p.kty !== "EC" || p.crv !== "P-256") return false;
  if (![p.x, p.y, p.d].every((v) => typeof v === "string" && /^[A-Za-z0-9_-]{40,46}$/.test(v))) return false;
  return rawPublicKey(p) === k.publicKey;
}
function newVapidKeys(now) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  return { publicKey: rawPublicKey(jwk), privateKey: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }, createdAt: now.toISOString() };
}

// Nøklene hvis de finnes (og er hele), ellers null. Lager aldri nye.
export async function readVapidKeys(store) {
  const doc = await store.get(VAPID_KEY, { type: "json" });
  return validVapid(doc) ? doc : null;
}

// Nøklene, laget første gang noen spør. To samtidige førstegangs-forespørsler ender med det samme paret.
// Svarer nøklene, eller { error, status }.
export async function vapidKeys(store, { now = new Date() } = {}) {
  const current = await readVapidKeys(store);
  if (current) return current;
  const r = await mutateJSON(store, VAPID_KEY, (d) => (d && typeof d === "object" && !Array.isArray(d) ? d : {}), (doc) => {
    if (validVapid(doc)) return { ok: true, noWrite: true, keys: { ...doc } };
    for (const k of Object.keys(doc)) delete doc[k];
    Object.assign(doc, newVapidKeys(now));
    return { ok: true, keys: { ...doc } };
  });
  return r.error ? r : r.keys;
}

// Hvem push-tjenesten kan kontakte om meldingene (VAPID «sub»): nettsidens egen https-adresse
export const contactFor = (origin) => (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(String(origin || "")) ? String(origin) : "https://localhost");

// «Authorization: vapid t=<JWT>, k=<offentlig nøkkel>» for én push-tjeneste (audience = adressens opphav)
export function vapidAuthorization(audience, keys, { now = new Date(), subject } = {}) {
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud: audience, exp: Math.floor(now.getTime() / 1000) + JWT_LIFETIME_S, sub: subject || "https://localhost" }));
  const input = `${header}.${claims}`;
  const key = createPrivateKey({ key: keys.privateKey, format: "jwk" });
  const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }); // r || s, 64 byte (JWS ES256)
  return `vapid t=${input}.${b64u(signature)}, k=${keys.publicKey}`;
}

// ---------- Kryptering (RFC 8291 over RFC 8188 aes128gcm) ----------
// Én post: salt (16) | rs (4) | idlen (1) | avsenderens offentlige nøkkel (65) | kryptert tekst + 0x02 + tag (16).
// salt og senderPrivateKey er bare til testene (RFC 8291s eksempel); ellers er begge nye og tilfeldige hver gang.
export function encryptPayload(plaintext, { p256dh, auth }, { salt = randomBytes(16), senderPrivateKey } = {}) {
  const uaPublic = decodeKey(p256dh, 65);
  const authSecret = decodeKey(auth, 16);
  if (!uaPublic || !authSecret) throw new Error("Ugyldige nøkler i abonnementet");
  const sender = createECDH("prime256v1");
  if (senderPrivateKey) sender.setPrivateKey(senderPrivateKey); else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const shared = sender.computeSecret(uaPublic);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  const body = Buffer.concat([header, asPublic, record]);
  if (record.length > RECORD_SIZE || body.length > 4096) throw new Error("Varselet er for stort for Web Push");
  return body;
}

// ---------- Sending ----------
// Sender én melding til én enhet. Kaster aldri. Svarer { ok, status, gone, service } eller { ok: false, error, service }
// der error er «refused» (ukjent tjeneste: ingenting sendt), «crypto», «timeout» eller «network».
export async function sendPush(sub, message, { keys, fetch, now = new Date(), subject, timeoutMs = PUSH_TIMEOUT_MS, ttl = PUSH_TTL_S, urgency = "high" } = {}) {
  const parsed = parseEndpoint(sub && sub.endpoint);
  if (!parsed) return { ok: false, error: "refused", service: "ukjent tjeneste" };
  const { url, service } = parsed;
  let body, authorization;
  try {
    body = encryptPayload(Buffer.from(JSON.stringify(message), "utf8"), sub);
    authorization = vapidAuthorization(url.origin, keys, { now, subject });
  } catch {
    return { ok: false, error: "crypto", service };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url.href, {
      method: "POST",
      headers: {
        Authorization: authorization,
        TTL: String(ttl),
        Urgency: urgency,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
      },
      body,
      redirect: "error", // en push-tjeneste videresender aldri; vi følger aldri en omdirigering til en annen adresse
      signal: ctrl.signal,
    });
    try { await res.arrayBuffer(); } catch { /* svaret brukes ikke */ }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410, service };
  } catch {
    return { ok: false, error: ctrl.signal.aborted ? "timeout" : "network", service };
  } finally {
    clearTimeout(timer);
  }
}

const why = (r) => (r.status ? `svarte ${r.status}` : r.error === "timeout" ? "svarte ikke i tide" : r.error === "crypto" ? "fikk ikke kryptert melding" : "kunne ikke nås");

// Sender meldingen til alle lagrede enheter (eller bare den med adressen endpoint) samtidig, og sletter enheter
// push-tjenesten sier er borte. Svarer { devices, targets, sent, failed, gone }. Kaster bare hvis lagringen feiler.
export async function pushToDevices(store, message, { fetch, now = new Date(), origin, endpoint, timeoutMs } = {}) {
  const all = await readSubscriptions(store);
  const only = endpoint === undefined ? null : normalizeEndpoint(endpoint);
  const targets = endpoint === undefined ? all : all.filter((s) => s.endpoint === only);
  const summary = { devices: all.length, targets: targets.length, sent: 0, failed: 0, gone: 0 };
  if (!targets.length) return summary;
  const keys = await readVapidKeys(store);
  if (!keys) {
    console.error("Push: VAPID-nøklene mangler, så ingen varsler ble sendt");
    return { ...summary, failed: targets.length };
  }
  const subject = contactFor(origin);
  const results = await Promise.all(targets.map((s) => sendPush(s, message, { keys, fetch, now, subject, timeoutMs })));
  const gone = [];
  results.forEach((r, i) => {
    if (r.ok) summary.sent++;
    else if (r.gone) {
      summary.gone++;
      gone.push(targets[i].endpoint);
      console.warn(`Push: ${r.service} ${why(r)}: enheten abonnerer ikke lenger og er fjernet`);
    } else {
      summary.failed++;
      console.warn(`Push: ${r.service} ${why(r)}`);
    }
  });
  if (gone.length) {
    try {
      const removed = await removeSubscriptions(store, gone);
      if (!removed.error) summary.devices = removed.devices;
    } catch (err) {
      console.error("Push: kunne ikke fjerne enheter som er borte:", err && err.name);
    }
  }
  return summary;
}

// ---------- Innholdet i varslene ----------
const WEEKDAYS = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
const MONTHS = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];
const pad = (n) => String(n).padStart(2, "0");

// «Ny time» med ukedag, dato, klokkeslett, tjeneste (+ tillegg) og kundens navn. Trykk åpner /admin på den dagen.
export function bookingMessage(item) {
  const d = new Date(`${item.date}T12:00:00Z`);
  const weekday = WEEKDAYS[d.getUTCDay()];
  const when = `${weekday[0].toUpperCase()}${weekday.slice(1)} ${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]} kl. ${pad(Math.floor(item.start / 60))}:${pad(item.start % 60)}`;
  const service = item.service || "Time";
  const what = Array.isArray(item.addons) && item.addons.length ? `${service} + ${item.addons.join(", ")}` : service;
  return { title: "Ny time", body: [when, what, item.name].filter(Boolean).join(" · "), url: `/admin?dag=${item.date}`, tag: `ny-time-${item.id}` };
}

export const testMessage = () => ({
  title: "Testvarsel",
  body: "Varsler virker på denne enheten. Slik ser det ut når en kunde bestiller time.",
  url: "/admin",
  tag: "testvarsel",
});

// Varsler alle Viggos enheter om en ny nettbestilling. Kaster aldri: bestillingen er allerede lagret, og et varsel
// som feiler skal aldri felle den. Feil logges uten navn, telefonnummer, adresser eller nøkler.
export async function notifyNewBooking(store, item, opts = {}) {
  // En dato som ikke finnes (f.eks. 2026-11-31) ville blitt «Tirsdag 1. desember» i varselet: send heller ingenting
  if (!item || !isDate(item.date) || !Number.isInteger(item.start)) return { skipped: true };
  try {
    return await pushToDevices(store, bookingMessage(item), opts);
  } catch (err) {
    console.error("Push: kunne ikke varsle om ny time:", err && err.name); // aldri meldingen: den kan sitere lagret innhold
    return { error: true };
  }
}
