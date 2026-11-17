// Bookingstatistikk til /api/stats. Regnes ut ved å LESE bookingene – bestillingen selv skriver ingenting ekstra,
// så statistikken kan aldri ødelegge en booking. Bare tall: aldri navn, telefon eller merknad.
// Gruppert etter dagen bookingen ble GJORT (norsk tid). Når en dag er SNAPSHOT_AFTER dager gammel, lagres tallene for
// den dagen fast i statistikk-dagen (feltet «bookings»), slik at de finnes også etter at bookingene slettes.
import { readMonths, osloNow, addDays, dayOfWeek, isDate, CONFIG, SERVICE_ALIASES } from "./booking-core.mjs";

export const SNAPSHOT_AFTER = 14;      // dager: tid nok til at de fleste avlysninger er kommet før tallene fryses
const MAX_SNAPSHOT_WRITES = 20;        // per forespørsel, så svaret aldri blir tregt; resten tas neste gang

export const emptyDay = () => ({ web: 0, admin: 0, cancelled: 0, services: {}, weekdays: [0, 0, 0, 0, 0, 0, 0] });
export const osloDate = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : osloNow(d).date; };
const canonical = (s) => (Object.prototype.hasOwnProperty.call(SERVICE_ALIASES, s) ? SERVICE_ALIASES[s] : s) || "Annet";
const isBooking = (i) => i && (i.type === undefined || i.type === "booking"); // «block» = stengt tid, ikke en kunde

// items → { "YYYY-MM-DD" (dagen den ble gjort): { web, admin, cancelled, services, weekdays } } for dager i [fromDate, toDate]
export function aggregateByCreatedDay(items, fromDate, toDate) {
  const out = {};
  for (const it of items) {
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

async function saveSnapshot(statsStore, date, snap) {
  const key = `d/${date}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await statsStore.getWithMetadata(key, { type: "json" });
    const doc = cur && cur.data ? cur.data : { views: 0, visits: 0, pages: {}, sources: {} };
    if (doc.bookings) return; // allerede frosset
    doc.bookings = snap;
    const w = await statsStore.setJSON(key, doc, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (w && w.modified) return;
  }
}

// dates: nyeste først. dayDocs: { date: statistikk-dag eller null }. Returnerer tall per dag (samme rekkefølge) og samlet.
export async function bookingStats(bookingsStore, statsStore, dates, today, dayDocs) {
  const frozen = (d) => dayDocs[d] && dayDocs[d].bookings;
  const need = dates.filter((d) => !frozen(d));
  const from = need.length ? need[need.length - 1] : today;
  // Bookinger gjort fra «from» kan ligge på datoer fra litt før (lagt inn bakover av barberen) til maxDays frem
  const items = await readMonths(bookingsStore, addDays(from, -31), addDays(today, CONFIG.maxDays + 1));
  const live = aggregateByCreatedDay(items, from, today);

  const toFreeze = need.filter((d) => d <= addDays(today, -SNAPSHOT_AFTER)).slice(0, MAX_SNAPSHOT_WRITES);
  await Promise.all(toFreeze.map((d) => saveSnapshot(statsStore, d, live[d] || emptyDay()).catch(() => {})));

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
