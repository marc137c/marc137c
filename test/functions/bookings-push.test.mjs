// Every new booking made on the website notifies every device the barber turned notifications on for (owner
// decision 2b). The devices subscribe through the real /admin handler, the push service is fake, the clock fixed.
// Invariants:
//   1. every new web booking reaches every subscribed device exactly once, as «Ny time» with weekday, date, time,
//      service (+ add-ons) and the customer's name, opening /admin on that day; each message decrypts with the
//      device's private key, and its VAPID JWT verifies with the key /admin subscribed with;
//   2. a new booking never waits for push when the platform can finish work after the reply (context.waitUntil),
//      and never more than BOOKING_PUSH_WAIT_MS when it cannot;
//   3. push never fails a booking: a failing, hanging or unreachable push service, a store failure or missing keys
//      still give 201 with the booking stored, and the log has no name, phone or endpoint;
//   4. a device the push service reports gone (404/410) is removed; the others keep getting notified;
//   5. no notification without a new web booking: taken, invalid, rate-limited, honeypot, cross-site and
//      admin-made bookings send nothing;
//   6. a deploy preview notifies only its own devices, production only the live ones (F10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, SITE, PRODUCTION, PREVIEW } from "../helpers/deps.mjs";
import { storedItems, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { makeDevice, fakePushService, gate } from "../helpers/fake-push.mjs";
import { fakeFetch } from "../helpers/fake-fetch.mjs";
import { makeToken } from "../../netlify/lib/booking-core.mjs";
import { VAPID_KEY, SUBS_KEY, BOOKING_PUSH_WAIT_MS } from "../../netlify/lib/push.mjs";
import { afterResponse } from "../../netlify/lib/runtime.mjs";
import * as bookings from "../../netlify/functions/bookings.mjs";
import * as admin from "../../netlify/functions/admin.mjs";

const PASSWORD = "fake-admin-password";
const NOW = "2026-11-12T09:00:00Z"; // Thursday 10:00 in Oslo
const BODY = { service: "Herreklipp", date: "2026-11-13", start: 600, addons: ["Styling"], name: "Ola Nordmann", phone: CUSTOMER_PHONE };

const auth = (d) => ({ Authorization: "Bearer " + makeToken(PASSWORD, d.clock.now()) });
const adminCall = (d, path, { method = "POST", json, ctx = PRODUCTION } = {}) =>
  admin.handle(request(path, { method, json, headers: auth(d) }), ctx, d).then(read);
const book = (d, body = BODY, ctx = PRODUCTION) =>
  bookings.handle(request("/api/bookings", { method: "POST", json: body }), ctx, d).then(read);

// A site with the given devices subscribed through /admin (as «Slå på varsler» does)
async function site(kinds, { reply, ctx = PRODUCTION, devices } = {}) {
  devices = devices || kinds.map(makeDevice);
  const push = fakePushService({ devices, reply });
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PASSWORD }, fetch: push.fetch });
  const { publicKey } = (await adminCall(d, "/api/admin/push", { method: "GET", ctx })).body;
  for (const dev of devices) assert.equal((await adminCall(d, "/api/admin/push/subscribe", { json: { subscription: dev.subscription }, ctx })).status, 201);
  return Object.assign(d, { push, devices, publicKey });
}

test("booking push: a new web booking reaches every subscribed device exactly once, readable only there", async () => {
  const d = await site(["apple", "fcm", "mozilla"]);
  const res = await book(d);
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.body).sort(), ["booking", "ok"], "the customer's reply is unchanged");
  const { id } = res.body.booking;
  assert.equal(d.push.deliveries.length, 3);
  assert.deepEqual(d.push.deliveries.map((x) => x.url).sort(), d.devices.map((x) => x.endpoint).sort(), "each device once");
  for (const del of d.push.deliveries) {
    assert.equal(del.error, undefined, del.error);
    assert.deepEqual(del.payload, {
      title: "Ny time",
      body: "Fredag 13. november kl. 10:00 · Herreklipp + Styling · Ola Nordmann",
      url: "/admin?dag=2026-11-13",
      tag: `ny-time-${id}`,
    });
    assert.equal(del.vapid.ok, true, del.vapid.why);
    assert.equal(del.vapid.k, d.publicKey, "signed with the key the devices subscribed with");
    assert.equal(del.vapid.claims.aud, new URL(del.url).origin);
    assert.equal(del.vapid.claims.sub, SITE);
    assert.equal(del.headers.urgency, "high");
    assert.doesNotMatch(JSON.stringify(del.payload), /912/, "the phone number does not travel through the push service");
  }
  // The next booking: again every device once
  const second = await book(d, { ...BODY, start: 660, name: "Kari Nordmann", phone: "41234567", addons: [] });
  assert.equal(second.status, 201);
  assert.equal(d.push.deliveries.length, 6);
  for (const dev of d.devices) assert.equal(d.push.deliveries.filter((x) => x.url === dev.endpoint).length, 2, dev.kind);
  assert.equal(d.push.deliveries[5].payload.body, "Fredag 13. november kl. 11:00 · Herreklipp · Kari Nordmann");
});

test("booking push: with context.waitUntil the reply never waits for push", async () => {
  const g = gate();
  const d = await site(["apple", "fcm"], { reply: g.reply });
  const pending = [];
  const ctx = { ...PRODUCTION, waitUntil: (p) => { pending.push(p); } };
  const t0 = performance.now();
  const res = await book(d, BODY, ctx); // the push service has not answered (and will not until the gate opens)
  const waited = performance.now() - t0;
  assert.equal(res.status, 201);
  assert.ok(waited < 1000, `the reply took ${waited} ms`);
  assert.equal(storedItems(d.blobs).length, 1);
  assert.equal(pending.length, 1, "the push is handed to waitUntil");
  g.open(201);
  const summary = await pending[0];
  assert.equal(d.push.deliveries.length, 2, "and still delivered after the reply");
  assert.equal(summary.sent, 2, "waitUntil gets the push itself (a promise that never rejects)");
});

test(`booking push: without waitUntil a booking waits at most BOOKING_PUSH_WAIT_MS (${BOOKING_PUSH_WAIT_MS} ms) for push`, async () => {
  assert.ok(BOOKING_PUSH_WAIT_MS <= 2000, "the limit itself is short");
  const g = gate();
  const d = await site(["apple"], { reply: g.reply });
  const t0 = performance.now();
  const res = await book(d); // the push service hangs
  const waited = performance.now() - t0;
  g.open(201);
  assert.equal(res.status, 201);
  assert.equal(storedItems(d.blobs).length, 1);
  assert.ok(waited < BOOKING_PUSH_WAIT_MS + 500, `the booking waited ${waited} ms`);
  assert.ok(waited >= BOOKING_PUSH_WAIT_MS - 50, `it does give push its chance (${waited} ms)`);
});

test("booking push: afterResponse never lets the work's failure out, and bounds the wait", async () => {
  await afterResponse(undefined, Promise.reject(new Error("boom")), 50);
  await afterResponse({ waitUntil: () => { throw new Error("no"); } }, Promise.reject(new Error("boom")), 50);
  const handed = [];
  await afterResponse({ waitUntil: (p) => handed.push(p) }, Promise.reject(new Error("boom")), 50);
  assert.equal(await handed[0], undefined);
  const t0 = performance.now();
  await afterResponse(undefined, new Promise(() => {}), 80);
  assert.ok(performance.now() - t0 < 600);
});

const failures = [
  ["the push service answers 500", (d) => d, { reply: () => 500 }],
  ["the push service cannot be reached", (d) => { d.fetch = fakeFetch([[() => true, () => { throw new TypeError("fetch failed"); }]]); return d; }],
  ["the device list cannot be read", (d) => { d.blobs.inject({ method: "GET", key: SUBS_KEY, fault: "fail-before", status: 500, times: Infinity }); return d; }],
  ["the key pair is missing", (d) => { d.blobs.remove("bookings", VAPID_KEY); return d; }],
  ["the device list is broken JSON", (d) => { d.blobs.seed("bookings", SUBS_KEY, "{ not json"); return d; }],
];
for (const [label, breakIt, opts] of failures) {
  test(`booking push: when ${label}, the booking still succeeds and the log has nothing personal`, async (t) => {
    const out = quiet(t);
    const d = breakIt(await site(["apple", "wns"], opts));
    const res = await book(d);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(storedItems(d.blobs).map((i) => i.name), ["Ola Nordmann"]);
    const logged = JSON.stringify([out.log, out.warn, out.error]);
    assert.notEqual(logged, "[[],[],[]]", "the failure is logged");
    for (const secret of ["Ola", "Nordmann", "912", ...d.devices.map((x) => x.endpoint.slice(-24))]) {
      assert.ok(!logged.includes(secret), `the log must not contain ${secret}`);
    }
  });
}

test("booking push: a device the push service reports gone is removed; the others keep getting notified", async (t) => {
  quiet(t);
  const devices = ["apple", "fcm", "mozilla"].map(makeDevice);
  const d = await site(null, { devices, reply: (del) => (del.device === devices[1] ? 410 : 201) });
  assert.equal((await book(d)).status, 201);
  assert.equal(d.push.deliveries.length, 3);
  assert.deepEqual(d.blobs.json("bookings", SUBS_KEY).subs.map((s) => s.endpoint).sort(), [devices[0].endpoint, devices[2].endpoint].sort());
  assert.equal((await book(d, { ...BODY, start: 660, phone: "41234567" })).status, 201);
  assert.deepEqual(d.push.deliveries.slice(3).map((x) => x.url).sort(), [devices[0].endpoint, devices[2].endpoint].sort());
});

test("booking push: nothing is sent without a new web booking", async (t) => {
  quiet(t);
  const d = await site(["apple"]);
  const sent = () => d.push.deliveries.length;
  assert.equal((await book(d)).status, 201);
  assert.equal(sent(), 1);
  const refused = [
    ["taken", () => book(d, { ...BODY, name: "Kari", phone: "41111111" }), 409],
    ["invalid service", () => book(d, { ...BODY, service: "Nope" }), 400],
    ["too early today", () => book(d, { ...BODY, date: "2026-11-12", start: 630 }), 400],
    ["honeypot", () => book(d, { ...BODY, start: 900, botField: "x" }), 200],
    ["cross-site", () => bookings.handle(request("/api/bookings", { method: "POST", json: { ...BODY, start: 900 }, headers: { "Sec-Fetch-Site": "cross-site" } }), PRODUCTION, d).then(read), 403],
    ["not JSON", () => bookings.handle(request("/api/bookings", { method: "POST", body: "x", headers: { "Content-Type": "text/plain" } }), PRODUCTION, d).then(read), 415],
  ];
  for (const [label, run, status] of refused) {
    assert.equal((await run()).status, status, label);
    assert.equal(sent(), 1, label);
  }
  // The same phone number may book 3 times in 24 h (F2): the 4th is refused, and sends nothing
  assert.equal((await book(d, { ...BODY, start: 660 })).status, 201);
  assert.equal((await book(d, { ...BODY, start: 720 })).status, 201);
  assert.equal(sent(), 3);
  assert.equal((await book(d, { ...BODY, start: 780 })).status, 429);
  assert.equal(sent(), 3, "a rate-limited booking sends nothing");
  // A booking the barber makes himself in /admin sends nothing
  const made = await adminCall(d, "/api/admin/items", { json: { date: "2026-11-14", start: 600, dur: 30, service: "Herreklipp", name: "Per", phone: "41234568" } });
  assert.equal(made.status, 201);
  assert.equal(sent(), 3);
});

test("booking push: a preview booking notifies only the preview's devices; a live booking only the live ones (F10)", async () => {
  const live = makeDevice("apple"), preview = makeDevice("fcm");
  const push = fakePushService({ devices: [live, preview] });
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PASSWORD }, fetch: push.fetch });
  await adminCall(d, "/api/admin/push", { method: "GET" });
  await adminCall(d, "/api/admin/push/subscribe", { json: { subscription: live.subscription } });
  await adminCall(d, "/api/admin/push", { method: "GET", ctx: PREVIEW });
  await adminCall(d, "/api/admin/push/subscribe", { json: { subscription: preview.subscription }, ctx: PREVIEW });
  assert.equal((await book(d, BODY, PREVIEW)).status, 201);
  assert.deepEqual(push.deliveries.map((x) => x.url), [preview.endpoint]);
  assert.equal((await book(d, { ...BODY, start: 660 }, PRODUCTION)).status, 201);
  assert.deepEqual(push.deliveries.map((x) => x.url), [preview.endpoint, live.endpoint]);
  assert.ok(push.deliveries.every((x) => x.vapid.ok && !x.error));
  assert.notEqual(push.deliveries[0].vapid.k, push.deliveries[1].vapid.k, "each deploy signs with its own key");
});

test("booking push: without any device a booking makes no network call and no key pair", async () => {
  const d = testDeps({ now: NOW });
  assert.equal((await book(d)).status, 201);
  assert.equal(d.fetch.calls.length, 0);
  assert.equal(d.blobs.has("bookings", VAPID_KEY), false);
});
