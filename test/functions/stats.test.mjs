// Visitor statistics without cookies (owner request 2026-11-16): POST /api/hit counts one page view, GET /api/stats
// shows the last 30 days to the logged-in barber. Through handle(req, context, deps) on FakeBlobs. Invariants:
//   1. a hit stores only counts: views, views per page (forside, personvern) and per source category (instagram,
//      facebook, google, tiktok, direkte, annet) in ONE document per Oslo date, d/YYYY-MM-DD; never an IP, a
//      user agent, a referrer address, an ID or a cookie; the reply is 204 with no body and no Set-Cookie;
//   2. concurrent hits are all counted (conflict-safe writes), and a damaged day document does not lose the hit;
//   3. bots, deploy previews, branch deploys, calls without a deploy context and retired deploys count nothing and
//      open no store; a cross-site POST counts nothing;
//   4. a body over 1 kB is refused (413) without being read in full, and counts nothing;
//   5. GET /api/stats needs a valid admin token (401 without, with a bad one, or one from before auth/epoch) and
//      reads the injected clock's last 30 Oslo days.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION, PREVIEW, BRANCH } from "../helpers/deps.mjs";
import { makeToken, EPOCH_KEY, retryDelay } from "../../netlify/lib/booking-core.mjs";
import * as stats from "../../netlify/functions/stats.mjs";

const PW = "fake-admin-password";
const NOW = "2026-11-12T09:00:00Z"; // 10:00 in Oslo
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const RETIRED = { deploy: { context: "production", id: "old", published: false } };

const hit = (d, body = { p: "/", r: "" }, { ctx = PRODUCTION, ua = UA, headers = {} } = {}) => stats.handle(request("/api/hit", {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "text/plain", "User-Agent": ua, ...headers },
}), ctx, d).then(read);
const getStats = (d, token, ctx = PRODUCTION) => stats.handle(request("/api/stats", { headers: token ? { Authorization: "Bearer " + token } : {} }), ctx, d).then(read);
const day = (d, date) => d.blobs.json("stats", `d/${date}`);

test("stats: paths", () => {
  assert.deepEqual(stats.config, { path: ["/api/hit", "/api/stats"] });
});

test("stats: a hit stores only counts per page and source in the day's document, and answers 204 with no cookie", async () => {
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
  const res = await hit(d, { p: "/", r: "" }, { headers: { "X-Nf-Client-Connection-Ip": "198.51.100.7" } });
  assert.equal(res.status, 204);
  assert.equal(res.body, "");
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal(res.headers["cache-control"], "no-store");
  await hit(d, { p: "/personvern.html", r: "www.google.no" });
  await hit(d, { p: "/index.html", r: "l.instagram.com" });
  await hit(d, { p: "/", r: "www.viggosbarbershop.no" });
  await hit(d, { p: "/", r: "evil.example" });
  assert.deepEqual(day(d, "2026-11-12"), {
    views: 5,
    pages: { forside: 4, personvern: 1 },
    sources: { direkte: 2, google: 1, instagram: 1, annet: 1 },
  });
  const raw = d.blobs.text("stats", "d/2026-11-12");
  for (const secret of ["198.51.100.7", "iPhone", "google.no", "evil.example", "instagram.com"]) assert.ok(!raw.includes(secret), secret);
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
    assert.deepEqual(day(d, "2026-11-12"), { views: 12, pages: { forside: 12 }, sources: { facebook: 6, direkte: 6 } });
  } finally { retryDelay.ms = saved; }
});

test("stats: a damaged day document does not lose the hit", async () => {
  const d = testDeps({ now: NOW });
  d.blobs.seed("stats", "d/2026-11-12", { views: 7, pages: null, sources: { google: "x", __proto__x: 1 } });
  await hit(d, { p: "/", r: "www.google.com" });
  assert.deepEqual(day(d, "2026-11-12"), { views: 8, pages: { forside: 1 }, sources: { google: 1 } });
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
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
  assert.equal((await read(await stats.handle(request("/api/hit"), PRODUCTION, d))).status, 405);
  assert.equal((await read(await stats.handle(request("/api/stats", { method: "POST", json: {} }), PRODUCTION, d))).status, 405);
});

test("stats: GET /api/stats needs a valid admin token, and is 401 for a token from before auth/epoch", async () => {
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
  assert.equal((await getStats(d)).status, 401);
  assert.equal((await getStats(d, "x.y")).status, 401);
  assert.equal((await getStats(d, makeToken("other", d.clock.now()))).status, 401);
  const old = makeToken(PW, d.clock.now());
  d.clock.advance(1000);
  d.blobs.seed("bookings", EPOCH_KEY, { t: d.clock.now() });
  assert.equal((await getStats(d, old)).status, 401);
  assert.equal((await getStats(d, makeToken(PW, d.clock.now()))).status, 200);
  assert.equal((await getStats(d, makeToken(PW, d.clock.now()), RETIRED)).status, 410);
});

test("stats: GET /api/stats sums the last 30 Oslo days from the injected clock", async () => {
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
  d.blobs.seed("stats", "d/2026-11-12", { views: 4, pages: { forside: 4 }, sources: { google: 3, direkte: 1 } });
  d.blobs.seed("stats", "d/2026-11-06", { views: 2, pages: { forside: 2 }, sources: { instagram: 2 } });
  d.blobs.seed("stats", "d/2026-10-14", { views: 10, pages: { forside: 10 }, sources: { annet: 10 } }); // 29 days ago
  d.blobs.seed("stats", "d/2026-10-13", { views: 99, pages: { forside: 99 }, sources: { annet: 99 } }); // 30 days ago: out
  const res = await getStats(d, makeToken(PW, d.clock.now()));
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.body.today, "2026-11-12");
  assert.deepEqual(res.body.totals, { today: 4, week: 6, month: 16 });
  assert.deepEqual(res.body.sources, { instagram: 2, facebook: 0, google: 3, tiktok: 0, direkte: 1, annet: 10 });
  assert.equal(res.body.days.length, 30);
});

test("stats: a store error while counting is logged without details and still answers 204", async (t) => {
  const out = quiet(t);
  const d = testDeps({ now: NOW });
  d.blobs.inject({ method: "GET", fault: "fail-before", status: 500, times: Infinity });
  assert.equal((await hit(d)).status, 204);
  assert.equal(out.error.length, 1);
});
