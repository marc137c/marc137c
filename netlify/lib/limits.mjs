// Tellere med glidende tidsvindu i Netlify Blobs, konfliktsikre (ETag): to samtidige forespørsler kan aldri
// begge få den siste plassen. Brukes mot flom av nettbestillinger (F2) og mot gjetting av admin-passordet (F4/F5).
// Et dokument per teller: { hits: [{ t: ms, id }], alertedAt? }. id gjør skrivingen trygg å gjenta: gikk svaret
// tapt etter at skrivingen ble lagret, finner neste forsøk sin egen id og teller ikke to ganger, og release() kan
// ta tilbake akkurat det treffet.
//
// Personvern (NEW-pii-keys, SPEC R4): nøkkelen til en teller er aldri telefonnummeret eller IP-adressen selv, men en
// nøkkel-hash av den: rl/<slag>/<HMAC-SHA256(hemmelighet, slag + ":" + verdi), 22 tegn base64url>. Hemmeligheten er
// 32 tilfeldige byte i dokumentet SECRET_KEY i samme lagring (en forhåndsvisning har sin egen), laget én gang.
// Tellerne slettes av den daglige oppryddingen (netlify/functions/retention.mjs) når nyeste treff er over et døgn gammelt.
import { randomBytes, createHmac } from "node:crypto";
import { mutateJSON } from "./booking-core.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const newToken = () => randomBytes(8).toString("hex");

const initHits = (data) => (data && typeof data === "object" && Array.isArray(data.hits) ? data : { hits: [] });
const longest = (rules) => Math.max(...rules.map((r) => r.windowMs));
const validHit = (h) => h && typeof h === "object" && Number.isFinite(h.t);
const recent = (hits, rules, nowMs) => hits.filter((h) => validHit(h) && nowMs - h.t < longest(rules));
const isFull = (hits, rules, nowMs) => rules.some((r) => hits.filter((h) => nowMs - h.t < r.windowMs).length >= r.max);
const hasOwn = (hits, token) => hits.some((h) => h && h.id === token);

// Tar én plass i telleren key hvis alle reglene ({ max, windowMs }) har plass. Svarer { ok: true } (own: true når
// dette forsøket allerede er telt), { ok: false, limited: true } eller { error, status } hvis lagringen ikke ble enig
// med seg selv. Med alertMs > 0 svarer den første avvisningen innen alertMs også tripped: true (alertedAt i samme
// skriving), så Viggo bare får ett varsel om at taket er nådd.
export async function take(store, key, rules, { nowMs, token = newToken(), alertMs = 0 } = {}) {
  return mutateJSON(store, key, initHits, (doc) => {
    if (hasOwn(doc.hits, token)) return { ok: true, own: true, noWrite: true }; // vårt forrige forsøk ble lagret
    doc.hits = recent(doc.hits, rules, nowMs);
    if (isFull(doc.hits, rules, nowMs)) {
      if (alertMs > 0 && !(Number.isFinite(doc.alertedAt) && nowMs - doc.alertedAt < alertMs)) {
        doc.alertedAt = nowMs;
        return { ok: false, limited: true, tripped: true };
      }
      return { ok: false, limited: true, noWrite: true };
    }
    doc.hits.push({ t: nowMs, id: token });
    return { ok: true };
  });
}

// Bare lesing: er telleren full for et nytt forsøk? Et forsøk som allerede er telt (samme token), er aldri «fullt».
export async function peek(store, key, rules, { nowMs, token } = {}) {
  const doc = initHits(await store.get(key, { type: "json" }));
  if (token !== undefined && hasOwn(doc.hits, token)) return { full: false, own: true };
  return { full: isFull(recent(doc.hits, rules, nowMs), rules, nowMs), alertedAt: doc.alertedAt };
}

// Tar tilbake treffet med denne id-en (et forsøk som likevel ikke ble noe av). Svarer { ok } eller { error, status }.
// Blir en klients eller et nummers teller tom (ingen treff, intet pausevarsel), slettes dokumentet i stedet for å
// lagres tomt (runde 2): ellers la hvert avviste forsøk igjen et dokument som den daglige oppryddingen måtte gå
// gjennom. Sletting kan ikke være betinget i Netlify Blobs, så et treff skrevet i millisekundene mellom lesingen og
// slettingen kan gå tapt; det gir høyst ett ekstra forsøk for den samme klienten eller det samme nummeret. De felles
// tellerne (rl/all, rl/login/all) er ett dokument hver og slettes aldri her, så det felles taket er alltid eksakt.
const isShared = (key) => key === ALL_KEY || key === LOGIN_ALL_KEY;
export async function release(store, key, token) {
  let drop = false;
  const r = await mutateJSON(store, key, initHits, (doc) => {
    drop = false;
    if (!hasOwn(doc.hits, token)) return { ok: true, noWrite: true };
    doc.hits = doc.hits.filter((h) => !(h && h.id === token));
    if (!isShared(key) && !doc.hits.some(validHit) && !Number.isFinite(doc.alertedAt)) {
      drop = true;
      return { ok: true, released: true, noWrite: true };
    }
    return { ok: true, released: true };
  });
  if (drop) await store.delete(key);
  return r;
}

// Taket er nådd uten at noen har fått varsel innen alertMs: skriv alertedAt og svar tripped (bare én gang)
async function trip(store, key, rules, nowMs, alertMs) {
  return mutateJSON(store, key, initHits, (doc) => {
    if (!isFull(recent(doc.hits, rules, nowMs), rules, nowMs)) return { noWrite: true, tripped: false };
    if (Number.isFinite(doc.alertedAt) && nowMs - doc.alertedAt < alertMs) return { noWrite: true, tripped: false };
    doc.alertedAt = nowMs;
    return { ok: true, tripped: true };
  });
}

// ---------- Hemmeligheten bak teller-nøklene ----------
export const SECRET_KEY = "rl/secret";
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/; // 32 byte i base64url
// Hemmeligheten i denne lagringen, laget første gang (to samtidige førstegangs-forespørsler ender med den samme).
// Leses hver gang (én sterk lesing), så en lagring aldri bruker en annen lagrings hemmelighet.
export async function limiterSecret(store) {
  const cur = await store.get(SECRET_KEY, { type: "json" });
  if (cur && SECRET_RE.test(cur.k)) return cur.k;
  const r = await mutateJSON(store, SECRET_KEY, (d) => (d && typeof d === "object" && !Array.isArray(d) ? d : {}), (doc) => {
    if (SECRET_RE.test(doc.k)) return { ok: true, noWrite: true, k: doc.k };
    doc.k = randomBytes(32).toString("base64url");
    return { ok: true, k: doc.k };
  });
  if (r.error) throw new Error("Kunne ikke lage teller-hemmeligheten: " + r.error);
  return r.k;
}
// Nøkkelen til telleren for verdien (et telefonnummer fra phoneKey, en klient fra clientKey)
export const counterKey = (secret, kind, value) =>
  `rl/${kind}/${createHmac("sha256", secret).update(`${kind}:${value}`).digest("base64url").slice(0, 22)}`;

// ---------- Hvem som spør ----------
function ipv4(s) {
  const p = s.split(".");
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return null;
  return p.map(Number).join(".");
}
// De åtte 16-bits gruppene i en IPv6-adresse (med «::» og en IPv4-hale), eller null
function ipv6Groups(s) {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(":") || s.length > 45) return null;
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = ipv4(last);
    if (!v4) return null;
    const o = v4.split(".").map(Number);
    s = s.slice(0, lastColon + 1) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h) => (h === "" ? [] : h.split(":"));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  if (![...head, ...tail].every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const n = head.length + tail.length;
  if (halves.length === 1 ? n !== 8 : n > 7) return null;
  return [...head, ...Array(8 - n).fill("0"), ...tail].map((g) => parseInt(g, 16));
}
// Klienten som teller-verdi: en IPv4-adresse som den er (også skrevet som IPv4 i IPv6, «::ffff:198.51.100.5»), en
// IPv6-adresse som sitt /64-nett (én tilkobling har et helt /64 å velge adresser fra, så hver adresse alene ville vært
// ubegrenset med «nye» klienter), uten [], port og sone. Alt annet blir «ukjent».
export function clientKey(raw) {
  let s = String(raw ?? "").trim();
  const bracket = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(s);
  if (bracket) s = bracket[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(s)) s = s.slice(0, s.lastIndexOf(":"));
  s = s.replace(/%[0-9A-Za-z._~-]{1,32}$/, ""); // sone (fe80::1%eth0)
  const v4 = ipv4(s);
  if (v4) return v4;
  const g = ipv6Groups(s);
  if (!g) return "ukjent";
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return g.slice(0, 4).map((x) => x.toString(16)).join(":") + "::/64";
}

// Telefonnummeret som teller-verdi, uansett skrivemåte: bare sifrene, og et norsk nummer skrevet med landskode
// («+47 912 34 567», «0047 912 34 567», «47 22 33 44 55») blir de åtte sifrene uten den («91234567», «22334455»).
export function phoneKey(phone) {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("0047")) return d.slice(4);
  if (d.length === 10 && d.startsWith("47")) return d.slice(2);
  return d;
}

// ---------- Admin-innlogging (F4, F5) ----------
// Hvert forsøk telles før passordet sjekkes: per klient (rl/login/ip/<hash>) og totalt (LOGIN_ALL_KEY).
export const LOGIN_LIMITS = {
  ip: [{ max: 10, windowMs: 15 * 60 * 1000 }],
  all: [{ max: 100, windowMs: 15 * 60 * 1000 }],
};
export const LOGIN_ALL_KEY = "rl/login/all";

// ---------- Nettbestillinger (F2, NEW-lockout, SPEC R5) ----------
// Uten tak kunne et skript fylle hele kalenderen på sekunder med falske bestillinger.
// Tellerne gjelder forespørsler som har bestått valideringen. En avvist bestilling (taket, eller tiden var tatt)
// gir pengene tilbake, så et angrep på det felles taket aldri brenner en kundes egne tellere.
export const BOOKING_LIMITS = {
  ip: [{ max: 5, windowMs: HOUR }, { max: 10, windowMs: DAY }],      // én klient (IPv4-adresse eller IPv6 /64)
  phone: [{ max: 6, windowMs: DAY }],                                // ett telefonnummer, uansett skrivemåte (eieren bekrefter 6)
  all: [{ max: 20, windowMs: HOUR }, { max: 40, windowMs: DAY }],    // alle nettbestillinger til sammen
};
export const ALL_KEY = "rl/all";
export const ALERT_MS = DAY; // Viggo får høyst ett varsel per døgn om at nettbestillingen er satt på pause
const ORDER = ["ip", "phone", "all"];

// Nøklene til de tre tellerne for denne klienten og dette nummeret
export function bookingKeys(secret, { ip, phone }) {
  return { ip: counterKey(secret, "ip", clientKey(ip)), phone: counterKey(secret, "phone", phoneKey(phone)), all: ALL_KEY };
}

// Tokenet et forsøk telles med. Uten requestId et nytt for hvert forsøk. Med requestId (SPEC R1, F1) det samme for
// et nytt forsøk på den samme bestillingen, og bare da: tokenet er en nøkkel-hash av requestId sammen med dato,
// starttid og telefonnummer, regnet ut av serveren. En klient som bruker samme requestId på en annen tid eller et
// annet nummer, får et annet token og telles som et nytt forsøk (runde 2: én requestId åpnet ellers alle takene).
export function bookingToken(secret, { requestId, date, start, phone }) {
  if (!requestId) return newToken();
  return createHmac("sha256", secret).update(`req:${requestId}|${date}|${start}|${phoneKey(phone)}`).digest("base64url").slice(0, 22);
}

// Teller én nettbestilling for klienten, telefonnummeret og totalen. Alle tre leses først, og er én full, avvises
// forsøket uten at noe skrives. Så tas plassene i rekkefølgen ip → phone → all med samme token; avviser en senere
// teller, gis de tidligere tilbake. token: se bookingToken (et nytt forsøk på samme bestilling telles ikke to ganger).
// Svarer { ok: true, keys, token, took } (took: tellerne dette kallet selv skrev i), { ok: false, limited: "ip" |
// "phone" | "all", tripped } (tripped: det felles taket avviste for første gang i ALERT_MS, si fra til Viggo) eller
// { ok: false, error, status }.
export async function takeBookingSlot(store, { ip, phone, requestId, date, start }, nowMs) {
  const secret = await limiterSecret(store);
  const keys = bookingKeys(secret, { ip, phone });
  const token = bookingToken(secret, { requestId, date, start, phone });
  const peeks = await Promise.all(ORDER.map((k) => peek(store, keys[k], BOOKING_LIMITS[k], { nowMs, token })));
  const fullAt = ORDER.find((k, i) => peeks[i].full);
  if (fullAt) {
    const tripped = peeks[2].full ? (await trip(store, ALL_KEY, BOOKING_LIMITS.all, nowMs, ALERT_MS)).tripped === true : false;
    return { ok: false, limited: fullAt, tripped };
  }
  const took = [];
  for (const k of ORDER) {
    const r = await take(store, keys[k], BOOKING_LIMITS[k], { nowMs, token, alertMs: k === "all" ? ALERT_MS : 0 });
    if (r.error || !r.ok) {
      await releaseKeys(store, took.map((t) => keys[t]), token);
      if (r.error) return { ok: false, limited: k, error: r.error, status: r.status };
      return { ok: false, limited: k, tripped: r.tripped === true };
    }
    if (!r.own) took.push(k);
  }
  return { ok: true, keys, token, took };
}

// Gir tilbake plassene en bestilling tok (slot fra takeBookingSlot) i tellerne kinds, f.eks. ["phone", "all"] når
// tiden var tatt. Bare treff dette kallet selv skrev (slot.took): et treff som allerede sto der med samme token,
// hører til et tidligere forsøk som kan ha blitt lagret, og blir stående. Feiler aldri: går det ikke, blir treffet
// stående til det går ut av vinduet.
export async function releaseBookingSlot(store, slot, kinds) {
  if (!slot || !slot.keys) return;
  const took = Array.isArray(slot.took) ? slot.took : [];
  await releaseKeys(store, kinds.filter((k) => took.includes(k)).map((k) => slot.keys[k]).filter(Boolean), slot.token);
}
// Et forsøk som ikke lagret noe (tiden var tatt, eller requestId var brukt på en annen tid), men som skal telle for
// klienten: treffet blir stående, men med en ny, tilfeldig id (runde 2). Ellers var tokenet fra requestId «allerede
// telt» i et døgn, og det samme forsøket kunne gjentas uten grense (300 x 409, aldri 429), med to skrivinger i rl/all
// hver gang. Bare et forsøk som kan ha lagret en bestilling, er unntatt fra å telles på nytt. Feiler aldri.
export async function forgetToken(store, slot, kind) {
  if (!slot || !slot.keys || !slot.keys[kind]) return;
  try {
    const r = await mutateJSON(store, slot.keys[kind], initHits, (doc) => {
      const hit = doc.hits.find((h) => h && h.id === slot.token);
      if (!hit) return { ok: true, noWrite: true };
      hit.id = newToken();
      return { ok: true };
    });
    if (r.error) console.warn("Teller: kunne ikke gi treffet en ny id:", r.error);
  } catch (err) {
    console.warn("Teller: kunne ikke gi treffet en ny id:", err && err.name);
  }
}
async function releaseKeys(store, keys, token) {
  for (const key of keys) {
    try {
      const r = await release(store, key, token);
      if (r.error) console.warn("Teller: kunne ikke gi tilbake en plass:", r.error);
    } catch (err) {
      console.warn("Teller: kunne ikke gi tilbake en plass:", err && err.name);
    }
  }
}
