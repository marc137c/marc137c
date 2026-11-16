// netlify/lib/reviews.mjs against Places API (New) responses shaped like the documentation
// (test/fixtures/places/*.json; docs/contracts/google-places.md lists the rules and the test for each). Invariants:
//   F77  Google content is served at most 3 days after the last good fetch. After that the stored blob holds no
//        review text or reviewer name any more (emptyReviews), and the page falls back to the owner's FEATURED reviews.
//   F78  the automatic lookup only accepts a place called «Viggo…» at Violgata 22; anything else throws and saves
//        nothing. The cache belongs to one place: a new GOOGLE_PLACE_ID never gets the old place's reviews.
//   F76  every review keeps its own Google Maps link (googleMapsUri → mapsUri), and «see all» uses the documented
//        googleMapsLinks.reviewsUri.
//   F83  a 403 BILLING_DISABLED is logged as a missing billing account, so the owner knows what to fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FakeBlobs } from "../helpers/fake-blobs.mjs";
import { FakeClock } from "../helpers/clock.mjs";
import { fakeFetch } from "../helpers/fake-fetch.mjs";
import { quiet } from "../helpers/deps.mjs";
import { getReviews, fetchReviews, emptyReviews, STALE_LIMIT_MS } from "../../netlify/lib/reviews.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/places/${name}.json`, import.meta.url), "utf8"));
const SEARCH = "https://places.googleapis.com/v1/places:searchText";
const DETAILS = /^https:\/\/places\.googleapis\.com\/v1\/places\/[^:/?]+\?/;
const KEY = "fixture-places-key";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = "2026-11-16T09:00:00Z";

function setup({ env = { GOOGLE_PLACES_API_KEY: KEY }, search = fixture("search-viggo"), details = fixture("details") } = {}) {
  const clock = new FakeClock(T0);
  const blobs = new FakeBlobs({ clock });
  const store = blobs.getStore("reviews");
  const google = { search, details, down: false };
  const fetch = fakeFetch([
    [SEARCH, () => (google.down ? google.down() : google.search)],
    [DETAILS, () => (google.down ? google.down() : google.details)],
  ]);
  const run = () => getReviews(env, store, fetch, { now: clock.date() });
  return { clock, blobs, store, google, fetch, env, run };
}
const billing = () => new Response(JSON.stringify(fixture("billing-disabled")), { status: 403, headers: { "Content-Type": "application/json" } });
const stored = (s) => s.blobs.text("reviews", "reviews") || "";

test("reviews: no key gives the unconfigured answer and touches neither Google nor the store", async () => {
  const s = setup({ env: {} });
  assert.deepEqual(await s.run(), emptyReviews());
  assert.equal(s.fetch.calls.length, 0);
  assert.deepEqual(s.blobs.keys("reviews"), []);
});

test("reviews: a good answer is mapped, cached for 12 h and not fetched again inside that time", async () => {
  const s = setup();
  const data = await s.run();
  assert.equal(data.configured, true);
  assert.equal(data.rating, 4.7);
  assert.equal(data.count, 41);
  assert.deepEqual(data.reviews.map((r) => r.author), ["Fixture Kunde En", "Fixture Kunde To", "Fixture Kunde Tre"]);
  assert.equal(data.reviews[0].text, "Fin klipp og god prat.", "the customer's own words (originalText), trimmed");
  assert.equal(data.reviews[1].text, "", "a rating without text keeps an empty text");
  assert.equal(s.fetch.calls.length, 2, "one text search and one place lookup");
  assert.ok(s.fetch.calls.every((c) => c.headers["X-Goog-Api-Key"] === KEY));
  s.clock.advance(11 * HOUR);
  assert.deepEqual(await s.run(), data);
  assert.equal(s.fetch.calls.length, 2, "served from the cache");
});

test("F76: each review keeps its Google Maps link, and «see all» is the documented reviewsUri", async () => {
  const s = setup();
  const data = await s.run();
  assert.deepEqual(data.reviews.map((r) => r.mapsUri), [
    "https://www.google.com/maps/reviews/data=fixture-review-1",
    "https://www.google.com/maps/reviews/data=fixture-review-2",
    "https://www.google.com/maps/reviews/data=fixture-review-3",
  ]);
  assert.equal(data.url, "https://www.google.com/maps/place//data=fixture-reviews");
  const mask = s.fetch.calls[1].headers["X-Goog-FieldMask"].split(",");
  for (const f of ["rating", "userRatingCount", "reviews", "googleMapsUri", "googleMapsLinks"]) assert.ok(mask.includes(f), f);
  assert.ok(!JSON.stringify(data).includes("search.google.com/local/reviews"), "no undocumented link format");

  // Without googleMapsLinks the place's own googleMapsUri is used; a review without a link gets null
  const d2 = fixture("details");
  delete d2.googleMapsLinks;
  delete d2.reviews[0].googleMapsUri;
  const s2 = setup({ details: d2 });
  const data2 = await s2.run();
  assert.equal(data2.url, "https://maps.google.com/?cid=1000000000000000001");
  assert.equal(data2.reviews[0].mapsUri, null);
});

test("F77: Google fails: cached reviews are served at +2 days, and at +4 days the answer is empty and the store holds no review text", async (t) => {
  const out = quiet(t);
  const s = setup();
  const good = await s.run();
  assert.ok(stored(s).includes("Fin klipp"));
  s.google.down = billing;

  s.clock.advance(2 * DAY);
  assert.deepEqual(await s.run(), good, "inside the limit the last good answer is served");
  s.clock.advance(20 * 60 * 1000);
  const calls = s.fetch.calls.length;
  assert.deepEqual(await s.run(), good, "a failed try waits 30 minutes before the next one");
  assert.equal(s.fetch.calls.length, calls);

  s.clock.set(Date.parse(T0) + 4 * DAY);
  assert.deepEqual(await s.run(), emptyReviews());
  for (const word of ["Fin klipp", "Fixture Kunde", "ventetid", "4.7", "fixture-review"]) assert.ok(!stored(s).includes(word), `${word} is gone from the store`);
  s.clock.advance(31 * 60 * 1000);
  assert.deepEqual(await s.run(), emptyReviews(), "and stays empty while Google fails");
  assert.ok(out.error.length >= 2);

  // Google works again: the reviews come back
  s.google.down = false;
  s.clock.advance(31 * 60 * 1000);
  assert.equal((await s.run()).count, 41);
});

test("F77: the limit counts from the last good fetch, not from the last failed one", async (t) => {
  quiet(t);
  const s = setup();
  await s.run();
  s.google.down = () => { throw new TypeError("fetch failed"); };
  // A visit every 6 hours: each failure rewrites the cache, but never moves the last good time forward
  for (let h = 6; h < 3 * 24; h += 6) {
    s.clock.set(Date.parse(T0) + h * HOUR);
    assert.equal((await s.run()).count, 41, `+${h} h`);
  }
  s.clock.set(Date.parse(T0) + STALE_LIMIT_MS + HOUR);
  assert.deepEqual(await s.run(), emptyReviews());
  assert.equal(STALE_LIMIT_MS, 3 * DAY);
});

test("F77: a cache written before the limit existed (no okAt) is dropped at its first failure", async (t) => {
  quiet(t);
  const s = setup();
  const data = await s.run();
  s.blobs.seed("reviews", "reviews", { fetchedAt: Date.parse(T0) - 13 * HOUR, data });
  s.google.down = billing;
  assert.deepEqual(await s.run(), emptyReviews());
  assert.ok(!stored(s).includes("Fin klipp"));
});

test("R6: a failed try that answers late never overwrites a newer good answer (conditional writes)", async (t) => {
  quiet(t);
  const env = { GOOGLE_PLACES_API_KEY: KEY, GOOGLE_PLACE_ID: "ChIJFixtureViggosBarbershop01" };
  const s = setup({ env });
  await s.run();
  s.clock.advance(13 * HOUR);
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  let n = 0;
  s.google.down = () => (++n === 1 ? slow.then(billing) : s.google.details);
  const d2 = fixture("details");
  d2.userRatingCount = 42;
  s.google.details = d2;
  const first = s.run();                       // waits for Google
  assert.equal((await s.run()).count, 42);     // a second visit gets the new answer and stores it
  release();
  assert.equal((await first).count, 41, "the slow failure answers with what it had");
  assert.equal(s.blobs.json("reviews", "reviews").data.count, 42, "the newer good answer stays stored");
  const calls = s.fetch.calls.length;
  assert.equal((await s.run()).count, 42);
  assert.equal(s.fetch.calls.length, calls, "and is served from the cache");
});

test("F78: a search hit called Viggo at another address throws and saves nothing", async (t) => {
  quiet(t);
  const s = setup({ search: fixture("search-other-viggo") });
  await assert.rejects(fetchReviews(s.env, s.store, s.fetch), /Violgata 22.*GOOGLE_PLACE_ID|GOOGLE_PLACE_ID/);
  assert.deepEqual(s.blobs.keys("reviews"), [], "nothing stored");
  assert.equal(s.fetch.calls.length, 1, "no place lookup for a wrong hit");

  assert.deepEqual(await s.run(), emptyReviews());
  assert.ok(!s.blobs.has("reviews", "place-id"));
  assert.ok(!stored(s).includes("Viggo Bil"));
  assert.ok(!stored(s).includes("ChIJFixtureViggoBilAS"));
});

test("F78: the real shop at Violgata 22 is accepted and its id is remembered; a remembered wrong place is looked up again", async () => {
  const s = setup();
  await s.run();
  assert.deepEqual(s.blobs.json("reviews", "place-id"), { id: "ChIJFixtureViggosBarbershop01", name: "Viggos Barbershop Kurti", address: "Violgata 22, 1776 Halden, Norge" });
  assert.match(s.fetch.calls[1].url, /places\/ChIJFixtureViggosBarbershop01\?/);

  // A place id saved by the old code for another business
  const s2 = setup();
  s2.blobs.seed("reviews", "place-id", { id: "ChIJFixtureViggoBilAS000001", name: "Viggo Bil AS", address: "Storgata 5, 1771 Halden, Norge" });
  await s2.run();
  assert.equal(s2.fetch.calls[0].url, SEARCH, "searched again");
  assert.match(s2.fetch.calls[1].url, /places\/ChIJFixtureViggosBarbershop01\?/);
  assert.equal(s2.blobs.json("reviews", "place-id").id, "ChIJFixtureViggosBarbershop01");
});

test("F78: a changed GOOGLE_PLACE_ID bypasses the old cache, also when Google then fails", async (t) => {
  quiet(t);
  const env = { GOOGLE_PLACES_API_KEY: KEY, GOOGLE_PLACE_ID: "ChIJFixtureWrongPlace0000001" };
  const s = setup({ env });
  await s.run();
  assert.match(s.fetch.calls[0].url, /places\/ChIJFixtureWrongPlace0000001\?/, "a set GOOGLE_PLACE_ID is used without a search");
  assert.equal(s.blobs.json("reviews", "reviews").placeId, "ChIJFixtureWrongPlace0000001");

  env.GOOGLE_PLACE_ID = "ChIJFixtureViggosBarbershop01";
  s.clock.advance(HOUR);
  const d2 = fixture("details");
  d2.rating = 5;
  s.google.details = d2;
  assert.equal((await s.run()).rating, 5, "fetched for the new place although the old cache is 1 h old");
  assert.match(s.fetch.calls[1].url, /places\/ChIJFixtureViggosBarbershop01\?/);

  // The old place's cache is never served for the new id, not even as a stale fallback
  const s3 = setup({ env: { GOOGLE_PLACES_API_KEY: KEY, GOOGLE_PLACE_ID: "ChIJFixtureWrongPlace0000001" } });
  await s3.run();
  s3.env.GOOGLE_PLACE_ID = "ChIJFixtureViggosBarbershop01";
  s3.google.down = billing;
  s3.clock.advance(HOUR);
  assert.deepEqual(await s3.run(), emptyReviews());
});

test("F83: a 403 BILLING_DISABLED is logged as a missing billing account (search and place lookup)", async (t) => {
  const out = quiet(t);
  const s = setup();
  s.google.down = billing;
  assert.deepEqual(await s.run(), emptyReviews());
  const s2 = setup({ env: { GOOGLE_PLACES_API_KEY: KEY, GOOGLE_PLACE_ID: "ChIJFixtureViggosBarbershop01" } });
  s2.google.down = billing;
  assert.deepEqual(await s2.run(), emptyReviews());
  const lines = out.error.map((a) => a.join(" "));
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.match(line, /betalingskonto/, line);
    assert.match(line, /Billing/, line);
    assert.match(line, /BILLING_DISABLED/, line);
  }
  assert.match(lines[0], /Places-søk 403/);
  assert.match(lines[1], /Places 403/);
});

test("reviews: other errors keep Google's own text in the log, cut to a sane length", async (t) => {
  const out = quiet(t);
  const s = setup();
  s.google.down = () => new Response("x".repeat(5000), { status: 500 });
  await s.run();
  const line = out.error.map((a) => a.join(" ")).join("\n");
  assert.match(line, /Places-søk 500: x+/);
  assert.ok(line.length < 1000);
  assert.doesNotMatch(line, /betalingskonto/);
});
