// Port of tools/test-sms.mjs (sections 1–6) to node:test, on the shared fake Blobs store and a fake Sveve.
// netlify/lib/sms.mjs (numbers, texts, sendSms, cap, timing rule) and netlify/lib/reminders.mjs (runner).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FakeBlobs } from "./helpers/fake-blobs.mjs";
import { fakeFetch, sveveReply } from "./helpers/fake-fetch.mjs";
import * as core from "../netlify/lib/booking-core.mjs";
import * as sms from "../netlify/lib/sms.mjs";
import { runReminders } from "../netlify/lib/reminders.mjs";

const ENV = { SVEVE_USER: "u", SVEVE_PASSWD: "p" };
const SVEVE = "https://sveve.no/SMS/SendMessage";

describe("SMS (port of tools/test-sms.mjs)", () => {
  // One store and one fake Sveve for the whole file, like the original script.
  const blobs = new FakeBlobs();
  const store = blobs.getStore({ name: "bookings", consistency: "strong" });
  let mode = "ok";
  const fetchFn = fakeFetch([[SVEVE, () => sveveReply(mode)]]);
  const calls = fetchFn.calls;
  const sent = () => calls.map((c) => ({ url: c.url, body: c.json(), headers: c.headers }));

  test("1 phone numbers: only Norwegian mobiles", () => {
    assert.equal(sms.norwegianMobile("409 63 911"), "40963911");
    assert.equal(sms.norwegianMobile("+47 409-63-911"), "40963911");
    assert.equal(sms.norwegianMobile("0047 40963911"), "40963911");
    assert.equal(sms.norwegianMobile("47 12 34 56"), "47123456");
    assert.equal(sms.norwegianMobile("22 33 44 55"), null);        // landline
    assert.equal(sms.norwegianMobile("+46 70 123 45 67"), null);   // Swedish
    assert.equal(sms.norwegianMobile("+882 1234 5678"), null);     // premium/intl
  });

  test("2 texts: trusted content only, GSM-7, one SMS unit for the longest service", (t) => {
    const longest = { date: "2026-11-12", start: 870, service: "Herreklipp + skjeggtrim (maskin)", name: "IGNORE http://evil.example" };
    const c = sms.confirmText(longest, "2026-11-10");
    const r = sms.reminderText(longest, "2026-11-11");
    const rWeekday = sms.reminderText({ ...longest, date: "2026-11-11" }, "2026-11-01"); // longest form: «onsdag 11.11. kl. …»
    assert.ok(rWeekday.length <= 160, `reminder with weekday is one unit (${rWeekday.length})`);
    assert.ok(!c.includes("evil") && !r.includes("evil"), "customer name must never be in the SMS");
    assert.match(c, /torsdag 12\.11\. kl\. 14:30/);
    assert.match(r, /i morgen kl\. 14:30/);
    assert.match(sms.confirmText({ ...longest, date: "2026-11-10" }, "2026-11-10"), /i dag kl\. 14:30/);
    const GSM = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà]*$/;
    for (const text of [c, r]) {
      assert.ok(GSM.test(text), "GSM-7 only: " + text);
      assert.ok(text.length <= 160, `one SMS unit (${text.length}): ${text}`);
    }
    t.diagnostic(`${c.length} / ${r.length} chars: ${c} | ${r}`);
  });

  test("3 sendSms: request shape, test flag, sender, errors", async () => {
    let s = await sms.sendSms({}, "40963911", "x", fetchFn);
    assert.deepEqual([s.ok, s.skipped], [false, true]);
    assert.equal(calls.length, 0);
    s = await sms.sendSms(ENV, "22334455", "x", fetchFn);
    assert.equal(s.error, "not_norwegian_mobile");
    assert.equal(calls.length, 0);
    s = await sms.sendSms({ ...ENV, SVEVE_TEST: "true", SVEVE_FROM: "Viggo's Bårbershop!!" }, "+47 409 63 911", "Hei", fetchFn);
    assert.ok(s.ok);
    const last = sent().at(-1);
    assert.equal(last.url, SVEVE);
    assert.deepEqual(last.body, { user: "u", passwd: "p", to: "40963911", msg: "Hei", from: "Viggos Brbe", f: "json", test: true });
    assert.match(last.headers["Content-Type"], /UTF-8/i);
    mode = "fatal";
    s = await sms.sendSms(ENV, "40963911", "x", fetchFn);
    assert.equal(s.ok, false);
    assert.match(s.error, /passord/);
    mode = "500";
    s = await sms.sendSms(ENV, "40963911", "x", fetchFn);
    assert.equal(s.error, "http_500");
    s = await sms.sendSms(ENV, "40963911", "x", async () => { throw new TypeError("fetch failed"); });
    assert.equal(s.error, "network");
    mode = "ok";
  });

  // Section 4–5 share bookings in the store, like the original script.
  const now = new Date("2026-11-10T16:00:00Z"); // 17:00 in Oslo
  const mk = async (date, start, extra = {}) => {
    const v = { date, start, dur: 30, service: "Herreklipp", name: "Ola", phone: "409 63 911", type: "booking", ...extra };
    return (await core.createItem(store, v, { source: "nettside", now: new Date("2026-11-09T10:00:00Z") })).item;
  };
  // Stand-in rule (the real rule is reminderDue, section 6)
  const standIn = (it, o) => it.type === "booking" && it.status !== "cancelled" && !it.remindedAt &&
    !!sms.norwegianMobile(it.phone) && sms.minutesUntil(it, o) > 0 && sms.minutesUntil(it, o) <= 24 * 60;

  test("4 reminder runner: once, concurrent-safe, moved = new reminder, errors stored", async () => {
    const tomorrow = await mk("2026-11-11", 600);
    const cancelled = await mk("2026-11-11", 660);
    await core.updateItem(store, cancelled.id, { status: "cancelled" });
    const landline = await mk("2026-11-11", 720, { phone: "22334455" });
    const block = await mk("2026-11-11", 780, { type: "block", phone: "" });
    calls.length = 0;
    let res = await runReminders(store, ENV, { now, due: standIn, fetchFn });
    assert.deepEqual(res, { sent: 1, failed: 0 });
    assert.equal(calls.length, 1);
    assert.match(calls[0].json().msg, /^Påminnelse: .* i morgen kl\. 10:00/);
    assert.ok((await core.findItem(store, tomorrow.id)).remindedAt, "marked as reminded");
    res = await runReminders(store, ENV, { now, due: standIn, fetchFn });
    assert.deepEqual(res, { sent: 0, failed: 0 }, "never twice");
    assert.equal(calls.length, 1);
    // Two runs at the same time: still one SMS
    const t2 = await mk("2026-11-11", 900);
    calls.length = 0;
    await Promise.all([runReminders(store, ENV, { now, due: standIn, fetchFn }), runReminders(store, ENV, { now, due: standIn, fetchFn })]);
    assert.equal(calls.length, 1, "concurrent runs send once");
    // Moving a booking clears remindedAt, so the new time gets a reminder
    await core.updateItem(store, t2.id, { start: 960 });
    assert.equal((await core.findItem(store, t2.id)).remindedAt, undefined);
    // A failed send is recorded on the booking. (tools/test-sms.mjs also asserted that the failed booking keeps
    // remindedAt, i.e. is never retried. That is audit finding F37, so it is not asserted here.)
    const t3 = await mk("2026-11-11", 1020);
    mode = "fatal";
    calls.length = 0;
    res = await runReminders(store, ENV, { now, due: standIn, fetchFn });
    mode = "ok";
    assert.equal(res.sent, 0);
    assert.ok((await core.findItem(store, t3.id)).reminderError, "error recorded");
    // Not configured: nothing happens
    assert.deepEqual(await runReminders(store, {}, { now, due: standIn, fetchFn }), { sent: 0, failed: 0, skipped: "not_configured" });
    for (const x of [cancelled, landline, block]) assert.equal((await core.findItem(store, x.id)).remindedAt, undefined);
  });

  test("5 per-number confirmation cap and the reminder time budget", async (t) => {
    const nowMs = Date.parse("2026-11-10T16:00:00Z");
    const b = (phone, hoursAgo, type = "booking") => ({ type, phone, createdAt: new Date(nowMs - hoursAgo * 3600e3).toISOString() });
    const items = [b("409 63 911", 1), b("+47 40963911", 2), b("40963911", 3), b("40963911", 30), b("99999999", 1), b("40963911", 1, "block")];
    assert.equal(sms.confirmationAllowed(items, "40963911", nowMs), true, "3 in 24 h (incl. the new one) is still allowed");
    assert.equal(sms.confirmationAllowed([...items, b("0047 409 63 911", 0)], "40963911", nowMs), false, "the 4th in 24 h is not");
    assert.equal(sms.confirmationAllowed(items, "22334455", nowMs), false, "landline never");
    // Budget: with a clock that jumps 15 s per call, only the first due booking is sent, the rest deferred
    for (const st of [660, 690, 720]) await mk("2026-11-12", st);
    let ms = 0;
    const clock = () => (ms += 15000);
    calls.length = 0;
    const due2 = (it, o, x) => standIn(it, o, x) || (it.type === "booking" && !it.remindedAt && it.status !== "cancelled" && it.date === "2026-11-12");
    const res2 = await runReminders(store, ENV, { now, due: due2, fetchFn, budgetMs: 20000, clock });
    assert.ok(res2.deferred >= 1 && calls.length === res2.sent, `deferred ones are not marked or sent (${JSON.stringify(res2)})`);
    const unmarked = (await core.readMonths(store, "2026-11-12", "2026-11-12")).filter((i) => !i.remindedAt).length;
    assert.equal(unmarked, res2.deferred, "deferred bookings keep no remindedAt, so the next run picks them up");
    t.diagnostic(JSON.stringify(res2));
  });

  test("6 reminder timing rule: 24 h before, or 2 h before for late bookings; never at night", () => {
    const at = (date, hh, mm = 0) => ({ date, minutes: hh * 60 + mm }); // Oslo "now"
    const ms = (iso) => Date.parse(iso);
    const bk = (date, start, createdIso, extra = {}) => ({ type: "booking", status: "confirmed", phone: "40963911", date, start, createdAt: createdIso, ...extra });
    const due = (item, o, nowIso) => sms.reminderDue(item, o, ms(nowIso));
    const b1 = bk("2026-11-20", 14 * 60, "2026-11-01T10:00:00Z"); // booked weeks ahead, 14:00
    assert.equal(due(b1, at("2026-11-19", 14, 30), "2026-11-19T13:30:00Z"), true, "23.5 h before → yes");
    assert.equal(due(b1, at("2026-11-19", 14, 0), "2026-11-19T13:00:00Z"), true, "exactly 24 h before → yes");
    assert.equal(due(b1, at("2026-11-19", 13, 45), "2026-11-19T12:45:00Z"), false, "24.25 h before → not yet");
    assert.equal(due(b1, at("2026-11-19", 15, 15), "2026-11-19T14:15:00Z"), false, "22.75 h before → window passed");
    assert.equal(due({ ...b1, remindedAt: "x" }, at("2026-11-19", 14, 30), "2026-11-19T13:30:00Z"), false, "never twice");
    assert.equal(due({ ...b1, status: "cancelled" }, at("2026-11-19", 14, 30), "2026-11-19T13:30:00Z"), false, "cancelled → no");
    assert.equal(due({ ...b1, phone: "22334455" }, at("2026-11-19", 14, 30), "2026-11-19T13:30:00Z"), false, "landline → no");
    assert.equal(due({ ...b1, type: "block" }, at("2026-11-19", 14, 30), "2026-11-19T13:30:00Z"), false, "block → no");
    // Booked 23.5 h ahead: no reminder right after the confirmation, but one 2 h before
    const b2 = bk("2026-11-20", 14 * 60, "2026-11-19T14:00:00Z");
    assert.equal(due(b2, at("2026-11-19", 14, 45), "2026-11-19T13:45:00Z"), false, "15 min after booking → no");
    assert.equal(due(b2, at("2026-11-20", 12, 30), "2026-11-20T11:30:00Z"), true, "late booking → 1.5 h before → yes");
    // Booked this morning for this afternoon: no reminder at all
    const b3 = bk("2026-11-20", 15 * 60, "2026-11-20T08:00:00Z");
    assert.equal(due(b3, at("2026-11-20", 13, 0), "2026-11-20T12:00:00Z"), false, "fresh same-day booking → no");
    assert.equal(due(b3, at("2026-11-20", 13, 30), "2026-11-20T12:30:00Z"), false, "fresh same-day booking → no");
    // Never at night: an admin booking at 07:30 would want a reminder at 05:30 → no
    const b4 = bk("2026-11-20", 7 * 60 + 30, "2026-11-01T10:00:00Z");
    assert.equal(due(b4, at("2026-11-20", 6, 0), "2026-11-20T05:00:00Z"), false, "night → no");
    // Every 15-min run inside the 24 h window says yes (so one missed run never loses the reminder)
    const hits = [0, 15, 30, 45].filter((m) => due(b1, at("2026-11-19", 14, m + 5), "2026-11-19T13:05:00Z")).length;
    assert.equal(hits, 4, "four chances inside the window");
  });
});
