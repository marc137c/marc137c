// Days for the /admin page tests (RC8: not only friendly on-grid bookings inside opening hours). Each case is one
// date with its items, as GET /api/admin/items returns them. The hours are the server's (booking-core CONFIG):
// Mon-Fri 10-18, Sat 10-17, Sunday closed. Used by test/page/admin-timeline.test.mjs (cards in start order) and
// test/page/admin-blocked-days.test.mjs, which also runs the shared closed-day cases re-exported here (D4).
export * as closedDays from "./closed-days.mjs";

let n = 0;
export const item = (date, start, dur, extra = {}) => ({
  id: `${date}_ad${String(++n).padStart(4, "0")}`, type: "booking", status: "confirmed", source: "admin",
  date, start, dur, service: "Herreklipp", addons: [], name: "Kunde " + n, phone: "400 00 " + String(100 + n), note: "",
  createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z", ...extra,
});
export const block = (date, start, dur, extra = {}) => item(date, start, dur, { type: "block", service: "", name: "", phone: "", note: "Stengt", ...extra });

// { label, date, items, closed (a fully blocked or weekly closed day) }
export const DAYS = [
  { label: "a booking before opening (09:30/60) and one at 10:30", date: "2026-11-17", closed: false,
    items: [item("2026-11-17", 570, 60, { name: "Tidlig" }), item("2026-11-17", 630, 30, { name: "Kunde" })] },
  { label: "a booking after closing (18:30)", date: "2026-11-18", closed: false,
    items: [item("2026-11-18", 600, 30), item("2026-11-18", 1110, 30, { name: "Sein" })] },
  { label: "an off-grid booking at 10:05", date: "2026-11-19", closed: false,
    items: [item("2026-11-19", 605, 30, { name: "Skjev" }), item("2026-11-19", 660, 30)] },
  { label: "overlapping bookings 11:00/60 and 11:30/30", date: "2026-11-20", closed: false,
    items: [item("2026-11-20", 660, 60, { name: "Lang" }), item("2026-11-20", 690, 30, { name: "Oppå" })] },
  { label: "a cancelled booking at 12:00 next to a live one at 12:00", date: "2026-11-21", closed: false,
    items: [item("2026-11-21", 720, 30, { status: "cancelled", name: "Avlyst" }), item("2026-11-21", 720, 30, { name: "Ny" })] },
  { label: "a Sunday with a booking", date: "2026-11-22", closed: true,
    items: [item("2026-11-22", 720, 30, { name: "Søndag" })] },
  { label: "a whole-day block", date: "2026-11-23", closed: true,
    items: [block("2026-11-23", 600, 480, { note: "Ferie" })] },
  { label: "adjacent blocks 10-14 and 14-18", date: "2026-11-24", closed: true,
    items: [block("2026-11-24", 600, 240), block("2026-11-24", 840, 240)] },
];

export const items = DAYS.flatMap((d) => d.items);
export const day = (label) => { const d = DAYS.find((x) => x.label === label); if (!d) throw new Error("no day " + label); return d; };
