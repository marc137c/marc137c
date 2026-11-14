// The reminder run (netlify/lib/reminders.mjs through the scheduled sms-reminders handler) under faults:
// audit findings F37, F38, F39 and F42. Invariants:
//   - a reminder is never sent twice, and never shown as sent ("SMS-påminnelse sendt" in /admin = remindedAt
//     without reminderError) unless Sveve confirmed it (F38, F39);
//   - when Sveve certainly did not send it, a later run tries again; when it may have sent it, never (F37);
//   - no Sveve call starts after the 20 s send deadline, measured on deps.now() (F39);
//   - a SVEVE_TEST dry run never uses up the real reminder (F42).
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, quiet, PRODUCTION } from "./helpers/deps.mjs";
import { oslo } from "./helpers/clock.mjs";
import { item, seedItems, storedItems } from "./helpers/bookings.mjs";
import { handle } from "../netlify/functions/sms-reminders.mjs";
import { MAX_FAILS, SEND_DEADLINE_MS } from "../netlify/lib/reminders.mjs";

const ENV = { SVEVE_USER: "u", SVEVE_PASSWD: "p" };
const tick = () => request("/.netlify/functions/sms-reminders", { method: "POST", json: { next_run: "x" } });
// Friday 20 Nov 15:00, booked weeks ahead: the 24 h window is Thu 19 Nov 15:00–15:59, the 2 h window Fri 13:00–13:59
const booking = (over = {}) => item({ date: "2026-11-20", start: 900, dur: 30, ...over });
const shownAsSent = (i) => Boolean(i.remindedAt) && !i.reminderError; // admin.js: «SMS-påminnelse sendt»

// Runs the scheduled function at every quarter hour from `from` to `to` (Oslo times as Dates), like Netlify does
async function runEveryQuarter(d, from, to) {
  for (let ms = from.getTime(); ms <= to.getTime(); ms += 15 * 60e3) {
    if (d.clock.now() < ms) d.clock.set(ms);
    await handle(tick(), PRODUCTION, d);
  }
}
const one = (d) => storedItems(d.blobs)[0];

test("reminders: a lost reply on the claim write still sends the reminder exactly once (F38)", async (t) => {
  quiet(t);
  const variants = {
    "reply lost, retry gets 412": (d) => d.blobs.inject({ method: "PUT", fault: "lost-response", match: (req) => req.json().items.some((i) => i.remindedAt) }),
    "write stored, then 502 on every retry": (d) => d.blobs.inject({ method: "PUT", fault: "fail-after", status: 502, times: 6 }),
  };
  for (const [name, inject] of Object.entries(variants)) {
    const d = testDeps({ now: oslo("2026-11-19", 15, 0), env: ENV, sveve: true });
    seedItems(d.blobs, [booking()]);
    inject(d);
    await runEveryQuarter(d, oslo("2026-11-19", 15, 0), oslo("2026-11-20", 14, 0));
    assert.equal(d.sveve.sent.length, 1, name);
    const b = one(d);
    assert.ok(b.reminderSentAt, name);
    assert.equal(b.reminderError, undefined, name);
  }
});

test("reminders: two runs at the same time with lost replies still send once", async (t) => {
  quiet(t);
  const d = testDeps({ now: oslo("2026-11-19", 15, 0), env: ENV, sveve: true });
  seedItems(d.blobs, [booking()]);
  d.blobs.inject({ method: "PUT", fault: "lost-response", times: 2 });
  await Promise.all([handle(tick(), PRODUCTION, d), handle(tick(), PRODUCTION, d), handle(tick(), PRODUCTION, d)]);
  await runEveryQuarter(d, oslo("2026-11-19", 15, 15), oslo("2026-11-20", 14, 0));
  assert.equal(d.sveve.sent.length, 1);
  assert.ok(one(d).reminderSentAt);
});

test("reminders: when Sveve certainly did not send it, the next run tries again (F37)", async (t) => {
  quiet(t);
  for (const fault of [{ fault: "fatal", message: "Ikke nok SMS-kreditt" }, { fault: "http", status: 503 }, { fault: "network-down" }, { fault: "rejected" }]) {
    const d = testDeps({ now: oslo("2026-11-19", 15, 0), env: ENV, sveve: true });
    seedItems(d.blobs, [booking()]);
    d.sveve.inject(fault);
    await handle(tick(), PRODUCTION, d);
    let b = one(d);
    assert.equal(d.sveve.sent.length, 0);
    assert.equal(b.remindedAt, undefined, `${fault.fault}: the claim is given back`);
    assert.ok(b.reminderError && b.reminderError !== "sending", fault.fault);
    assert.equal(shownAsSent(b), false);
    await runEveryQuarter(d, oslo("2026-11-19", 15, 15), oslo("2026-11-20", 14, 0));
    b = one(d);
    assert.equal(d.sveve.sent.length, 1, `${fault.fault}: sent by the next run`);
    assert.equal(d.sveve.calls.length, 2);
    assert.ok(b.reminderSentAt && shownAsSent(b));
    assert.equal(b.reminderFails, 1);
  }
});

test("reminders: when Sveve may have sent it (timeout, lost reply), it is never sent again (F37)", async (t) => {
  quiet(t);
  for (const fault of [{ fault: "timeout", sent: true }, { fault: "timeout", sent: false }, { fault: "lost-response" }]) {
    const d = testDeps({ now: oslo("2026-11-19", 15, 0), env: ENV, sveve: true });
    seedItems(d.blobs, [booking()]);
    d.sveve.inject(fault);
    await runEveryQuarter(d, oslo("2026-11-19", 15, 0), oslo("2026-11-20", 14, 45));
    assert.equal(d.sveve.calls.length, 1, JSON.stringify(fault));
    assert.ok(d.sveve.sent.length <= 1);
    const b = one(d);
    assert.ok(b.remindedAt && b.reminderError, "kept as 'feilet' in /admin, never 'sendt'");
    assert.equal(b.reminderSentAt, undefined);
  }
});

test("reminders: a 24 h reminder that kept failing is sent in the 2 h window; retries stop after MAX_FAILS (F37)", async (t) => {
  quiet(t);
  let d = testDeps({ now: oslo("2026-11-19", 15, 0), env: ENV, sveve: true });
  seedItems(d.blobs, [booking()]);
  const down = d.sveve.inject({ fault: "http", status: 503, times: Infinity });
  await runEveryQuarter(d, oslo("2026-11-19", 15, 0), oslo("2026-11-19", 16, 0));
  assert.equal(down.hits, 4, "four runs in the 24 h window");
  d.sveve.clearFaults();
  await runEveryQuarter(d, oslo("2026-11-19", 16, 15), oslo("2026-11-20", 14, 45));
  assert.equal(d.sveve.sent.length, 1);
  assert.equal(d.sveve.sent[0].at, oslo("2026-11-20", 13, 0).getTime(), "two hours before");

  d = testDeps({ now: oslo("2026-11-19", 15, 0), env: ENV, sveve: true });
  seedItems(d.blobs, [booking()]);
  d.sveve.inject({ fault: "fatal", times: Infinity });
  await runEveryQuarter(d, oslo("2026-11-19", 15, 0), oslo("2026-11-20", 14, 45));
  assert.equal(d.sveve.calls.length, MAX_FAILS);
  assert.equal(d.sveve.sent.length, 0);
  assert.equal(one(d).reminderFails, MAX_FAILS);
});

test("reminders: whatever the store and Sveve latency, no Sveve call starts after the send deadline and nothing is shown as sent unless it was (F39)", async (t) => {
  quiet(t);
  const phones = ["912 00 001", "912 00 002", "912 00 003", "912 00 004"];
  const mobileOf = (b) => b.phone.replace(/\D/g, "");
  let deferredSeen = 0;
  for (const putMs of [0, 3000, 7000, 9500, 12000, 19000, 25000]) {
    for (const sveve of [{}, { latencyMs: 7500 }, { fault: "timeout", sent: true }]) {
      // Thursday 15:45: all four bookings (Friday 15:00, 15:15, 15:30, 15:45) are inside their 24 h window
      const d = testDeps({ now: oslo("2026-11-19", 15, 45), env: ENV, sveve: true });
      seedItems(d.blobs, phones.map((phone, i) => booking({ start: 900 + 15 * i, dur: 15, phone })));
      if (putMs) d.blobs.inject({ method: "PUT", latencyMs: putMs, times: Infinity });
      if (sveve.fault || sveve.latencyMs) d.sveve.inject({ ...sveve, times: Infinity });
      const t0 = d.clock.now();
      await handle(tick(), PRODUCTION, d);
      const where = JSON.stringify({ putMs, sveve });
      for (const c of d.sveve.calls) assert.ok(c.at - t0 <= SEND_DEADLINE_MS, `Sveve called at ${c.at - t0} ms: ${where}`);
      const attempted = new Set(d.sveve.calls.map((c) => c.body.to));
      for (const b of storedItems(d.blobs)) {
        if (shownAsSent(b) || b.reminderSentAt) assert.ok(d.sveve.sent.some((s) => s.to === mobileOf(b)), `shown as sent, never delivered: ${where}`);
        if (b.remindedAt) assert.ok(attempted.has(mobileOf(b)), `marked without an attempt: ${where}`);
        else assert.ok(!b.reminderError || b.reminderError !== "sending", where);
      }
      // Whatever was not attempted is picked up by the next quarter-hour run, and nothing is sent twice
      d.blobs.clearFaults();
      d.sveve.clearFaults();
      const notAttempted = phones.map((p) => p.replace(/\D/g, "")).filter((m) => !attempted.has(m));
      deferredSeen += notAttempted.length;
      d.clock.set(Math.max(d.clock.now(), oslo("2026-11-19", 15, 59).getTime()));
      await handle(tick(), PRODUCTION, d);
      for (const m of notAttempted) assert.equal(d.sveve.to(m).length, 1, `deferred reminder lost: ${where}`);
      for (const m of attempted) assert.equal(d.sveve.calls.filter((c) => c.body.to === m).length, 1, `attempted twice: ${where}`);
    }
  }
  assert.ok(deferredSeen > 0, "some schedules really did defer");
});

test("reminders: a SVEVE_TEST dry run never uses up the real reminder (F42)", async (t) => {
  quiet(t);
  const d = testDeps({ now: oslo("2026-11-19", 15, 0), env: { ...ENV, SVEVE_TEST: "true" }, sveve: true });
  seedItems(d.blobs, [booking()]);
  await runEveryQuarter(d, oslo("2026-11-19", 15, 0), oslo("2026-11-19", 15, 30));
  assert.equal(d.sveve.dryRuns.length, 1, "one dry run, not one per quarter hour");
  assert.equal(d.sveve.sent.length, 0);
  let b = one(d);
  assert.equal(b.remindedAt, undefined, "/admin does not show it as sent");
  assert.ok(b.reminderTestAt);
  d.env.SVEVE_TEST = undefined; // the owner turns test mode off: the real reminder still goes out
  await runEveryQuarter(d, oslo("2026-11-19", 15, 45), oslo("2026-11-20", 14, 0));
  assert.equal(d.sveve.sent.length, 1);
  b = one(d);
  assert.ok(b.reminderSentAt && shownAsSent(b));
});
