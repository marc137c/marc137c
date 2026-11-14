// netlify/lib/push.mjs: Web Push to the barber's devices (owner decision 2b). Invariants:
//   1. encryption is RFC 8291: with the RFC's own keys and salt it gives exactly the RFC's example message, and a
//      subscription's private key (the fake browser) decrypts every message we send; every message has a new salt
//      and a new sender key; one record, rs 4096, at most 4096 bytes; every message is padded to PAD_SIZE, so two
//      bookings whose names differ in length give bodies of exactly the same length (the push service cannot see it);
//   2. the VAPID key pair is made once per store by the server itself (two first callers agree on one pair); the
//      JWT is ES256 and verifies with the public key the browser subscribes with; aud is the push service's
//      origin, exp is at most 24 h ahead (by the injected clock), sub is the site's https address;
//   3. only endpoints at the four known push services are accepted or ever fetched; anything else is refused
//      without a single network call;
//   4. a 404/410 from the push service removes that device and only that one; other failures keep it; nothing a
//      push logs contains an endpoint, a key, the customer's name or phone;
//   5. one push never waits longer than its timeout;
//   6. the notification for a booking says weekday, date, time, service (+ add-ons) and name, in Norwegian.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBlobs } from "../helpers/fake-blobs.mjs";
import { FakeClock } from "../helpers/clock.mjs";
import { quiet } from "../helpers/deps.mjs";
import { fakeFetch, hang } from "../helpers/fake-fetch.mjs";
import { RFC8291_EXAMPLE as X, makeDevice, fakePushService, decryptPushMessage, verifyVapid } from "../helpers/fake-push.mjs";
import {
  encryptPayload, vapidKeys, readVapidKeys, vapidAuthorization, contactFor, pushService, normalizeEndpoint,
  parseSubscription, saveSubscription, removeSubscriptions, readSubscriptions, sendPush, pushToDevices,
  bookingMessage, testMessage, notifyNewBooking, pushGen, clearSubscriptions, VAPID_KEY, SUBS_KEY, MAX_DEVICES, RECORD_SIZE, JWT_LIFETIME_S, PUSH_TIMEOUT_MS,
  PAD_SIZE, GONE_MAX, GONE_DAYS,
} from "../../netlify/lib/push.mjs";

const NOW = new Date("2026-11-16T08:00:00Z");
const unb64u = (s) => Buffer.from(s, "base64url");
const storeOf = (blobs = new FakeBlobs()) => blobs.getStore({ name: "bookings", consistency: "strong" });
const asStored = (device) => parseSubscription(device.subscription).value;
const GEN = pushGen("fake-admin-password"); // the admin password the devices were turned on with

async function setup(kinds = ["fcm"], reply) {
  const blobs = new FakeBlobs();
  const store = storeOf(blobs);
  const keys = await vapidKeys(store, { now: NOW });
  const devices = kinds.map(makeDevice);
  for (const d of devices) await saveSubscription(store, asStored(d), { now: NOW, gen: GEN });
  const push = fakePushService({ devices, reply });
  return { blobs, store, keys, devices, push };
}

// ---------- 1. Encryption ----------
test("push: with the RFC 8291 example's keys and salt the message is exactly the RFC's", () => {
  const body = encryptPayload(Buffer.from(X.plaintext), { p256dh: X.uaPublicKey, auth: X.authSecret },
    { salt: unb64u(X.salt), senderPrivateKey: unb64u(X.asPrivateKey), padTo: 0 }); // the RFC's example has no padding
  assert.equal(body.toString("base64url"), X.message);
});

test("push: messages are padded to one fixed length, so a booking's body length never shows the name's length", async () => {
  const { store, devices, push } = await setup(["fcm", "apple"]);
  const booking = (id, name) => ({ id, date: "2026-11-20", start: 840, service: "Herreklipp", addons: [], name, phone: "41234567" });
  const names = ["Al", "Kari-Mette Johansen Ødegård Bakkene"]; // 2 and 35 characters
  assert.deepEqual(names.map((n) => n.length), [2, 35]);
  for (const [i, name] of names.entries()) await notifyNewBooking(store, booking(`2026-11-20_${i}`, name), { fetch: push.fetch, now: NOW, gen: GEN });
  assert.equal(push.deliveries.length, 4);
  for (const del of push.deliveries) assert.equal(del.error, undefined, del.error); // the RFC 8291 receiver strips the zeros
  assert.deepEqual(push.deliveries.map((d) => d.payload.body.split(" · ").pop()), [names[0], names[0], names[1], names[1]]);
  const lengths = new Set(push.deliveries.map((d) => d.bytes.length));
  assert.deepEqual([...lengths], [86 + PAD_SIZE + 16], "every body: header, PAD_SIZE padded bytes, tag");
  // The longest message a web booking can make (an 80-character name of the costliest characters: a lone surrogate
  // is 6 bytes in JSON, «"» and «\» 2; the longest service, every add-on, the longest weekday and month) fits in the
  // same size, and so does the test notification
  const device = devices[0];
  const longest = {
    id: "2026-09-24_abcdef1234", date: "2026-09-24", start: 1050, service: "Herreklipp + skjeggtrim",
    addons: ["Vask kort hår", "Vask langt hår", "Styling"], name: "\ud800".repeat(80), phone: "41234567",
  };
  for (const msg of [bookingMessage(longest), bookingMessage({ ...longest, name: "\"\\".repeat(40) }), testMessage()]) {
    const body = encryptPayload(Buffer.from(JSON.stringify(msg)), asStored(device));
    assert.equal(body.length, 86 + PAD_SIZE + 16, msg.body);
    assert.deepEqual(JSON.parse(device.decrypt(body).toString("utf8")), JSON.parse(JSON.stringify(msg)));
  }
  // Anything longer still fits in one record and decrypts; only what cannot fit in 4096 bytes is refused
  const big = Buffer.alloc(PAD_SIZE * 2, 65);
  const body = encryptPayload(big, asStored(device));
  assert.ok(body.length <= 4096);
  assert.deepEqual(device.decrypt(body), big);
  assert.equal(encryptPayload(Buffer.alloc(3993, 65), asStored(device)).length, 4096);
  assert.throws(() => encryptPayload(Buffer.alloc(3994, 65), asStored(device)), /for stort/);
});

test("push: the subscription's private key decrypts every message; each has a new salt and sender key", () => {
  const device = makeDevice("apple");
  const text = JSON.stringify(bookingMessage({ id: "2026-11-20_x", date: "2026-11-20", start: 840, service: "Herreklipp", addons: ["Styling"], name: "Åse Ødegård" }));
  const a = encryptPayload(Buffer.from(text), asStored(device));
  const b = encryptPayload(Buffer.from(text), asStored(device));
  for (const body of [a, b]) {
    assert.equal(device.decrypt(body).toString("utf8"), text);
    assert.equal(body.readUInt32BE(16), RECORD_SIZE, "rs");
    assert.equal(body[20], 65, "idlen: the uncompressed sender key");
    assert.ok(body.length <= 4096);
  }
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16), "a new salt every time");
  assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86), "a new sender key every time");
  assert.throws(() => decryptPushMessage(a, { ...makeDevice() }), "another device cannot read it");
  assert.throws(() => encryptPayload(Buffer.alloc(4096, 65), asStored(device)), /for stort/);
});

// ---------- 2. VAPID ----------
test("push: the VAPID key pair is made once per store, and two first callers agree on it", async () => {
  const blobs = new FakeBlobs();
  const store = storeOf(blobs);
  assert.equal(await readVapidKeys(store), null, "reading never makes keys");
  const [a, b, c] = await Promise.all([vapidKeys(store, { now: NOW }), vapidKeys(store, { now: NOW }), vapidKeys(store, { now: NOW })]);
  assert.equal(a.publicKey, b.publicKey);
  assert.equal(a.publicKey, c.publicKey);
  const stored = blobs.json("bookings", VAPID_KEY);
  assert.equal(stored.publicKey, a.publicKey);
  assert.equal(stored.createdAt, NOW.toISOString());
  assert.equal(unb64u(a.publicKey).length, 65);
  assert.equal(unb64u(a.publicKey)[0], 4);
  assert.equal((await vapidKeys(store, { now: new Date() })).publicKey, a.publicKey, "never replaced once it exists");
  // Another store (a deploy preview) has its own pair (F10)
  assert.notEqual((await vapidKeys(blobs.getStore({ name: "bookings-preview", consistency: "strong" }), { now: NOW })).publicKey, a.publicKey);
});

test("push: a broken stored key pair is replaced; a whole one is kept", async () => {
  const blobs = new FakeBlobs();
  const store = storeOf(blobs);
  for (const junk of ["not json at all", { publicKey: "x" }, [], { publicKey: "BAAA", privateKey: { kty: "EC", crv: "P-256", x: "a", y: "b", d: "c" } }]) {
    blobs.seed("bookings", VAPID_KEY, junk);
    assert.equal(await readVapidKeys(store).catch(() => null), null, JSON.stringify(junk));
  }
  blobs.seed("bookings", VAPID_KEY, { publicKey: "x" });
  const made = await vapidKeys(store, { now: NOW });
  assert.equal(unb64u(made.publicKey).length, 65);
  assert.deepEqual(await readVapidKeys(store), made);
});

test("push: the VAPID JWT is ES256, verifies with the public key, and carries aud, exp ≤ 24 h and sub", async () => {
  const { keys } = await setup([]);
  const header = vapidAuthorization("https://web.push.apple.com", keys, { now: NOW, subject: contactFor("https://viggos.test") });
  const v = verifyVapid(header);
  assert.equal(v.ok, true, v.why);
  assert.deepEqual(v.header, { typ: "JWT", alg: "ES256" });
  assert.equal(v.k, keys.publicKey, "k is the key the browser subscribed with");
  assert.equal(v.claims.aud, "https://web.push.apple.com");
  const nowS = NOW.getTime() / 1000;
  assert.equal(v.claims.exp, nowS + JWT_LIFETIME_S);
  assert.ok(v.claims.exp > nowS && v.claims.exp <= nowS + 24 * 3600, "push services refuse more than 24 h");
  assert.equal(v.claims.sub, "https://viggos.test");
  assert.doesNotMatch(header, new RegExp(keys.privateKey.d), "the private key is never in the header");
  assert.equal(contactFor("http://localhost:8888"), "https://localhost");
  assert.equal(contactFor(undefined), "https://localhost");
});

// ---------- 3. Known push services only ----------
const ACCEPTED = [
  ["https://fcm.googleapis.com/fcm/send/cXk:APA91bH", "Google FCM"],
  ["https://fcm.googleapis.com/wp/cXk:APA91bH", "Google FCM"],
  ["https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB", "Mozilla autopush"],
  ["https://web.push.apple.com/QGzs2Lp", "Apple"],
  ["https://api.push.apple.com/3/device/x", "Apple"],
  ["https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB", "Microsoft WNS"],
  ["https://FCM.googleapis.com:443/fcm/send/x", "Google FCM"],
];
const REFUSED = [
  "http://fcm.googleapis.com/fcm/send/x", "https://fcm.googleapis.com.evil.test/x", "https://evil.test/fcm.googleapis.com/x",
  "https://evilfcm.googleapis.com/x", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x",
  "https://fcm.googleapis.com./x", "https://fcm.googleapis.com/x#y", "https://push.apple.com.evil.test/", "https://apple.com/",
  "https://notify.windows.com/w/", "https://windows.com/", "https://127.0.0.1/", "https://[::1]/", "https://localhost/",
  "https://viggos.test/api/admin/items", "https://blobs-edge.test/x", "data:text/plain,x", "javascript:alert(1)", "ftp://fcm.googleapis.com/",
  "https://fcm.googleapis.com/\nx", " https://fcm.googleapis.com/x", "https://xn--fcm-googleapis-com.test/", "https://fcm.googleapis.com/" + "a".repeat(2100),
  "", null, undefined, 42, {}, ["https://fcm.googleapis.com/x"],
];

test("push: only endpoints at Google FCM, Mozilla autopush, Apple and Microsoft WNS are accepted", () => {
  for (const [url, name] of ACCEPTED) {
    assert.equal(pushService(url), name, url);
    assert.ok(normalizeEndpoint(url).startsWith("https://"), url);
  }
  assert.equal(normalizeEndpoint("https://FCM.googleapis.com:443/fcm/send/x"), "https://fcm.googleapis.com/fcm/send/x");
  for (const url of REFUSED) {
    assert.equal(pushService(url), null, String(url));
    assert.equal(parseSubscription({ endpoint: url, keys: makeDevice().subscription.keys }).code, "unknown_push_service", String(url));
  }
});

test("push: sendPush never fetches an endpoint outside the known push services", async () => {
  const { keys } = await setup([]);
  const fetch = fakeFetch([[() => true, () => new Response(null, { status: 201 })]]); // would answer anything
  const keysOf = makeDevice().subscription.keys;
  for (const url of REFUSED) {
    const r = await sendPush({ endpoint: url, p256dh: keysOf.p256dh, auth: keysOf.auth }, testMessage(), { keys, fetch, now: NOW });
    assert.deepEqual([r.ok, r.error], [false, "refused"], String(url));
  }
  assert.equal(fetch.calls.length, 0);
});

test("push: a subscription needs a valid P-256 point and a 16-byte auth secret", () => {
  const good = makeDevice().subscription;
  assert.deepEqual(parseSubscription(good).value, { endpoint: good.endpoint, p256dh: good.keys.p256dh, auth: good.keys.auth });
  const padded = { ...good, keys: { p256dh: Buffer.from(unb64u(good.keys.p256dh)).toString("base64"), auth: Buffer.from(unb64u(good.keys.auth)).toString("base64") } };
  assert.deepEqual(parseSubscription(padded).value, parseSubscription(good).value, "standard base64 with padding is read too");
  const offCurve = Buffer.from(unb64u(good.keys.p256dh));
  offCurve[64] ^= 1;
  const compressed = Buffer.concat([Buffer.from([3]), unb64u(good.keys.p256dh).subarray(1, 33)]);
  for (const keys of [
    {}, { p256dh: good.keys.p256dh }, { auth: good.keys.auth },
    { p256dh: offCurve.toString("base64url"), auth: good.keys.auth },
    { p256dh: compressed.toString("base64url"), auth: good.keys.auth },
    { p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: good.keys.auth },
    { p256dh: good.keys.p256dh, auth: "AAAA" }, { p256dh: good.keys.p256dh, auth: Buffer.alloc(32).toString("base64url") },
    { p256dh: good.keys.p256dh + "!", auth: good.keys.auth }, { p256dh: 1, auth: 2 },
  ]) {
    assert.equal(parseSubscription({ endpoint: good.endpoint, keys }).code, "bad_subscription", JSON.stringify(keys));
  }
  for (const input of [null, undefined, "x", 1]) assert.equal(parseSubscription(input).code, "bad_subscription");
});

// ---------- Stored devices ----------
test("push: saving is idempotent per endpoint; above MAX_DEVICES the least recently seen device goes", async () => {
  const blobs = new FakeBlobs();
  const store = storeOf(blobs);
  const clock = new FakeClock(NOW);
  const devices = Array.from({ length: MAX_DEVICES + 1 }, () => makeDevice());
  let r = await saveSubscription(store, asStored(devices[0]), { now: clock.date(), gen: GEN });
  assert.deepEqual(r, { ok: true, created: true, devices: 1 });
  r = await saveSubscription(store, asStored(devices[0]), { now: clock.advance(1000).date(), gen: GEN });
  assert.deepEqual(r, { ok: true, created: false, devices: 1 }, "the same device twice is one device");
  const first = blobs.json("bookings", SUBS_KEY).subs[0];
  assert.equal(first.createdAt, NOW.toISOString());
  assert.equal(first.seenAt, new Date(NOW.getTime() + 1000).toISOString());
  for (const d of devices.slice(1, MAX_DEVICES)) await saveSubscription(store, asStored(d), { now: clock.advance(1000).date(), gen: GEN });
  await saveSubscription(store, asStored(devices[0]), { now: clock.advance(1000).date(), gen: GEN }); // the first one is seen again
  r = await saveSubscription(store, asStored(devices[MAX_DEVICES]), { now: clock.advance(1000).date(), gen: GEN });
  assert.equal(r.devices, MAX_DEVICES);
  const kept = (await readSubscriptions(store)).map((s) => s.endpoint);
  assert.ok(kept.includes(devices[0].endpoint), "seen recently: kept");
  assert.ok(!kept.includes(devices[1].endpoint), "seen least recently: dropped");
  assert.ok(kept.includes(devices[MAX_DEVICES].endpoint));
  // Removing
  r = await removeSubscriptions(store, [devices[0].endpoint, "https://evil.test/x"]);
  assert.deepEqual([r.removed, r.devices], [1, MAX_DEVICES - 1]);
  r = await removeSubscriptions(store, [devices[0].endpoint]);
  assert.deepEqual([r.removed, r.noWrite], [0, true], "removing again writes nothing");
});

test("push: two devices saved at the same time are both kept", async () => {
  const blobs = new FakeBlobs();
  const store = storeOf(blobs);
  const devices = Array.from({ length: 4 }, () => makeDevice());
  await Promise.all(devices.map((d) => saveSubscription(store, asStored(d), { now: NOW, gen: GEN })));
  assert.deepEqual((await readSubscriptions(store)).map((s) => s.endpoint).sort(), devices.map((d) => d.endpoint).sort());
});

test("push: junk in the stored device list is ignored, never sent to", async () => {
  const blobs = new FakeBlobs();
  const store = storeOf(blobs);
  const good = asStored(makeDevice());
  blobs.seed("bookings", SUBS_KEY, { subs: [null, 1, { endpoint: "https://evil.test/x", p256dh: good.p256dh, auth: good.auth }, { ...good, auth: "x" }, good] });
  assert.deepEqual(await readSubscriptions(store), [good]);
  blobs.seed("bookings", SUBS_KEY, { subs: "nope" });
  assert.deepEqual(await readSubscriptions(store), []);
});

// ---------- Sending ----------
test("push: a sent message has the Web Push headers, decrypts on the device and its VAPID JWT verifies", async () => {
  const { keys, devices, push } = await setup(["fcm", "mozilla", "apple", "wns"]);
  for (const d of devices) {
    const r = await sendPush(asStored(d), testMessage(), { keys, fetch: push.fetch, now: NOW, subject: "https://viggos.test" });
    assert.deepEqual(r, { ok: true, status: 201, gone: false, service: pushService(d.endpoint) }, d.kind);
  }
  assert.equal(push.deliveries.length, 4);
  for (const [i, del] of push.deliveries.entries()) {
    assert.equal(del.url, devices[i].endpoint);
    assert.equal(del.method, "POST");
    assert.equal(del.error, undefined, del.error);
    assert.deepEqual(del.payload, testMessage());
    assert.equal(del.headers["content-encoding"], "aes128gcm");
    assert.equal(del.headers["content-type"], "application/octet-stream");
    assert.equal(del.headers.ttl, String(24 * 3600));
    assert.equal(del.headers.urgency, "high");
    assert.equal(del.vapid.ok, true, del.vapid.why);
    assert.equal(del.vapid.claims.aud, new URL(devices[i].endpoint).origin);
    assert.equal(del.vapid.k, keys.publicKey);
  }
  assert.ok(push.fetch.calls.every((c) => c.signal), "every push can be aborted");
});

test("push: the push service's answer decides: 2xx sent, 404/410 gone, anything else failed", async () => {
  const { keys, devices, push } = await setup(["fcm"]);
  const sub = asStored(devices[0]);
  for (const [status, ok, gone] of [[201, true, false], [200, true, false], [202, true, false], [404, false, true], [410, false, true],
    [400, false, false], [401, false, false], [403, false, false], [413, false, false], [429, false, false], [500, false, false], [503, false, false]]) {
    const p = fakePushService({ devices, reply: () => status });
    const r = await sendPush(sub, testMessage(), { keys, fetch: p.fetch, now: NOW });
    assert.deepEqual([r.ok, r.gone, r.status], [ok, gone, status], String(status));
  }
  const down = fakeFetch([[() => true, () => { throw new TypeError("fetch failed"); }]]);
  assert.deepEqual(await sendPush(sub, testMessage(), { keys, fetch: down, now: NOW }), { ok: false, error: "network", service: "Google FCM" });
  assert.equal(push.deliveries.length, 0);
});

test("push: one push never waits longer than its timeout", async () => {
  const { keys, devices } = await setup(["apple"]);
  const p = fakePushService({ devices, reply: hang });
  const t0 = performance.now();
  const r = await sendPush(asStored(devices[0]), testMessage(), { keys, fetch: p.fetch, now: NOW, timeoutMs: 150 });
  const waited = performance.now() - t0;
  assert.deepEqual(r, { ok: false, error: "timeout", service: "Apple" });
  assert.ok(waited >= 140 && waited < 1000, `waited ${waited} ms`);
  assert.ok(PUSH_TIMEOUT_MS <= 5000, "the production timeout is short");
});

test("push: pushToDevices sends to every device at once, removes only the gone one, and logs nothing personal", async (t) => {
  const out = quiet(t);
  const { store, blobs, devices, push } = await setup(["fcm", "mozilla", "apple", "wns"], (del) => (del.device.kind === "mozilla" ? 410 : del.device.kind === "wns" ? 500 : 201));
  const item = { id: "2026-11-20_abc", date: "2026-11-20", start: 840, service: "Herreklipp", addons: [], name: "Ola Nordmann", phone: "912 34 567" };
  const r = await pushToDevices(store, bookingMessage(item), { fetch: push.fetch, now: NOW, gen: GEN, origin: "https://viggos.test" });
  assert.deepEqual(r, { devices: 3, targets: 4, sent: 2, failed: 1, gone: 1, stale: 0 });
  assert.equal(push.deliveries.length, 4);
  const left = (await readSubscriptions(store)).map((s) => s.endpoint).sort();
  assert.deepEqual(left, devices.filter((d) => d.kind !== "mozilla").map((d) => d.endpoint).sort(), "a 500 keeps the device, a 410 removes it");
  const logged = JSON.stringify([out.log, out.warn, out.error]);
  assert.match(logged, /Mozilla autopush svarte 410/);
  assert.match(logged, /Microsoft WNS svarte 500/);
  const vapid = blobs.json("bookings", VAPID_KEY);
  for (const secret of [...devices.flatMap((d) => [d.endpoint.slice(-24), d.subscription.keys.auth, d.subscription.keys.p256dh]), vapid.privateKey.d, "Ola", "912"]) {
    assert.ok(!logged.includes(secret), `the log must not contain ${secret.slice(0, 12)}…`);
  }
});

test("push: only the one device asked for; an unknown endpoint sends nothing", async () => {
  const { store, devices, push } = await setup(["fcm", "apple"]);
  let r = await pushToDevices(store, testMessage(), { fetch: push.fetch, now: NOW, gen: GEN, endpoint: devices[1].endpoint });
  assert.deepEqual([r.targets, r.sent], [1, 1]);
  assert.deepEqual(push.deliveries.map((d) => d.url), [devices[1].endpoint]);
  r = await pushToDevices(store, testMessage(), { fetch: push.fetch, now: NOW, gen: GEN, endpoint: makeDevice().endpoint });
  assert.deepEqual([r.targets, r.sent], [0, 0]);
  r = await pushToDevices(store, testMessage(), { fetch: push.fetch, now: NOW, gen: GEN, endpoint: "https://evil.test/x" });
  assert.equal(r.targets, 0);
  assert.equal(push.deliveries.length, 1);
});

test("push: without devices nothing is read beyond the device list, and nothing is fetched", async () => {
  const blobs = new FakeBlobs();
  const fetch = fakeFetch();
  const r = await pushToDevices(storeOf(blobs), testMessage(), { fetch, now: NOW, gen: GEN });
  assert.deepEqual(r, { devices: 0, targets: 0, sent: 0, failed: 0, gone: 0, stale: 0 });
  assert.deepEqual(blobs.log.map((e) => e.key), [SUBS_KEY]);
  assert.equal(blobs.has("bookings", VAPID_KEY), false, "sending never makes keys");
  assert.equal(fetch.calls.length, 0);
});

test("push: notifyNewBooking never throws, whatever the store or the push service does", async (t) => {
  const out = quiet(t);
  const { blobs, store, devices } = await setup(["fcm"]);
  const item = { id: "2026-11-20_abc", date: "2026-11-20", start: 840, service: "Herreklipp", addons: [], name: "Ola Nordmann", phone: "912 34 567" };
  blobs.inject({ method: "GET", key: SUBS_KEY, fault: "fail-before", status: 500, times: Infinity });
  assert.deepEqual(await notifyNewBooking(store, item, { fetch: fakePushService({ devices }).fetch, now: NOW, gen: GEN }), { error: true });
  blobs.clearFaults();
  blobs.seed("bookings", SUBS_KEY, "{ broken json with Ola Nordmann");
  assert.deepEqual(await notifyNewBooking(store, item, { fetch: fakePushService({ devices }).fetch, now: NOW, gen: GEN }), { error: true });
  assert.doesNotMatch(JSON.stringify(out.error), /Ola|broken/, "a parse error's message (which quotes stored text) is not logged");
});

// ---------- 6. The text ----------
test("push: a booking's notification says weekday, date, time, service with add-ons and the name, in Norwegian", () => {
  const msg = bookingMessage({ id: "2026-11-20_abc", date: "2026-11-20", start: 840, service: "Herreklipp", addons: ["Vask kort hår", "Styling"], name: "Ola Nordmann", phone: "912 34 567" });
  assert.deepEqual(msg, {
    title: "Ny time",
    body: "Fredag 20. november kl. 14:00 · Herreklipp + Vask kort hår, Styling · Ola Nordmann",
    url: "/admin?dag=2026-11-20",
    tag: "ny-time-2026-11-20_abc",
  });
  assert.doesNotMatch(JSON.stringify(msg), /912/, "the phone number is not sent through the push service");
  // Every weekday and month agrees with Intl's Norwegian names
  const weekday = new Intl.DateTimeFormat("nb-NO", { weekday: "long", timeZone: "UTC" });
  const month = new Intl.DateTimeFormat("nb-NO", { month: "long", timeZone: "UTC" });
  for (let i = 0; i < 400; i += 3) {
    const d = new Date(Date.UTC(2026, 0, 1 + i, 12));
    const date = d.toISOString().slice(0, 10);
    const body = bookingMessage({ id: `${date}_x`, date, start: 605, service: "Barneklipp", addons: [], name: "Kari" }).body;
    const w = weekday.format(d);
    assert.equal(body, `${w[0].toUpperCase()}${w.slice(1)} ${d.getUTCDate()}. ${month.format(d)} kl. 10:05 · Barneklipp · Kari`);
  }
});

// ---------- 7. Tied to the admin password ----------
test("push: devices belong to the admin password they were turned on with; another password never reaches them", async (t) => {
  const out = quiet(t);
  const { store, blobs, devices, push } = await setup(["apple", "fcm"]);
  assert.equal(pushGen("fake-admin-password"), GEN);
  assert.match(GEN, /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(pushGen("another-password"), GEN);
  assert.equal(pushGen(""), null);
  assert.equal(pushGen(undefined), null);
  assert.ok(blobs.json("bookings", SUBS_KEY).subs.every((s) => s.gen === GEN), "each device is stored with its password's gen");
  assert.doesNotMatch(JSON.stringify(blobs.json("bookings", SUBS_KEY)), /fake-admin-password/, "never the password itself");
  // No password (admin not set up): nothing is sent and nothing is deleted
  for (const gen of [undefined, null, ""]) {
    const r = await pushToDevices(store, testMessage(), { fetch: push.fetch, now: NOW, gen });
    assert.deepEqual([r.targets, r.sent, r.stale], [0, 0, 0], String(gen));
  }
  assert.equal(blobs.json("bookings", SUBS_KEY).subs.length, 2);
  assert.deepEqual(await saveSubscription(store, asStored(makeDevice()), { now: NOW }), { error: "Varsler er ikke satt opp: mangler admin-passord.", status: 503 });
  // A new password: the old devices get nothing and are removed
  const r = await pushToDevices(store, testMessage(), { fetch: push.fetch, now: NOW, gen: pushGen("another-password") });
  assert.deepEqual(r, { devices: 0, targets: 0, sent: 0, failed: 0, gone: 0, stale: 2 });
  assert.equal(push.deliveries.length, 0);
  assert.deepEqual(blobs.json("bookings", SUBS_KEY).subs, []);
  assert.doesNotMatch(JSON.stringify(out.warn), new RegExp(devices[0].endpoint.slice(-20)));
});

test("push: saving under a new password drops the old password's devices; reading counts only the current ones", async () => {
  const { store, blobs, devices } = await setup(["apple", "fcm"]);
  const NEW = pushGen("new-password");
  assert.deepEqual((await readSubscriptions(store, { gen: NEW })), []);
  assert.equal((await readSubscriptions(store, { gen: GEN })).length, 2);
  const r = await saveSubscription(store, asStored(devices[0]), { now: NOW, gen: NEW });
  assert.deepEqual(r, { ok: true, created: true, devices: 1 }, "the same browser under a new password is a new device");
  assert.deepEqual(blobs.json("bookings", SUBS_KEY).subs.map((s) => [s.endpoint, s.gen]), [[devices[0].endpoint, NEW]]);
});

test("push: clearSubscriptions leaves no device, and writes nothing when there is none", async () => {
  const { store, blobs } = await setup(["apple", "fcm", "wns"]);
  assert.deepEqual(await clearSubscriptions(store), { ok: true, devices: 0 });
  assert.deepEqual(blobs.json("bookings", SUBS_KEY), { subs: [], gone: [] });
  const writes = blobs.log.filter((e) => e.method === "PUT").length;
  assert.ok(writes >= 4, "the three saves and the clear were writes");
  assert.deepEqual(await clearSubscriptions(store), { ok: true, devices: 0 });
  assert.equal(blobs.log.filter((e) => e.method === "PUT").length, writes);
});

// ---------- 8. An endpoint the push service called gone ----------
// Invariant: an endpoint the push service answered 404/410 for is never stored again (Chrome keeps such a dead
// subscription and /admin would send it again and show «på»); only its hash is kept, at most GONE_MAX of them, for
// GONE_DAYS days; other endpoints are unaffected.
test("push: an endpoint the push service called gone is never stored again", async (t) => {
  quiet(t);
  for (const status of [404, 410]) {
    const { store, blobs, devices, push } = await setup(["fcm", "apple"], (del) => (del.device.kind === "fcm" ? status : 201));
    const [dead, alive] = devices;
    const r = await pushToDevices(store, testMessage(), { fetch: push.fetch, now: NOW, gen: GEN });
    assert.deepEqual([r.sent, r.gone, r.devices], [1, 1, 1], String(status));
    assert.deepEqual(await saveSubscription(store, asStored(dead), { now: NOW, gen: GEN }),
      { error: "Denne enheten kan ikke lenger få varsler. Trykk «Slå på varsler» igjen.", status: 410, code: "gone" });
    assert.deepEqual((await readSubscriptions(store, { gen: GEN })).map((s) => s.endpoint), [alive.endpoint], "the dead one stays out");
    assert.deepEqual(await saveSubscription(store, asStored(alive), { now: NOW, gen: GEN }), { ok: true, created: false, devices: 1 });
    const fresh = makeDevice("fcm"); // the same browser after «Slå på varsler»: a new endpoint
    assert.equal((await saveSubscription(store, asStored(fresh), { now: NOW, gen: GEN })).created, true);
    const stored = JSON.stringify(blobs.json("bookings", SUBS_KEY));
    assert.ok(!stored.includes(dead.endpoint) && !stored.includes(dead.endpoint.slice(-30)), "only a hash of the dead endpoint is stored");
    assert.equal(blobs.json("bookings", SUBS_KEY).gone.length, 1);
  }
});

test("push: at most GONE_MAX gone endpoints are remembered, for GONE_DAYS days", async () => {
  const blobs = new FakeBlobs();
  const store = storeOf(blobs);
  const dead = Array.from({ length: GONE_MAX + 5 }, () => makeDevice("mozilla"));
  for (const [i, d] of dead.entries()) await removeSubscriptions(store, [d.endpoint], { gone: true, now: new Date(NOW.getTime() + i * 1000) });
  const gone = blobs.json("bookings", SUBS_KEY).gone;
  assert.equal(gone.length, GONE_MAX);
  const later = new Date(NOW.getTime() + 3600e3);
  assert.equal((await saveSubscription(store, asStored(dead[0]), { now: later, gen: GEN })).created, true, "the oldest ones fell off the list");
  assert.equal((await saveSubscription(store, asStored(dead.at(-1)), { now: later, gen: GEN })).status, 410);
  const afterDays = new Date(NOW.getTime() + GONE_DAYS * 24 * 3600e3 + 3600e3);
  assert.equal((await saveSubscription(store, asStored(dead.at(-1)), { now: afterDays, gen: GEN })).created, true, `forgotten after ${GONE_DAYS} days`);
  assert.ok(blobs.json("bookings", SUBS_KEY).gone.length < GONE_MAX, "old entries are cleaned away on the next write");
  // «Slå av varsler på alle andre enheter» keeps the list
  await removeSubscriptions(store, [dead[1].endpoint], { gone: true, now: afterDays });
  await clearSubscriptions(store);
  assert.equal((await saveSubscription(store, asStored(dead[1]), { now: afterDays, gen: GEN })).status, 410);
});
