// Smoke test: the scheduled sms-reminders function through handle(req, context, deps) with fake Blobs, env,
// clock and Sveve. The time budget, the store's latency and the Sveve ledger all run on the one virtual clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, quiet } from "../helpers/deps.mjs";
import { oslo } from "../helpers/clock.mjs";
import { item, seedItems, storedItems, CUSTOMER_MOBILE } from "../helpers/bookings.mjs";
import { handle, config } from "../../netlify/functions/sms-reminders.mjs";

const SVEVE_ENV = { SVEVE_USER: "u", SVEVE_PASSWD: "p" };
// Netlify calls a scheduled function with a POST whose body says when the next run is
const tick = () => request("/.netlify/functions/sms-reminders", { method: "POST", json: { next_run: "2026-11-19T13:45:00.000Z" } });
// Thursday 19 Nov 14:30 in Oslo: bookings on Friday 20 Nov between 13:50 and 14:30 are in the 24 h window
const NOW = oslo("2026-11-19", 14, 30);
const due = (start, over = {}) => item({ date: "2026-11-20", start, dur: 15, ...over });

test("sms-reminders: schedule is unchanged", () => {
  assert.deepEqual(config, { schedule: "*/15 * * * *" });
});

test("sms-reminders: sends a due reminder through deps.fetch and marks it on the injected store and clock", async (t) => {
  const out = quiet(t);
  const d = testDeps({ now: NOW, env: SVEVE_ENV, sveve: true });
  const [b] = seedItems(d.blobs, [due(840), item({ date: "2026-11-25", start: 600 })]);
  assert.equal(await handle(tick(), {}, d), undefined);
  assert.equal(d.sveve.sent.length, 1);
  assert.equal(d.sveve.sent[0].to, CUSTOMER_MOBILE);
  assert.match(d.sveve.sent[0].msg, /i morgen kl\. 14:00/);
  const stored = storedItems(d.blobs).find((i) => i.id === b.id);
  assert.equal(stored.remindedAt, NOW.toISOString());
  assert.deepEqual(d.blobs.opened, [{ name: "bookings", consistency: "strong" }]);
  assert.ok(d.blobs.requests().every((r) => r.consistency === "strong"));
  assert.deepEqual(out.log, [["SMS-påminnelser:", { sent: 1, failed: 0 }]]);
});

test("sms-reminders: without Sveve configured nothing is read, written or sent", async (t) => {
  const out = quiet(t);
  const d = testDeps({ now: NOW, env: {}, sveve: true });
  seedItems(d.blobs, [due(840)]);
  await handle(tick(), {}, d);
  assert.equal(d.blobs.log.length, 0);
  assert.equal(d.sveve.calls.length, 0);
  assert.deepEqual(out.log, []);
});

test("sms-reminders: a Blobs outage is logged and never thrown (the client's retries run on the virtual clock)", async (t) => {
  const out = quiet(t);
  const d = testDeps({ now: NOW, env: SVEVE_ENV, sveve: true });
  seedItems(d.blobs, [due(840)]);
  d.blobs.inject({ method: "GET", fault: "fail-before", status: 500, times: Infinity });
  const t0 = d.clock.now();
  await handle(tick(), {}, d);
  assert.equal(d.clock.now() - t0, 5 * 5000, "6 attempts, 5 s apart");
  assert.equal(d.sveve.calls.length, 0);
  assert.equal(out.error.length, 1);
  assert.equal(out.error[0][1].name, "BlobsInternalError");
});

test("sms-reminders: the 20 s budget is measured on deps.now(), so slow store writes defer the rest", async (t) => {
  const out = quiet(t);
  const d = testDeps({ now: NOW, env: SVEVE_ENV, sveve: true });
  const items = seedItems(d.blobs, [due(830), due(845), due(860)]);
  d.blobs.inject({ method: "PUT", latencyMs: 12000, times: Infinity }); // every claim write takes 12 s
  await handle(tick(), {}, d);
  // claim 1 at 0 s, claim 2 at 12 s, item 3 at 24 s > 20 s: deferred, unmarked, picked up by the next run
  assert.equal(d.sveve.sent.length, 2);
  const stored = storedItems(d.blobs);
  assert.deepEqual(items.map((i) => Boolean(stored.find((s) => s.id === i.id).remindedAt)), [true, true, false]);
  assert.deepEqual(out.log, [["SMS-påminnelser:", { sent: 2, failed: 0, deferred: 1 }]]);
});
