// SPEC R4, NEW-pii-keys: every key the server writes has a deletion rule, and no key name holds a phone number or
// an IP address. The handlers run for real on FakeBlobs: a web booking, a failed and a good login, an admin create
// and edit, the calendar link, a push device, cancel-phone, the customer's .ics and the daily clean-up. Then every
// key in every store must match a row in netlify/lib/store-keys.mjs KEY_RULES (with a non-empty deletion rule).
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { FakeBlobs } from "../helpers/fake-blobs.mjs";
import { FakeClock } from "../helpers/clock.mjs";
import { fakeFetch } from "../helpers/fake-fetch.mjs";
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
import * as stats from "../../netlify/functions/stats.mjs";
import { getReviews, STALE_LIMIT_MS } from "../../netlify/lib/reviews.mjs";
import { buildFeed, KEEP_POSTS_MS } from "../../netlify/lib/social.mjs";

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
  // A page view from Instagram (visitor statistics) and the barber reading them
  const view = await stats.handle(request("/api/hit", { method: "POST", body: JSON.stringify({ p: "/", r: "l.instagram.com" }),
    headers: { "Content-Type": "text/plain", "User-Agent": "Mozilla/5.0 (iPhone) Safari/604.1", "X-Nf-Client-Connection-Ip": IP } }), ctx(IP), d);
  assert.equal(view.status, 204);
  assert.equal((await call(stats, "/api/stats", { token })).status, 200);
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
  assert.deepEqual(d.blobs.keys("stats"), ["d/2026-11-12"]);
  // Fix-up round 2 (demo-counters.test.mjs): the privacy facts said the counters store «bare tidspunkter», but every
  // hit also stores an id (for a web booking derived from its request). A row that lists its fields must name every
  // field the handlers actually store under it, as paths: «hits[].t», «alertedAt».
  const fieldProblems = [];
  for (const store of stores) {
    for (const key of d.blobs.keys(store)) {
      const rule = ruleFor(store, key);
      if (!rule || !rule.fields) continue;
      for (const f of fieldPaths(d.blobs.json(store, key))) if (!rule.fields.includes(f)) fieldProblems.push(`${store} ${key}: stores «${f}», not in its row's fields ${JSON.stringify(rule.fields)}`);
    }
  }
  assert.deepEqual(fieldProblems, []);
  for (const prefix of ["rl/", "d/"]) assert.ok(KEY_RULES.some((r) => r.prefix === prefix && Array.isArray(r.fields)), `the ${prefix} row lists its fields`);
});
// Field paths in a stored JSON document: top-level names, and «name[].sub» for arrays of objects
function fieldPaths(doc) {
  const out = new Set();
  for (const [k, v] of Object.entries(doc || {})) {
    if (Array.isArray(v) && v.some((x) => x && typeof x === "object")) for (const x of v) for (const sub of Object.keys(x || {})) out.add(`${k}[].${sub}`);
    else out.add(k);
  }
  return [...out];
}

test("store keys: the Google reviews and Instagram code writes only keys with a deletion rule, and the rows name its limits", async (t) => {
  quiet(t);
  const DAY = 24 * 60 * 60 * 1000;
  const clock = new FakeClock(NOW);
  const blobs = new FakeBlobs({ clock });
  const google = { down: false };
  const fetch = fakeFetch([
    ["https://places.googleapis.com/v1/places:searchText", () => ({ places: [{ id: "ChIJFixture", displayName: { text: "Viggos Barbershop Kurti" }, formattedAddress: "Violgata 22, 1776 Halden" }] })],
    [/^https:\/\/places\.googleapis\.com\/v1\/places\//, () => (google.down ? new Response("{}", { status: 403 }) : { rating: 5, userRatingCount: 7, reviews: [{ rating: 5, text: { text: "Bra" }, authorAttribution: { displayName: "Fixture Kunde" } }] })],
    ["https://graph.instagram.com/refresh_access_token", () => ({ access_token: "IGFixture2", expires_in: 5183944 })],
    ["https://graph.instagram.com/me/media", () => ({ data: [{ id: "1", caption: "Klipp", media_type: "IMAGE", media_url: "https://cdn.test/1.jpg", permalink: "https://www.instagram.com/p/1/" }] })],
  ]);
  const reviews = blobs.getStore("reviews");
  const social = blobs.getStore("social");
  await getReviews({ GOOGLE_PLACES_API_KEY: "fixture-key" }, reviews, fetch, { now: clock.date() });
  await buildFeed(social, { INSTAGRAM_ACCESS_TOKEN: "IGFixture1" }, fetch, { now: clock.date() });
  // Google fails for longer than the limit: the names and texts leave the store
  google.down = true;
  clock.advance(STALE_LIMIT_MS + DAY);
  await getReviews({ GOOGLE_PLACES_API_KEY: "fixture-key" }, reviews, fetch, { now: clock.date() });
  assert.ok(!blobs.text("reviews", "reviews").includes("Fixture Kunde"));

  assert.deepEqual(blobs.keys("reviews"), ["place-id", "reviews"]);
  assert.deepEqual(blobs.keys("social"), ["feed", "instagram-token"]);
  for (const store of ["reviews", "social"]) {
    for (const key of blobs.keys(store)) assert.ok(ruleFor(store, key) && ruleFor(store, key).deletion, `${store} ${key} has a deletion rule`);
  }
  assert.equal(STALE_LIMIT_MS, 3 * DAY);
  assert.match(ruleFor("reviews", "reviews").deletion, /3 days after the last good fetch/);
  assert.equal(KEEP_POSTS_MS, 2 * DAY);
  assert.match(ruleFor("social", "feed").deletion, /at most 2 days after the last good fetch/);
  assert.match(ruleFor("social", "instagram-token").deletion, /INSTAGRAM_ACCESS_TOKEN changes/);
  assert.ok(ruleFor("social", "oauth-state-" + "a".repeat(48)), "unfinished Instagram connections have a row too");
});
