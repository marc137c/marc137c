// SPEC R4, NEW-pii-keys: every key the server writes has a deletion rule, and no key name holds a phone number or
// an IP address. The handlers run for real on FakeBlobs: a web booking, a failed and a good login, an admin create
// and edit, the calendar link, a push device, cancel-phone, the customer's .ics and the daily clean-up. Then every
// key in every store must match a row in netlify/lib/store-keys.mjs KEY_RULES (with a non-empty deletion rule).
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, PRODUCTION } from "../helpers/deps.mjs";
import { makeDevice, fakePushService } from "../helpers/fake-push.mjs";
import { KEY_RULES, ruleFor } from "../../netlify/lib/store-keys.mjs";
import { EPOCH_KEY } from "../../netlify/lib/booking-core.mjs";
import { SECRET_KEY, ALL_KEY, LOGIN_ALL_KEY } from "../../netlify/lib/limits.mjs";
import { VAPID_KEY, SUBS_KEY } from "../../netlify/lib/push.mjs";
import { FEED_KEY } from "../../netlify/lib/calendar.mjs";
import * as bookings from "../../netlify/functions/bookings.mjs";
import * as admin from "../../netlify/functions/admin.mjs";
import * as bookingIcs from "../../netlify/functions/booking-ics.mjs";
import * as retention from "../../netlify/functions/retention.mjs";

const PW = "fake-admin-password";
const PHONE = "+47 912 34 567";
const IP = "198.51.100.23";
const IP6 = "2a01:79c:cebd:1000::42";
const NOW = "2026-11-12T09:00:00Z";
const IPV4_RE = /(^|[^0-9])\d{1,3}(\.\d{1,3}){3}([^0-9]|$)/;
const IPV6_RE = /[0-9a-f]{1,4}:[0-9a-f]{0,4}:/i;

test("store keys: every row names its stores, what it holds and a non-empty deletion rule", () => {
  assert.ok(KEY_RULES.length >= 10);
  for (const r of KEY_RULES) {
    assert.ok(Array.isArray(r.stores) && r.stores.length, JSON.stringify(r));
    assert.ok((typeof r.key === "string") !== (typeof r.prefix === "string"), "exactly one of key and prefix");
    assert.ok(typeof r.holds === "string" && r.holds.length > 10, JSON.stringify(r));
    assert.ok(typeof r.deletion === "string" && r.deletion.length > 10, JSON.stringify(r));
  }
  for (const key of [SECRET_KEY, EPOCH_KEY, VAPID_KEY, SUBS_KEY, FEED_KEY, ALL_KEY, LOGIN_ALL_KEY, "m/2026-11"]) {
    for (const store of ["bookings", "bookings-preview"]) assert.ok(ruleFor(store, key), `${store} ${key}`);
  }
});

test("store keys: after every handler has run, every stored key has a deletion rule and no key name holds a phone or an IP", async () => {
  const device = makeDevice("apple");
  const push = fakePushService({ devices: [device] });
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW }, fetch: push.fetch });
  const ctx = (ip) => ({ ...PRODUCTION, ip });
  const call = (fn, path, { method = "GET", json, token, ip = IP, params } = {}) =>
    fn.handle(request(path, { method, json, headers: token ? { Authorization: "Bearer " + token } : {} }), { ...ctx(ip), params }, d).then(read);

  // Admin: a failed and a good login (from IPv4 and IPv6), then push, calendar, create, edit, cancel-phone
  assert.equal((await call(admin, "/api/admin/login", { method: "POST", json: { password: "feil" }, ip: IP6 })).status, 401);
  const login = await call(admin, "/api/admin/login", { method: "POST", json: { password: PW, remember: true } });
  const token = login.body.token;
  assert.equal((await call(admin, "/api/admin/push", { token })).status, 200);
  assert.equal((await call(admin, "/api/admin/push/subscribe", { method: "POST", json: { subscription: device.subscription }, token })).status, 201);
  assert.equal((await call(admin, "/api/admin/calendar", { method: "POST", json: {}, token })).status, 201);
  // A web booking (counted per client, phone and in total) notifies the device
  const booked = await call(bookings, "/api/bookings", { method: "POST", json: {
    service: "Herreklipp", date: "2026-11-13", start: 600, addons: [], name: "Kari Nordmann", phone: PHONE, requestId: "store-keys-1",
  }, ip: IP6 });
  assert.equal(booked.status, 201);
  assert.equal(push.deliveries.length, 1);
  assert.equal((await call(bookingIcs, `/api/bookings/${booked.body.booking.id}.ics`)).status, 200);
  const made = await call(admin, "/api/admin/items", { method: "POST", json: { date: "2026-12-03", start: 600, dur: 30, name: "Per", phone: "400 00 000", requestId: "store-keys-2" }, token });
  assert.equal(made.status, 201);
  const id = made.body.item.id;
  assert.equal((await call(admin, `/api/admin/items/${id}`, { method: "PATCH", json: { date: "2027-01-05", expect: made.body.item.updatedAt }, token, params: { id } })).status, 200);
  assert.equal((await call(admin, "/api/admin/cancel-phone", { method: "POST", json: { phone: PHONE }, token })).body.cancelled, 1);
  assert.equal((await call(retention, "/.netlify/functions/retention", { method: "POST", json: {} })).status, 200);

  const problems = [];
  const stores = [...new Set(d.blobs.log.map((e) => e.store))];
  assert.ok(stores.includes("bookings"));
  for (const store of stores) {
    for (const key of d.blobs.keys(store)) {
      const rule = ruleFor(store, key);
      if (!rule || !rule.deletion) problems.push(`${store} ${key}: no deletion rule`);
      if (/\d{8}/.test(key)) problems.push(`${store} ${key}: eight digits in a row (a phone number?)`);
      if (IPV4_RE.test(key) || IPV6_RE.test(key)) problems.push(`${store} ${key}: an IP address`);
      for (const secret of ["91234567", "912 34 567", "198.51.100.23", "2a01:79c", "Kari"]) if (key.includes(secret)) problems.push(`${store} ${key}: contains ${secret}`);
    }
  }
  assert.deepEqual(problems, []);
  // Sanity: the run really wrote counters, a month, push and calendar docs
  const keys = d.blobs.keys("bookings");
  for (const prefix of ["rl/ip/", "rl/phone/", "rl/login/ip/", "m/2026-11", "m/2027-01", "push/subs", "calendar/feed", "rl/secret"]) {
    assert.ok(keys.some((k) => k.startsWith(prefix)), `${prefix} in ${keys.join(", ")}`);
  }
});
