// The /admin test harness itself (test/helpers/admin-page.mjs) and the admin day fixtures: a fake clock the page
// really uses, routes that hold, fail or never answer, clicks on what admin.js drew, and fixture dates on the
// weekdays their labels name. The page tests (test/page/admin-*.test.mjs) rely on these.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin, itemsRoute, held, hang, netFail, fakeDate } from "../helpers/admin-page.mjs";
import { DAYS, items, closedDays } from "../fixtures/admin-days.mjs";

test("harness: the fake clock is the page's today, and setNow moves it", async () => {
  const page = await loadAdmin({ now: "2026-11-11T23:50", routes: { "GET /api/admin/items": itemsRoute([]) } });
  assert.match(page.$("day-title").textContent, /onsdag 11\. november/i);
  assert.equal(page.calls[0].url, "/api/admin/items?from=2026-11-11&to=2026-11-11");
  page.setNow("2026-11-12T07:30");
  assert.equal(new page.context.Date().getDate(), 12);
  const d = fakeDate("2026-01-02T03:04");
  assert.equal(new d.Date(2026, 0, 5).getDate(), 5, "explicit dates still work");
  assert.equal(new d.Date().getHours(), 3);
});

test("harness: itemsRoute answers from..to in start order; tap reaches the delegated listener with the drawn element", async () => {
  const [a, b] = DAYS[2].items; // 10:05 and 11:00 on Thursday 19 November
  const page = await loadAdmin({ now: "2026-11-19T08:00", routes: { "GET /api/admin/items": itemsRoute([b, a, items[0]]) } });
  const ids = [...page.rendered("timeline").querySelectorAll("[data-id]")].map((e) => e.getAttribute("data-id"));
  assert.deepEqual(ids, [a.id, b.id], "only that day's items, in start order");
  page.tap("week", '[data-day="2026-11-20"]');
  await page.flush();
  assert.equal(page.calls.at(-2).url, "/api/admin/items?from=2026-11-20&to=2026-11-20");
});

test("harness: a held route answers when the test says so; netFail and hang behave like a dropped connection", async () => {
  const h = held();
  const page = await loadAdmin({ routes: { "GET /api/admin/calendar": h.route, "GET /api/a": netFail("Load failed"), "GET /api/b": hang() } });
  const fetchOf = (path) => page.context.fetch(path);
  const p = fetchOf("/api/admin/calendar");
  await page.flush();
  assert.equal(h.pending(), 1);
  assert.equal(h.calls[0].path, "/api/admin/calendar");
  h.release({ status: 409, body: { error: "x" } });
  assert.equal((await (await p)).status, 409);
  await assert.rejects(fetchOf("/api/a"), { name: "TypeError", message: "Load failed" });
  let settled = false;
  fetchOf("/api/b").then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
});

test("fixtures: every admin day is on the weekday its label names, and the closed-day cases are re-exported", () => {
  const weekday = (iso) => new Date(iso + "T12:00:00Z").getUTCDay();
  for (const d of DAYS) {
    assert.ok(d.items.every((i) => i.date === d.date), d.label);
    if (/Sunday/.test(d.label)) assert.equal(weekday(d.date), 0, d.label);
    else assert.notEqual(weekday(d.date), 0, d.label);
  }
  assert.ok(Array.isArray(closedDays.CASES) && closedDays.CASES.length > 5);
  assert.equal(new Set(items.map((i) => i.id)).size, items.length, "ids are unique");
});
