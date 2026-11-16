// Smoke test: GET /api/availability through handle(req, context, deps) with fake Blobs, env and clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { item, seedItems } from "../helpers/bookings.mjs";
import { handle, config } from "../../netlify/functions/availability.mjs";
import { CONFIG, closedDays, SERVICE_ALIASES } from "../../netlify/lib/booking-core.mjs";
import * as closedFixture from "../fixtures/closed-days.mjs";

test("availability: path is unchanged", () => {
  assert.deepEqual(config, { path: "/api/availability" });
});

test("availability: answers with the schedule from the injected clock and busy ranges from the store", async () => {
  const d = testDeps({ now: "2026-11-12T09:00:00Z" }); // 10:00 in Oslo
  seedItems(d.blobs, [
    item({ date: "2026-11-13", start: 600, dur: 30, name: "Kari Hemmelig", phone: "912 34 567" }),
    item({ date: "2026-11-13", start: 660, dur: 60, status: "cancelled" }),
    item({ date: "2026-12-01", start: 720, dur: 30, type: "block" }),
  ]);
  const res = await read(await handle(request("/api/availability"), PRODUCTION, d));
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual(Object.keys(res.body).sort(), ["busy", "closed", "durations", "hours", "lastDate", "leadMin", "maxDays", "nowMinutes", "slotMin", "today"]);
  assert.equal(res.body.today, "2026-11-12");
  assert.equal(res.body.nowMinutes, 600);
  assert.equal(res.body.lastDate, "2027-01-11");
  assert.deepEqual(res.body.busy, { "2026-11-13": [[600, 630]], "2026-12-01": [[720, 750]] });
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes("Kari") && !raw.includes("912"), "never names or phone numbers");
  assert.deepEqual(d.blobs.opened, [{ name: "bookings", consistency: "strong" }]);
});

test("availability: a Blobs outage gives 500 JSON, not a crash", async (t) => {
  const out = quiet(t);
  const d = testDeps();
  d.blobs.inject({ method: "GET", fault: "fail-before", status: 500, times: Infinity });
  const res = await read(await handle(request("/api/availability"), PRODUCTION, d));
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: "Kunne ikke hente ledige tider." });
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(out.error.length, 1);
});

// Owner decision D4 (F7, F56): a day the barber blocked completely is closed. Cases: test/fixtures/closed-days.mjs.
for (const c of closedFixture.CASES) {
  test(`availability: closedDays: ${c.label} → ${c.closed ? "closed" : "not closed"}`, () => {
    assert.deepEqual(closedDays(c.items), c.closed ? [c.date] : []);
  });
}

test("availability: /api/availability lists exactly the fully blocked days in closed, sorted, and still shows them as busy", async () => {
  const d = testDeps({ now: "2026-11-12T09:00:00Z" });
  assert.equal(closedFixture.TODAY, "2026-11-12");
  seedItems(d.blobs, closedFixture.items);
  const res = await read(await handle(request("/api/availability"), PRODUCTION, d));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.closed, closedFixture.closed);
  assert.deepEqual(res.body.closed, ["2026-12-19", "2026-12-21", "2026-12-22", "2026-12-23", "2026-12-24"]);
  assert.ok(res.body.busy["2026-12-24"].length > 0, "busy is unchanged, so an old page still sees the day as taken");
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes("Stengt") && !raw.includes("Kunde"), "no notes or names");
});

test("availability: closed covers only today to lastDate, and is [] with nothing blocked", async () => {
  const d = testDeps({ now: "2026-11-12T09:00:00Z" });
  seedItems(d.blobs, [
    item({ date: "2026-11-11", start: 600, dur: 480, type: "block" }), // yesterday
    item({ date: "2027-01-12", start: 600, dur: 480, type: "block" }), // after lastDate 2027-01-11
  ]);
  assert.deepEqual((await read(await handle(request("/api/availability"), PRODUCTION, d))).body.closed, []);
});

test("availability: durations also list every old service name with its new service's duration (F24)", async () => {
  const d = testDeps({ now: "2026-11-12T09:00:00Z" });
  const { durations } = (await read(await handle(request("/api/availability"), PRODUCTION, d))).body;
  assert.equal(durations["Herreklipp + skjeggtrim (maskin)"], durations["Herreklipp + skjeggtrim"]);
  for (const [old, now] of Object.entries(SERVICE_ALIASES)) assert.equal(durations[old], CONFIG.durations[now], old);
  for (const [name, min] of Object.entries(CONFIG.durations)) assert.equal(durations[name], min, name);
  assert.deepEqual(Object.keys(durations).sort(), [...Object.keys(CONFIG.durations), ...Object.keys(SERVICE_ALIASES)].sort());
});
