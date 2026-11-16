// netlify/lib/social.mjs against Instagram API responses shaped like the documentation
// (test/fixtures/instagram/*.json; docs/contracts/instagram.md lists the rules and the test for each). Invariants:
//   F15  when Instagram fails, the last good posts stay at most 2 days after the last good fetch (the image links
//        are signed CDN links that expire, and a post deleted on Instagram must leave the site); then the feed is
//        empty and the page hides the grid.
//   F81  a token seeded from INSTAGRAM_ACCESS_TOKEN remembers that value (seed). A new value in the env var
//        replaces it; a refresh keeps the seed; a token from the connect flow (no seed) is never replaced by it.
//   R6   the feed and token writes are conditional, so a late failure never overwrites a newer feed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FakeBlobs } from "../helpers/fake-blobs.mjs";
import { FakeClock } from "../helpers/clock.mjs";
import { fakeFetch } from "../helpers/fake-fetch.mjs";
import { quiet } from "../helpers/deps.mjs";
import { buildFeed, getInstagramToken, KEEP_POSTS_MS } from "../../netlify/lib/social.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/instagram/${name}.json`, import.meta.url), "utf8"));
const MEDIA = "https://graph.instagram.com/me/media";
const REFRESH = "https://graph.instagram.com/refresh_access_token";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = "2026-11-16T09:00:00Z";
const invalid = () => new Response(JSON.stringify(fixture("token-invalid")), { status: 400, headers: { "Content-Type": "application/json" } });

function setup({ env = {}, token: seeded } = {}) {
  const clock = new FakeClock(T0);
  const blobs = new FakeBlobs({ clock });
  const store = blobs.getStore("social");
  if (seeded) blobs.seed("social", "instagram-token", seeded);
  const ig = { media: fixture("media"), down: false, refreshed: [] };
  const fetch = fakeFetch([
    [MEDIA, (call) => (ig.down ? ig.down(call) : ig.media)],
    [REFRESH, (call) => {
      const old = new URL(call.url).searchParams.get("access_token");
      ig.refreshed.push(old);
      return ig.refreshDown ? invalid() : { ...fixture("refresh"), access_token: old + "-r" + ig.refreshed.length };
    }],
  ]);
  const build = () => buildFeed(store, env, fetch, { now: clock.date() });
  const token = () => getInstagramToken(store, env, fetch, { now: clock.date() });
  const usedToken = () => { const c = fetch.calls.filter((x) => x.url.startsWith(MEDIA)).pop(); return c && new URL(c.url).searchParams.get("access_token"); };
  return { clock, blobs, store, env, ig, fetch, build, token, usedToken, doc: () => blobs.json("social", "instagram-token"), feed: () => blobs.json("social", "feed") };
}
const fresh = (access_token, extra = {}) => ({ access_token, refreshed_at: Date.parse(T0) - DAY, expires_at: Date.parse(T0) + 59 * DAY, ...extra });

test("social: a good fetch maps the posts and records when it happened", async () => {
  const s = setup({ token: fresh("IGConnected") });
  const feed = await s.build();
  assert.equal(feed.instagram.length, 2);
  assert.deepEqual(feed.instagram.map((p) => p.url), ["https://www.instagram.com/p/FixturePost1/", "https://www.instagram.com/reel/FixturePost2/"]);
  assert.equal(feed.instagram[1].image, "https://scontent.cdninstagram.com/v/t51.fixture/2.jpg?oh=fixture&oe=69300000", "a video shows its thumbnail");
  assert.equal(feed.instagram[1].video, true);
  assert.equal(feed.fetched_at, new Date(T0).toISOString());
  assert.deepEqual(s.feed(), feed);
  assert.equal(s.usedToken(), "IGConnected");
});

test("social: no token gives an empty feed without calling Instagram", async () => {
  const s = setup();
  const feed = await s.build();
  assert.deepEqual(feed.instagram, []);
  assert.equal(feed.fetched_at, null);
  assert.equal(s.fetch.calls.length, 0);
});

test("F15: Instagram fails: the posts stay at +1 day and are gone at +3 days", async (t) => {
  const out = quiet(t);
  const s = setup({ token: fresh("IGConnected") });
  await s.build();
  s.ig.down = invalid;

  s.clock.set(Date.parse(T0) + DAY);
  let feed = await s.build();
  assert.equal(feed.instagram.length, 2, "+1 day: the last good posts");
  assert.equal(feed.fetched_at, new Date(T0).toISOString(), "the last good fetch time is kept, not moved forward");
  s.clock.set(Date.parse(T0) + 1.9 * DAY);
  assert.equal((await s.build()).instagram.length, 2, "+1.9 days");

  s.clock.set(Date.parse(T0) + 3 * DAY);
  feed = await s.build();
  assert.deepEqual(feed.instagram, [], "+3 days: empty");
  assert.equal(feed.fetched_at, null);
  assert.ok(!s.blobs.text("social", "feed").includes("FixturePost"), "no old post is left in the store");
  assert.ok(out.error.some((a) => /Instagram 400/.test(a.join(" "))));
  assert.equal(KEEP_POSTS_MS, 2 * DAY);

  // Instagram works again
  s.ig.down = false;
  s.clock.advance(HOUR);
  assert.equal((await s.build()).instagram.length, 2);
});

test("F15: a feed stored before the limit existed (no fetched_at) is not kept when Instagram fails", async (t) => {
  quiet(t);
  const s = setup({ token: fresh("IGConnected") });
  const feed = await s.build();
  s.blobs.seed("social", "feed", { updated_at: feed.updated_at, profiles: feed.profiles, instagram: feed.instagram });
  s.ig.down = invalid;
  s.clock.advance(HOUR);
  assert.deepEqual((await s.build()).instagram, []);
});

test("F81: a token seeded from env A, then env set to B: B is used and stored with seed B", async (t) => {
  quiet(t);
  const env = { INSTAGRAM_ACCESS_TOKEN: "IGSeedA" };
  const s = setup({ env });
  s.ig.refreshDown = true;            // a fresh long-lived token under 24 h old cannot be refreshed yet
  assert.equal(await s.token(), "IGSeedA");
  assert.equal(s.doc().seed, "IGSeedA");
  assert.equal(s.doc().access_token, "IGSeedA");

  env.INSTAGRAM_ACCESS_TOKEN = "IGSeedB";
  s.clock.advance(2 * HOUR);
  assert.equal(await s.token(), "IGSeedB");
  assert.equal(s.doc().seed, "IGSeedB");
  assert.equal(s.doc().access_token, "IGSeedB");
  await s.build();
  assert.equal(s.usedToken(), "IGSeedB");
});

test("F81: a refresh save keeps the seed, so an unchanged env var does not undo the refresh", async () => {
  const env = { INSTAGRAM_ACCESS_TOKEN: "IGSeedA" };
  const s = setup({ env, token: { access_token: "IGSeedA", seed: "IGSeedA", refreshed_at: Date.parse(T0) - 8 * DAY } });
  assert.equal(await s.token(), "IGSeedA-r1", "refreshed after 7 days");
  assert.deepEqual(s.ig.refreshed, ["IGSeedA"]);
  assert.equal(s.doc().seed, "IGSeedA");
  assert.equal(s.doc().access_token, "IGSeedA-r1");
  assert.equal(s.doc().refreshed_at, Date.parse(T0));
  assert.equal(s.doc().expires_at, Date.parse(T0) + 5183944 * 1000);
  s.clock.advance(HOUR);
  assert.equal(await s.token(), "IGSeedA-r1", "still the refreshed token, not the env value again");
  assert.deepEqual(s.ig.refreshed, ["IGSeedA"]);
});

test("F81: a token from the connect flow (no seed) is never replaced by the env var", async () => {
  const env = { INSTAGRAM_ACCESS_TOKEN: "IGOldEnvValue" };
  const s = setup({ env, token: fresh("IGConnected") });
  assert.equal(await s.token(), "IGConnected");
  await s.build();
  assert.equal(s.usedToken(), "IGConnected");
  assert.equal(s.doc().seed, undefined);
});

test("R6: a slow failure that answers late never overwrites a newer feed", async (t) => {
  quiet(t);
  const s = setup({ token: fresh("IGConnected") });
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  let n = 0;
  s.ig.down = () => (++n === 1 ? slow.then(invalid) : s.ig.media);
  const first = s.build();                               // waits for Instagram
  assert.equal((await s.build()).instagram.length, 2);   // a second run gets the posts and stores them
  release();
  assert.deepEqual((await first).instagram, [], "the slow failure had no earlier posts to keep");
  assert.equal(s.feed().instagram.length, 2, "the newer feed stays stored");
});
