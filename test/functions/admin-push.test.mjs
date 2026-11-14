// /api/admin/push*: the barber turns notifications on and off per device, and sends himself a test (owner decision 2b).
// Invariants:
//   1. only a logged-in admin can do anything: without the admin token every push path is 401, nothing is stored,
//      no key pair is made and nothing is fetched;
//   2. the browser gets the VAPID public key and never the private key; the key pair stays the same;
//   3. only subscriptions at known push services with valid keys are stored, once per device; anything else is
//      400 with nothing stored and no network call;
//   4. a test send goes only to a device that is already stored (never to an address the browser just names), is
//      decryptable with that device's private key, and its VAPID JWT verifies with the key /admin subscribed with;
//   5. a device the push service reports gone (404/410) is removed; «Slå av» removes the device;
//   6. a deploy preview has its own key pair and its own devices (F10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, SITE, PRODUCTION, PREVIEW } from "../helpers/deps.mjs";
import { makeDevice, fakePushService } from "../helpers/fake-push.mjs";
import { makeToken } from "../../netlify/lib/booking-core.mjs";
import { VAPID_KEY, SUBS_KEY, testMessage } from "../../netlify/lib/push.mjs";
import * as admin from "../../netlify/functions/admin.mjs";

const PASSWORD = "fake-admin-password";
const NOW = "2026-11-16T08:00:00Z";
const PATHS = ["/api/admin/push", "/api/admin/push/subscribe", "/api/admin/push/unsubscribe", "/api/admin/push/test"];

function setup({ devices = [], reply } = {}) {
  const push = fakePushService({ devices, reply });
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PASSWORD }, fetch: push.fetch });
  return Object.assign(d, { push });
}
const auth = (d) => ({ Authorization: "Bearer " + makeToken(PASSWORD, d.clock.now()) });
const call = (d, path, { method = "POST", json, headers = auth(d), ctx = PRODUCTION } = {}) =>
  admin.handle(request(path, { method, json, headers }), ctx, d).then(read);
const info = (d, ctx) => call(d, "/api/admin/push", { method: "GET", ctx });
const subscribe = (d, device, ctx) => call(d, "/api/admin/push/subscribe", { json: { subscription: device.subscription }, ctx });

test("admin push: the paths are registered with the admin function", () => {
  for (const p of PATHS) assert.ok(admin.config.path.includes(p), p);
});

test("admin push: without the admin token every push path is 401, and nothing is made, stored or sent", async () => {
  const phone = makeDevice("apple");
  const d = setup({ devices: [phone] });
  for (const headers of [{}, { Authorization: "Bearer nope" }, { Authorization: "Bearer " + makeToken("other-password", d.clock.now()) }]) {
    for (const path of PATHS) {
      for (const method of ["GET", "POST"]) {
        const res = await call(d, path, { method, headers, json: method === "POST" ? { subscription: phone.subscription, endpoint: phone.endpoint } : undefined });
        assert.equal(res.status, 401, `${method} ${path}`);
        assert.equal(res.body.publicKey, undefined);
      }
    }
  }
  assert.equal(d.blobs.has("bookings", VAPID_KEY), false, "no key pair made");
  assert.equal(d.blobs.has("bookings", SUBS_KEY), false, "no device stored");
  assert.equal(d.push.fetch.calls.length, 0, "nothing sent");
});

test("admin push: GET gives the public key and the device count, never the private key", async () => {
  const d = setup();
  const first = await info(d);
  assert.equal(first.status, 200);
  assert.equal(first.headers["cache-control"], "no-store");
  assert.deepEqual(Object.keys(first.body).sort(), ["devices", "publicKey"]);
  assert.equal(first.body.devices, 0);
  const stored = d.blobs.json("bookings", VAPID_KEY);
  assert.equal(first.body.publicKey, stored.publicKey);
  const raw = Buffer.from(first.body.publicKey, "base64url");
  assert.deepEqual([raw.length, raw[0]], [65, 4], "the applicationServerKey the browser subscribes with");
  assert.doesNotMatch(JSON.stringify(first), new RegExp(stored.privateKey.d), "the private key never reaches the browser");
  for (let k = 0; k < 3; k++) assert.deepEqual((await info(d)).body, first.body, "the same key every time");
  assert.equal(d.push.fetch.calls.length, 0);
});

test("admin push: subscribing stores the device once; unknown push services and bad keys are refused without a network call", async () => {
  const phone = makeDevice("apple"), pc = makeDevice("wns");
  const d = setup({ devices: [phone, pc] });
  await info(d);
  let res = await subscribe(d, phone);
  assert.deepEqual([res.status, res.body], [201, { ok: true, devices: 1 }]);
  res = await subscribe(d, phone);
  assert.deepEqual([res.status, res.body], [200, { ok: true, devices: 1 }], "the same device twice is one device");
  res = await subscribe(d, pc);
  assert.deepEqual([res.status, res.body.devices], [201, 2]);
  assert.equal((await info(d)).body.devices, 2);
  const before = d.blobs.json("bookings", SUBS_KEY);
  for (const bad of [
    { ...phone.subscription, endpoint: "https://evil.test/push/abc" },
    { ...phone.subscription, endpoint: "http://fcm.googleapis.com/fcm/send/abc" },
    { ...phone.subscription, endpoint: "https://viggos.test/api/bookings" },
    { ...phone.subscription, endpoint: "https://169.254.169.254/latest/meta-data" },
    { ...phone.subscription, keys: { p256dh: "AAAA", auth: phone.subscription.keys.auth } },
    { endpoint: phone.endpoint }, null, "x",
  ]) {
    res = await call(d, "/api/admin/push/subscribe", { json: { subscription: bad } });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match(res.body.error, /push-tjeneste|abonnement/i);
  }
  assert.equal((await call(d, "/api/admin/push/subscribe", { json: { subscription: phone.subscription, pad: "x".repeat(5000) } })).status, 413);
  assert.deepEqual(d.blobs.json("bookings", SUBS_KEY), before, "nothing stored by a refused request");
  assert.equal(d.push.fetch.calls.length, 0, "subscribing never fetches anything");
});

test("admin push: «Send testvarsel» reaches this device only, decrypts with its key, and the JWT verifies with the key /admin got", async () => {
  const phone = makeDevice("apple"), android = makeDevice("fcm");
  const d = setup({ devices: [phone, android] });
  const { publicKey } = (await info(d)).body;
  await subscribe(d, phone);
  await subscribe(d, android);
  const res = await call(d, "/api/admin/push/test", { json: { endpoint: phone.endpoint } });
  assert.deepEqual([res.status, res.body], [200, { ok: true, devices: 2 }]);
  assert.equal(d.push.deliveries.length, 1, "only the device that asked");
  const [del] = d.push.deliveries;
  assert.equal(del.url, phone.endpoint);
  assert.equal(del.error, undefined, del.error);
  assert.deepEqual(del.payload, testMessage());
  assert.equal(del.vapid.ok, true, del.vapid.why);
  assert.equal(del.vapid.k, publicKey);
  assert.equal(del.vapid.claims.aud, "https://web.push.apple.com");
  assert.equal(del.vapid.claims.sub, SITE);
  assert.ok(del.vapid.claims.exp <= Date.parse(NOW) / 1000 + 24 * 3600);
});

test("admin push: a test send to an address that is not a stored device is 404 and fetches nothing", async () => {
  const phone = makeDevice("apple");
  const d = setup({ devices: [phone] });
  await info(d);
  await subscribe(d, phone);
  const fetchAnything = d.push.fetch.route(() => true, () => new Response(null, { status: 201 }));
  for (const endpoint of [makeDevice("apple").endpoint, "https://evil.test/collect", "https://viggos.test/api/bookings", "", undefined, 1]) {
    const res = await call(d, "/api/admin/push/test", { json: { endpoint } });
    assert.equal(res.status, 404, String(endpoint));
    assert.equal(res.body.code, "not_subscribed");
  }
  assert.equal(fetchAnything.calls.length, 0, "never POSTs to an address the browser names");
});

test("admin push: a gone device is removed (410); a failing push service keeps it (502)", async (t) => {
  quiet(t);
  const phone = makeDevice("apple");
  let status = 500;
  const d = setup({ devices: [phone], reply: () => status });
  await info(d);
  await subscribe(d, phone);
  let res = await call(d, "/api/admin/push/test", { json: { endpoint: phone.endpoint } });
  assert.deepEqual([res.status, res.body.code], [502, "push_failed"]);
  assert.equal((await info(d)).body.devices, 1, "a 500 does not remove the device");
  status = 410;
  res = await call(d, "/api/admin/push/test", { json: { endpoint: phone.endpoint } });
  assert.deepEqual([res.status, res.body.code, res.body.devices], [410, "gone", 0]);
  assert.equal((await info(d)).body.devices, 0);
  res = await call(d, "/api/admin/push/test", { json: { endpoint: phone.endpoint } });
  assert.equal(res.status, 404, "after removal it is no longer a device");
});

test("admin push: «Slå av» removes this device and only this one", async () => {
  const phone = makeDevice("apple"), pc = makeDevice("mozilla");
  const d = setup({ devices: [phone, pc] });
  await info(d);
  await subscribe(d, phone);
  await subscribe(d, pc);
  let res = await call(d, "/api/admin/push/unsubscribe", { json: { endpoint: phone.endpoint } });
  assert.deepEqual([res.status, res.body], [200, { ok: true, devices: 1 }]);
  res = await call(d, "/api/admin/push/unsubscribe", { json: { endpoint: phone.endpoint } });
  assert.deepEqual([res.status, res.body], [200, { ok: true, devices: 1 }], "turning off twice is fine");
  assert.equal((await call(d, "/api/admin/push/unsubscribe", { json: { endpoint: "https://evil.test/x" } })).status, 400);
  assert.deepEqual(d.blobs.json("bookings", SUBS_KEY).subs.map((s) => s.endpoint), [pc.endpoint]);
  assert.equal(d.push.fetch.calls.length, 0);
});

test("admin push: a deploy preview has its own key pair and its own devices (F10)", async () => {
  const phone = makeDevice("apple"), tester = makeDevice("fcm");
  const d = setup({ devices: [phone, tester] });
  const live = (await info(d)).body.publicKey;
  await subscribe(d, phone);
  const preview = await info(d, PREVIEW);
  assert.notEqual(preview.body.publicKey, live);
  assert.equal(preview.body.devices, 0, "the preview does not see the live devices");
  await subscribe(d, tester, PREVIEW);
  assert.equal((await call(d, "/api/admin/push/test", { json: { endpoint: phone.endpoint }, ctx: PREVIEW })).status, 404, "the preview cannot send to a live device");
  assert.deepEqual(d.blobs.json("bookings", SUBS_KEY).subs.map((s) => s.endpoint), [phone.endpoint]);
  assert.deepEqual(d.blobs.json("bookings-preview", SUBS_KEY).subs.map((s) => s.endpoint), [tester.endpoint]);
});

test("admin push: other methods are unknown requests", async () => {
  const d = setup();
  for (const [method, path] of [["PUT", "/api/admin/push"], ["DELETE", "/api/admin/push"], ["POST", "/api/admin/push"], ["GET", "/api/admin/push/test"], ["PATCH", "/api/admin/push/subscribe"]]) {
    assert.equal((await call(d, path, { method, json: method === "GET" ? undefined : {} })).status, 404, `${method} ${path}`);
  }
  assert.equal(d.blobs.has("bookings", VAPID_KEY), false);
});
