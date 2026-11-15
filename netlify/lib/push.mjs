// Varsler på Viggos telefon og PC når en kunde bestiller time (eierens beslutning 2b), med standard Web Push:
//   RFC 8030  levering: vi POSTer meldingen til enhetens adresse hos nettleserens push-tjeneste;
//   RFC 8291  meldingen krypteres til enheten (aes128gcm, RFC 8188), så push-tjenesten ikke kan lese den;
//   RFC 8292  VAPID: et JWT signert med serverens nøkkel viser push-tjenesten at meldingen kommer fra oss.
//
// Nøkler og abonnementer ligger i timebokens egen lagring, så en forhåndsvisning har sine egne (F10):
//   VAPID_KEY  { publicKey, privateKey (JWK), createdAt }: lages én gang, av serveren selv, så ingen trenger å
//              skrive inn en hemmelighet. Den private nøkkelen forlater aldri serveren og skrives aldri til
//              loggen; nettleseren får bare den offentlige.
//   SUBS_KEY   { subs: [{ endpoint, p256dh, auth, gen, createdAt, seenAt, until? }], gone: [{ h, at }] }: én per enhet,
//              høyst MAX_DEVICES. gone: adresser push-tjenesten har sagt er borte (404/410), som SHA-256 (h), så de
//              aldri lagres igjen (høyst GONE_MAX, i GONE_DAYS dager).
//
// Hver enhet er knyttet til admin-passordet den ble slått på med (gen = pushGen(ADMIN_PASSWORD)). Bytter Viggo
// passordet, får ingen av de gamle enhetene flere varsler (de slettes ved neste sending), akkurat som alle blir
// logget ut. «Slå av varsler på alle andre enheter» (clearSubscriptions) fjerner alle med en gang.
// En enhet slått på med en kort innlogging («Hold meg innlogget» av, 12 timer) får until = når innloggingen går ut,
// og får ingen varsler etter det (en lånt PC der innloggingen bare gikk ut, viser ikke kundenavn i ukevis). Hver
// innlogging der fornyer until, og en lang innlogging fjerner den.
//
// Vi sender bare til adresser hos kjente push-tjenester (PUSH_SERVICES), aldri til en vilkårlig adresse en
// nettleser har oppgitt. Svarer tjenesten 404/410, er abonnementet borte for godt: det slettes, og adressen
// godtas ikke igjen (Chrome beholder et slikt dødt abonnement, og /admin ville ellers meldt det på og vist «på»).
// Sending kaster aldri, har kort tidsfrist (PUSH_TIMEOUT_MS) og logger bare tjenestens navn og svaret: aldri
// adressen (den er selv en slags nøkkel), kundens navn eller noen nøkkel.
import { ECDH, createECDH, createHash, createPrivateKey, generateKeyPairSync, hkdfSync, createCipheriv, randomBytes, sign, timingSafeEqual } from "node:crypto";
import { isDate, mutateJSON, passwordGen } from "./booking-core.mjs";

// Hvilket admin-passord en enhet hører til: de første 16 tegnene av SHA-256("viggos-push:" + passordet) i
// base64url. Uten passord (admin ikke satt opp) null: da sendes ingenting.
export const pushGen = (password) => passwordGen(password, "push");

export const VAPID_KEY = "push/vapid";
export const SUBS_KEY = "push/subs";
export const MAX_DEVICES = 10;
export const GONE_MAX = 50;                   // så mange adresser som er «borte» huskes høyst …
export const GONE_DAYS = 60;                  // … og så mange dager
export const PUSH_TIMEOUT_MS = 4000;          // én melding til én push-tjeneste
export const BOOKING_PUSH_WAIT_MS = 1500;     // så lenge venter en nettbestilling høyst på varslene (uten waitUntil)
export const PUSH_TTL_S = 24 * 60 * 60;       // push-tjenesten tar vare på meldingen et døgn hvis enheten er av
export const RECORD_SIZE = 4096;              // rs i aes128gcm-hodet; hele meldingen må også være ≤ 4096 byte
// Hver melding fylles ut til samme lengde (RFC 8188 2: nuller etter 0x02-skillet), så push-tjenesten ikke kan se
// hvor langt kundens navn er. 1024 rommer den lengste meldingen en nettbestilling kan gi (navn på 80 tegn).
export const PAD_SIZE = 1024;
const MAX_PADDED = 4096 - 86 - 16;            // hele meldingen ≤ 4096 byte: hodet (86) og taggen (16) trekkes fra
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
const initSubs = (d) => {
  const doc = d && typeof d === "object" && Array.isArray(d.subs) ? d : { subs: [] };
  if (!Array.isArray(doc.gone)) doc.gone = [];
  return doc;
};
const newestFirst = (a, b) => (a.seenAt < b.seenAt ? 1 : a.seenAt > b.seenAt ? -1 : 0);

const isGen = (gen) => typeof gen === "string" && gen.length === 16;
// Utløpt: slått på med en kort innlogging som har gått ut (en until som ikke kan leses, regnes som utløpt)
const expired = (s, now) => typeof s.until === "string" && !(Date.parse(s.until) > now.getTime());
const current = (gen, now = new Date()) => (s) => usable(s) && isGen(gen) && s.gen === gen && !expired(s, now);

// Adresser push-tjenesten har sagt er borte. Bare en hash lagres: adressen er selv en slags nøkkel.
const DAY_MS = 24 * 60 * 60 * 1000;
const goneHash = (endpoint) => createHash("sha256").update("viggos-push-gone:" + endpoint).digest("base64url");
const goneFresh = (now) => (g) => g && typeof g.h === "string" && typeof g.at === "string" && now.getTime() - Date.parse(g.at) < GONE_DAYS * DAY_MS;
const isGone = (doc, endpoint, now) => { const h = goneHash(endpoint); return doc.gone.some((g) => goneFresh(now)(g) && g.h === h); };
// Legger til adressene i gone-listen (nyeste sist), og rydder bort gamle og det som er over GONE_MAX
function markGone(doc, endpoints, now) {
  const add = endpoints.map(goneHash);
  doc.gone = doc.gone.filter((g) => goneFresh(now)(g) && !add.includes(g.h))
    .concat(add.map((h) => ({ h, at: now.toISOString() })))
    .slice(-GONE_MAX);
}

// Enhetene som hører til dette passordet (gen) og ikke er utløpt ved now. Uten gen: alle som er hele (bare til
// tester og opprydding).
export async function readSubscriptions(store, { gen, now = new Date() } = {}) {
  const subs = initSubs(await store.get(SUBS_KEY, { type: "json" })).subs.filter(usable);
  return gen === undefined ? subs : subs.filter(current(gen, now));
}

// Legger til (eller fornyer) en enhet for passordet gen. Enheter fra et gammelt passord ryddes bort samtidig.
// Er det flere enn MAX_DEVICES, går den som er sett minst nylig ut. En adresse push-tjenesten har sagt er borte,
// lagres aldri igjen: { error, status: 410, code: "gone" } (nettleseren må lage et nytt abonnement).
// until (Date): enheten får varsler bare til da (en kort innlogging); uten until får den varsler til den slås av.
// Svarer { ok, created, devices, until? } (eller { error, status } hvis lagringen ikke ble enig med seg selv).
export async function saveSubscription(store, sub, { now = new Date(), gen, until = null } = {}) {
  if (!isGen(gen)) return { error: "Varsler er ikke satt opp: mangler admin-passord.", status: 503 };
  let created = false;
  const r = await mutateJSON(store, SUBS_KEY, initSubs, (doc) => {
    if (isGone(doc, sub.endpoint, now)) return { error: "Denne enheten kan ikke lenger få varsler. Trykk «Slå på varsler» igjen.", status: 410, code: "gone" };
    doc.gone = doc.gone.filter(goneFresh(now));
    const at = now.toISOString();
    const same = doc.subs.find((s) => s && s.endpoint === sub.endpoint && s.gen === gen);
    created = !same;
    doc.subs = doc.subs.filter((s) => s !== same && current(gen, now)(s) && s.endpoint !== sub.endpoint);
    const record = same
      ? Object.assign(same, { p256dh: sub.p256dh, auth: sub.auth, seenAt: at })
      : { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, gen, createdAt: at, seenAt: at };
    if (until) record.until = until.toISOString(); else delete record.until;
    doc.subs.push(record);
    doc.subs = doc.subs.filter(usable).sort(newestFirst).slice(0, MAX_DEVICES);
    return { ok: true, devices: doc.subs.length };
  });
  if (r.error) return r;
  return until ? { ok: true, created, devices: r.devices, until: until.toISOString() } : { ok: true, created, devices: r.devices };
}

// Fjerner enhetene med disse adressene (og, med gen, alle fra et gammelt passord eller med en utløpt innlogging).
// Med gone: true har push-tjenesten sagt at adressene er borte, og de godtas ikke igjen (saveSubscription). Svarer { ok, removed, devices }.
export async function removeSubscriptions(store, endpoints, { gen, gone: markAsGone = false, now = new Date() } = {}) {
  const gone = new Set(endpoints.map(normalizeEndpoint).filter(Boolean));
  return mutateJSON(store, SUBS_KEY, initSubs, (doc) => {
    const before = doc.subs.length;
    doc.subs = doc.subs.filter((s) => !(s && gone.has(s.endpoint)) && (gen === undefined || current(gen, now)(s)));
    if (markAsGone && gone.size) markGone(doc, [...gone], now);
    const devices = doc.subs.filter(gen === undefined ? usable : current(gen, now)).length;
    const removed = before - doc.subs.length;
    return removed || (markAsGone && gone.size) ? { ok: true, removed, devices } : { ok: true, noWrite: true, removed: 0, devices };
  });
}

// Nettleseren har byttet ut abonnementet (pushsubscriptionchange i admin-sw.js), og service workeren gir serveren det
// nye (POST /api/push/renew) uten innlogging: den har ingen. Derfor godtas det bare som erstatning for en lagret
// enhet for dette passordet som ikke er utløpt, og bare når både den gamle adressen og dens auth-hemmelighet stemmer.
// Hemmeligheten kjenner bare nettleseren og serveren (push-tjenesten får den aldri), og den sammenlignes i konstant
// tid. Den nye adressen må også være hos en kjent push-tjeneste (parseSubscription) og ikke være meldt borte. Enheten
// beholder gen, createdAt og until, og den gamle adressen godtas ikke igjen.
// old: { endpoint, auth } (base64url). Svarer { ok, devices } eller { error, status, code } (404 for alt som ikke
// stemmer, så svaret aldri sier hva som var feil).
export async function renewSubscription(store, old, sub, { now = new Date(), gen } = {}) {
  if (!isGen(gen)) return { error: "Varsler er ikke satt opp.", status: 503, code: "not_configured" };
  const unknown = { error: "Ukjent enhet.", status: 404, code: "unknown_device" };
  const oldEndpoint = normalizeEndpoint(old && old.endpoint);
  const oldAuth = decodeKey(old && old.auth, 16);
  if (!oldEndpoint || !oldAuth || !sub) return unknown;
  return mutateJSON(store, SUBS_KEY, initSubs, (doc) => {
    const prev = doc.subs.find((s) => s && s.endpoint === oldEndpoint && current(gen, now)(s));
    const storedAuth = prev && decodeKey(prev.auth, 16);
    if (!storedAuth || !timingSafeEqual(storedAuth, oldAuth)) return unknown;
    if (isGone(doc, sub.endpoint, now)) return { error: "Abonnementet er borte.", status: 410, code: "gone" };
    doc.subs = doc.subs.filter((s) => s !== prev && !(s && s.endpoint === sub.endpoint));
    doc.subs.push(Object.assign(prev, { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, seenAt: now.toISOString() }));
    if (oldEndpoint !== sub.endpoint) markGone(doc, [oldEndpoint], now);
    doc.subs = doc.subs.filter(usable).sort(newestFirst).slice(0, MAX_DEVICES);
    return { ok: true, devices: doc.subs.filter(current(gen, now)).length };
  });
}

// «Slå av varsler på alle andre enheter»: ingen enhet får varsler før den slås på igjen. Svarer { ok, devices: 0 }.
export async function clearSubscriptions(store) {
  const r = await mutateJSON(store, SUBS_KEY, initSubs, (doc) => {
    if (!doc.subs.length) return { ok: true, noWrite: true };
    doc.subs = [];
    return { ok: true };
  });
  return r.error ? r : { ok: true, devices: 0 };
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
// Én post: salt (16) | rs (4) | idlen (1) | avsenderens offentlige nøkkel (65) | kryptert (tekst + 0x02 + nuller) + tag (16).
// Teksten fylles ut med nuller til et helt antall padTo byte (standard PAD_SIZE), så alle vanlige varsler er like
// lange. salt, senderPrivateKey og padTo: 0 (ingen utfylling) er bare til testene (RFC 8291s eksempel); ellers er
// salt og avsendernøkkel nye og tilfeldige hver gang.
export function encryptPayload(plaintext, { p256dh, auth }, { salt = randomBytes(16), senderPrivateKey, padTo = PAD_SIZE } = {}) {
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
  const text = Buffer.from(plaintext);
  if (text.length + 1 > MAX_PADDED) throw new Error("Varselet er for stort for Web Push");
  const size = padTo > 0 ? Math.min(Math.ceil((text.length + 1) / padTo) * padTo, MAX_PADDED) : text.length + 1;
  const padded = Buffer.alloc(size); // nuller
  text.copy(padded);
  padded[text.length] = 2;           // skillet etter siste (og eneste) post
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
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

// Sender meldingen til alle lagrede enheter for passordet gen (eller bare den med adressen endpoint) samtidig.
// Sletter enheter push-tjenesten sier er borte, og enheter fra et gammelt passord eller med en utløpt kort
// innlogging (de får aldri noe). Uten gen
// (admin-passordet mangler) sendes ingenting, og ingenting slettes.
// Svarer { devices, targets, sent, failed, gone, stale }. Kaster bare hvis lagringen feiler.
export async function pushToDevices(store, message, { fetch, now = new Date(), origin, endpoint, timeoutMs, gen } = {}) {
  const stored = await readSubscriptions(store);
  const all = stored.filter(current(gen, now));
  const stale = isGen(gen) ? stored.length - all.length : 0;
  const only = endpoint === undefined ? null : normalizeEndpoint(endpoint);
  const targets = endpoint === undefined ? all : all.filter((s) => s.endpoint === only);
  const summary = { devices: all.length, targets: targets.length, sent: 0, failed: 0, gone: 0, stale };
  if (stale) {
    try {
      await removeSubscriptions(store, [], { gen, now });
      console.warn(`Push: ${stale} ${stale === 1 ? "enhet" : "enheter"} fra et gammelt admin-passord eller med utløpt innlogging er fjernet`);
    } catch (err) {
      console.error("Push: kunne ikke fjerne enheter fra et gammelt passord eller med utløpt innlogging:", err && err.name);
    }
  }
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
      const removed = await removeSubscriptions(store, gone, { gen, gone: true, now });
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

// Det felles taket for nettbestillinger er nådd (netlify/lib/limits.mjs): kundene får beskjed om å ringe. Ingen
// kundedata. Sendes høyst én gang per døgn.
export const bookingsPausedMessage = () => ({
  title: "Nettbestilling er satt på pause",
  body: "For mange bestillinger siste døgn. Kunder som prøver å bestille, får beskjed om å ringe 409 63 911.",
  url: "/admin",
  tag: "nettbestilling-pause",
});

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
