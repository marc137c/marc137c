// Booking numbers for the owner's statistics (netlify/lib/stats-bookings.mjs), on FakeBlobs. Ported from main's
// test/stats.test.mjs (merge of origin/main, 2026-11-17) and extended. Invariants:
//   1. numbers are computed by READING the bookings, grouped by the Oslo day the booking was MADE: website vs
//      /admin, cancelled ones, per service (old names under the new one) and per weekday of the appointment;
//      blocks are not bookings;
//   2. a day SNAPSHOT_AFTER days old is frozen into d/<date>.bookings, so it survives the bookings' deletion; a
//      frozen day is never written again, today is never frozen, and a frozen day keeps its visitor counts;
//   3. only numbers are stored: a service name /admin typed freely is counted as «Annet» (no free text in a
//      document kept 400 days), and a booking caught mid-move between two months is counted once;
//   4. the day document is normalised: unknown pages/sources and damaged counts are dropped, and a day from before
//      visits were counted gets its visits from the sum of its sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBlobs } from "../helpers/fake-blobs.mjs";
import { item, seedItems } from "../helpers/bookings.mjs";
import { aggregateByCreatedDay, bookingStats, sumDays, statsDay, SNAPSHOT_AFTER } from "../../netlify/lib/stats-bookings.mjs";
import { addDays } from "../../netlify/lib/booking-core.mjs";

const TODAY = "2026-11-17";
const at = (date, hh = "10") => `${date}T${hh}:00:00.000Z`; // 10 UTC = 11 Oslo time, same date
const DATES = Array.from({ length: 30 }, (_, i) => addDays(TODAY, -i));
const stores = (blobs) => [blobs.getStore({ name: "bookings", consistency: "strong" }), blobs.getStore({ name: "stats", consistency: "strong" })];
const dayDocs = (blobs) => Object.fromEntries(DATES.map((d) => [d, blobs.has("stats", `d/${d}`) ? statsDay(blobs.json("stats", `d/${d}`)) : null]));

test("stats-bookings: website vs admin, cancelled, blocks and the old service name, by the Oslo day it was made", () => {
  const items = [
    item({ date: "2026-11-20", createdAt: at("2026-11-16") }),
    item({ date: "2026-11-21", createdAt: at("2026-11-16"), source: "admin", service: "Full service" }),
    item({ date: "2026-11-21", createdAt: at("2026-11-16"), status: "cancelled" }),
    item({ date: "2026-11-21", createdAt: at("2026-11-16"), type: "block" }),
    item({ date: "2026-11-22", createdAt: at("2026-11-16"), service: "Herreklipp + skjeggtrim (maskin)" }),
    item({ date: "2026-11-22", createdAt: at("2026-11-15", "23") }), // 23 UTC = 00 Oslo time on the 16th
  ];
  const out = aggregateByCreatedDay(items, "2026-11-10", TODAY);
  const d = out["2026-11-16"];
  assert.deepEqual([d.web, d.admin, d.cancelled], [4, 1, 1]);
  assert.deepEqual(d.services, { "Herreklipp": 2, "Full service": 1, "Herreklipp + skjeggtrim": 1 });
  assert.equal(d.weekdays[5] + d.weekdays[6] + d.weekdays[0], 4); // Fri 20th, Sat 21st, Sun 22nd
  assert.equal(out["2026-11-15"], undefined);
});

test("stats-bookings: a service typed freely in /admin is counted as «Annet», never stored as text", () => {
  const out = aggregateByCreatedDay([
    item({ date: "2026-11-20", createdAt: at("2026-11-16"), source: "admin", service: "Kari Nordmann 912 34 567" }),
    item({ date: "2026-11-20", createdAt: at("2026-11-16"), source: "admin", service: "" }),
  ], "2026-11-10", TODAY);
  assert.deepEqual(out["2026-11-16"].services, { Annet: 2 });
});

test("stats-bookings: a booking caught mid-move between two months (original + copy) is counted once", () => {
  const original = item({ id: "2026-11-30_abc123", date: "2026-11-30", createdAt: at("2026-11-16"), moving: { to: "2026-12-02_abc123", m: "mk" } });
  const copy = { ...original, id: "2026-12-02_abc123", date: "2026-12-02", mv: { m: "mk", from: original.id } };
  delete copy.moving;
  const out = aggregateByCreatedDay([original, copy], "2026-11-10", TODAY);
  assert.equal(out["2026-11-16"].web, 1);
  assert.equal(out["2026-11-16"].services.Herreklipp, 1);
});

test("stats-bookings: old days are frozen and survive the bookings' deletion; today's are read from the bookings", async () => {
  const blobs = new FakeBlobs();
  const [bookings, stats] = stores(blobs);
  const old = addDays(TODAY, -(SNAPSHOT_AFTER + 1));
  seedItems(blobs, [
    item({ date: addDays(old, 2), createdAt: at(old) }),
    item({ date: addDays(old, 3), createdAt: at(old), source: "admin" }),
    item({ date: addDays(TODAY, 2), createdAt: at(TODAY) }),
    item({ date: addDays(TODAY, 9), createdAt: at(TODAY), status: "cancelled" }),
  ]);
  let r = await bookingStats(bookings, stats, DATES, TODAY, dayDocs(blobs));
  let t = sumDays(r.perDay);
  assert.deepEqual([t.web, t.admin, t.cancelled], [3, 1, 1]); // made on the website = also the ones cancelled later
  assert.equal(r.upcoming7, 1); // the one in 2 days; the cancelled one is outside the week anyway
  assert.ok(blobs.json("stats", `d/${old}`).bookings, "the day older than the limit is frozen");
  assert.equal(blobs.has("stats", `d/${TODAY}`), false, "today is not frozen");

  for (const k of blobs.keys("bookings")) await bookings.delete(k); // every booking deleted (as after 90 days)
  r = await bookingStats(bookings, stats, DATES, TODAY, dayDocs(blobs));
  t = sumDays(r.perDay);
  assert.deepEqual([t.web, t.admin], [1, 1], "the frozen day stays, today's numbers are gone with the bookings");
});

test("stats-bookings: a frozen day is not written again, and a day with hits keeps its views", async () => {
  const blobs = new FakeBlobs();
  const [bookings, stats] = stores(blobs);
  const old = addDays(TODAY, -(SNAPSHOT_AFTER + 2));
  blobs.seed("stats", `d/${old}`, { views: 7, visits: 6, pages: {}, sources: {} });
  seedItems(blobs, [item({ date: addDays(old, 1), createdAt: at(old) })]);
  await bookingStats(bookings, stats, DATES, TODAY, dayDocs(blobs));
  const saved = blobs.json("stats", `d/${old}`);
  assert.equal(saved.views, 7);
  assert.equal(saved.visits, 6);
  assert.equal(saved.bookings.web, 1);
  const writes = () => blobs.log.filter((e) => e.store === "stats" && e.method === "PUT").length;
  const before = writes();
  await bookingStats(bookings, stats, DATES, TODAY, dayDocs(blobs));
  assert.equal(writes(), before, "no new write once the day is frozen");
});

test("stats-bookings: unreadable bookings throw (the caller reports them unknown) and freeze nothing", async () => {
  const blobs = new FakeBlobs();
  const [bookings, stats] = stores(blobs);
  seedItems(blobs, [item({ date: addDays(TODAY, -20), createdAt: at(addDays(TODAY, -20)) })]);
  blobs.inject({ method: "GET", store: "bookings", key: /^m\//, fault: "fail-before", status: 500, times: Infinity });
  await assert.rejects(bookingStats(bookings, stats, DATES, TODAY, dayDocs(blobs)));
  assert.deepEqual(blobs.keys("stats"), []);
});

test("stats-bookings: the day document keeps only known pages, sources and whole counts; old days get visits from their sources", () => {
  assert.deepEqual(statsDay({ views: 5, pages: { forside: 5 }, sources: { direkte: 3, google: 2 } }),
    { views: 5, visits: 5, pages: { forside: 5 }, sources: { direkte: 3, google: 2 } });
  assert.deepEqual(statsDay({ views: "x", visits: -1, pages: null, sources: { google: "x", evil: 9 }, bookings: { web: 2, services: { Herreklipp: 1, "Kari": 4 }, weekdays: [1] } }),
    { views: 0, visits: 0, pages: {}, sources: {}, bookings: { web: 2, admin: 0, cancelled: 0, services: { Herreklipp: 1 }, weekdays: [1, 0, 0, 0, 0, 0, 0] } });
  assert.deepEqual(statsDay(null), { views: 0, visits: 0, pages: {}, sources: {} });
  assert.deepEqual(statsDay({ views: 2, visits: 1, bookings: "broken" }), { views: 2, visits: 1, pages: {}, sources: {} });
});
