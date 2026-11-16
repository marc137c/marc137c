// Owner decision D4: no automatic holidays, but a day the barber blocked completely is closed everywhere (the
// customer calendar, the hero status line, the admin week strip and day info). One rule, one set of cases, used by
// every place that shows it (RC6): test/functions/availability.test.mjs (server closedDays and /api/availability)
// now, and the client and admin tests in steps 3 and 4.
// Rule: a date is closed when the union of its active (not cancelled) type "block" items covers the opening hours
// of that weekday (CONFIG.hours: Mon-Fri 600-1080, Sat 600-1020). Sundays have no hours and are closed anyway, so
// they are never listed. Bookings never close a day, however full it is.
// All dates are within 60 days of TODAY.
export const TODAY = "2026-11-12"; // a Thursday; the clock for these cases: 2026-11-12T09:00:00Z (10:00 in Oslo)

let n = 0;
const block = (date, start, dur, extra = {}) => ({
  id: `${date}_cd${String(++n).padStart(4, "0")}`, type: "block", status: "confirmed", source: "admin",
  date, start, dur, service: "", addons: [], name: "", phone: "", note: "Stengt",
  createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z", ...extra,
});
const booking = (date, start, dur = 30) => ({ ...block(date, start, dur), type: "booking", source: "nettside", service: "Herreklipp", name: "Kunde", phone: "400 00 000", note: "" });

// { label, date, items, closed }
export const CASES = [
  { label: "two adjacent blocks 10-14 and 14-18 on a Thursday", date: "2026-12-24", items: [block("2026-12-24", 600, 240), block("2026-12-24", 840, 240)], closed: true },
  { label: "one block over the whole day (00:00-24:00)", date: "2026-12-23", items: [block("2026-12-23", 0, 1440)], closed: true },
  { label: "one block exactly over the opening hours", date: "2026-12-22", items: [block("2026-12-22", 600, 480)], closed: true },
  { label: "two overlapping blocks that together cover the day", date: "2026-12-21", items: [block("2026-12-21", 600, 300), block("2026-12-21", 800, 280)], closed: true },
  { label: "a Saturday blocked 10-17 (Saturday hours end at 17)", date: "2026-12-19", items: [block("2026-12-19", 600, 420)], closed: true },
  { label: "a partial block that leaves 17-18 open", date: "2026-12-18", items: [block("2026-12-18", 600, 420)], closed: false },
  { label: "a cancelled whole-day block", date: "2026-12-17", items: [block("2026-12-17", 600, 480, { status: "cancelled" })], closed: false },
  { label: "a day full of bookings (fully booked is not closed)", date: "2026-12-16", items: Array.from({ length: 16 }, (_, i) => booking("2026-12-16", 600 + 30 * i)), closed: false },
  { label: "two blocks with a 30-minute gap between them", date: "2026-12-15", items: [block("2026-12-15", 600, 240), block("2026-12-15", 870, 210)], closed: false },
  { label: "a booking (not a block) over the whole day", date: "2026-12-14", items: [booking("2026-12-14", 600, 480)], closed: false },
  { label: "a Saturday blocked 10-16:30, open until 17", date: "2026-12-12", items: [block("2026-12-12", 600, 390)], closed: false },
  { label: "a block plus bookings that fill the rest", date: "2026-12-11", items: [block("2026-12-11", 600, 240), ...Array.from({ length: 8 }, (_, i) => booking("2026-12-11", 840 + 30 * i))], closed: false },
  { label: "a Sunday block (closed by the hours already, never listed)", date: "2026-12-20", items: [block("2026-12-20", 600, 480)], closed: false },
];

export const items = CASES.flatMap((c) => c.items);
export const closed = CASES.filter((c) => c.closed).map((c) => c.date).sort();
export const date = (label) => CASES.find((c) => c.label === label).date;
