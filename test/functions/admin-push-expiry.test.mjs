// A device turned on with a short login («Hold meg innlogget» off: 12 hours) gets notifications with customers'
// names only until that login runs out (fix-up 2, item 1: a borrowed PC where the session simply expired, or the
// tab was closed, must not keep showing «Ny time» for weeks). Through the real /admin and /api/bookings handlers,
// with a fake push service and a fixed clock. Invariants:
//   1. subscribed with a 12-hour token: 13 hours later a new booking reaches no device, and the record is gone;
//      30 days later still nothing; the device count says 0 once it has run out;
//   2. subscribed with a 60-day token: unaffected, also 30 days later;
//   3. every login on the device renews it (pushSync sends the subscription again with the new token): a new short
//      login moves the end, a long login removes it;
//   4. the subscribe answer says until when (the token's expiry) for a short login, and nothing for a long one;
//   5. tokens made before they carried iat count as short when at most 12 hours are left;
//   6. nothing personal is logged when an expired device is removed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { makeDevice, fakePushService } from "../helpers/fake-push.mjs";
import { makeToken, readToken, verifyToken } from "../../netlify/lib/booking-core.mjs";
import { SUBS_KEY } from "../../netlify/lib/push.mjs";
import * as admin from "../../netlify/functions/admin.mjs";
import * as bookings from "../../netlify/functions/bookings.mjs";

const PASSWORD = "fake-admin-password";
const NOW = "2026-11-12T09:00:00Z"; // Thursday 10:00 in Oslo
const HOUR = 3600e3, DAY = 24 * HOUR;
const SHORT = DAY / 2, LONG = 60 * DAY; // what POST /api/admin/login gives with «Hold meg innlogget» off / on

function setup(devices) {
  const push = fakePushService({ devices });
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PASSWORD }, fetch: push.fetch });
  return Object.assign(d, { push });
}
const call = (d, path, { method = "POST", json, token } = {}) =>
  admin.handle(request(path, { method, json, headers: { Authorization: "Bearer " + token } }), PRODUCTION, d).then(read);
// As /admin does: GET /api/admin/push first (it makes the key pair the first time), then subscribe
const subscribe = (d, device, token) => call(d, "/api/admin/push", { method: "GET", token })
  .then(() => call(d, "/api/admin/push/subscribe", { json: { subscription: device.subscription }, token }));
const devices = (d, token) => call(d, "/api/admin/push", { method: "GET", token }).then((r) => r.body.devices);
const login = (d, remember) => admin.handle(request("/api/admin/login", { method: "POST", json: { password: PASSWORD, remember } }), PRODUCTION, d).then(read).then((r) => r.body.token);
let slot = 0;
const book = (d, name = "Kari Etterpå") => bookings.handle(request("/api/bookings", { method: "POST", json: {
  service: "Herreklipp", addons: ["Styling"], name, phone: "41234567",
  date: "2026-12-14", start: 600 + 30 * (slot++ % 14), // a Monday within 60 days of every clock below
} }), PRODUCTION, d).then(read);
const stored = (d) => (d.blobs.has("bookings", SUBS_KEY) ? d.blobs.json("bookings", SUBS_KEY).subs : []);

test("push expiry: the login itself makes a 12-hour token without «Hold meg innlogget» and a 60-day one with it", async () => {
  const d = setup([]);
  for (const [remember, ttl] of [[false, SHORT], [true, LONG], [undefined, SHORT]]) { // 60 days only with remember === true (F34)
    const t = readToken(await login(d, remember), PASSWORD, d.clock.now());
    assert.deepEqual(t, { exp: d.clock.now() + ttl, iat: d.clock.now() }, String(remember));
  }
});

test("push expiry: subscribed with a 12-hour token, 13 hours later a booking reaches no device and the record is gone", async (t) => {
  const out = quiet(t);
  const pc = makeDevice("fcm");
  const d = setup([pc]);
  const token = await login(d, false);
  const res = await subscribe(d, pc, token);
  assert.equal(res.status, 201);
  assert.equal(res.body.until, new Date(d.clock.now() + SHORT).toISOString(), "the answer says when it stops");
  assert.equal(stored(d)[0].until, res.body.until);
  assert.equal((await book(d)).status, 201);
  assert.equal(d.push.deliveries.length, 1, "while the login is valid the device is notified");

  d.clock.advance(13 * HOUR);
  assert.equal((await call(d, "/api/admin/push", { method: "GET", token })).status, 401, "the login has run out");
  assert.equal((await book(d)).status, 201, "the booking itself is unaffected");
  assert.equal(d.push.deliveries.length, 1, "no delivery after the login ran out");
  assert.deepEqual(stored(d), [], "the expired device is removed");
  d.clock.advance(30 * DAY);
  assert.equal((await book(d, "Kari Senere")).status, 201);
  assert.equal(d.push.deliveries.length, 1, "30 days later still nothing");
  assert.equal((await subscribe(d, pc, token)).status, 401, "an expired token cannot add the device again");
  const logged = JSON.stringify([out.log, out.warn, out.error]);
  assert.match(logged, /utløpt innlogging er fjernet/);
  for (const secret of ["Kari", "41234567", pc.endpoint.slice(-24), pc.subscription.keys.auth]) assert.ok(!logged.includes(secret), secret);
});

test("push expiry: the device count leaves out a device whose short login has run out, even before it is cleaned away", async () => {
  const pc = makeDevice("fcm"), phone = makeDevice("apple");
  const d = setup([pc, phone]);
  await subscribe(d, pc, makeToken(PASSWORD, d.clock.now(), SHORT));
  await subscribe(d, phone, makeToken(PASSWORD, d.clock.now(), LONG));
  const later = () => makeToken(PASSWORD, d.clock.now(), LONG);
  assert.equal(await devices(d, later()), 2);
  d.clock.advance(SHORT + 1);
  assert.equal(stored(d).length, 2, "still stored");
  assert.equal(await devices(d, later()), 1, "but not counted");
});

test("push expiry: a device subscribed with a 60-day token is unaffected, also 30 days later", async () => {
  const phone = makeDevice("apple");
  const d = setup([phone]);
  const token = await login(d, true);
  const res = await subscribe(d, phone, token);
  assert.deepEqual([res.status, res.body], [201, { ok: true, devices: 1 }], "no until for a long login");
  assert.equal(stored(d)[0].until, undefined);
  for (const wait of [13 * HOUR, 30 * DAY]) {
    d.clock.advance(wait);
    assert.equal((await book(d)).status, 201);
  }
  assert.equal(d.push.deliveries.length, 2);
  assert.ok(d.push.deliveries.every((x) => x.device === phone && x.payload.title === "Ny time"));
});

test("push expiry: every login renews it; a new short login moves the end, a long login removes it", async () => {
  const pc = makeDevice("wns");
  const d = setup([pc]);
  await subscribe(d, pc, await login(d, false));
  d.clock.advance(11 * HOUR);
  // The barber logs in again on the same PC: /admin (pushSync) sends the subscription again with the new token
  const second = await subscribe(d, pc, await login(d, false));
  assert.deepEqual([second.status, second.body.until], [200, new Date(d.clock.now() + SHORT).toISOString()]);
  d.clock.advance(2 * HOUR); // 13 hours after the first login, 2 after the second
  assert.equal((await book(d)).status, 201);
  assert.equal(d.push.deliveries.length, 1, "the second login keeps it going");
  const long = await subscribe(d, pc, await login(d, true));
  assert.deepEqual(long.body, { ok: true, devices: 1 });
  assert.equal(stored(d)[0].until, undefined, "a long login removes the end");
  d.clock.advance(5 * DAY);
  assert.equal((await book(d)).status, 201);
  assert.equal(d.push.deliveries.length, 2);
  // … and a later short login on the same device sets it again
  const short = await subscribe(d, pc, await login(d, false));
  assert.equal(short.body.until, new Date(d.clock.now() + SHORT).toISOString());
});

// Tokens issued before this change carried only { exp }
function oldToken(password, exp) {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  const key = createHash("sha256").update("viggos-admin:" + password).digest();
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

test("push expiry: an old token without iat counts as short when it has at most 12 hours left", async () => {
  const a = makeDevice("fcm"), b = makeDevice("apple");
  const d = setup([a, b]);
  const soon = oldToken(PASSWORD, d.clock.now() + 3 * HOUR);
  const far = oldToken(PASSWORD, d.clock.now() + 40 * DAY);
  assert.deepEqual(readToken(soon, PASSWORD, d.clock.now()), { exp: d.clock.now() + 3 * HOUR, iat: undefined });
  assert.equal((await subscribe(d, a, soon)).body.until, new Date(d.clock.now() + 3 * HOUR).toISOString());
  assert.equal((await subscribe(d, b, far)).body.until, undefined);
});

test("push expiry: readToken gives { exp, iat } only for a valid, unexpired token of this password", () => {
  const now = Date.parse(NOW);
  const token = makeToken(PASSWORD, now, SHORT);
  assert.deepEqual(readToken(token, PASSWORD, now + 1), { exp: now + SHORT, iat: now });
  for (const [label, t, pw, at] of [
    ["expired", token, PASSWORD, now + SHORT], ["another password", token, "other", now],
    ["tampered", token.replace(/^./, (c) => (c === "e" ? "f" : "e")), PASSWORD, now], ["no password", token, "", now],
    ["junk", "x.y", PASSWORD, now], ["not a string", 5, PASSWORD, now],
    ["exp not a number", oldToken(PASSWORD, "9999999999999"), PASSWORD, now],
  ]) {
    assert.equal(readToken(t, pw, at), null, label);
    assert.equal(verifyToken(t, pw, at), false, label);
  }
  assert.equal(verifyToken(token, PASSWORD, now), true);
});
