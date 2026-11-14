// POST /api/push/renew (netlify/functions/push-renew.mjs): the service worker hands the server the subscription the
// browser made in place of an old one (pushsubscriptionchange), without an admin login. Through the real handler,
// with the fake store, a fake push service and a fixed clock. Invariants:
//   1. it replaces a stored device only when both the old endpoint and that device's auth secret match: anything
//      else is the same 404, with nothing changed, nothing sent and nothing about the devices in the answer;
//   2. the new endpoint must be at a known push service with valid keys (400 otherwise, nothing stored or fetched);
//      one the push service has called gone is refused (410);
//   3. a renewed device keeps its password (gen) and the end of a short login (until); the old endpoint is never
//      accepted again; a device of an old password or with an expired short login cannot be renewed;
//   4. only same-site JSON POSTs of a sane size; a deploy preview renews only its own devices (F10);
//   5. nothing personal or secret is logged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION, PREVIEW } from "../helpers/deps.mjs";
import { makeDevice, fakePushService } from "../helpers/fake-push.mjs";
import { makeToken } from "../../netlify/lib/booking-core.mjs";
import { SUBS_KEY } from "../../netlify/lib/push.mjs";
import * as admin from "../../netlify/functions/admin.mjs";
import * as renew from "../../netlify/functions/push-renew.mjs";

const PASSWORD = "fake-admin-password";
const NOW = "2026-11-16T08:00:00Z";
const HOUR = 3600e3;

function setup(devices) {
  const push = fakePushService({ devices });
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PASSWORD }, fetch: push.fetch });
  return Object.assign(d, { push });
}
const token = (d, ttl = 60 * 24 * HOUR) => makeToken(PASSWORD, d.clock.now(), ttl);
async function subscribe(d, device, { ttl, ctx = PRODUCTION } = {}) {
  const headers = { Authorization: "Bearer " + token(d, ttl) };
  await admin.handle(request("/api/admin/push", { headers }), ctx, d);
  return read(await admin.handle(request("/api/admin/push/subscribe", { method: "POST", headers, json: { subscription: device.subscription } }), ctx, d));
}
const post = (d, json, { ctx = PRODUCTION, headers = { "Sec-Fetch-Site": "same-origin" }, body } = {}) =>
  renew.handle(request("/api/push/renew", { method: "POST", json, body, headers }), ctx, d).then(read);
const renewal = (old, next, auth = old.subscription.keys.auth) => ({ oldEndpoint: old.endpoint, oldAuth: auth, subscription: next.subscription });
const stored = (d, store = "bookings") => (d.blobs.has(store, SUBS_KEY) ? d.blobs.json(store, SUBS_KEY).subs : []);

test("push renew: the path is registered", () => {
  assert.equal(renew.config.path, "/api/push/renew");
});

test("push renew: the old endpoint plus its auth secret replace the device with the new subscription", async () => {
  const old = makeDevice("mozilla"), next = makeDevice("mozilla"), other = makeDevice("apple");
  const d = setup([old, next, other]);
  await subscribe(d, old);
  await subscribe(d, other);
  const before = stored(d).find((s) => s.endpoint === old.endpoint);
  d.clock.advance(HOUR);
  const res = await post(d, renewal(old, next));
  assert.deepEqual([res.status, res.body], [200, { ok: true }], "the answer says nothing about the devices");
  assert.equal(res.headers["cache-control"], "no-store");
  const now = stored(d).find((s) => s.endpoint === next.endpoint);
  assert.ok(now, "the new subscription is stored");
  assert.deepEqual([now.p256dh, now.auth], [next.subscription.keys.p256dh, next.subscription.keys.auth]);
  assert.deepEqual([now.gen, now.createdAt], [before.gen, before.createdAt], "it is the same device");
  assert.equal(now.seenAt, new Date(d.clock.now()).toISOString());
  assert.deepEqual(stored(d).map((s) => s.endpoint).sort(), [next.endpoint, other.endpoint].sort(), "the old one is gone, the other device untouched");
  assert.equal(d.push.fetch.calls.length, 0, "nothing is sent");
  // The old endpoint is never accepted again, also not through /admin
  assert.equal((await subscribe(d, old)).status, 410);
  assert.equal((await post(d, renewal(old, makeDevice("mozilla")))).status, 404, "renewing the old one twice does nothing");
});

test("push renew: without the right old endpoint and auth secret it is 404 and nothing changes", async () => {
  const old = makeDevice("fcm"), next = makeDevice("fcm");
  const d = setup([old, next]);
  await subscribe(d, old);
  const snapshot = JSON.stringify(d.blobs.json("bookings", SUBS_KEY));
  const wrongAuth = makeDevice().subscription.keys.auth;
  for (const [label, body] of [
    ["wrong auth secret", renewal(old, next, wrongAuth)],
    ["another device's endpoint", renewal(makeDevice("fcm"), next, old.subscription.keys.auth)],
    ["no auth secret", { oldEndpoint: old.endpoint, subscription: next.subscription }],
    ["auth secret of the wrong length", renewal(old, next, old.subscription.keys.auth.slice(0, 10))],
    ["no old endpoint", { oldAuth: old.subscription.keys.auth, subscription: next.subscription }],
    ["old endpoint at an unknown host", { ...renewal(old, next), oldEndpoint: "https://evil.test/x" }],
    ["the new key as the old secret", renewal(old, next, next.subscription.keys.auth)],
  ]) {
    const res = await post(d, body);
    assert.deepEqual([res.status, res.body], [404, { error: "Ukjent enhet.", code: "unknown_device" }], label);
  }
  assert.equal(JSON.stringify(d.blobs.json("bookings", SUBS_KEY)), snapshot, "nothing changed");
  assert.equal(d.push.fetch.calls.length, 0);
});

test("push renew: the new subscription must be at a known push service with valid keys", async () => {
  const old = makeDevice("apple");
  const d = setup([old]);
  await subscribe(d, old);
  const snapshot = JSON.stringify(d.blobs.json("bookings", SUBS_KEY));
  for (const bad of [
    { ...old.subscription, endpoint: "https://evil.test/push/abc" },
    { ...old.subscription, endpoint: "https://viggos.test/api/bookings" },
    { ...old.subscription, endpoint: "https://169.254.169.254/latest/meta-data" },
    { ...old.subscription, keys: { p256dh: "AAAA", auth: old.subscription.keys.auth } },
    null, "x", 5,
  ]) {
    const res = await post(d, { oldEndpoint: old.endpoint, oldAuth: old.subscription.keys.auth, subscription: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.equal(JSON.stringify(d.blobs.json("bookings", SUBS_KEY)), snapshot);
  assert.equal(d.push.fetch.calls.length, 0, "never contacts an address it was handed");
});

test("push renew: a new endpoint the push service has called gone is refused (410)", async (t) => {
  quiet(t);
  const old = makeDevice("fcm"), dead = makeDevice("fcm");
  const push = fakePushService({ devices: [old, dead], reply: (del) => (del.device === dead ? 410 : 201) });
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PASSWORD }, fetch: push.fetch });
  await subscribe(d, dead);
  await admin.handle(request("/api/admin/push/test", { method: "POST", headers: { Authorization: "Bearer " + token(d) }, json: { endpoint: dead.endpoint } }), PRODUCTION, d);
  await subscribe(d, old);
  const res = await post(d, renewal(old, dead));
  assert.deepEqual([res.status, res.body.code], [410, "gone"]);
  assert.deepEqual(stored(d).map((s) => s.endpoint), [old.endpoint], "the old device is kept");
});

test("push renew: a device keeps the end of its short login; an expired one or one of an old password cannot be renewed", async () => {
  const short = makeDevice("wns"), next = makeDevice("wns");
  let d = setup([short, next]);
  const sub = await subscribe(d, short, { ttl: 12 * HOUR });
  d.clock.advance(HOUR);
  assert.equal((await post(d, renewal(short, next))).status, 200);
  assert.equal(stored(d)[0].until, sub.body.until, "the short login still ends when it did");
  d.clock.advance(12 * HOUR);
  assert.equal((await post(d, renewal(next, makeDevice("wns")))).status, 404, "after the short login ran out");

  const phone = makeDevice("apple");
  d = setup([phone]);
  await subscribe(d, phone);
  d.env.ADMIN_PASSWORD = "new-password";
  assert.equal((await post(d, renewal(phone, makeDevice("apple")))).status, 404, "a device of the old password");
  delete d.env.ADMIN_PASSWORD;
  assert.equal((await post(d, renewal(phone, makeDevice("apple")))).status, 503, "admin not set up");
});

test("push renew: only same-site JSON POSTs of a sane size", async () => {
  const old = makeDevice("mozilla"), next = makeDevice("mozilla");
  const d = setup([old, next]);
  await subscribe(d, old);
  const snapshot = JSON.stringify(d.blobs.json("bookings", SUBS_KEY));
  assert.equal((await renew.handle(request("/api/push/renew"), PRODUCTION, d).then(read)).status, 405);
  assert.equal((await post(d, undefined, { body: JSON.stringify(renewal(old, next)), headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await post(d, renewal(old, next), { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await post(d, renewal(old, next), { headers: { "Sec-Fetch-Site": "same-site" } })).status, 403);
  assert.equal((await post(d, { ...renewal(old, next), pad: "x".repeat(5000) })).status, 413);
  assert.equal((await post(d, undefined, { body: "{not json", headers: { "Content-Type": "application/json" } })).status, 400);
  assert.equal((await post(d, null)).status, 400);
  assert.equal(JSON.stringify(d.blobs.json("bookings", SUBS_KEY)), snapshot);
  assert.equal((await post(d, renewal(old, next), { headers: {} })).status, 200, "a browser without Sec-Fetch-Site is fine");
});

test("push renew: a deploy preview renews only its own devices (F10)", async () => {
  const live = makeDevice("fcm"), tester = makeDevice("fcm"), next = makeDevice("fcm");
  const d = setup([live, tester, next]);
  await subscribe(d, live);
  await subscribe(d, tester, { ctx: PREVIEW });
  assert.equal((await post(d, renewal(live, next), { ctx: PREVIEW })).status, 404, "the preview cannot touch a live device");
  assert.equal((await post(d, renewal(tester, next), { ctx: PREVIEW })).status, 200);
  assert.deepEqual(stored(d).map((s) => s.endpoint), [live.endpoint]);
  assert.deepEqual(stored(d, "bookings-preview").map((s) => s.endpoint), [next.endpoint]);
});

test("push renew: a store failure is a 500 that logs no endpoint or key", async (t) => {
  const out = quiet(t);
  const old = makeDevice("apple"), next = makeDevice("apple");
  const d = setup([old, next]);
  await subscribe(d, old);
  d.blobs.inject({ method: "GET", key: SUBS_KEY, fault: "fail-before", status: 500, times: Infinity });
  const res = await post(d, renewal(old, next));
  assert.equal(res.status, 500);
  const logged = JSON.stringify([out.log, out.warn, out.error]);
  for (const secret of [old.endpoint.slice(-24), next.endpoint.slice(-24), old.subscription.keys.auth, next.subscription.keys.auth, next.subscription.keys.p256dh]) {
    assert.ok(!logged.includes(secret), "the log must not contain a secret");
  }
});
