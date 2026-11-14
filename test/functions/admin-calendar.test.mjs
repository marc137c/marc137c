// /api/admin/calendar: the barber creates, sees again (reveal) and re-creates the calendar link (owner decision 2a).
// Invariants:
//   1. only a logged-in admin gets the link: without the admin token every method is 401 and shows no link;
//   2. creating is idempotent (a second «create» keeps the link the phone already uses); only replace: true
//      makes a new one, and then the old link 404s at once while the new one works;
//   3. the reply carries the three links /admin shows (https to copy, webcal:// for iPhone, Google's add-by-URL),
//      all pointing at this site and the current token, never cached;
//   4. a deploy preview has its own link (F10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, SITE, PRODUCTION, PREVIEW } from "../helpers/deps.mjs";
import { item, seedItems } from "../helpers/bookings.mjs";
import { rfc5545Problems } from "../helpers/ical.mjs";
import { makeToken } from "../../netlify/lib/booking-core.mjs";
import { FEED_KEY } from "../../netlify/lib/calendar.mjs";
import * as admin from "../../netlify/functions/admin.mjs";
import * as calendar from "../../netlify/functions/calendar.mjs";

const PASSWORD = "fake-admin-password";
const NOW = "2026-11-16T08:00:00Z";
const TOKEN_IN_LINK = /\/api\/calendar\/([A-Za-z0-9_-]{43})\.ics$/;

const setup = () => testDeps({ now: NOW, env: { ADMIN_PASSWORD: PASSWORD } });
const auth = (d) => ({ Authorization: "Bearer " + makeToken(PASSWORD, d.clock.now()) });
const call = (d, { method = "GET", json, headers = auth(d), ctx = PRODUCTION } = {}) =>
  admin.handle(request("/api/admin/calendar", { method, json, headers }), ctx, d).then(read);
const fetchFeed = (d, link, ctx = PRODUCTION) => calendar.handle(request(new URL(link).pathname), ctx, d).then(read);

test("admin calendar: the path is registered with the admin function", () => {
  assert.ok(admin.config.path.includes("/api/admin/calendar"));
});

test("admin calendar: without the admin token nothing is shown or made", async () => {
  const d = setup();
  await call(d, { method: "POST", json: {} }); // a link exists
  for (const headers of [{}, { Authorization: "Bearer nope" }, { Authorization: "Bearer " + makeToken("other-password", d.clock.now()) }]) {
    for (const method of ["GET", "POST"]) {
      const res = await call(d, { method, json: method === "POST" ? { replace: true } : undefined, headers });
      assert.equal(res.status, 401, `${method} ${JSON.stringify(headers)}`);
      assert.equal(res.body.links, undefined);
      assert.doesNotMatch(JSON.stringify(res.body), /api\/calendar/);
    }
  }
  const stored = d.blobs.json("bookings", FEED_KEY).token;
  assert.equal((await call(d)).body.links.https.endsWith(`/${stored}.ics`), true, "a refused replace changed nothing");
});

test("admin calendar: before a link exists it says so; creating makes one with the three links", async () => {
  const d = setup();
  const none = await call(d);
  assert.equal(none.status, 200);
  assert.deepEqual(none.body, { enabled: false });
  assert.equal(none.headers["cache-control"], "no-store");
  const made = await call(d, { method: "POST", json: {} });
  assert.equal(made.status, 201);
  assert.equal(made.headers["cache-control"], "no-store");
  assert.equal(made.body.enabled, true);
  assert.equal(made.body.createdAt, new Date(NOW).toISOString());
  const { https, webcal, google } = made.body.links;
  const token = TOKEN_IN_LINK.exec(https)[1];
  assert.equal(https, `${SITE}/api/calendar/${token}.ics`);
  assert.equal(webcal, `webcal://viggos.test/api/calendar/${token}.ics`);
  assert.equal(google, `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`);
  assert.equal(d.blobs.json("bookings", FEED_KEY).token, token);
  assert.deepEqual(Object.keys(made.body).sort(), ["createdAt", "enabled", "links"], "no other secrets in the reply");
  // Reveal: the same link again, as often as asked
  for (let k = 0; k < 3; k++) assert.deepEqual((await call(d)).body, made.body);
});

test("admin calendar: create again keeps the link; replace makes a new one and the old stops at once", async () => {
  const d = setup();
  seedItems(d.blobs, [item({ date: "2026-11-18", name: "Ola Nordmann" })]);
  const first = (await call(d, { method: "POST", json: {} })).body;
  const again = await call(d, { method: "POST", json: {} });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first, "a double tap on «Lag kalenderlenke» does not break the phone's link");
  assert.deepEqual((await call(d, { method: "POST", json: { replace: "yes" } })).body, first, "only replace: true replaces");
  let feed = await fetchFeed(d, first.links.https);
  assert.equal(feed.status, 200);
  assert.deepEqual(rfc5545Problems(feed.body), []);

  d.clock.advance(3600e3);
  const renewed = await call(d, { method: "POST", json: { replace: true } });
  assert.equal(renewed.status, 201);
  assert.notEqual(renewed.body.links.https, first.links.https);
  assert.equal(renewed.body.createdAt, new Date(Date.parse(NOW) + 3600e3).toISOString());
  feed = await fetchFeed(d, first.links.https);
  assert.equal(feed.status, 404, "the old link stops working at once");
  assert.doesNotMatch(feed.body, /Ola/);
  assert.equal((await fetchFeed(d, renewed.body.links.https)).status, 200);
  assert.deepEqual((await call(d)).body, renewed.body, "reveal shows the new link");
});

test("admin calendar: two «Lag ny lenke» at once leave exactly one working link, the one /admin then shows", async () => {
  const d = setup();
  const old = (await call(d, { method: "POST", json: {} })).body;
  const [a, b] = await Promise.all([call(d, { method: "POST", json: { replace: true } }), call(d, { method: "POST", json: { replace: true } })]);
  assert.deepEqual([a.status, b.status], [201, 201]);
  const shown = (await call(d)).body.links.https;
  assert.ok([a.body.links.https, b.body.links.https].includes(shown));
  const working = await Promise.all([old, a.body, b.body].map((x) => fetchFeed(d, x.links.https)));
  assert.deepEqual(working.map((r) => r.status).filter((s) => s === 200).length, 1);
  assert.equal((await fetchFeed(d, shown)).status, 200);
});

test("admin calendar: a deploy preview has its own link, which never opens the live feed (F10)", async () => {
  const d = setup();
  const live = (await call(d, { method: "POST", json: {} })).body;
  const preview = await call(d, { ctx: PREVIEW });
  assert.deepEqual(preview.body, { enabled: false }, "the preview does not reveal the live link");
  const made = (await call(d, { method: "POST", json: {}, ctx: PREVIEW })).body;
  assert.notEqual(made.links.https, live.links.https);
  assert.equal((await fetchFeed(d, made.links.https, PRODUCTION)).status, 404);
  assert.equal((await fetchFeed(d, made.links.https, PREVIEW)).status, 200);
  assert.equal(d.blobs.json("bookings", FEED_KEY).token, TOKEN_IN_LINK.exec(live.links.https)[1]);
});

test("admin calendar: other methods are unknown requests", async () => {
  const d = setup();
  for (const method of ["PATCH", "DELETE", "PUT"]) assert.equal((await call(d, { method, json: {} })).status, 404, method);
  assert.deepEqual((await call(d)).body, { enabled: false });
});
