// Owner decision D4 in /admin: a day the barber blocked completely (the union of active blocks covers the opening
// hours) is closed in the week strip («stengt», is-closed) and in the day info, by the same rule as the server's
// closedDays() and the customer calendar (F91, RC6). Runs the shared cases in test/fixtures/closed-days.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin, itemsRoute } from "../helpers/admin-page.mjs";
import { closedDays as fixture, block, item } from "../fixtures/admin-days.mjs";
import { closedDays } from "../../netlify/lib/booking-core.mjs";

const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isSunday = (iso) => new Date(iso + "T12:00:00Z").getUTCDay() === 0;
const weekButton = (page, date) => {
  const b = page.rendered("week").querySelector(`[data-day="${date}"]`);
  assert.ok(b, "week button for " + date);
  return { closed: b.classList.contains("is-closed"), label: b.querySelector(".n").textContent.trim() };
};
const BLOCKED_INFO = "Stengt – blokkert hele dagen (du kan likevel legge inn avtaler).";

for (const c of fixture.CASES) {
  test(`blocked days: ${c.label}: the week strip and day info agree with closedDays()`, async () => {
    const server = closedDays(c.items).includes(c.date);
    assert.equal(server, c.closed, "the fixture and booking-core agree");
    const shut = server || isSunday(c.date);
    // The day itself (today, first in the strip) and the strip seen from three days before
    const page = await loadAdmin({ now: c.date + "T08:00", routes: { "GET /api/admin/items": itemsRoute(fixture.items) } });
    const w = weekButton(page, c.date);
    assert.equal(w.closed, shut, "is-closed");
    assert.equal(/stengt/.test(w.label), shut, "label: " + w.label);
    const info = page.$("day-info").textContent;
    if (server) assert.equal(info, BLOCKED_INFO);
    else if (shut) assert.match(info, /^Stengt denne dagen/);
    else assert.match(info, /^Åpent /);
    const before = await loadAdmin({ now: addDays(c.date, -3) + "T08:00", routes: { "GET /api/admin/items": itemsRoute(fixture.items) } });
    assert.equal(weekButton(before, c.date).closed, shut, "is-closed seen from three days before");
  });
}

test("blocked days: bookings left under a whole-day block keep their count, followed by «· stengt», and the day info says so", async () => {
  const day = "2026-11-25"; // Wednesday
  const list = [block(day, 600, 480, { note: "Ferie" }), item(day, 660, 30, { name: "Kari" })];
  const page = await loadAdmin({ now: day + "T08:00", routes: { "GET /api/admin/items": itemsRoute(list) } });
  assert.deepEqual(weekButton(page, day), { closed: true, label: "1 time · stengt" });
  assert.equal(page.$("day-info").textContent, BLOCKED_INFO + " 1 avtale ligger fortsatt inne.");
});
