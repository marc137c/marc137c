// F36, F20, NEW-pii-keys, SPEC R4: the daily clean-up (netlify/functions/retention.mjs) carries out the deletion
// rules in netlify/lib/store-keys.mjs. The clock is 2027-03-01, so the booking limit (RETENTION_DAYS = 90) is
// 2026-12-01. Invariants:
//   1. bookings: every item dated before the limit is deleted (cancelled ones too), every later one is kept
//      unchanged, an impossible date (a «ghost» 2026-11-31) is deleted, and a month document left empty is deleted;
//   2. rate-limit counters (rl/*) whose newest hit is over 24 hours old are deleted, recent ones are kept, and
//      rl/secret and auth/epoch are kept; legacy auth/ip/* and auth/all are deleted;
//   3. it runs on both "bookings" and "bookings-preview", reads every list page, and a second run deletes nothing;
//   4. visitor statistics older than STATS_KEEP_DAYS and unfinished Instagram connections older than a day go;
//   5. on a retired deploy it does nothing at all; a store error stops nothing else, and the next run finishes;
//   6. it is a scheduled function declared in its own file, and never named after reminders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { FakeBlobs } from "../helpers/fake-blobs.mjs";
import { FakeClock } from "../helpers/clock.mjs";
import { item } from "../helpers/bookings.mjs";
import { RETENTION_DAYS, STATS_KEEP_DAYS } from "../../netlify/lib/store-keys.mjs";
import * as retention from "../../netlify/functions/retention.mjs";

const NOW = "2027-03-01T03:00:00Z";
const DAY = 24 * 3600e3;
const nowMs = Date.parse(NOW);
const RETIRED = { deploy: { context: "production", id: "old", published: false } };

function seedStore(blobs, store) {
  const keep = item({ date: "2026-12-15", name: "Behold" });
  const keepCancelled = item({ date: "2027-01-10", status: "cancelled", name: "Avlyst, men nylig" });
  blobs.seed(store, "m/2026-11", { items: [
    item({ date: "2026-11-20", name: "Gammel" }),
    item({ date: "2026-11-21", status: "cancelled", name: "Gammel avlyst" }),
    item({ date: "2026-11-31", name: "Spøkelse" }),
  ] });
  blobs.seed(store, "m/2026-12", { items: [item({ date: "2026-11-30", name: "Feil måned, gammel" }), keep] });
  blobs.seed(store, "m/2027-01", { items: [keepCancelled] });
  blobs.seed(store, "m/2026-10", { items: [] }); // an empty old month
  blobs.seed(store, "rl/secret", { k: "A".repeat(43) });
  blobs.seed(store, "rl/ip/oldoldoldoldoldoldold", { hits: [{ t: nowMs - 25 * 3600e3, id: "a" }] });
  blobs.seed(store, "rl/phone/newnewnewnewnewnewnew", { hits: [{ t: nowMs - 25 * 3600e3, id: "a" }, { t: nowMs - 3600e3, id: "b" }] });
  blobs.seed(store, "rl/all", { hits: [{ t: nowMs - 30 * 3600e3, id: "a" }], alertedAt: nowMs - 2 * 3600e3 });
  blobs.seed(store, "rl/login/all", { hits: [] });
  blobs.seed(store, "auth/epoch", { t: nowMs - 10 * DAY });
  blobs.seed(store, "auth/ip/198.51.100.5", { count: 3, start: nowMs - 60e3 });
  blobs.seed(store, "auth/all", { count: 9, start: nowMs - 60e3 });
  blobs.seed(store, "push/subs", { subs: [], gone: [] });
  blobs.seed(store, "calendar/feed", { token: "B".repeat(43), gen: "x".repeat(16) });
  return { keep, keepCancelled };
}

function site({ listPageSize = 1000 } = {}) {
  const clock = new FakeClock(NOW);
  const blobs = new FakeBlobs({ clock, listPageSize });
  const d = testDeps({ blobs });
  const seeded = { bookings: seedStore(blobs, "bookings"), "bookings-preview": seedStore(blobs, "bookings-preview") };
  blobs.seed("stats", "d/2027-02-28", { views: 3, pages: { forside: 3 }, sources: { direkte: 3 } });
  blobs.seed("stats", "d/2026-01-20", { views: 1, pages: { forside: 1 }, sources: { google: 1 } }); // 405 days ago
  blobs.seed("stats-preview", "d/2025-12-01", { views: 1, pages: {}, sources: {} });
  blobs.seed("social", "oauth-state-" + "a".repeat(48), { platform: "instagram", created_at: nowMs - 2 * DAY });
  blobs.seed("social", "oauth-state-" + "b".repeat(48), { platform: "instagram", created_at: nowMs - 3600e3 });
  blobs.seed("social", "instagram-token", { access_token: "x", refreshed_at: nowMs });
  blobs.seed("social", "feed", { instagram: [] });
  return { d, blobs, seeded };
}
const run = (d, ctx = PRODUCTION) => retention.handle(request("/.netlify/functions/retention", { method: "POST", json: { next_run: NOW } }), ctx, d).then(read);

test("retention: the limits are the documented ones", () => {
  assert.equal(RETENTION_DAYS, 90);
  assert.equal(STATS_KEEP_DAYS, 400);
});

test("retention: bookings 90 days after their date, ghosts and empty old months go; later bookings stay unchanged", async () => {
  const { d, blobs, seeded } = site();
  const res = await run(d);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  for (const store of ["bookings", "bookings-preview"]) {
    assert.equal(blobs.has(store, "m/2026-11"), false, `${store}: the November document is empty and old, so deleted`);
    assert.equal(blobs.has(store, "m/2026-10"), false, `${store}: an empty old month is deleted`);
    assert.deepEqual(blobs.json(store, "m/2026-12").items, [seeded[store].keep], `${store}: only the December booking stays, unchanged`);
    assert.deepEqual(blobs.json(store, "m/2027-01").items, [seeded[store].keepCancelled]);
  }
});

test("retention: counters a day after their newest hit, legacy auth/* always; the secret, the epoch and push/calendar stay", async () => {
  const { d, blobs } = site();
  await run(d);
  for (const store of ["bookings", "bookings-preview"]) {
    const keys = blobs.keys(store).filter((k) => !k.startsWith("m/"));
    assert.deepEqual(keys, ["auth/epoch", "calendar/feed", "push/subs", "rl/all", "rl/phone/newnewnewnewnewnewnew", "rl/secret"], store);
  }
});

test("retention: old statistics and unfinished Instagram connections go; the rest of the social store stays", async () => {
  const { d, blobs } = site();
  await run(d);
  assert.deepEqual(blobs.keys("stats"), ["d/2027-02-28"]);
  assert.deepEqual(blobs.keys("stats-preview"), []);
  assert.deepEqual(blobs.keys("social"), ["feed", "instagram-token", "oauth-state-" + "b".repeat(48)]);
});

test("retention: it reads every list page, and a second run deletes nothing and writes nothing", async () => {
  const { d, blobs } = site({ listPageSize: 2 });
  const first = await run(d);
  assert.equal(first.status, 200);
  assert.ok(first.body.deleted > 0);
  assert.equal(blobs.has("bookings", "auth/all"), false, "found on a later page");
  const snapshot = JSON.stringify(blobs.snapshot());
  const before = blobs.log.length;
  const second = await run(d);
  assert.deepEqual([second.status, second.body.deleted, second.body.changed], [200, 0, 0]);
  assert.equal(JSON.stringify(blobs.snapshot()), snapshot);
  assert.equal(blobs.log.slice(before).filter((e) => e.method === "PUT" || e.method === "DELETE").length, 0);
});

test("retention: a retired deploy does nothing at all", async () => {
  const { d, blobs } = site();
  const snapshot = JSON.stringify(blobs.snapshot());
  const res = await run(d, RETIRED);
  assert.equal(res.status, 410);
  assert.deepEqual(blobs.log, []);
  assert.equal(JSON.stringify(blobs.snapshot()), snapshot);
});

test("retention: outside production only the preview stores are cleaned", async () => {
  const { d, blobs } = site();
  await run(d, { deploy: { context: "deploy-preview" } });
  assert.equal(blobs.has("bookings", "m/2026-11"), true, "the live store is not touched");
  assert.equal(blobs.has("bookings-preview", "m/2026-11"), false);
  assert.ok(blobs.log.every((e) => ["bookings-preview", "stats-preview"].includes(e.store)), JSON.stringify([...new Set(blobs.log.map((e) => e.store))]));
});

test("retention: a store error on one document stops nothing else, and the next run finishes the job", async (t) => {
  quiet(t);
  const { d, blobs } = site();
  blobs.inject({ method: "PUT", store: "bookings", key: "m/2026-12", fault: "fail-before", status: 500, times: 6 });
  const first = await run(d);
  assert.equal(first.status, 500);
  assert.ok(first.body.errors >= 1);
  assert.equal(blobs.has("bookings-preview", "m/2026-11"), false, "the other store was still cleaned");
  assert.equal(blobs.has("bookings", "auth/all"), false, "and the other keys");
  assert.equal(blobs.json("bookings", "m/2026-12").items.length, 2, "the failed document is unchanged");
  const second = await run(d);
  assert.equal(second.status, 200);
  assert.equal(blobs.json("bookings", "m/2026-12").items.length, 1);
});

test("retention: a scheduled function declared in its own file, daily", () => {
  assert.deepEqual(retention.config, { schedule: "@daily" });
  assert.match(readFileSync(new URL("../../netlify/functions/retention.mjs", import.meta.url), "utf8"), /export const config = \{ schedule: "@daily" \}/);
});
