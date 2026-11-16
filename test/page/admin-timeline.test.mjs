// /admin day view (#timeline): every card is in start order, whatever the day holds (F31, RC8). Runs the real
// admin.js on each day in test/fixtures/admin-days.mjs: bookings before opening and after closing, off-grid times,
// overlaps, cancelled bookings, a Sunday and blocked days.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin, itemsRoute } from "../helpers/admin-page.mjs";
import { DAYS, items, day } from "../fixtures/admin-days.mjs";

const open = (date) => loadAdmin({ now: date + "T08:00", routes: { "GET /api/admin/items": itemsRoute(items) } });
const cards = (page) => [...page.rendered("timeline").querySelectorAll("[data-id]")].map((e) => e.getAttribute("data-id"));

for (const d of DAYS) {
  test(`timeline: ${d.label}: the live cards are in start order, the cancelled ones after them`, async () => {
    const page = await open(d.date);
    const live = d.items.filter((i) => i.status !== "cancelled").slice().sort((a, b) => a.start - b.start).map((i) => i.id);
    const gone = d.items.filter((i) => i.status === "cancelled").map((i) => i.id);
    assert.deepEqual(cards(page), live.concat(gone));
  });
}

test("timeline F31: a customer booked 09:30 (before opening) is drawn first, above the first free row and the trailing heading", async () => {
  const d = day("a booking before opening (09:30/60) and one at 10:30");
  const page = await open(d.date);
  const html = page.$("timeline").innerHTML;
  const early = html.indexOf("Tidlig");
  assert.ok(early >= 0, "the early booking is shown");
  assert.ok(early < html.indexOf("Kunde"), "before the 10:30 booking");
  const free = html.indexOf("+ Ledig");
  assert.ok(free < 0 || early < free, "above the first free row");
  assert.doesNotMatch(html, /<h4/, "no trailing heading: nothing is outside the day");
  const rows = [...page.rendered("timeline").querySelectorAll("li.row > time")].map((t) => t.textContent);
  assert.equal(rows[0], "09:30", "the first row is 09:30");
  assert.ok(!rows.includes("10:00"), "10:00 is still taken by the 09:30-10:30 booking, so no free row there");
});

test("timeline: a booking after closing and a cancelled one are listed after the day, under «Etter stengetid / avlyste»", async () => {
  for (const label of ["a booking after closing (18:30)", "a cancelled booking at 12:00 next to a live one at 12:00"]) {
    const d = day(label);
    const page = await open(d.date);
    const html = page.$("timeline").innerHTML;
    const h = html.indexOf("Etter stengetid / avlyste");
    assert.ok(h > 0, label + ": the heading is there");
    const odd = d.items.find((i) => i.name === "Sein" || i.status === "cancelled");
    assert.ok(html.indexOf(odd.id) > h, label + ": listed under it");
  }
});
