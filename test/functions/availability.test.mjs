// Smoke test: GET /api/availability through handle(req, context, deps) with fake Blobs, env and clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet } from "../helpers/deps.mjs";
import { item, seedItems } from "../helpers/bookings.mjs";
import { handle, config } from "../../netlify/functions/availability.mjs";

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
  const res = await read(await handle(request("/api/availability"), {}, d));
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  for (const k of ["today", "nowMinutes", "lastDate", "hours", "slotMin", "leadMin", "maxDays", "durations", "busy", "sms"]) {
    assert.ok(k in res.body, `field ${k}`);
  }
  assert.equal(res.body.today, "2026-11-12");
  assert.equal(res.body.nowMinutes, 600);
  assert.equal(res.body.lastDate, "2027-01-11");
  assert.deepEqual(res.body.busy, { "2026-11-13": [[600, 630]], "2026-12-01": [[720, 750]] });
  assert.equal(res.body.sms, false);
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes("Kari") && !raw.includes("912"), "never names or phone numbers");
  assert.deepEqual(d.blobs.opened, [{ name: "bookings", consistency: "strong" }]);
});

test("availability: sms is true only when Sveve is configured in the injected env", async () => {
  const d = testDeps({ env: { SVEVE_USER: "u", SVEVE_PASSWD: "p" } });
  assert.equal((await read(await handle(request("/api/availability"), {}, d))).body.sms, true);
});

test("availability: a Blobs outage gives 500 JSON, not a crash", async (t) => {
  const out = quiet(t);
  const d = testDeps();
  d.blobs.inject({ method: "GET", fault: "fail-before", status: 500, times: Infinity });
  const res = await read(await handle(request("/api/availability"), {}, d));
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: "Kunne ikke hente ledige tider." });
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(out.error.length, 1);
});
