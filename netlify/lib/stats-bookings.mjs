// Statistikkdagen (d/ÅÅÅÅ-MM-DD i lageret «stats») og bookingtallene til /api/stats.
// Bookingtallene regnes ut ved å LESE bookingene – bestillingen selv skriver ingenting ekstra, så statistikken kan
// aldri ødelegge en booking. Bare tall: aldri navn, telefon, merknad eller fritekst (en tjeneste /admin har skrevet
// fritt, telles som «Annet», så et navn i tjenestefeltet aldri havner i statistikken).
// Gruppert etter dagen bookingen ble GJORT (norsk tid). Når en dag er SNAPSHOT_AFTER dager gammel, lagres tallene for
// den dagen fast i statistikkdagen (feltet «bookings»), slik at de finnes også etter at bookingene slettes.
import { readMonths, mutateJSON, osloNow, addDays, dayOfWeek, isDate, CONFIG, SERVICE_ALIASES } from "./booking-core.mjs";

export const SNAPSHOT_AFTER = 14;      // dager: tid nok til at de fleste avlysninger er kommet før tallene fryses
const MAX_SNAPSHOT_WRITES = 20;        // per forespørsel, så svaret aldri blir tregt; resten tas neste gang
export const SOURCES = Object.freeze(["instagram", "facebook", "google", "tiktok", "direkte", "annet"]);
export const PAGES = Object.freeze(["forside", "personvern"]);
export const OTHER_SERVICE = "Annet";

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const pick = (obj, names) => {
  const out = {};
  for (const n of names) if (isObj(obj) && count(obj[n])) out[n] = count(obj[n]);
  return out;
};
const sumOf = (obj) => Object.keys(obj).reduce((a, k) => a + obj[k], 0);
const SERVICES = () => Object.keys(CONFIG.durations).concat(OTHER_SERVICE);

export const emptyDay = () => ({ web: 0, admin: 0, cancelled: 0, services: {}, weekdays: [0, 0, 0, 0, 0, 0, 0] });

// Frosne bookingtall i fast form (bare kjente tjenester og sju ukedager), eller null når feltet mangler eller er ødelagt
export function bookingsDay(b) {
  if (!isObj(b)) return null;
  const w = Array.isArray(b.weekdays) ? b.weekdays : [];
  return { web: count(b.web), admin: count(b.admin), cancelled: count(b.cancelled), services: pick(b.services, SERVICES()),
    weekdays: [0, 1, 2, 3, 4, 5, 6].map((i) => count(w[i])) };
}

// Statistikkdagen i fast form, uansett hva som lå der: bare kjente sider og kilder med heltall.
// visits: besøk utenfra. Dager fra før besøk ble skilt ut, har ikke feltet: der hadde hver visning en kilde, så
// summen av kildene er det beste anslaget.
export function statsDay(data) {
  const src = isObj(data) ? data : {};
  const sources = pick(src.sources, SOURCES);
  const doc = { views: count(src.views), visits: Number.isInteger(src.visits) && src.visits >= 0 ? src.visits : sumOf(sources),
    pages: pick(src.pages, PAGES), sources };
  const b = bookingsDay(src.bookings);
  if (b) doc.bookings = b;
  return doc;
}

export const osloDate = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : osloNow(d).date; };
const canonical = (s) => {
  const name = Object.prototype.hasOwnProperty.call(SERVICE_ALIASES, s) ? SERVICE_ALIASES[s] : s;
  return Object.prototype.hasOwnProperty.call(CONFIG.durations, name) ? name : OTHER_SERVICE;
};
const isBooking = (i) => isObj(i) && (i.type === undefined || i.type === "booking"); // «block» = stengt tid, ikke en kunde
// Under en flytting til en annen måned står avtalen et øyeblikk i begge månedene (originalen med «moving», kopien
// med «mv», samme tilfeldige del av id-en; booking-core.mjs). Den telles én gang.
const suffix = (id) => { const s = String(id); return s.slice(s.indexOf("_") + 1); };
export function uniqueItems(items) {
  const seen = new Set();
  return items.filter((it) => {
    if (!isObj(it) || it.id === undefined) return true;
    const k = suffix(it.id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// items → { "YYYY-MM-DD" (dagen den ble gjort): { web, admin, cancelled, services, weekdays } } for dager i [fromDate, toDate]
export function aggregateByCreatedDay(items, fromDate, toDate) {
  const out = {};
  for (const it of uniqueItems(items)) {
    if (!isBooking(it)) continue;
    const day = osloDate(it.createdAt);
    if (!day || day < fromDate || day > toDate) continue;
    const s = out[day] || (out[day] = emptyDay());
    if (it.source === "admin") s.admin++; else s.web++;
    if (it.status === "cancelled") { s.cancelled++; continue; }
    const svc = canonical(it.service);
    s.services[svc] = (s.services[svc] || 0) + 1;
    if (isDate(it.date)) s.weekdays[dayOfWeek(it.date)]++;
  }
  return out;
}

// Fryser tallene for én dag i statistikkdagen (konfliktsikkert; en dag som allerede er frosset, skrives ikke over)
async function saveSnapshot(statsStore, date, snap) {
  return mutateJSON(statsStore, `d/${date}`, statsDay, (doc) => {
    if (doc.bookings) return { ok: true, noWrite: true };
    doc.bookings = bookingsDay(snap);
    return { ok: true };
  }, { attempts: 4 });
}

// dates: nyeste først. dayDocs: { date: statistikkdag eller null }. Svarer tall per dag (samme rekkefølge) og hvor
// mange aktive bookinger som står de neste sju dagene. Kaster når bookingene ikke kan leses (da fryses ingenting).
export async function bookingStats(bookingsStore, statsStore, dates, today, dayDocs) {
  const frozen = (d) => (dayDocs[d] && bookingsDay(dayDocs[d].bookings)) || null;
  const need = dates.filter((d) => !frozen(d));
  const from = need.length ? need[need.length - 1] : today;
  // Bookinger gjort fra «from» kan ligge på datoer fra litt før (lagt inn bakover av barberen) til maxDays frem
  const items = uniqueItems(await readMonths(bookingsStore, addDays(from, -31), addDays(today, CONFIG.maxDays + 1)));
  const live = aggregateByCreatedDay(items, from, today);

  const toFreeze = need.filter((d) => d <= addDays(today, -SNAPSHOT_AFTER)).slice(0, MAX_SNAPSHOT_WRITES);
  // En frysing som feiler, prøves igjen ved neste visning; tallene i svaret er de samme uansett
  await Promise.all(toFreeze.map((d) => saveSnapshot(statsStore, d, live[d] || emptyDay()).catch((err) => {
    console.error("Statistikk: kunne ikke fryse en dag:", err && err.name);
  })));

  const perDay = dates.map((d) => frozen(d) || live[d] || emptyDay());
  const week = addDays(today, 6);
  const upcoming7 = items.filter((i) => isBooking(i) && i.status !== "cancelled" && i.date >= today && i.date <= week).length;
  return { perDay, upcoming7 };
}

// Legger sammen dagstall (f.eks. de siste 7, 30 eller 90 dagene)
export function sumDays(list) {
  const total = emptyDay();
  for (const s of list) {
    total.web += s.web || 0; total.admin += s.admin || 0; total.cancelled += s.cancelled || 0;
    for (const k of Object.keys(s.services || {})) total.services[k] = (total.services[k] || 0) + s.services[k];
    (s.weekdays || []).forEach((n, i) => { total.weekdays[i] += n || 0; });
  }
  return total;
}
