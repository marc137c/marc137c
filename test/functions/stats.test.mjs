// Visitor and booking statistics without cookies (owner request 2026-11-16; the owner's only since 2026-11-17, merged
// from main 7110b71/6bf86e8, whose test/stats.test.mjs cases live here and in test/lib/stats-bookings.test.mjs).
// POST /api/hit counts one page view; GET /api/stats gives the owner's overview (oversikt/) the numbers. Through
// handle(req, context, deps) on FakeBlobs. Invariants:
//   1. a hit stores only counts in ONE document per Oslo date, d/YYYY-MM-DD: views, views per page (forside,
//      personvern), and for a VISIT (a view not reached from another page of the same site) visits and the visit's
//      source category (instagram, facebook, google, tiktok, direkte, annet); never an IP, a user agent, a referrer
//      address, an ID or a cookie; the reply is 204 with no body and no Set-Cookie;
//   2. concurrent hits are all counted (conflict-safe writes), and a damaged day document does not lose the hit;
//   3. bots, deploy previews, branch deploys, calls without a deploy context and retired deploys count nothing and
//      open no store; a cross-site POST counts nothing;
//   4. a body over 1 kB is refused (413) without being read in full, and counts nothing;
//   5. GET /api/stats answers ONLY to X-Stats-Key = STATS_READ_KEY (compared in constant time); the barber's admin
//      token, a wrong key or an unset key get 401 before any store is opened;
//   6. it reads the injected clock's last 7, 30 or 90 Oslo days (30 for anything else), with booking numbers read
//      from the bookings; an unreadable day is 503 without numbers, unreadable bookings are null (unknown), never 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION, PREVIEW, BRANCH } from "../helpers/deps.mjs";
import { item, seedItems } from "../helpers/bookings.mjs";
import { makeToken, retryDelay } from "../../netlify/lib/booking-core.mjs";
import * as stats from "../../netlify/functions/stats.mjs";
import * as bookings from "../../netlify/functions/bookings.mjs";
import * as admin from "../../netlify/functions/admin.mjs";

const PW = "fake-admin-password";
const KEY = "fake-owner-stats-key";
const ENV = { ADMIN_PASSWORD: PW, STATS_READ_KEY: KEY };
const NOW = "2026-11-12T09:00:00Z"; // 10:00 in Oslo
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const RETIRED = { deploy: { context: "production", id: "old", published: false } };

const hit = (d, body = { p: "/", r: "" }, { ctx = PRODUCTION, ua = UA, headers = {} } = {}) => stats.handle(request("/api/hit", {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "text/plain", "User-Agent": ua, ...headers },
}), ctx, d).then(read);
const getStats = (d, headers = { "X-Stats-Key": KEY }, { ctx = PRODUCTION, query = "" } = {}) =>
  stats.handle(request("/api/stats" + query, { headers }), ctx, d).then(read);
const day = (d, date) => d.blobs.json("stats", `d/${date}`);

test("stats: paths", () => {
  assert.deepEqual(stats.config, { path: ["/api/hit", "/api/stats"] });
});

test("stats: a visit's source comes from the referrer's host; a view from the site itself is internal", () => {
  assert.equal(stats.isInternal("www.viggosbarbershop.no", "www.viggosbarbershop.no"), true);
  assert.equal(stats.isInternal("viggosbarbershop.no", "www.viggosbarbershop.no"), true);
  assert.equal(stats.isInternal("", "www.viggosbarbershop.no"), false);
  assert.equal(stats.isInternal("l.instagram.com", "www.viggosbarbershop.no"), false);
  assert.equal(stats.sourceOf(""), "direkte");
  assert.equal(stats.sourceOf("l.instagram.com"), "instagram");
  assert.equal(stats.sourceOf("m.facebook.com"), "facebook");
  assert.equal(stats.sourceOf("lm.fb.me"), "facebook");
  assert.equal(stats.sourceOf("www.google.no"), "google");
  assert.equal(stats.sourceOf("www.tiktok.com"), "tiktok");
  assert.equal(stats.sourceOf("notgoogle.example"), "annet");
});

test("stats: the read key must be set and equal", () => {
  assert.equal(stats.keyMatches("abc", "abc"), true);
  assert.equal(stats.keyMatches("abd", "abc"), false);
  assert.equal(stats.keyMatches("abcd", "abc"), false);
  assert.equal(stats.keyMatches("", "abc"), false);
  assert.equal(stats.keyMatches("abc", undefined), false);
  assert.equal(stats.keyMatches(null, ""), false);
});

test("stats: a hit stores only counts per page, and visits per source, in the day's document; 204 with no cookie", async () => {
  const d = testDeps({ now: NOW, env: ENV });
  const res = await hit(d, { p: "/", r: "" }, { headers: { "X-Nf-Client-Connection-Ip": "198.51.100.7" } });
  assert.equal(res.status, 204);
  assert.equal(res.body, "");
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal(res.headers["cache-control"], "no-store");
  await hit(d, { p: "/personvern.html", r: "www.google.no" });
  await hit(d, { p: "/index.html", r: "l.instagram.com" });
  await hit(d, { p: "/", r: "viggos.test" });     // from another page of this site: a view, not a visit
  await hit(d, { p: "/", r: "www.viggos.test" }); // the same with www
  await hit(d, { p: "/", r: "evil.example" });
  assert.deepEqual(day(d, "2026-11-12"), {
    views: 6,
    visits: 4,
    pages: { forside: 5, personvern: 1 },
    sources: { direkte: 1, google: 1, instagram: 1, annet: 1 },
  });
  const raw = d.blobs.text("stats", "d/2026-11-12");
  for (const secret of ["198.51.100.7", "iPhone", "google.no", "evil.example", "instagram.com", "viggos.test"]) assert.ok(!raw.includes(secret), secret);
  assert.deepEqual(d.blobs.keys("stats"), ["d/2026-11-12"]);
  assert.deepEqual([...new Set(d.blobs.opened.map((o) => o.name))], ["stats"]);
});

test("stats: concurrent hits are all counted", async () => {
  const saved = retryDelay.ms;
  retryDelay.ms = () => Math.random() * 3;
  try {
    const d = testDeps({ now: NOW });
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => hit(d, { p: "/", r: i % 2 ? "m.facebook.com" : "" })));
    assert.ok(rs.every((r) => r.status === 204));
    assert.deepEqual(day(d, "2026-11-12"), { views: 12, visits: 12, pages: { forside: 12 }, sources: { facebook: 6, direkte: 6 } });
  } finally { retryDelay.ms = saved; }
});

test("stats: a damaged day document does not lose the hit, and a day from before visits were counted gets them from its sources", async () => {
  const d = testDeps({ now: NOW });
  d.blobs.seed("stats", "d/2026-11-12", { views: 7, pages: null, sources: { google: "x", __proto__x: 1 } });
  await hit(d, { p: "/", r: "www.google.com" });
  assert.deepEqual(day(d, "2026-11-12"), { views: 8, visits: 1, pages: { forside: 1 }, sources: { google: 1 } });
  d.blobs.seed("stats", "d/2026-11-12", { views: 5, pages: { forside: 5 }, sources: { direkte: 3, google: 2 } });
  await hit(d, { p: "/", r: "www.google.no" });
  await hit(d, { p: "/personvern.html", r: "viggos.test" });
  assert.deepEqual(day(d, "2026-11-12"), { views: 7, visits: 6, pages: { forside: 6, personvern: 1 }, sources: { direkte: 3, google: 3 } });
});

test("stats: one document per Oslo date, whatever the time of day", async () => {
  const d = testDeps({ now: "2026-11-12T22:59:00Z" }); // 23:59 in Oslo
  for (let i = 0; i < 30; i++) await hit(d);
  d.clock.advance(2 * 60e3);                           // 00:01 on the 13th in Oslo
  await hit(d);
  assert.deepEqual(d.blobs.keys("stats"), ["d/2026-11-12", "d/2026-11-13"]);
  assert.equal(day(d, "2026-11-12").views, 30);
  assert.equal(day(d, "2026-11-13").views, 1);
});

for (const [label, opts] of [
  ["Googlebot", { ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }],
  ["HeadlessChrome", { ua: "Mozilla/5.0 HeadlessChrome/120.0" }],
  ["curl", { ua: "curl/8.4.0" }],
  ["no user agent", { ua: "" }],
  ["a deploy preview", { ctx: PREVIEW }],
  ["a branch deploy", { ctx: BRANCH }],
  ["a context without deploy info", { ctx: {} }],
  ["a call without a context", { ctx: null }],
  ["a retired deploy", { ctx: RETIRED }],
  ["a cross-site POST", { headers: { "Sec-Fetch-Site": "cross-site" } }],
]) {
  test(`stats: ${label} counts nothing and opens no store`, async () => {
    const d = testDeps({ now: NOW });
    const res = await hit(d, { p: "/", r: "" }, opts);
    assert.equal(res.status, 204);
    assert.deepEqual(d.blobs.opened, []);
    assert.deepEqual(d.blobs.log, []);
  });
}

test("stats: a body over 1 kB is refused with 413 and counts nothing", async () => {
  const d = testDeps({ now: NOW });
  assert.equal((await hit(d, JSON.stringify({ p: "/", r: "x".repeat(2000) }))).status, 413);
  assert.equal((await hit(d, "x".repeat(100000))).status, 413);
  assert.equal((await hit(d, "{}", { headers: { "Content-Length": "999999" } })).status, 413);
  assert.deepEqual(d.blobs.log, []);
  assert.equal((await hit(d, "not json")).status, 204, "a small unreadable body counts as the front page");
  assert.equal(day(d, "2026-11-12").views, 1);
});

test("stats: only POST on /api/hit and GET on /api/stats", async () => {
  const d = testDeps({ now: NOW, env: ENV });
  assert.equal((await read(await stats.handle(request("/api/hit"), PRODUCTION, d))).status, 405);
  assert.equal((await read(await stats.handle(request("/api/stats", { method: "POST", json: {}, headers: { "X-Stats-Key": KEY } }), PRODUCTION, d))).status, 405);
});

test("stats: GET /api/stats is the owner's only: the barber's admin token, a wrong key or no key get 401 and open no store", async () => {
  const d = testDeps({ now: NOW, env: ENV });
  assert.equal((await getStats(d, { Authorization: "Bearer " + makeToken(PW, d.clock.now()) })).status, 401);
  assert.equal((await getStats(d, { "X-Stats-Key": "wrong" })).status, 401);
  assert.equal((await getStats(d, {})).status, 401);
  assert.equal((await getStats(testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } }), { "X-Stats-Key": "" })).status, 401, "no STATS_READ_KEY set");
  assert.equal((await getStats(testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } }), { "X-Stats-Key": "undefined" })).status, 401);
  assert.deepEqual(d.blobs.opened, []);
  assert.equal((await getStats(d, { "X-Stats-Key": KEY }, { ctx: RETIRED })).status, 410);
  assert.equal((await getStats(d)).status, 200);
});

test("stats: GET /api/stats sums the last 30 Oslo days from the injected clock, views and visits apart", async () => {
  const d = testDeps({ now: NOW, env: ENV });
  d.blobs.seed("stats", "d/2026-11-12", { views: 4, visits: 3, pages: { forside: 4 }, sources: { google: 2, direkte: 1 } });
  d.blobs.seed("stats", "d/2026-11-06", { views: 2, pages: { forside: 2 }, sources: { instagram: 2 } }); // from before visits
  d.blobs.seed("stats", "d/2026-10-14", { views: 10, visits: 10, pages: { forside: 10 }, sources: { annet: 10 } }); // 29 days ago
  d.blobs.seed("stats", "d/2026-10-13", { views: 99, visits: 99, pages: { forside: 99 }, sources: { annet: 99 } }); // 30 days ago: out
  const res = await getStats(d);
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.body.site, "viggos.test");
  assert.equal(res.body.today, "2026-11-12");
  assert.equal(res.body.range, 30);
  assert.deepEqual(res.body.totals, { today: 4, week: 6, month: 16, views: 16, visits: 15 });
  assert.deepEqual(res.body.sources, { instagram: 2, facebook: 0, google: 2, tiktok: 0, direkte: 1, annet: 10 });
  assert.equal(res.body.days.length, 30);
  assert.deepEqual(res.body.days[0], { date: "2026-11-12", views: 4, visits: 3, sources: { google: 2, direkte: 1 }, bookings: { web: 0, admin: 0, cancelled: 0 } });
});

test("stats: ?days=7 and ?days=90 choose the period; anything else is 30", async () => {
  const d = testDeps({ now: NOW, env: ENV });
  d.blobs.seed("stats", "d/2026-11-12", { views: 1, visits: 1, pages: { forside: 1 }, sources: { direkte: 1 } });
  d.blobs.seed("stats", "d/2026-11-01", { views: 2, visits: 2, pages: { forside: 2 }, sources: { google: 2 } });  // 11 days ago
  d.blobs.seed("stats", "d/2026-08-20", { views: 5, visits: 5, pages: { forside: 5 }, sources: { tiktok: 5 } }); // 84 days ago
  const week = (await getStats(d, undefined, { query: "?days=7" })).body;
  assert.equal(week.range, 7);
  assert.equal(week.days.length, 30, "the 30 days stay, so totals.month is always there");
  assert.deepEqual([week.totals.views, week.totals.visits, week.totals.month], [1, 1, 3]);
  assert.deepEqual(week.sources, { instagram: 0, facebook: 0, google: 0, tiktok: 0, direkte: 1, annet: 0 });
  const quarter = (await getStats(d, undefined, { query: "?days=90" })).body;
  assert.equal(quarter.range, 90);
  assert.equal(quarter.days.length, 90);
  assert.deepEqual([quarter.totals.views, quarter.sources.tiktok], [8, 5]);
  for (const q of ["?days=12", "?days=-1", "?days=abc", ""]) assert.equal((await getStats(d, undefined, { query: q })).body.range, 30, q);
});

test("stats: booking numbers are read from the bookings (website vs admin, cancelled, services, weekdays, next 7 days)", async () => {
  const d = testDeps({ now: NOW, env: ENV });
  seedItems(d.blobs, [
    item({ date: "2026-11-14", createdAt: "2026-11-12T08:00:00.000Z" }),
    item({ date: "2026-11-16", createdAt: "2026-11-12T08:30:00.000Z", source: "admin", service: "Full service" }),
    item({ date: "2026-11-17", createdAt: "2026-11-11T08:00:00.000Z", status: "cancelled" }),
    item({ date: "2026-11-13", createdAt: "2026-11-11T09:00:00.000Z", type: "block" }),
  ]);
  const res = await getStats(d, undefined, { query: "?days=7" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.days[0].bookings, { web: 1, admin: 1, cancelled: 0 });
  assert.deepEqual(res.body.days[1].bookings, { web: 1, admin: 0, cancelled: 1 });
  assert.deepEqual(res.body.bookings, { web: 2, admin: 1, cancelled: 1, services: { Herreklipp: 1, "Full service": 1 }, weekdays: [0, 1, 0, 0, 0, 0, 1], upcoming7: 2 });
  // Nothing about a customer in the reply
  for (const secret of ["Ola", "912 34 567", "seed"]) assert.ok(!JSON.stringify(res.body).includes(secret), secret);
  // The booking store is only read
  assert.deepEqual(d.blobs.log.filter((e) => e.store === "bookings" && e.method !== "GET"), []);
});

test("stats: GET /api/stats answers 503 without numbers when a day's document cannot be read", async (t) => {
  quiet(t);
  const d = testDeps({ now: "2026-11-16T09:00:00Z", env: ENV });
  d.blobs.seed("stats", "d/2026-11-16", { views: 37, visits: 37, pages: { forside: 37 }, sources: { direkte: 37 } });
  d.blobs.inject({ method: "GET", key: "d/2026-11-16", fault: "fail-before", status: 500, times: Infinity });
  const res = await getStats(d);
  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: "Kunne ikke hente statistikken." });
  d.blobs.clearFaults();
  assert.equal((await getStats(d)).body.totals.today, 37);
});

test("stats: unreadable bookings make the booking numbers null (unknown), never 0, and the visits still come", async (t) => {
  const out = quiet(t);
  const d = testDeps({ now: NOW, env: ENV });
  d.blobs.seed("stats", "d/2026-11-12", { views: 3, visits: 2, pages: { forside: 3 }, sources: { direkte: 2 } });
  seedItems(d.blobs, [item({ date: "2026-11-14", createdAt: "2026-11-12T08:00:00.000Z" })]);
  d.blobs.inject({ method: "GET", store: "bookings", key: /^m\//, fault: "fail-before", status: 500, times: Infinity });
  const res = await getStats(d);
  assert.equal(res.status, 200);
  assert.equal(res.body.bookings, null);
  assert.ok(res.body.days.every((x) => x.bookings === null));
  assert.equal(res.body.totals.visits, 2);
  assert.equal(out.error.length, 1);
});

test("stats: a store error while counting is logged without details and still answers 204", async (t) => {
  const out = quiet(t);
  const d = testDeps({ now: NOW });
  d.blobs.inject({ method: "GET", fault: "fail-before", status: 500, times: Infinity });
  assert.equal((await hit(d)).status, 204);
  assert.equal(out.error.length, 1);
});

test("stats: bump counts a view from the site itself as a view only, and many at once all count", async () => {
  const d = testDeps({ now: NOW });
  const store = d.getStore({ name: "stats", consistency: "strong" });
  await stats.bump(store, "d/x", "forside", "instagram");
  await stats.bump(store, "d/x", "personvern", null);
  const x = d.blobs.json("stats", "d/x");
  assert.deepEqual([x.views, x.visits, x.sources.instagram, x.pages.personvern], [2, 1, 1, 1]);
  const saved = retryDelay.ms;
  retryDelay.ms = () => Math.random() * 3;
  try {
    await Promise.all(Array.from({ length: 12 }, () => stats.bump(store, "d/y", "forside", "direkte")));
  } finally { retryDelay.ms = saved; }
  assert.deepEqual([d.blobs.json("stats", "d/y").views, d.blobs.json("stats", "d/y").visits], [12, 12]);
});

// D12: the booking numbers are computed by reading the bookings; a booking (web or /admin), an edit or a deletion
// writes nothing for the statistics, so the statistics can never break a booking.
test("stats: the booking write path writes nothing for statistics (web booking, /admin create, edit and delete)", async () => {
  const d = testDeps({ now: NOW, env: ENV });
  const web = await read(await bookings.handle(request("/api/bookings", { method: "POST", json: {
    service: "Herreklipp", date: "2026-11-13", start: 600, addons: [], name: "Ola Nordmann", phone: "912 34 567", requestId: "stats-write-01",
  } }), PRODUCTION, d));
  assert.equal(web.status, 201, JSON.stringify(web.body));
  const auth = { Authorization: "Bearer " + makeToken(PW, d.clock.now()) };
  const made = await read(await admin.handle(request("/api/admin/items", { method: "POST", headers: auth, json: {
    date: "2026-11-14", start: 600, dur: 30, name: "Per", phone: "400 00 000", requestId: "stats-write-02",
  } }), PRODUCTION, d));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.item.id;
  const edited = await read(await admin.handle(request(`/api/admin/items/${id}`, { method: "PATCH", headers: auth, json: { start: 630, expect: made.body.item.updatedAt } }),
    { ...PRODUCTION, params: { id } }, d));
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const gone = await read(await admin.handle(request(`/api/admin/items/${id}`, { method: "DELETE", headers: auth }), { ...PRODUCTION, params: { id } }, d));
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.deepEqual(d.blobs.opened.filter((o) => /^stats/.test(o.name)), []);
  assert.deepEqual(d.blobs.keys("stats"), []);
});
