// Tellere med glidende tidsvindu i Netlify Blobs, konfliktsikre (ETag): to samtidige forespørsler kan aldri
// begge få den siste plassen. Brukes mot flom av nettbestillinger (F2).
// Et dokument per teller: { hits: [{ t: ms, id }] }. id gjør skrivingen trygg å gjenta: gikk svaret tapt
// etter at skrivingen ble lagret, finner neste forsøk sin egen id og teller ikke to ganger.
import { randomBytes } from "node:crypto";
import { mutateJSON } from "./booking-core.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const newToken = () => randomBytes(8).toString("hex");

const initHits = (data) => (data && Array.isArray(data.hits) ? data : { hits: [] });
const longest = (rules) => Math.max(...rules.map((r) => r.windowMs));

// Tar én plass i telleren key hvis alle reglene ({ max, windowMs }) har plass. Svarer { ok: true } eller
// { ok: false, limited: true } (eller { error, status } hvis lagringen ikke ble enig med seg selv).
export async function take(store, key, rules, { nowMs, token = newToken() } = {}) {
  return mutateJSON(store, key, initHits, (doc) => {
    if (doc.hits.some((h) => h.id === token)) return { ok: true, own: true, noWrite: true }; // vårt forrige forsøk ble lagret
    doc.hits = doc.hits.filter((h) => nowMs - h.t < longest(rules));
    for (const r of rules) {
      const used = doc.hits.filter((h) => nowMs - h.t < r.windowMs).length;
      if (used >= r.max) return { ok: false, limited: true, noWrite: true };
    }
    doc.hits.push({ t: nowMs, id: token });
    return { ok: true };
  });
}

// ---------- Nettbestillinger (F2) ----------
// Uten tak kunne et skript fylle hele kalenderen på sekunder med falske bestillinger.
// Tellerne gjelder forespørsler som har bestått valideringen (også en tid som var tatt).
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
