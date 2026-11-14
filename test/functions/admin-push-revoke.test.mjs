// Cutting off devices that should no longer get notifications with customers' names (owner decision 2b, fix-up 1).
// Through the real /admin and /api/bookings handlers, with a fake push service and a fixed clock. Invariants:
//   1. after ADMIN_PASSWORD changes, no device subscribed before gets a push (also one subscribed with a stolen
//      12-hour token), the device count is 0, and the old devices are removed from the store, logging nothing personal;
//   2. «Slå av varsler på alle andre enheter» (POST /api/admin/push/reset) leaves 0 devices and the next booking
//      sends nothing; a device turned on again afterwards is notified as before;
//   3. reset requires the admin token: without it (or with a token for an old password) it is 401 and nothing changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { makeDevice, fakePushService } from "../helpers/fake-push.mjs";
import { makeToken, addDays, osloNow, dayOfWeek } from "../../netlify/lib/booking-core.mjs";
import { SUBS_KEY } from "../../netlify/lib/push.mjs";
import * as admin from "../../netlify/functions/admin.mjs";
import * as bookings from "../../netlify/functions/bookings.mjs";

const OLD = "old-password";
const NEW = "new-password";
const NOW = "2026-11-12T09:00:00Z"; // Thursday 10:00 in Oslo
const DAY = 24 * 60 * 60 * 1000;

function setup(devices) {
  const push = fakePushService({ devices });
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: OLD }, fetch: push.fetch });
  return Object.assign(d, { push });
}
const token = (d, password = d.env.ADMIN_PASSWORD, ttl) => makeToken(password, d.clock.now(), ttl);
const call = (d, path, { method = "POST", json, auth = token(d) } = {}) =>
  admin.handle(request(path, { method, json, headers: auth ? { Authorization: "Bearer " + auth } : {} }), PRODUCTION, d).then(read);
const info = (d, auth) => call(d, "/api/admin/push", { method: "GET", auth });
const subscribe = (d, device, auth) => call(d, "/api/admin/push/subscribe", { json: { subscription: device.subscription }, auth });
let slot = 0;
function book(d, name = "Kari Hemmelig") {
  const start = 600 + 30 * (slot++ % 14);
  let date = addDays(osloNow(d.clock.date()).date, 1); // tomorrow (never a Sunday, when the shop is closed)
  if (dayOfWeek(date) === 0) date = addDays(date, 1);
  return bookings.handle(request("/api/bookings", { method: "POST", json: { service: "Herreklipp", date, start, addons: [], name, phone: CUSTOMER_PHONE } }), PRODUCTION, d).then(read);
}
const storedEndpoints = (d) => (d.blobs.has("bookings", SUBS_KEY) ? d.blobs.json("bookings", SUBS_KEY).subs.map((s) => s.endpoint) : []);

test("push revoke: the reset path is registered with the admin function", () => {
  assert.ok(admin.config.path.includes("/api/admin/push/reset"));
});

test("push revoke: after ADMIN_PASSWORD changes, no device subscribed before gets a push", async (t) => {
  const out = quiet(t);
  const phone = makeDevice("apple"), pc = makeDevice("fcm");
  const d = setup([phone, pc]);
  assert.equal((await info(d)).status, 200);
  assert.equal((await subscribe(d, phone)).status, 201);
  assert.equal((await subscribe(d, pc)).status, 201);
  assert.equal((await book(d)).status, 201);
  assert.equal(d.push.deliveries.length, 2, "before the change both devices are notified");

  d.env.ADMIN_PASSWORD = NEW; // Viggo changes the password in Netlify
  assert.equal((await info(d, token(d, OLD))).status, 401, "the old login is gone");
  assert.equal((await info(d)).body.devices, 0, "no device belongs to the new password");
  const res = await book(d);
  assert.equal(res.status, 201, "the booking itself is unaffected");
  assert.equal(d.push.deliveries.length, 2, "no device subscribed under the old password gets the new booking");
  assert.deepEqual(storedEndpoints(d), [], "the old devices are removed from the store");
  // A test send to an old device under the new password finds nothing
  const test = await call(d, "/api/admin/push/test", { json: { endpoint: phone.endpoint } });
  assert.deepEqual([test.status, test.body.code], [404, "not_subscribed"]);
  assert.equal(d.push.deliveries.length, 2);
  // The barber turns the phone on again under the new password: it is notified as before, the PC is not
  assert.deepEqual([(await subscribe(d, phone)).status, (await info(d)).body.devices], [201, 1]);
  assert.equal((await book(d, "Per Etterpå")).status, 201);
  assert.equal(d.push.deliveries.length, 3);
  assert.deepEqual([d.push.deliveries[2].device, d.push.deliveries[2].payload.body.endsWith("Per Etterpå")], [phone, true]);
  const logged = JSON.stringify([out.log, out.warn, out.error]);
  assert.match(logged, /fra et gammelt admin-passord er fjernet/);
  for (const secret of [phone.endpoint.slice(-24), pc.endpoint.slice(-24), "Kari", "Hemmelig", OLD, NEW]) assert.ok(!logged.includes(secret), secret);
});

test("push revoke: a device subscribed with a stolen 12-hour token stops when the password changes (30 days later)", async (t) => {
  quiet(t);
  const viggo = makeDevice("apple"), attacker = makeDevice("mozilla");
  const d = setup([viggo, attacker]);
  const stolen = token(d, OLD, DAY / 2);
  await info(d, stolen);
  assert.equal((await subscribe(d, attacker, stolen)).status, 201);
  assert.equal((await subscribe(d, viggo)).status, 201);
  d.clock.advance(30 * DAY);
  assert.equal((await info(d, stolen)).status, 401, "the stolen token has expired");
  d.env.ADMIN_PASSWORD = NEW;
  await info(d); // Viggo logs in with the new password; then a customer books
  assert.equal((await subscribe(d, viggo)).status, 201);
  assert.equal((await book(d)).status, 201);
  assert.deepEqual(d.push.deliveries.map((x) => x.device.kind), ["apple"], "only Viggo's re-enabled phone");
});

test("push revoke: reset leaves 0 devices and the next booking sends nothing; a device turned on again is notified", async () => {
  const phone = makeDevice("apple"), pc = makeDevice("wns");
  const junk = Array.from({ length: 10 }, () => makeDevice("fcm")); // a token holder pushes the real devices out
  const d = setup([phone, pc, ...junk]);
  await info(d);
  await subscribe(d, phone);
  await subscribe(d, pc);
  for (const j of junk) await subscribe(d, j);
  assert.equal((await info(d)).body.devices, 10);
  const reset = await call(d, "/api/admin/push/reset");
  assert.equal(reset.status, 200);
  assert.equal(reset.headers["cache-control"], "no-store");
  assert.deepEqual(reset.body, { ok: true, devices: 0 });
  assert.equal((await info(d)).body.devices, 0);
  assert.deepEqual(storedEndpoints(d), []);
  assert.equal((await book(d)).status, 201);
  assert.equal(d.push.deliveries.length, 0, "nobody is notified after a reset");
  assert.deepEqual((await call(d, "/api/admin/push/reset")).body, { ok: true, devices: 0 }, "resetting again is fine");
  // This device turns itself on again (the page re-subscribes after a reset)
  assert.equal((await subscribe(d, phone)).body.devices, 1);
  assert.equal((await book(d)).status, 201);
  assert.deepEqual(d.push.deliveries.map((x) => x.device), [phone]);
});

test("push revoke: reset requires the admin token", async () => {
  const phone = makeDevice("apple");
  const d = setup([phone]);
  await info(d);
  await subscribe(d, phone);
  const before = JSON.stringify(d.blobs.json("bookings", SUBS_KEY));
  d.env.ADMIN_PASSWORD = NEW;
  await subscribe(d, phone); // under the new password
  const now = JSON.stringify(d.blobs.json("bookings", SUBS_KEY));
  assert.notEqual(now, before);
  for (const auth of [null, "nope", token(d, OLD), token(d, NEW, -1)]) {
    const res = await call(d, "/api/admin/push/reset", { auth });
    assert.equal(res.status, 401, String(auth));
    assert.equal(res.body.devices, undefined);
  }
  for (const method of ["GET", "PUT", "DELETE"]) assert.notEqual((await call(d, "/api/admin/push/reset", { method })).status, 200, method);
  assert.equal(JSON.stringify(d.blobs.json("bookings", SUBS_KEY)), now, "nothing changed");
  assert.equal((await info(d)).body.devices, 1);
});
