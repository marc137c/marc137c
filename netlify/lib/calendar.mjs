// Kalender på telefonen: en privat iCalendar-strøm (RFC 5545) med timebokens avtaler, som Viggo abonnerer på
// én gang (iPhone via webcal://, Google Kalender via «legg til med URL»). Telefonen henter strømmen selv med
// jevne mellomrom, så nye, flyttede og avlyste timer kommer med av seg selv.
//
// Kalenderapper kan ikke sende innlogging, så adressen bærer en lang, tilfeldig hemmelighet (256 bit).
// Den ligger i timebokens egen lagring (nøkkel FEED_KEY, så forhåndsvisninger har sin egen, F10) og kan
// lages på nytt fra /admin: da slutter den gamle adressen å virke med en gang. Den slutter også å virke når
// admin-passordet byttes og nettstedet er publisert på nytt (feedGen; et nytt passord gjelder først etter en ny
// utrulling), så et passordbytte stenger alt: innlogging, varsler og kalenderlenken.
//
// Strømmen:
//  - hver aktive avtale (type «booking», ikke avlyst) fra FEED_PAST_DAYS dager tilbake til FEED_FUTURE_DAYS
//    dager frem, nøyaktig én gang; blokkeringer og avlyste timer er ikke med, så de forsvinner fra telefonen;
//  - norsk tid med TZID=Europe/Oslo og en VTIMEZONE med EUs sommertidsregler (siste søndag i mars/oktober),
//    så klokkeslettene står riktig også over sommertid/vintertid; lengden er DURATION i nøyaktige minutter;
//  - bare tjeneste (+ tillegg), kundens navn og telefonnummer: aldri Viggos egne notater (de er private, og Google
//    Kalender henter og lagrer strømmen på sine servere);
//  - en påminnelse ALARM_MIN minutter før hver time;
//  - CRLF etter hver linje, linjer brettet etter 75 oktetter (aldri midt i et UTF-8-tegn), og tekst escapet.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { CONFIG, addDays, isDate, osloNow, readMonths, mutateJSON, passwordGen } from "./booking-core.mjs";

export const FEED_KEY = "calendar/feed";
export const FEED_PAST_DAYS = 31;
export const FEED_FUTURE_DAYS = 366;
export const ALARM_MIN = 15;
export const TZID = CONFIG.timeZone; // "Europe/Oslo"
const UID_DOMAIN = "viggos-timebok";

// ---------- Hemmeligheten i adressen ----------
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 tilfeldige byte i base64url
export const isTokenShaped = (s) => typeof s === "string" && TOKEN_RE.test(s);
export const newFeedToken = () => randomBytes(32).toString("base64url");

// Lenken hører til admin-passordet den ble laget med (gen = feedGen(ADMIN_PASSWORD)), akkurat som innloggingen:
// bytter Viggo passordet, slutter den gamle lenken å virke, og /admin ber ham lage en ny.
export const feedGen = (password) => passwordGen(password, "calendar");
const isGen = (gen) => typeof gen === "string" && gen.length === 16;

// { feed, stale }: feed er lenken for dette passordet (eller null); stale sier at det finnes en lenke fra et
// gammelt passord, som ikke virker lenger.
export async function readFeedState(store, gen) {
  const doc = await store.get(FEED_KEY, { type: "json" });
  const shaped = !!(doc && typeof doc === "object" && isTokenShaped(doc.token));
  const ok = shaped && isGen(gen) && doc.gen === gen;
  return { feed: ok ? doc : null, stale: shaped && !ok };
}
// Lenken for dette passordet, eller null (ingen lenke, eller en fra et gammelt passord)
export const readFeed = async (store, gen) => (await readFeedState(store, gen)).feed;

// Lager hemmeligheten for passordet gen hvis den mangler (eller er fra et gammelt passord). replace: true lager
// alltid en ny (den gamle slutter å virke med en gang). Svarer { ok, created, feed: { token, createdAt } }.
export async function createFeed(store, { replace = false, now = new Date(), gen } = {}) {
  if (!isGen(gen)) return { error: "Kalenderen er ikke satt opp: mangler admin-passord.", status: 503 };
  let made = false;
  const r = await mutateJSON(store, FEED_KEY, (data) => (data && typeof data === "object" ? data : {}), (doc) => {
    if (!replace && isTokenShaped(doc.token) && doc.gen === gen) { made = false; return { ok: true, noWrite: true, feed: { token: doc.token, createdAt: doc.createdAt } }; }
    doc.token = newFeedToken();
    doc.createdAt = now.toISOString();
    doc.gen = gen;
    made = true;
    return { ok: true, feed: { token: doc.token, createdAt: doc.createdAt } };
  });
  return r.error ? r : { ok: true, created: made, feed: r.feed };
}

// Sammenligning med konstant tid (sammenligner SHA-256 av begge, så lengden ikke lekker heller)
export function tokenMatches(given, stored) {
  if (!isTokenShaped(given) || !isTokenShaped(stored)) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(stored).digest();
  return timingSafeEqual(a, b);
}

export const feedPath = (token) => `/api/calendar/${token}.ics`;

// Lenkene /admin viser: vanlig https (kopier), webcal:// (iPhone/Mac åpner «Abonner»), og Google Kalenders
// «legg til med URL» (cid=webcal-adressen).
export function feedLinks(origin, token) {
  const https = new URL(feedPath(token), origin).href;
  const webcal = https.replace(/^https?:/, "webcal:");
  return { https, webcal, google: "https://calendar.google.com/calendar/r?cid=" + encodeURIComponent(webcal) };
}

// ---------- iCalendar (RFC 5545) ----------
// Tekst (3.3.11): \ ; , og linjeskift escapes; andre kontrolltegn er ikke lov og blir mellomrom.
export function escapeText(s) {
  return String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

// Bretting (3.1): ingen linje over 75 oktetter uten CRLF; fortsettelser begynner med ett mellomrom.
// Deler bare mellom hele tegn (kodepunkter), aldri midt i en UTF-8-sekvens.
export function foldLine(line) {
  const out = [];
  let cur = "", bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > 75) { out.push(cur); cur = " "; bytes = 1; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

const pad = (n, w = 2) => String(n).padStart(w, "0");
// Lokal tid i Oslo som DATE-TIME uten Z: dato «ÅÅÅÅ-MM-DD» + minutter etter midnatt (1440 = neste dag 00:00)
export function localDateTime(date, minutes) {
  const day = addDays(date, Math.floor(minutes / 1440));
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${day.replace(/-/g, "")}T${pad(Math.floor(m / 60))}${pad(m % 60)}00`;
}
// UTC-tid (med Z) fra en ISO-streng eller Date
export function utcDateTime(when) {
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Europe/Oslo: CET (UTC+1) om vinteren, CEST (UTC+2) fra siste søndag i mars kl. 02:00 til siste søndag
// i oktober kl. 03:00 (EUs regel siden 1996).
const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  `TZID:${TZID}`,
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const isBookingInFeed = (i) => i && i.type === "booking" && i.status !== "cancelled"
  && isDate(i.date) && Number.isInteger(i.start) && Number.isInteger(i.dur) && i.dur > 0; // aldri en dato som ikke finnes

const what = (i) => {
  const service = i.service || "Avtale";
  return i.addons && i.addons.length ? `${service} + ${i.addons.join(", ")}` : service;
};

function eventLines(i, fallbackStamp) {
  const stamp = utcDateTime(i.updatedAt) || utcDateTime(i.createdAt) || fallbackStamp;
  const summary = i.name ? `${what(i)} – ${i.name}` : what(i);
  const description = [
    i.name && `Kunde: ${i.name}`,
    i.phone && `Telefon: ${i.phone}`,
    `Tjeneste: ${i.service || "Avtale"}`,
    i.addons && i.addons.length && `Tillegg: ${i.addons.join(", ")}`,
    i.source === "nettside" ? "Bestilt på nettsiden" : "Lagt inn i timeboken",
  ].filter(Boolean).join("\n");
  const lines = [
    "BEGIN:VEVENT",
    `UID:${escapeText(`${i.id}@${UID_DOMAIN}`)}`,
    `DTSTAMP:${stamp}`,
  ];
  const created = utcDateTime(i.createdAt);
  if (created) lines.push(`CREATED:${created}`);
  if (utcDateTime(i.updatedAt)) lines.push(`LAST-MODIFIED:${utcDateTime(i.updatedAt)}`);
  lines.push(
    `DTSTART;TZID=${TZID}:${localDateTime(i.date, i.start)}`,
    // Varighet, ikke sluttid: PT…M er nøyaktige minutter (RFC 5545 3.3.6), så timen varer alltid like lenge som
    // den er booket, også natten sommertid starter eller slutter. En sluttid i lokal tid (start + varighet på
    // klokken) ville gitt 0 minutter for 02:00–03:00 i mars og 90 minutter for 02:30–03:00 i oktober.
    `DURATION:PT${i.dur}M`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description)}`,
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeText(summary)}`,
    `TRIGGER:-PT${ALARM_MIN}M`,
    "END:VALARM",
    "END:VEVENT",
  );
  return lines;
}

// Hele kalenderen som tekst. items: lagrede avtaler (booking-core), now: brukes bare som DTSTAMP-reserve.
export function buildCalendar(items, { now = new Date() } = {}) {
  const fallbackStamp = utcDateTime(now);
  const seen = new Set();
  const events = [];
  for (const i of items) {
    if (!isBookingInFeed(i) || seen.has(i.id)) continue;
    seen.add(i.id);
    events.push(i);
  }
  events.sort((a, b) => (a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1));
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Viggo's Barbershop//Timebok//NO",
    "CALSCALE:GREGORIAN",
    `NAME:${escapeText("Timebok – Viggo's Barbershop")}`,
    `X-WR-CALNAME:${escapeText("Timebok – Viggo's Barbershop")}`,
    `X-WR-TIMEZONE:${TZID}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
    ...VTIMEZONE,
    ...events.flatMap((i) => eventLines(i, fallbackStamp)),
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// Perioden strømmen dekker, i norsk dato
export function feedRange(now = new Date()) {
  const today = osloNow(now).date;
  return { from: addDays(today, -FEED_PAST_DAYS), to: addDays(today, FEED_FUTURE_DAYS) };
}

export async function calendarFor(store, now = new Date()) {
  const { from, to } = feedRange(now);
  return buildCalendar(await readMonths(store, from, to), { now });
}
