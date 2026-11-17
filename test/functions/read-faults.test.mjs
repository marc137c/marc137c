// Guard rule (round 2, SPEC R18): a missing document and an unreadable one are different things on a read path.
// GET /api/stats turned a store error into «0 visits» with status 200 (`.catch(() => null)` on the read).
// Test rule: every read endpoint of the booking store gets a GET fault (fail-before 500 on the documents it
// reads) and must answer non-2xx or carry an explicit error flag, never a confident value. A source check fails
// when a handler swallows a store read into a value again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { item, seedItems } from "../helpers/bookings.mjs";
import { makeToken } from "../../netlify/lib/booking-core.mjs";
import { createFeed, feedGen } from "../../netlify/lib/calendar.mjs";
import * as availability from "../../netlify/functions/availability.mjs";
import * as admin from "../../netlify/functions/admin.mjs";
import * as calendar from "../../netlify/functions/calendar.mjs";
import * as bookingIcs from "../../netlify/functions/booking-ics.mjs";
import * as stats from "../../netlify/functions/stats.mjs";

const PW = "fake-admin-password";
const NOW = "2026-11-16T09:00:00Z";
const FN_DIR = fileURLToPath(new URL("../../netlify/functions/", import.meta.url));
const bearer = (d) => ({ Authorization: "Bearer " + makeToken(PW, d.clock.now()) });
// /api/stats answers only the owner's overview (merge of main 6bf86e8): its read key, never the barber's token
const STATS_KEY = "fake-owner-stats-key";
const statsKey = { "X-Stats-Key": STATS_KEY };
// Since that merge /api/stats also reads the booking months for the owner's booking numbers. Unreadable months make
// those numbers null (unknown) in an otherwise good reply, never 0: that is its explicit flag.
const bookingsUnknown = (body) => body.bookings === null && Array.isArray(body.days) && body.days.length > 0 && body.days.every((x) => x.bookings === null);

// [label, the keys whose reads fail, call(d, ctx), optional: how a good reply marks the unreadable part unknown]
const READS = [
  ["GET /api/availability", /^m\//, (d) => availability.handle(request("/api/availability"), PRODUCTION, d)],
  ["GET /api/admin/items", /^m\//, (d) => admin.handle(request("/api/admin/items?from=2026-11-16&to=2026-11-22", { headers: bearer(d) }), PRODUCTION, d)],
  ["GET /api/admin/push", /^push\//, (d) => admin.handle(request("/api/admin/push", { headers: bearer(d) }), PRODUCTION, d)],
  ["GET /api/admin/calendar", /^calendar\//, (d) => admin.handle(request("/api/admin/calendar", { headers: bearer(d) }), PRODUCTION, d)],
  ["GET /api/calendar/<token>.ics", /^m\//, (d, c) => calendar.handle(request(new URL(c.feed).pathname), PRODUCTION, d)],
  ["GET /api/bookings/<id>.ics", /^m\//, (d, c) => bookingIcs.handle(request(`/api/bookings/${c.id}.ics`), PRODUCTION, d)],
  ["GET /api/stats", /^d\//, (d) => stats.handle(request("/api/stats", { headers: statsKey }), PRODUCTION, d)],
  ["GET /api/stats (booking months)", /^m\//, (d) => stats.handle(request("/api/stats", { headers: statsKey }), PRODUCTION, d), bookingsUnknown],
];

for (const [label, keys, call, unknown] of READS) {
  test(`read faults: ${label} with its documents unreadable is non-2xx or flags the error, never a confident value`, async (t) => {
    quiet(t);
    const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW, STATS_READ_KEY: STATS_KEY } });
    const store = d.getStore({ name: "bookings", consistency: "strong" });
    const [b] = seedItems(d.blobs, [item({ date: "2026-11-18", start: 600 })]);
    d.blobs.seed("stats", "d/2026-11-16", { views: 3, pages: { forside: 3 }, sources: { direkte: 3 } });
    const feed = await createFeed(store, { now: d.now(), gen: feedGen(PW) });
    const ctx = { id: b.id, feed: `https://viggos.test/api/calendar/${feed.feed.token}.ics` };
    assert.ok((await call(d, ctx)).status < 300, `${label} works without the fault`);
    d.blobs.inject({ method: "GET", key: keys, fault: "fail-before", status: 500, times: Infinity });
    const res = await read(await call(d, ctx));
    const flagged = res.body && typeof res.body === "object" && (res.body.error !== undefined || res.body.unknown === true || (unknown ? unknown(res.body) : false));
    assert.ok(res.status >= 300 || flagged, `${label}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  });
}

test("read faults: no handler turns a failed store read into a value (.catch(() => null) and the like)", () => {
  for (const f of readdirSync(FN_DIR).filter((x) => x.endsWith(".mjs"))) {
    const src = readFileSync(FN_DIR + f, "utf8");
    const bad = src.match(/\.(get|getWithMetadata|list)\([^)]*\)[^;\n]*\.catch\(\s*\(\)\s*=>\s*(null|undefined|\[\]|\{\}|\(\{\}\)|0)\s*\)/g);
    assert.equal(bad, null, `${f}: ${bad}`);
  }
});
