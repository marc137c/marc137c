// Dates that do not exist in the calendar (2026-11-31, 2026-02-30, 2027-02-29 …). Date rolls them over to the next
// month, so before this fix «2026-11-31 10:00» was stored next to a real «2026-12-01 10:00»: two overlapping events on
// the barber's phone, a «Tirsdag 1. desember» notification, and a booking /admin never shows and cannot cancel.
// Invariants:
//   1. isDate accepts exactly the dates that exist (leap years included) and nothing that rolls over;
//   2. POST /api/bookings and admin POST/PATCH with an impossible date give 400 and store nothing;
//   3. every event in the feed starts on its stored date, and a ghost record already in the store never appears;
//   4. no notification is ever built for a date that does not exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, PRODUCTION } from "../helpers/deps.mjs";
import { item, storedItems, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { makeDevice, fakePushService } from "../helpers/fake-push.mjs";
import { parseCalendar, components, prop } from "../helpers/ical.mjs";
import { isDate, addDays, makeToken, getAvailability } from "../../netlify/lib/booking-core.mjs";
import { buildCalendar } from "../../netlify/lib/calendar.mjs";
import { notifyNewBooking, saveSubscription, parseSubscription, vapidKeys } from "../../netlify/lib/push.mjs";
import * as bookings from "../../netlify/functions/bookings.mjs";
import * as admin from "../../netlify/functions/admin.mjs";

const PASSWORD = "fake-admin-password";
const NOW = "2026-11-12T09:00:00Z"; // Thursday 10:00 in Oslo; 2026-11-31 would be inside the 60-day window
const IMPOSSIBLE = ["2026-11-31", "2026-02-29", "2027-02-29", "2026-02-30", "2026-04-31", "2026-06-31", "2026-09-31", "2026-13-01", "2026-00-10", "2026-12-00", "2026-12-32", "2100-02-29"];
const LEAP = ["2028-02-29", "2024-02-29", "2000-02-29"];
const customer = (date, start = 600) => ({ service: "Herreklipp", date, start, addons: [], name: "Spøkelse", phone: CUSTOMER_PHONE });
const auth = (d) => ({ Authorization: "Bearer " + makeToken(PASSWORD, d.clock.now()) });
const book = (d, json) => bookings.handle(request("/api/bookings", { method: "POST", json }), PRODUCTION, d).then(read);
const adminCall = (d, path, method, json) => admin.handle(request(path, { method, json, headers: auth(d) }), PRODUCTION, d).then(read);

test("isDate: exactly the dates that exist, leap years included", () => {
  for (const s of IMPOSSIBLE) assert.equal(isDate(s), false, s);
  for (const s of [...LEAP, "2026-11-30", "2026-12-01", "2026-01-31", "2026-12-31", "2027-02-28"]) assert.equal(isDate(s), true, s);
  for (const s of ["", null, undefined, 20261130, "2026-1-30", "2026-11-30T00:00", " 2026-11-30", "2026/11/30"]) assert.equal(isDate(s), false, String(s));
  // Every day of 2026–2028 round-trips through addDays, and nothing else of the form ÅÅÅÅ-MM-DD does
  const real = new Set();
  for (let d = "2026-01-01"; d <= "2028-12-31"; d = addDays(d, 1)) real.add(d);
  for (const y of [2026, 2027, 2028]) {
    for (let m = 1; m <= 12; m++) {
      for (let day = 1; day <= 31; day++) {
        const s = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        assert.equal(isDate(s), real.has(s), s);
      }
    }
  }
});

test("impossible dates: a web booking for 2026-11-31 is 400 and stores nothing, so 1 December 10:00 is booked once", async () => {
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PASSWORD } });
  assert.equal((await book(d, customer("2026-12-01"))).status, 201);
  for (const date of ["2026-11-31", "2026-02-29", "2027-02-29"]) {
    const res = await book(d, customer(date));
    assert.deepEqual([res.status, res.body.code, res.body.error], [400, "bad_date", "Ugyldig dato."], date);
  }
  assert.deepEqual(storedItems(d.blobs).map((i) => i.date), ["2026-12-01"]);
  const free = await getAvailability(d.blobs.getStore({ name: "bookings", consistency: "strong" }), d.clock.date());
  assert.deepEqual(free.busy, { "2026-12-01": [[600, 630]] });
});

test("impossible dates: admin POST and PATCH with 2026-11-31, 2026-02-29 or 2027-02-29 are 400; 2028-02-29 is fine", async () => {
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PASSWORD } });
  const base = { start: 600, dur: 30, type: "booking", service: "Herreklipp", name: "Kari", phone: CUSTOMER_PHONE };
  for (const date of ["2026-11-31", "2026-02-29", "2027-02-29"]) {
    const res = await adminCall(d, "/api/admin/items", "POST", { ...base, date });
    assert.deepEqual([res.status, res.body.error], [400, "Ugyldig dato."], date);
  }
  assert.deepEqual(storedItems(d.blobs), []);
  const leap = await adminCall(d, "/api/admin/items", "POST", { ...base, date: "2028-02-29" });
  assert.equal(leap.status, 201);
  assert.equal(leap.body.item.date, "2028-02-29");
  const real = await adminCall(d, "/api/admin/items", "POST", { ...base, date: "2026-11-30" });
  for (const date of ["2026-11-31", "2026-02-29", "2027-02-29"]) {
    const res = await adminCall(d, `/api/admin/items/${real.body.item.id}`, "PATCH", { date });
    assert.deepEqual([res.status, res.body.error], [400, "Ugyldig dato."], date);
  }
  assert.deepEqual(storedItems(d.blobs).map((i) => i.date).sort(), ["2026-11-30", "2028-02-29"]);
  // An id or a range with an impossible date finds nothing and falls back to a real day
  assert.equal((await adminCall(d, "/api/admin/items/2026-11-31_f541ac8f19", "DELETE")).status, 404);
  const list = await adminCall(d, "/api/admin/items?from=2026-11-31&to=2026-12-02", "GET");
  assert.equal(list.status, 200);
  assert.ok(isDate(list.body.from) && isDate(list.body.to), JSON.stringify([list.body.from, list.body.to]));
});

test("impossible dates (feed): every event starts on its stored date; a ghost record already stored never appears", () => {
  const real = item({ date: "2026-12-01", start: 600 });
  const ghosts = ["2026-11-31", "2027-02-29", "2026-02-30"].map((date) => item({ date, start: 600, name: "Spøkelse" }));
  const ics = buildCalendar([real, ...ghosts], { now: new Date(NOW) });
  const evs = components(parseCalendar(ics), "VEVENT");
  assert.deepEqual(evs.map((e) => prop(e, "UID").value), [`${real.id}@viggos-timebok`]);
  assert.doesNotMatch(ics, /Spøkelse/);
  for (const ev of evs) assert.equal(prop(ev, "DTSTART").value.slice(0, 8), real.date.replace(/-/g, ""));
});

test("impossible dates: no notification is built for a date that does not exist", async () => {
  const phone = makeDevice("apple");
  const push = fakePushService({ devices: [phone] });
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PASSWORD }, fetch: push.fetch });
  const store = d.blobs.getStore({ name: "bookings", consistency: "strong" });
  await vapidKeys(store, { now: d.clock.date() });
  await saveSubscription(store, parseSubscription(phone.subscription).value, { now: d.clock.date() });
  const opts = { fetch: push.fetch, now: d.clock.date(), origin: "https://viggos.test" };
  for (const date of ["2026-11-31", "2027-02-29", "", undefined]) {
    assert.deepEqual(await notifyNewBooking(store, item({ date, name: "Spøkelse" }), opts), { skipped: true }, String(date));
  }
  assert.equal(push.deliveries.length, 0);
  const ok = await notifyNewBooking(store, item({ date: "2026-12-01", name: "Ekte" }), opts);
  assert.equal(ok.sent, 1);
  assert.match(push.deliveries[0].payload.body, /^Tirsdag 1\. desember kl\. 10:00/);
});
