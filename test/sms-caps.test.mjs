// Per-number SMS cap and the night rule across every kind of customer SMS: audit findings F3 and F16 and owner
// decision (c). Invariants, checked on everything the fake Sveve delivered:
//   - no customer number ever gets more than 3 SMS in any 24 h window, confirmations and reminders together,
//     however many bookings carry that number and whoever made them (F3), and the window never resets at
//     midnight (F16);
//   - no SMS is ever delivered between 21:00 and 08:00 Oslo time; a booking made at night gets its confirmation
//     from 08:00 instead (c).
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION } from "./helpers/deps.mjs";
import { oslo } from "./helpers/clock.mjs";
import { item, seedItems, storedItems, CUSTOMER_PHONE, CUSTOMER_MOBILE, SHOP_MOBILE } from "./helpers/bookings.mjs";
import { osloNow } from "../netlify/lib/booking-core.mjs";
import { quietHours } from "../netlify/lib/sms.mjs";
import { SMS_LIMITS, smsLogKey } from "../netlify/lib/limits.mjs";
import * as bookings from "../netlify/functions/bookings.mjs";
import * as smsReminders from "../netlify/functions/sms-reminders.mjs";

const ENV = { SVEVE_USER: "u", SVEVE_PASSWD: "p" };
const DAY = 24 * 3600e3;
const tick = () => request("/.netlify/functions/sms-reminders", { method: "POST", json: { next_run: "x" } });
let ipSeq = 0;
const book = (d, over = {}) => bookings.handle(
  request("/api/bookings", { method: "POST", json: { service: "Herreklipp", addons: [], name: "Kunde", phone: CUSTOMER_PHONE, ...over } }),
  { ...PRODUCTION, ip: `192.0.2.${++ipSeq % 250}` }, d,
).then(read);
async function runEveryQuarter(d, from, to) {
  for (let ms = from.getTime(); ms <= to.getTime(); ms += 15 * 60e3) {
    if (d.clock.now() < ms) d.clock.set(ms);
    await smsReminders.handle(tick(), PRODUCTION, d);
  }
}
const atNight = (ms) => quietHours(osloNow(new Date(ms)));

test("SMS cap: the limit is 3 SMS per customer number per rolling 24 h", () => {
  assert.deepEqual(SMS_LIMITS.customer.rules, [{ max: 3, windowMs: DAY }]);
});

test("SMS cap: one number on many bookings never gets more than 3 SMS in any 24 h (F3, F16)", async (t) => {
  quiet(t);
  const d = testDeps({ now: oslo("2026-11-19", 10, 0), env: ENV, sveve: true });
  // 16 bookings with the same stranger's number, made in /admin weeks ago, over Friday to Monday
  const admin = [];
  for (const [date, starts] of [["2026-11-20", [600, 660, 720, 780, 840]], ["2026-11-21", [600, 660, 720, 780]], ["2026-11-23", [600, 660, 720, 780, 840, 900, 960]]]) {
    for (const start of starts) admin.push(item({ date, start, source: "admin", phone: "+47 912 34 567", createdAt: "2026-10-01T10:00:00.000Z" }));
  }
  seedItems(d.blobs, admin);
  // and three web bookings with the same number (written differently) on Thursday morning: three confirmations
  for (const [phone, start] of [["912 34 567", 900], ["91234567", 930], ["0047 912 34 567", 960]]) {
    assert.equal((await book(d, { date: "2026-11-19", start, phone })).status, 201);
  }
  await runEveryQuarter(d, oslo("2026-11-19", 10, 15), oslo("2026-11-24", 20, 0));
  const max = d.sveve.maxPerNumber(DAY);
  assert.ok(max.count <= 3, `${max.number} got ${max.count} SMS within 24 h`);
  const toCustomer = d.sveve.to(CUSTOMER_MOBILE);
  assert.ok(toCustomer.length >= 6, `the cap rolls with time (${toCustomer.length} SMS over five days)`);
  // The ones that were held back are marked, never sent later, and never shown as sent in /admin
  const held = storedItems(d.blobs).filter((i) => i.reminderError === "limit");
  assert.ok(held.length > 0);
  for (const i of held) assert.equal(i.reminderSentAt, undefined);
});

test("SMS cap: the 24 h window does not reset at midnight (F16)", async (t) => {
  quiet(t);
  const d = testDeps({ now: oslo("2026-11-19", 10, 0), env: ENV, sveve: true });
  // Booked in /admin on Thursday evening for Friday 10:00: its reminder is due Friday 08:00 (two hours before)
  seedItems(d.blobs, [item({ date: "2026-11-20", start: 600, source: "admin", createdAt: oslo("2026-11-19", 19, 0).toISOString() })]);
  // Thursday 10:00: three same-day web bookings with that number, three confirmations
  for (const start of [840, 870, 900]) assert.equal((await book(d, { date: "2026-11-19", start })).status, 201);
  assert.equal(d.sveve.to(CUSTOMER_MOBILE).length, 3);
  await runEveryQuarter(d, oslo("2026-11-19", 10, 15), oslo("2026-11-20", 9, 45));
  assert.equal(d.sveve.to(CUSTOMER_MOBILE).length, 3, "Friday 08:00 is only 22 h later: the reminder is held back");
});

test("SMS cap: a confirmation and a reminder for the same number at the same moment cannot both take the last seat", async (t) => {
  quiet(t);
  for (let round = 0; round < 5; round++) {
    const d = testDeps({ now: oslo("2026-11-19", 15, 30), env: ENV, sveve: true });
    seedItems(d.blobs, [item({ date: "2026-11-20", start: 900, dur: 30 })]); // reminder due now
    d.blobs.seed("bookings", smsLogKey(CUSTOMER_MOBILE), { hits: [{ t: d.clock.now() - 3600e3, id: "x1", kind: "confirm" }, { t: d.clock.now() - 1800e3, id: "x2", kind: "confirm" }] });
    await Promise.all([
      smsReminders.handle(tick(), PRODUCTION, d),
      book(d, { date: "2026-11-23", start: 600 + 30 * round }),
    ]);
    assert.equal(d.sveve.to(CUSTOMER_MOBILE).length, 1, `round ${round}`);
    assert.equal(d.blobs.json("bookings", smsLogKey(CUSTOMER_MOBILE)).hits.length, 3);
  }
});

test("SMS cap: a lost reply on the SMS log write is not counted twice", async (t) => {
  quiet(t);
  const d = testDeps({ now: oslo("2026-11-19", 10, 0), env: ENV, sveve: true });
  // In the reminder run: the client retries after 5 s, gets 412, and the run finds its own entry
  seedItems(d.blobs, [item({ date: "2026-11-20", start: 600 })]); // 24 h before: due now
  d.blobs.inject({ method: "PUT", key: smsLogKey(CUSTOMER_MOBILE), fault: "lost-response" });
  await smsReminders.handle(tick(), PRODUCTION, d);
  assert.equal(d.sveve.to(CUSTOMER_MOBILE).length, 1);
  assert.equal(d.blobs.json("bookings", smsLogKey(CUSTOMER_MOBILE)).hits.length, 1);
  // While the customer waits: the 5 s retry passes the 3 s deadline, so the seat is given back and the
  // confirmation goes out with the next run, counted once
  d.blobs.inject({ method: "PUT", key: smsLogKey("91300000"), fault: "lost-response" });
  assert.equal((await book(d, { date: "2026-11-25", start: 600, phone: "913 00 000" })).body.sms, "later");
  assert.equal(d.blobs.json("bookings", smsLogKey("91300000")).hits.length, 0);
  d.clock.set(oslo("2026-11-19", 10, 15));
  await smsReminders.handle(tick(), PRODUCTION, d);
  assert.equal(d.sveve.to("91300000").length, 1);
  assert.equal(d.blobs.json("bookings", smsLogKey("91300000")).hits.length, 1);
});

test("night rule: no SMS between 21:00 and 08:00; a night booking is confirmed from 08:00 (c)", async (t) => {
  quiet(t);
  const d = testDeps({ now: oslo("2026-11-19", 23, 10), env: ENV, sveve: true });
  // Thursday 23:10: one booking for Friday 10:00, one for Monday
  const a = await book(d, { date: "2026-11-20", start: 600 });
  const b = await book(d, { date: "2026-11-23", start: 600, phone: "913 00 000" });
  assert.deepEqual([a.status, a.body.sms, b.body.sms], [201, "later", "later"], "the page promises no SMS now");
  assert.equal(d.sveve.calls.length, 0);
  await runEveryQuarter(d, oslo("2026-11-19", 23, 15), oslo("2026-11-20", 12, 0));
  assert.deepEqual(d.sveve.sent.filter((s) => s.to !== SHOP_MOBILE).map((s) => [s.to, s.at]), [
    [CUSTOMER_MOBILE, oslo("2026-11-20", 8, 0).getTime()],
    ["91300000", oslo("2026-11-20", 8, 0).getTime()],
  ], "both confirmations at 08:00, and no extra 2 h reminder right after the confirmation");
  assert.match(d.sveve.to(CUSTOMER_MOBILE)[0].msg, /^Timen din .* i dag kl\. 10:00/);
  assert.deepEqual(d.sveve.to(SHOP_MOBILE).map((s) => s.at), [oslo("2026-11-20", 8, 0).getTime(), oslo("2026-11-20", 8, 0).getTime()], "the barber's notices too");
  assert.ok(storedItems(d.blobs).every((i) => i.confirmSentAt));
});

test("night rule: whatever the timing, no SMS reaches a phone at night (c)", async (t) => {
  quiet(t);
  // Bookings and runs around 21:00 and 08:00, with slow store writes and a slow Sveve
  for (const [h, m] of [[20, 50], [20, 55], [20, 58], [20, 59], [7, 45], [7, 59]]) {
    for (const latencyMs of [0, 1500, 4000]) {
      const day = h < 12 ? "2026-11-20" : "2026-11-19";
      const d = testDeps({ now: oslo(day, h, m), env: ENV, sveve: { latencyMs } });
      // an admin booking whose 24 h reminder window opens right before 21:00 or right before 08:00
      const due = h < 12 ? { date: "2026-11-21", start: 8 * 60 + 10 } : { date: "2026-11-20", start: 20 * 60 + 45 };
      seedItems(d.blobs, [item({ ...due, dur: 15, source: "admin", phone: "915 55 555" })]);
      d.blobs.inject({ method: "PUT", latencyMs: 1000, times: Infinity });
      await book(d, { date: "2026-11-23", start: 600 });
      await runEveryQuarter(d, oslo(day, h, m), new Date(oslo(day, h, m).getTime() + 15 * 3600e3));
      for (const s of d.sveve.sent) assert.equal(atNight(s.at), false, `delivered at night: ${new Date(s.at).toISOString()} (${h}:${m}, ${latencyMs} ms)`);
      assert.ok(d.sveve.to(CUSTOMER_MOBILE).length >= 1, "the confirmation still goes out in the morning");
    }
  }
});

test("a confirmation that Sveve certainly refused is sent by the next run (F37 for confirmations)", async (t) => {
  quiet(t);
  const d = testDeps({ now: oslo("2026-11-19", 10, 0), env: ENV, sveve: true });
  d.sveve.inject({ fault: "fatal", message: "Ikke nok SMS-kreditt", match: (c) => c.body.to === CUSTOMER_MOBILE });
  const r = await book(d, { date: "2026-11-25", start: 600 });
  assert.deepEqual([r.status, r.body.sms], [201, "failed"]);
  await runEveryQuarter(d, oslo("2026-11-19", 10, 15), oslo("2026-11-19", 11, 0));
  assert.equal(d.sveve.to(CUSTOMER_MOBILE).length, 1);
  assert.equal(d.sveve.to(CUSTOMER_MOBILE)[0].at, oslo("2026-11-19", 10, 15).getTime());
  assert.ok(storedItems(d.blobs)[0].confirmSentAt);
});
