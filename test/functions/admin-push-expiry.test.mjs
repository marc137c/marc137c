// A device gets notifications with customers' names only while the login it was turned on with is valid: 12 hours
// with «Hold meg innlogget» off, 60 days with it on (fix-up 2, item 1, and the notify audit's re-check 1: a shared
// or handed-on device logged in with the default must not show «Ny time» with names after that login has run out).
// Through the real /admin and /api/bookings handlers, with a fake push service and a fixed clock. Invariants:
//   1. subscribed with any login, the subscribe answer and the record carry until = that login's expiry;
//   2. after until, the next booking gives that device exactly one notice with no customer data («Innloggingen på
//      denne enheten har gått ut …»), never «Ny time», and the record is gone; later bookings send nothing more;
//      two bookings at the same moment still give one notice; the device count says 0 once it has run out;
//   3. every login on the device renews it (pushSync sends the subscription again with the new token): a new login
//      moves the end to that login's expiry, short or long;
//   4. a 60-day login keeps notifications going for 60 days, also 30 days later;
//   5. tokens made before F34 (no iat, signed with the old fast key) are refused;
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
import * as pushRenew from "../../netlify/functions/push-renew.mjs";

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

const EXPIRED_NOTICE = {
  title: "Timebok",
  body: "Innloggingen på denne enheten har gått ut. Åpne Timebok og logg inn for å få varsler igjen.",
  url: "/admin",
  tag: "innlogging-utlopt",
};
const noCustomerData = (x) => !/Kari|41234567|Ny time/.test(JSON.stringify(x.payload));

test("push expiry: subscribed with a 12-hour token, 13 hours later the device gets one notice without customer data, then nothing", async (t) => {
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
  assert.equal(d.push.deliveries.length, 2);
  const notice = d.push.deliveries[1];
  assert.equal(notice.device, pc);
  assert.deepEqual(notice.payload, EXPIRED_NOTICE);
  assert.ok(noCustomerData(notice), "no name, phone or «Ny time»");
  assert.equal(notice.bytes.length, 1126, "padded like every other message");
  assert.deepEqual(stored(d), [], "the expired device is removed");
  d.clock.advance(30 * DAY);
  assert.equal((await book(d, "Kari Senere")).status, 201);
  assert.equal(d.push.deliveries.length, 2, "30 days later still nothing");
  assert.equal((await subscribe(d, pc, token)).status, 401, "an expired token cannot add the device again");
  const logged = JSON.stringify([out.log, out.warn, out.error]);
  assert.match(logged, /utløpt innlogging er fjernet/);
  for (const secret of ["Kari", "41234567", pc.endpoint.slice(-24), pc.subscription.keys.auth]) assert.ok(!logged.includes(secret), secret);
});

test("push expiry: two bookings at the same moment after the login ran out still give exactly one notice", async (t) => {
  quiet(t);
  const pc = makeDevice("fcm"), other = makeDevice("apple");
  const d = setup([pc, other]);
  await subscribe(d, pc, await login(d, false));
  await subscribe(d, other, await login(d, true));
  d.clock.advance(13 * HOUR);
  const rs = await Promise.all([book(d, "Kari En"), book(d, "Kari To")]);
  assert.deepEqual(rs.map((r) => r.status), [201, 201]);
  const toPc = d.push.deliveries.filter((x) => x.device === pc);
  assert.equal(toPc.length, 1, JSON.stringify(toPc.map((x) => x.payload)));
  assert.deepEqual(toPc[0].payload, EXPIRED_NOTICE);
  assert.equal(d.push.deliveries.filter((x) => x.device === other && x.payload.title === "Ny time").length, 2, "the valid device gets both bookings");
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

// A weekday two to eight days after the clock, 10:00 + n slots (the clock moves months in these tests)
function bookSoon(d, name = "Kari Etterpå") {
  const day = new Date(d.clock.now() + 2 * DAY);
  while (day.getUTCDay() === 0) day.setUTCDate(day.getUTCDate() + 1);
  return bookings.handle(request("/api/bookings", { method: "POST", json: {
    service: "Herreklipp", addons: [], name, phone: "41234567", date: day.toISOString().slice(0, 10), start: 600 + 30 * (slot++ % 14),
  } }), PRODUCTION, d).then(read);
}

test("push expiry: a 60-day login keeps notifications for 60 days, then the device gets one notice without customer data", async (t) => {
  quiet(t);
  const phone = makeDevice("apple");
  const d = setup([phone]);
  const token = await login(d, true);
  const res = await subscribe(d, phone, token);
  assert.deepEqual([res.status, res.body], [201, { ok: true, devices: 1, until: new Date(d.clock.now() + LONG).toISOString() }]);
  assert.equal(stored(d)[0].until, res.body.until);
  for (const wait of [13 * HOUR, 30 * DAY]) {
    d.clock.advance(wait);
    assert.equal((await bookSoon(d)).status, 201);
  }
  assert.equal(d.push.deliveries.length, 2);
  assert.ok(d.push.deliveries.every((x) => x.device === phone && x.payload.title === "Ny time"));
  d.clock.advance(31 * DAY); // 61 days after the login
  assert.equal((await call(d, "/api/admin/push", { method: "GET", token })).status, 401);
  assert.equal((await bookSoon(d, "Kari Dag 61")).status, 201);
  assert.equal(d.push.deliveries.length, 3);
  assert.deepEqual(d.push.deliveries[2].payload, EXPIRED_NOTICE);
  assert.ok(noCustomerData(d.push.deliveries[2]));
  assert.deepEqual(stored(d), []);
  assert.equal((await bookSoon(d, "Kari Dag 62")).status, 201);
  assert.equal(d.push.deliveries.length, 3, "nothing more");
});

test("push expiry: every login renews it, and moves the end to that login's expiry, short or long", async () => {
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
  assert.deepEqual(long.body, { ok: true, devices: 1, until: new Date(d.clock.now() + LONG).toISOString() });
  assert.equal(stored(d)[0].until, long.body.until, "a long login moves the end 60 days out");
  d.clock.advance(5 * DAY);
  assert.equal((await book(d)).status, 201);
  assert.equal(d.push.deliveries.length, 2);
  // … and a later short login on the same device moves it again
  const short = await subscribe(d, pc, await login(d, false));
  assert.equal(short.body.until, new Date(d.clock.now() + SHORT).toISOString());
});

// Tokens issued before F34 carried only { exp } and were signed with SHA-256("viggos-admin:" + password)
function oldToken(password, exp) {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  const key = createHash("sha256").update("viggos-admin:" + password).digest();
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

test("push expiry: an old token (no iat, the old fast key) is refused, so it can never subscribe a device", async () => {
  const a = makeDevice("fcm");
  const d = setup([a]);
  const soon = oldToken(PASSWORD, d.clock.now() + 3 * HOUR);
  assert.equal(readToken(soon, PASSWORD, d.clock.now()), null);
  assert.equal((await subscribe(d, a, soon)).status, 401);
  assert.deepEqual(stored(d), []);
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

// ---------- Round 2: every writer of push/subs leaves an expired other device for its one last notice ----------
// demo-expired-notice-lost.mjs: the PC's 12-hour login runs out overnight; in the morning Viggo logs in on his
// phone (pushSync saves its subscription again) and the PC was silently dropped: it never got its notice.
// Guard rule (SPEC R17): only the send path (dropStale) removes expired devices, and it always yields them for
// the notice; subscribe, unsubscribe and renew keep an expired other device of the same password.
const WRITERS = {
  "the phone subscribes again (a new login)": async (d, phone) => {
    const token = await login(d, true);
    assert.equal((await subscribe(d, phone, token)).status, 200);
  },
  "the phone unsubscribes": async (d, phone, phoneToken) => {
    assert.equal((await call(d, "/api/admin/push/unsubscribe", { json: { endpoint: phone.endpoint }, token: phoneToken })).status, 200);
  },
  "the phone's browser renews its subscription": async (d, phone) => {
    const fresh = makeDevice("fcm");
    d.push.devices.push(fresh);
    const res = await pushRenew.handle(request("/api/push/renew", { method: "POST", json: {
      subscription: fresh.subscription, oldEndpoint: phone.endpoint, oldAuth: phone.subscription.keys.auth,
    } }), PRODUCTION, d).then(read);
    assert.equal(res.status, 200, JSON.stringify(res.body));
  },
};
for (const [label, writer] of Object.entries(WRITERS)) {
  test(`push expiry: after ${label}, the PC whose login ran out still gets exactly one notice at the next booking`, async (t) => {
    quiet(t);
    const pc = makeDevice("mozilla"), phone = makeDevice("fcm");
    const d = setup([pc, phone]);
    assert.equal((await subscribe(d, pc, await login(d, false))).status, 201);
    const phoneToken = await login(d, true);
    assert.equal((await subscribe(d, phone, phoneToken)).status, 201);
    d.clock.advance(13 * HOUR);
    await writer(d, phone, phoneToken);
    assert.equal((await book(d)).status, 201);
    const toPc = () => d.push.deliveries.filter((x) => x.device === pc);
    assert.deepEqual(toPc().map((x) => x.payload), [EXPIRED_NOTICE], `deliveries: ${JSON.stringify(d.push.deliveries.map((x) => x.payload && x.payload.tag))}`);
    assert.equal((await book(d, "Neste")).status, 201);
    assert.equal(toPc().length, 1, "and nothing more");
    assert.ok(!stored(d).some((s) => s.endpoint === pc.endpoint), "the PC's record is gone after its notice");
  });
}
