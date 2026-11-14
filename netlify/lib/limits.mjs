// Tellere med glidende tidsvindu i Netlify Blobs, konfliktsikre (ETag): to samtidige forespørsler kan aldri
// begge få den siste plassen. Brukes mot flom av nettbestillinger (F2) og som SMS-tak per nummer (sms.mjs).
// Et dokument per teller: { hits: [{ t: ms, id }] }. id gjør skrivingen trygg å gjenta: gikk svaret tapt
// etter at skrivingen ble lagret, finner neste forsøk sin egen id og teller ikke to ganger.
import { randomBytes } from "node:crypto";
import { mutateJSON } from "./booking-core.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const newToken = () => randomBytes(8).toString("hex");

const initHits = (data) => (data && Array.isArray(data.hits) ? data : { hits: [] });
const longest = (rules) => Math.max(...rules.map((r) => r.windowMs));

// Tar én plass i telleren key hvis alle reglene ({ max, windowMs }) har plass. Svarer { ok: true } eller
// { ok: false, limited: true } (eller { error, status } hvis lagringen ikke ble enig med seg selv).
// count(hit) velger hvilke treff som teller (standard: alle).
export async function take(store, key, rules, { nowMs, token = newToken(), data = {}, count = () => true } = {}) {
  return mutateJSON(store, key, initHits, (doc) => {
    if (doc.hits.some((h) => h.id === token)) return { ok: true, own: true, noWrite: true }; // vårt forrige forsøk ble lagret
    doc.hits = doc.hits.filter((h) => nowMs - h.t < longest(rules));
    for (const r of rules) {
      const used = doc.hits.filter((h) => nowMs - h.t < r.windowMs && count(h)).length;
      if (used >= r.max) return { ok: false, limited: true, noWrite: true };
    }
    doc.hits.push({ t: nowMs, id: token, ...data });
    return { ok: true };
  });
}

// Gir plassen tilbake (SMS-en ble aldri sendt). Finnes den ikke, skjer ingenting.
export async function release(store, key, token) {
  return mutateJSON(store, key, initHits, (doc) => {
    const before = doc.hits.length;
    doc.hits = doc.hits.filter((h) => h.id !== token);
    if (doc.hits.length === before) return { ok: true, noWrite: true };
    return { ok: true };
  });
}

// ---------- Nettbestillinger (F2) ----------
// Uten tak kunne et skript fylle hele kalenderen på sekunder og (med SMS på) sende hundrevis av SMS til fremmede
// på butikkens regning. Tellerne gjelder forespørsler som har bestått valideringen (også en tid som var tatt).
export const BOOKING_LIMITS = {
  ip: [{ max: 5, windowMs: HOUR }, { max: 10, windowMs: DAY }],      // én klient
  phone: [{ max: 3, windowMs: DAY }],                                // ett telefonnummer, uansett skrivemåte
  all: [{ max: 20, windowMs: HOUR }, { max: 40, windowMs: DAY }],    // alle nettbestillinger til sammen
};

const keyPart = (s) => String(s).replace(/[^\w.:-]/g, "_").slice(0, 64) || "ukjent";

// Telefonnummeret som teller-nøkkel, uansett skrivemåte: bare sifrene, og et norsk nummer skrevet med landskode
// («+47 912 34 567», «0047 912 34 567», «47 22 33 44 55») blir de åtte sifrene uten den («91234567», «22334455»).
export function phoneKey(phone) {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("0047")) return d.slice(4);
  if (d.length === 10 && d.startsWith("47")) return d.slice(2);
  return d;
}

// Teller én nettbestilling for IP-en, telefonnummeret og totalen, i den rekkefølgen. Svarer { ok: true } eller
// { ok: false, limited: "ip" | "phone" | "all" }. Er en tidligere teller full, telles ikke de neste.
export async function takeBookingSlot(store, { ip, phone }, nowMs) {
  const checks = [
    ["ip", `rl/ip/${keyPart(ip || "ukjent")}`],
    ["phone", `rl/phone/${keyPart(phoneKey(phone))}`],
    ["all", "rl/all"],
  ];
  for (const [name, key] of checks) {
    const r = await take(store, key, BOOKING_LIMITS[name], { nowMs });
    if (r.error) return { ok: false, limited: name, error: r.error, status: r.status };
    if (!r.ok) return { ok: false, limited: name };
  }
  return { ok: true };
}

// ---------- SMS-tak per mottaker (F3, F16) ----------
// Én logg per nummer (nøkkel «sms/to/<nummer>»), glidende døgn, så taket aldri nullstilles ved midnatt.
// En plass tas FØR SMS-en sendes og gis tilbake hvis Sveve sikkert ikke sendte den.
//   customer  bekreftelser og påminnelser: høyst 3 SMS per nummer per døgn, uansett hvor mange timer
//             nummeret står på, så et fremmed nummer aldri kan bli oversvømt
//   shop      varsel til frisøren om nye nettbestillinger: høyst 40 per døgn (samme som taket på nettbestillinger),
//             så en flom aldri kan sende frisøren flere SMS enn det
export const SMS_LIMITS = {
  customer: { rules: [{ max: 3, windowMs: DAY }], count: () => true },
  shop: { rules: [{ max: 40, windowMs: DAY }], count: (h) => h.kind === "shop" },
};
export const smsLogKey = (number) => `sms/to/${keyPart(number)}`;
export function reserveSms(store, number, kind, nowMs, token) {
  const l = kind === "shop" ? SMS_LIMITS.shop : SMS_LIMITS.customer;
  return take(store, smsLogKey(number), l.rules, { nowMs, token, data: { kind }, count: l.count });
}
export const releaseSms = (store, number, token) => release(store, smsLogKey(number), token);
