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
import { RETENTION_DAYS, STATS_KEEP_DAYS, COUNTER_MAX_AGE_MS } from "../../netlify/lib/store-keys.mjs";
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
  // the counters (limits.mjs): buckets of named hits and the two shared documents
  blobs.seed(store, "rl/b/ip/3", { hits: [{ t: nowMs - 25 * 3600e3, id: "a", k: "o".repeat(22) }] });
  blobs.seed(store, "rl/b/phone/c", { hits: [{ t: nowMs - 25 * 3600e3, id: "a", k: "n".repeat(22) }, { t: nowMs - 3600e3, id: "b", k: "n".repeat(22) }, { t: nowMs - 2 * 3600e3, id: "c", k: "m".repeat(22) }] });
  blobs.seed(store, "rl/all", { hits: [{ t: nowMs - 30 * 3600e3, id: "a" }], alertedAt: nowMs - 2 * 3600e3 });
  blobs.seed(store, "rl/login/all", { hits: [{ t: nowMs - 49 * 3600e3, id: "z" }], alertedAt: nowMs - 26 * 3600e3 });
  // leftovers of builds before round 3: one document per client or number (never released, so always deleted)
  blobs.seed(store, "rl/ip/oldoldoldoldoldoldold", { hits: [{ t: nowMs - 25 * 3600e3, id: "a" }] });
  blobs.seed(store, "rl/phone/newnewnewnewnewnewnew", { hits: [{ t: nowMs - 3600e3, id: "b" }] });
  blobs.seed(store, "rl/login/ip/newnewnewnewnewnewnew", { hits: [{ t: nowMs - 60e3, id: "c" }] });
  blobs.seed(store, "auth/epoch", { t: nowMs - 10 * DAY });
  blobs.seed(store, "auth/ip/198.51.100.5", { count: 3, start: nowMs - 60e3 });
  blobs.seed(store, "auth/all", { count: 9, start: nowMs - 60e3 });
  blobs.seed(store, "push/subs", { subs: [], gone: [] });
  blobs.seed(store, "calendar/feed", { token: "B".repeat(43), gen: "x".repeat(16) });
  return { keep, keepCancelled };
}

function site({ listPageSize = 1000, retryDelayMs } = {}) {
  const clock = new FakeClock(NOW);
  const blobs = new FakeBlobs({ clock, listPageSize, ...(retryDelayMs !== undefined ? { retryDelayMs } : {}) });
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

test("retention: every counter hit and pause alert a day old goes, the counter documents stay; leftovers and legacy auth/* always go; the secret, the epoch and push/calendar stay", async () => {
  const { d, blobs } = site();
  await run(d);
  for (const store of ["bookings", "bookings-preview"]) {
    const keys = blobs.keys(store).filter((k) => !k.startsWith("m/"));
    assert.deepEqual(keys, ["auth/epoch", "calendar/feed", "push/subs", "rl/all", "rl/b/ip/3", "rl/b/phone/c", "rl/login/all", "rl/secret"], store);
    assert.deepEqual(blobs.json(store, "rl/b/ip/3"), { hits: [] }, "an emptied bucket is written empty (one of a fixed set)");
    assert.deepEqual(blobs.json(store, "rl/b/phone/c").hits.map((h) => h.id), ["b", "c"], "the hit over a day old went, the same number's newer hit stayed");
    assert.deepEqual(blobs.json(store, "rl/all"), { hits: [], alertedAt: nowMs - 2 * 3600e3 }, "a recent pause alert stays");
    assert.deepEqual(blobs.json(store, "rl/login/all"), { hits: [] });
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
  // the client retries a 500 five times; with its real 5-s delay one failing document would use up the run's time
  // budget (tested below), so here the retries are quick and the run has time for everything else
  const { d, blobs } = site({ retryDelayMs: 100 });
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

// Netlify runs scheduled functions only on the published deploy. If its call ever came without deploy information,
// the live store must still be cleaned: the rules are the same for every store, so this deletes only what is due.
test("retention: a call without deploy information (the scheduler) cleans the live store too", async () => {
  for (const ctx of [undefined, {}]) {
    const { d, blobs } = site();
    const res = await read(await retention.handle(request("/.netlify/functions/retention", { method: "POST", json: {} }), ctx, d));
    assert.equal(res.status, 200);
    assert.equal(blobs.has("bookings", "m/2026-11"), false, JSON.stringify(ctx));
    assert.deepEqual(blobs.keys("stats"), ["d/2027-02-28"]);
  }
});

// ---------- Round 2: the worst-case lifetime is what the pages state (SPEC R30) ----------
// The clean-up runs once per schedule interval (config.schedule), so a thing lives up to its threshold PLUS one
// interval: a counter whose last hit came just after a run was still stored 47 h later, while personvern.html said
// «24 timer». The stated periods (personvern.html, SPEC, DEPLOY) are these worst cases; this test seeds each kind
// just after a run, runs the clean-up on its schedule, and requires it gone within the stated period.
const RUN_EVERY_MS = { "@hourly": 3600e3, "@daily": DAY }[retention.config.schedule];
const STATED = {
  counterHours: (COUNTER_MAX_AGE_MS + RUN_EVERY_MS) / 3600e3,
  bookingDays: RETENTION_DAYS + RUN_EVERY_MS / DAY,
  statsDays: STATS_KEEP_DAYS + RUN_EVERY_MS / DAY,
};
// The end of an Oslo date (midnight Oslo at the start of the next day), in ms
const endOfOsloDay = (date) => {
  const next = new Date(Date.parse(date + "T00:00:00Z") + DAY).toISOString().slice(0, 10);
  for (const off of [1, 2]) { const t = Date.parse(`${next}T00:00:00Z`) - off * 3600e3; if (osloDate(t) === next && osloDate(t - 1) !== next) return t; }
  throw new Error("no Oslo midnight");
};
const osloDate = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
// Runs the clean-up at every scheduled time from startMs until gone() or limitMs; returns the time it went
async function runUntilGone(clock, d, gone, limitMs) {
  for (let t = clock.now(); t <= limitMs; t += RUN_EVERY_MS) {
    clock.set(t);
    assert.equal((await run(d)).status, 200);
    if (gone()) return t;
  }
  return null;
}

test("retention round 2: the schedule is one the stated periods are derived from", () => {
  assert.ok(RUN_EVERY_MS, `config.schedule ${retention.config.schedule}`);
  assert.deepEqual(STATED, { counterHours: 48, bookingDays: 91, statsDays: 401 });
});

test("retention round 2: a counter hit just after a run is gone within the stated worst case (48 h), not before 24 h", async (t) => {
  quiet(t);
  const runAt = Date.parse("2027-03-01T00:00:00Z"); // @daily runs at midnight UTC
  const clock = new FakeClock(new Date(runAt).toISOString());
  const blobs = new FakeBlobs({ clock });
  const d = testDeps({ blobs });
  const hit = runAt + 60e3;
  blobs.seed("bookings", "rl/b/ip/7", { hits: [{ t: hit, id: "a", k: "x".repeat(22) }] });
  clock.advance(RUN_EVERY_MS);
  const gone = await runUntilGone(clock, d, () => !blobs.json("bookings", "rl/b/ip/7").hits.some((h) => h.id === "a"), runAt + 10 * DAY);
  assert.ok(gone, "deleted at all");
  assert.ok(gone - hit > COUNTER_MAX_AGE_MS, "not before the threshold");
  assert.ok(gone - hit <= STATED.counterHours * 3600e3, `deleted ${(gone - hit) / 3600e3} h after the last hit`);
});

for (const [kind, seed, has, statedDays, keepDays] of [
  ["a booking", (blobs, date) => blobs.seed("bookings", `m/${date.slice(0, 7)}`, { items: [item({ date })] }), (blobs, date) => (blobs.json("bookings", `m/${date.slice(0, 7)}`) || { items: [] }).items.length > 0, () => STATED.bookingDays, RETENTION_DAYS],
  ["a statistics day", (blobs, date) => blobs.seed("stats", `d/${date}`, { views: 1, pages: { forside: 1 }, sources: { direkte: 1 } }), (blobs, date) => blobs.has("stats", `d/${date}`), () => STATED.statsDays, STATS_KEEP_DAYS],
]) {
  test(`retention round 2: ${kind} is gone within the stated worst case after its date, not before its threshold`, async (t) => {
    quiet(t);
    const date = "2026-11-20";
    const end = endOfOsloDay(date);
    const firstRun = Date.parse("2026-11-21T00:00:00Z"); // the first @daily run after the day
    const clock = new FakeClock(new Date(firstRun + (keepDays - 2) * DAY).toISOString());
    const blobs = new FakeBlobs({ clock });
    const d = testDeps({ blobs });
    seed(blobs, date);
    const gone = await runUntilGone(clock, d, () => !has(blobs, date), firstRun + (keepDays + 5) * DAY);
    assert.ok(gone, "deleted at all");
    assert.ok(gone - end >= keepDays * DAY - 3 * 3600e3, `not before ${keepDays} days`);
    assert.ok(gone - end <= statedDays() * DAY, `deleted ${((gone - end) / DAY).toFixed(2)} days after the end of the date; stated ${statedDays()}`);
  });
}

// ---------- Fix-up round 2: a time budget (retention-load.mjs) ----------
// Netlify stops a scheduled function after 30 s (docs/contracts/netlify.md). The clean-up walked every key one by
// one, three Blobs calls per stale counter, bookings first: 600 refused logins from 600 /64s made it need 45 s, and
// the statistics and Instagram steps never ran. Round 3: the current counters are a fixed set (counter-flood.test.mjs
// proves the nightly work stays the same under any flood); what can still be large is a one-off backlog of leftovers
// from older builds (a document per client or number, auth/ip/<address>). Guard: with 5 000 of them at 25 ms per
// Blobs call (the fake clock adds concurrent calls up, so this is the pessimistic case), one run stops cleanly inside
// the limit, has done everything else first (bookings, statistics, Instagram, the current counters), says how much is
// left, and later runs finish.
test("retention budget: 5 000 leftover counters at 25 ms per call: the run stops cleanly within 30 s, bookings, statistics, Instagram and the current counters done first, and later nights finish", async (t) => {
  const out = quiet(t);
  const clock = new FakeClock(NOW);
  const blobs = new FakeBlobs({ clock, latencyMs: 25 });
  const d = testDeps({ blobs });
  const old = nowMs - 3 * DAY;
  for (let i = 0; i < 5000; i++) blobs.seed("bookings", `rl/login/ip/${String(i).padStart(22, "x")}`, i % 2 ? { hits: [] } : { hits: [{ t: old, id: "a" + i }] });
  blobs.seed("bookings", "rl/secret", { k: "s".repeat(43) });
  blobs.seed("bookings", "rl/b/phone/f", { hits: [{ t: old, id: "kari", k: "k".repeat(22) }] }); // a customer's number
  blobs.seed("bookings", "m/2026-10", { items: [item({ date: "2026-10-05", name: "Gammel kunde" })] });
  blobs.seed("stats", "d/2025-01-01", { views: 1, pages: { forside: 1 }, sources: { direkte: 1 } });
  blobs.seed("social", "oauth-state-" + "c".repeat(48), { platform: "instagram", created_at: old });
  const counters = () => blobs.keys("bookings").filter((k) => k.startsWith("rl/login/ip/")).length;
  const t0 = clock.now();
  const first = await run(d);
  const took = clock.now() - t0;
  assert.ok(took < 30e3, `the run took ${took / 1000} s on the virtual clock`);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(blobs.has("bookings", "m/2026-10"), false, "the old booking (personal data) went first");
  assert.equal(blobs.has("stats", "d/2025-01-01"), false, "the statistics step ran");
  assert.equal(blobs.has("social", "oauth-state-" + "c".repeat(48)), false, "the Instagram step ran");
  assert.deepEqual(blobs.json("bookings", "rl/b/phone/f").hits, [], "the customer's old hit went in the first run, before the leftovers");
  assert.ok(first.body.unfinished > 0 && counters() > 0, `stopped early: ${JSON.stringify(first.body)}, ${counters()} counters left`);
  assert.ok(out.log.some((a) => /stoppet/i.test(String(a[0]))), "it says so in the log");
  let nights = 1;
  while (counters() > 0 && nights < 40) {
    clock.advance(DAY);
    const t1 = clock.now();
    const r = await run(d);
    assert.equal(r.status, 200);
    assert.ok(clock.now() - t1 < 30e3);
    nights++;
  }
  assert.equal(counters(), 0, `all leftovers gone after ${nights} nights`);
  assert.ok(blobs.has("bookings", "rl/secret"));
});

// Round 3 (list-starves-months.mjs): the clean-up listed every key in the store before it first checked the
// deadline, so 100 000 keys at 200 ms per list page used up the budget in the listing: {deleted: 0}, and a booking
// stayed 103 days. Guard: each step lists only its own prefix, right before it runs, and reads no new list page
// after the deadline; a slow, long listing of leftovers can never hold back the months, the bounded steps or the
// current counters, and the run still ends inside the limit.
test("retention budget: a listing that alone would take 40 s (5 000 leftovers, 50 keys per page, 400 ms per page) stops at the deadline, after the months, statistics, Instagram and current counters are done", async (t) => {
  const out = quiet(t);
  const clock = new FakeClock(NOW);
  const blobs = new FakeBlobs({ clock, listPageSize: 50, latencyMs: (req) => (req.op === "LIST" ? 400 : 25) });
  const d = testDeps({ blobs });
  const old = nowMs - 3 * DAY;
  for (let i = 0; i < 2500; i++) blobs.seed("bookings", `auth/ip/198.51.${i >> 8}.${i & 255}`, { n: 1, start: old });
  for (let i = 0; i < 2500; i++) blobs.seed("bookings", `rl/ip/${String(i).padStart(22, "q")}`, { hits: [{ t: nowMs - 60e3, id: "a" }] });
  blobs.seed("bookings", "rl/b/phone/2", { hits: [{ t: old, id: "kari", k: "k".repeat(22) }] });
  blobs.seed("bookings", "m/2026-10", { items: [item({ date: "2026-10-05", name: "Gammel kunde" })] });
  blobs.seed("stats", "d/2025-01-01", { views: 1, pages: {}, sources: {} });
  blobs.seed("social", "oauth-state-" + "d".repeat(48), { platform: "instagram", created_at: old });
  const t0 = clock.now();
  const first = await run(d);
  assert.ok(clock.now() - t0 < 30e3, `the run took ${(clock.now() - t0) / 1000} s on the virtual clock`);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(blobs.has("bookings", "m/2026-10"), false, "the months first");
  assert.equal(blobs.has("stats", "d/2025-01-01"), false);
  assert.equal(blobs.has("social", "oauth-state-" + "d".repeat(48)), false);
  assert.deepEqual(blobs.json("bookings", "rl/b/phone/2").hits, [], "the current counters before the leftovers");
  assert.ok(first.body.unfinished > 0, JSON.stringify(first.body));
  const lists = blobs.log.filter((e) => e.method === "LIST");
  assert.ok(lists.every((e) => e.at - 400 < t0 + retention.BUDGET_MS), "no list page was asked for after the deadline");
  assert.ok(out.log.some((a) => /stoppet/i.test(String(a[0]))));
  for (let night = 0; night < 30 && blobs.keys("bookings").some((k) => k.startsWith("auth/ip/") || k.startsWith("rl/ip/")); night++) {
    clock.advance(DAY);
    assert.equal((await run(d)).status, 200);
  }
  assert.deepEqual(blobs.keys("bookings").filter((k) => k.startsWith("auth/ip/") || k.startsWith("rl/ip/")), [], "later nights finish");
});

test("retention budget: a counter with a stale hit costs two Blobs calls (read, conditional write), a leftover one (delete), and nothing stale one read", async () => {
  const clock = new FakeClock(NOW);
  const blobs = new FakeBlobs({ clock });
  const d = testDeps({ blobs });
  for (let i = 0; i < 16; i++) blobs.seed("bookings", `rl/b/ip/${i.toString(16)}`, { hits: [{ t: nowMs - 3 * DAY, id: "a", k: "y".repeat(22) }] });
  for (let i = 0; i < 16; i++) blobs.seed("bookings", `rl/b/phone/${i.toString(16)}`, { hits: [{ t: nowMs - 3600e3, id: "a", k: "y".repeat(22) }] });
  for (let i = 0; i < 20; i++) blobs.seed("bookings", `rl/ip/${String(i).padStart(22, "y")}`, { hits: [{ t: nowMs - 3 * DAY, id: "a" }] });
  const from = blobs.log.length;
  await run(d);
  const on = (re) => blobs.log.slice(from).filter((e) => e.store === "bookings" && e.key && re.test(e.key)).map((e) => e.method);
  assert.deepEqual(on(/^rl\/b\/ip\//).sort(), [...Array(16).fill("GET"), ...Array(16).fill("PUT")].sort());
  assert.deepEqual(on(/^rl\/b\/phone\//), Array(16).fill("GET"));
  assert.deepEqual(on(/^rl\/ip\//), Array(20).fill("DELETE"));
});

// ---------- Round 3 (tombstone-age.mjs): the move and deletion logs in a month document ----------
// KEY_RULES said the movedOut/deletedOut logs hold the moves and deletions «in the last 24 h», but an entry was
// pruned only when the same month got a new one, so after a quiet month it stayed until the month document went
// (90+ days): it shows that a booking existed on that date and was deleted. Guard rule: every field in KEY_RULES with
// a stated period has a test that seeds an old value, runs the clean-up on schedule, and requires it gone within that
// period. Here: an entry is gone by the first run after it is 24 h old (stated: at the latest 48 hours), by the
// clean-up alone; newer entries, the bookings and a second quiet run stay unchanged.
test("retention round 3: move and deletion log entries in a month go by the first run after they are 24 h old (at the latest 48 h), newer ones and the bookings stay", async (t) => {
  quiet(t);
  const { KEY_RULES } = await import("../../netlify/lib/store-keys.mjs");
  const row = KEY_RULES.find((r) => r.prefix === "m/");
  assert.match(row.holds, /movedOut, deletedOut/);
  assert.match(row.holds + " " + row.deletion, /movedOut[\s\S]*at the latest 48 hours/, "the row states the period this test checks");
  const runAt = Date.parse("2026-11-21T00:00:00Z"); // @daily: midnight UTC
  const clock = new FakeClock(new Date(runAt).toISOString());
  const blobs = new FakeBlobs({ clock });
  const d = testDeps({ blobs });
  const kept = item({ date: "2026-11-27", name: "Blir" });
  const old = "2026-11-20T08:00:00.000Z"; // 16 h before the first run, 40 h before the second
  blobs.seed("bookings", "m/2026-11", {
    items: [kept],
    deletedOut: [{ id: "2026-11-27_seed0001", m: "aaaaaaaaaaaa", at: old }],
    movedOut: [{ id: "2026-11-28_seed0002", to: "2026-12-03_seed0002", m: "bbbbbbbbbbbb", at: old }],
  });
  assert.equal((await run(d)).status, 200);
  assert.equal(blobs.json("bookings", "m/2026-11").deletedOut.length, 1, "16 h old: still kept (the threshold is 24 h)");
  clock.set(runAt + DAY - 3600e3); // an hour before the second run another booking is deleted
  const doc = blobs.json("bookings", "m/2026-11");
  const fresh = { id: "2026-11-29_seed0003", m: "cccccccccccc", at: new Date(clock.now()).toISOString() };
  blobs.seed("bookings", "m/2026-11", { ...doc, deletedOut: [...doc.deletedOut, fresh] });
  clock.set(runAt + DAY);
  const second = await run(d);
  assert.equal(second.status, 200);
  const after = blobs.json("bookings", "m/2026-11");
  assert.deepEqual(after.items, [kept], "the booking is unchanged");
  assert.deepEqual(after.deletedOut, [fresh], "the 40-h-old deletion entry went, the 1-h-old one stayed");
  assert.ok(!after.movedOut || after.movedOut.length === 0, `the 40-h-old move entry went: ${JSON.stringify(after.movedOut)}`);
  assert.ok(Date.parse(old) + 48 * 3600e3 >= runAt + DAY, "within the stated 48 h");
  const before = blobs.log.length;
  clock.set(runAt + DAY + 3600e3);
  assert.equal((await run(d)).body.changed, 0);
  assert.equal(blobs.log.slice(before).filter((e) => e.method === "PUT" || e.method === "DELETE").length, 0, "a quiet run writes nothing");
});
