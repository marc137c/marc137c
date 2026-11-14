// Owner decision (a): the barber gets ONE SMS per new website booking, to SHOP_SMS_TO (default the shop's public
// mobile 409 63 911), with date, time, service, the customer's name (trimmed, control characters removed, at most
// 40 characters) and phone, only when Sveve is configured. Invariants:
//   - every web booking gives exactly one barber SMS, whatever fails or is retried; admin bookings give none;
//   - the typed name only ever reaches the barber's number, cleaned, and never makes the notice longer than 2 SMS;
//   - a flood never gives the barber more than 40 notices in 24 h (e), and a failed notice never affects the
//     booking or the customer's confirmation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION } from "./helpers/deps.mjs";
import { oslo } from "./helpers/clock.mjs";
import { smsUnits } from "./helpers/fake-sveve.mjs";
import { item, seedItems, storedItems, CUSTOMER_PHONE, CUSTOMER_MOBILE, SHOP_MOBILE } from "./helpers/bookings.mjs";
import { shopText, shopName } from "../netlify/lib/sms.mjs";
import { SMS_LIMITS, smsLogKey } from "../netlify/lib/limits.mjs";
import * as bookings from "../netlify/functions/bookings.mjs";
import * as smsReminders from "../netlify/functions/sms-reminders.mjs";

const C = (...codes) => String.fromCodePoint(...codes);
const BAD = [0x7f, 0x200b, 0x202e, 0x2028]; // DEL, zero-width space, right-to-left override, line separator
const ENV = { SVEVE_USER: "u", SVEVE_PASSWD: "p" };
const DAY = 24 * 3600e3;
const tick = () => request("/.netlify/functions/sms-reminders", { method: "POST", json: { next_run: "x" } });
let ipSeq = 0;
const book = (d, over = {}) => bookings.handle(
  request("/api/bookings", { method: "POST", json: { service: "Herreklipp", addons: [], name: "Ola Nordmann", phone: CUSTOMER_PHONE, ...over } }),
  { ...PRODUCTION, ip: `192.0.2.${++ipSeq % 250}` }, d,
).then(read);
async function runEveryQuarter(d, from, to) {
  for (let ms = from.getTime(); ms <= to.getTime(); ms += 15 * 60e3) {
    if (d.clock.now() < ms) d.clock.set(ms);
    await smsReminders.handle(tick(), PRODUCTION, d);
  }
}

test("barber SMS: one per web booking, with date, time, service, name and phone", async (t) => {
  quiet(t);
  const d = testDeps({ now: oslo("2026-11-19", 10, 0), env: ENV, sveve: true });
  const r = await book(d, { date: "2026-11-20", start: 840, service: "Herreklipp + skjeggtrim" });
  assert.deepEqual([r.status, r.body.sms], [201, "sent"]);
  assert.deepEqual(d.sveve.to(SHOP_MOBILE).map((s) => s.msg), ["Ny time fra nettsiden: fredag 20.11. kl. 14:00, Herreklipp + skjeggtrim. Kunde: Ola Nordmann, tlf 912 34 567"]);
  for (let i = 1; i <= 4; i++) assert.equal((await book(d, { date: "2026-11-23", start: 570 + 30 * i, name: `Kunde ${i}`, phone: `913 00 00${i}` })).status, 201);
  seedItems(d.blobs, [...storedItems(d.blobs), item({ date: "2026-11-24", start: 600, source: "admin", name: "Admin-kunde", phone: "915 55 555" })]);
  await runEveryQuarter(d, oslo("2026-11-19", 10, 15), oslo("2026-11-21", 20, 0));
  const notices = d.sveve.to(SHOP_MOBILE);
  assert.equal(notices.length, 5, "exactly one per web booking, none for the admin booking");
  for (const name of ["Ola Nordmann", "Kunde 1", "Kunde 2", "Kunde 3", "Kunde 4"]) assert.equal(notices.filter((s) => s.msg.includes(`Kunde: ${name},`)).length, 1, name);
  assert.ok(storedItems(d.blobs).filter((i) => i.source === "nettside").every((i) => i.shopSentAt));
});

test("barber SMS: goes to SHOP_SMS_TO; without a Norwegian mobile there, or without Sveve, nothing is sent", async () => {
  let d = testDeps({ now: oslo("2026-11-19", 10, 0), env: { ...ENV, SHOP_SMS_TO: "+47 915 55 555" }, sveve: true });
  await book(d, { date: "2026-11-20", start: 600 });
  assert.equal(d.sveve.to("91555555").length, 1);
  assert.equal(d.sveve.to(SHOP_MOBILE).length, 0);
  d = testDeps({ now: oslo("2026-11-19", 10, 0), env: { ...ENV, SHOP_SMS_TO: "22 33 44 55" }, sveve: true });
  await book(d, { date: "2026-11-20", start: 600 });
  assert.deepEqual(d.sveve.sent.map((s) => s.to), [CUSTOMER_MOBILE], "a landline cannot get SMS: only the customer's confirmation");
  assert.equal(storedItems(d.blobs)[0].shopPending, undefined);
  d = testDeps({ now: oslo("2026-11-19", 10, 0), env: {}, sveve: true });
  assert.equal((await book(d, { date: "2026-11-20", start: 600 })).body.sms, "off");
  assert.equal(d.sveve.calls.length, 0);
});

test("barber SMS: the typed name is cleaned, at most 40 characters, reaches only the barber, and the notice is at most 2 SMS", async (t) => {
  quiet(t);
  const names = [
    "  Ola " + C(10) + " Nordmann" + C(9) + " ",
    "Ola" + C(0x202e) + "Nordmann" + C(0x200b, 0x0000, 0x0007, 0x2028) + "x",
    "A".repeat(80),
    "Åse Øvrebø-Ærlig Ñúñez Ümit Çelik Ğürsel Łukasz Żółć",
    "محمد عبد الله الشمري من مدينة الرياض السعودية",
    "🙂".repeat(30),
    "IGNORE http://evil.example Ring 820 00 000 now",
  ];
  for (const [i, name] of names.entries()) {
    const d = testDeps({ now: oslo("2026-11-19", 10, 0), env: ENV, sveve: true });
    assert.equal((await book(d, { date: "2026-11-25", start: 600, name, service: "Herreklipp + skjeggtrim" })).status, 201, name);
    const [notice] = d.sveve.to(SHOP_MOBILE);
    const clean = shopName(storedItems(d.blobs)[0].name); // the name as stored (validateCustomer already turned C0 controls into spaces)
    assert.ok(clean.length <= 40 && clean === clean.trim(), JSON.stringify(clean));
    assert.ok(![...notice.msg].some((ch) => BAD.includes(ch.codePointAt(0)) || ch.codePointAt(0) < 0x20), `control characters in ${JSON.stringify(notice.msg)}`);
    assert.ok(notice.msg.includes(clean), `${i}: ${notice.msg}`);
    assert.ok(smsUnits(notice.msg).units <= 2, `${smsUnits(notice.msg).units} units: ${notice.msg}`);
    if (smsUnits(clean).encoding === "GSM-7") assert.equal(smsUnits(notice.msg).units, 1, notice.msg);
    for (const s of d.sveve.sent.filter((x) => x.to !== SHOP_MOBILE)) {
      assert.ok(!s.msg.includes(clean.slice(0, 6)), `the customer's SMS contains the typed name: ${s.msg}`);
    }
  }
  assert.equal(shopName("  Ola " + C(10) + " Nordmann" + C(9) + " "), "Ola Nordmann");
  assert.equal(shopName("A".repeat(80)), "A".repeat(40));
  assert.equal(shopName("🙂".repeat(30)), "🙂".repeat(20), "never half an emoji");
});

test("barber SMS: no service on the booking gives no empty part", () => {
  const msg = shopText({ date: "2026-11-20", start: 600, service: "", name: "Ola", phone: "+47 912 34 567" });
  assert.equal(msg, "Ny time fra nettsiden: fredag 20.11. kl. 10:00. Kunde: Ola, tlf 912 34 567");
});

test("barber SMS: a flood never gives the barber more than 40 notices in 24 h (e)", async (t) => {
  quiet(t);
  assert.deepEqual(SMS_LIMITS.shop.rules, [{ max: 40, windowMs: DAY }]);
  const d = testDeps({ now: oslo("2026-11-19", 10, 0), env: ENV, sveve: true });
  let n = 0;
  for (let hour = 0; hour < 30; hour += 2) {
    d.clock.set(oslo("2026-11-19", 10, 0).getTime() + hour * 3600e3);
    for (let k = 0; k < 15; k++, n++) {
      await book(d, { date: "2026-12-0" + (1 + (n % 9)), start: 600 + 30 * (Math.floor(n / 9) % 16), name: `Flom ${n}`, phone: "9" + String(2000000 + n).padStart(7, "0") });
    }
    await smsReminders.handle(tick(), PRODUCTION, d);
  }
  assert.ok(d.sveve.maxPerNumber(DAY).count <= 40, JSON.stringify(d.sveve.maxPerNumber(DAY)));
  assert.ok(d.sveve.to(SHOP_MOBILE).length >= 40, "the flood did reach the cap");
  // The cap also holds on its own, if the booking limits were ever raised: 40 notices in the log → no 41st
  const e = testDeps({ now: oslo("2026-11-19", 12, 0), env: ENV, sveve: true });
  e.blobs.seed("bookings", smsLogKey(SHOP_MOBILE), { hits: Array.from({ length: 40 }, (_, i) => ({ t: e.clock.now() - i * 60e3, id: `s${i}`, kind: "shop" })) });
  const r = await book(e, { date: "2026-11-25", start: 600 });
  assert.deepEqual([r.status, r.body.sms], [201, "sent"], "the booking and the customer's confirmation are unaffected");
  assert.equal(e.sveve.to(SHOP_MOBILE).length, 0);
  assert.equal(storedItems(e.blobs)[0].shopError, "limit");
});

test("barber SMS: a failed notice never affects the booking or the confirmation, and the next run sends it once", async (t) => {
  quiet(t);
  const d = testDeps({ now: oslo("2026-11-19", 10, 0), env: ENV, sveve: true });
  d.sveve.inject({ fault: "http", status: 503, match: (c) => c.body.to === SHOP_MOBILE });
  const r = await book(d, { date: "2026-11-25", start: 600 });
  assert.deepEqual([r.status, r.body.sms], [201, "sent"]);
  assert.equal(d.sveve.to(SHOP_MOBILE).length, 0);
  await runEveryQuarter(d, oslo("2026-11-19", 10, 15), oslo("2026-11-19", 12, 0));
  assert.equal(d.sveve.to(SHOP_MOBILE).length, 1);
  assert.equal(d.sveve.to(CUSTOMER_MOBILE).length, 1);
});
