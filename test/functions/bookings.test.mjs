// Smoke test: POST /api/bookings through handle(req, context, deps) with fake Blobs, env and clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { storedItems, counterHits, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { handle, config } from "../../netlify/functions/bookings.mjs";
import { validateCustomer, CONFIG } from "../../netlify/lib/booking-core.mjs";
import { counterRef, limiterSecret, ALL_KEY } from "../../netlify/lib/limits.mjs";
import { vapidKeys, saveSubscription, parseSubscription, pushGen } from "../../netlify/lib/push.mjs";
import { makeDevice, fakePushService } from "../helpers/fake-push.mjs";

const NOW = "2026-11-12T09:00:00Z"; // Thursday 10:00 in Oslo
const BODY = { service: "Herreklipp", date: "2026-11-13", start: 600, addons: [], name: "Ola Nordmann", phone: CUSTOMER_PHONE };
const post = (json) => request("/api/bookings", { method: "POST", json });
// Exactly the fields a stored web booking has (booking-core.mjs createItem): the booking itself, nothing else
const STORED_FIELDS = ["addons", "createdAt", "date", "dur", "id", "name", "note", "phone", "service", "source", "start", "status", "type", "updatedAt"];

test("bookings: path is unchanged", () => {
  assert.deepEqual(config, { path: "/api/bookings" });
});

test("bookings: only POST", async () => {
  const res = await read(await handle(request("/api/bookings"), PRODUCTION, testDeps()));
  assert.equal(res.status, 405);
});

test("bookings: a valid booking is stored once, with the injected clock, and answered 201", async () => {
  const d = testDeps({ now: NOW });
  const res = await read(await handle(post(BODY), PRODUCTION, d));
  assert.equal(res.status, 201);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual(Object.keys(res.body).sort(), ["booking", "ok"]);
  assert.equal(res.body.ok, true);
  assert.deepEqual(Object.keys(res.body.booking).sort(), ["date", "dur", "id", "service", "start"]);
  const items = storedItems(d.blobs);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, res.body.booking.id);
  assert.equal(items[0].source, "nettside");
  assert.equal(items[0].createdAt, new Date(NOW).toISOString());
  assert.deepEqual(d.blobs.opened, [{ name: "bookings", consistency: "strong" }]);
  assert.equal(d.fetch.calls.length, 0, "a booking makes no network call");
});

test("bookings: the stored booking holds only the booking, whatever extra fields the page sends", async () => {
  const d = testDeps({ now: NOW });
  const res = await read(await handle(post({ ...BODY, addons: ["Styling", "Ukjent"], lang: "en", status: "cancelled", source: "admin", extra: 1 }), PRODUCTION, d));
  assert.equal(res.status, 201);
  const [stored] = storedItems(d.blobs);
  assert.deepEqual(Object.keys(stored).sort(), STORED_FIELDS);
  assert.deepEqual([stored.status, stored.source, stored.addons], ["confirmed", "nettside", ["Styling"]]);
});

test("bookings: validation errors carry a code; a taken slot is 409", async () => {
  const d = testDeps({ now: NOW });
  let res = await read(await handle(post({ ...BODY, service: "Nope" }), PRODUCTION, d));
  assert.deepEqual([res.status, res.body.code], [400, "bad_service"]);
  res = await read(await handle(post({ ...BODY, phone: "12" }), PRODUCTION, d));
  assert.deepEqual([res.status, res.body.code], [400, "bad_phone"]);
  assert.equal((await handle(post(BODY), PRODUCTION, d)).status, 201);
  res = await read(await handle(post({ ...BODY, name: "Kari" }), PRODUCTION, d));
  assert.deepEqual([res.status, res.body.code], [409, "taken"]);
  assert.equal(storedItems(d.blobs).length, 1);
});

test("bookings: today's slots respect the injected clock (lead time)", async () => {
  // 10:00 in Oslo: 10:00 is inside the lead time (CONFIG.leadMin, 15 min since the owner's choice of 2026-11-17), 10:30 is not
  const d = testDeps({ now: NOW });
  const res = await read(await handle(post({ ...BODY, date: "2026-11-12", start: 600 }), PRODUCTION, d));
  assert.deepEqual([res.status, res.body.code], [400, "too_early"]);
  const ok = await read(await handle(post({ ...BODY, date: "2026-11-12", start: 600 + CONFIG.slotMin * Math.ceil(CONFIG.leadMin / CONFIG.slotMin) }), PRODUCTION, d));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test("bookings: honeypot, oversize and broken JSON", async () => {
  const d = testDeps({ now: NOW });
  let res = await read(await handle(post({ ...BODY, botField: "x" }), PRODUCTION, d));
  assert.deepEqual([res.status, res.body], [200, { ok: true }]);
  assert.equal(storedItems(d.blobs).length, 0);
  res = await read(await handle(post({ ...BODY, note: "x".repeat(5000) }), PRODUCTION, d));
  assert.equal(res.status, 413);
  res = await read(await handle(request("/api/bookings", { method: "POST", body: "{nope", headers: { "Content-Type": "application/json" } }), PRODUCTION, d));
  assert.equal(res.status, 400);
});

test("bookings: a Blobs outage gives 500 and the call-us text", async (t) => {
  quiet(t);
  const d = testDeps({ now: NOW });
  d.blobs.inject({ method: "GET", fault: "fail-before", status: 500, times: Infinity });
  const res = await read(await handle(post(BODY), PRODUCTION, d));
  assert.equal(res.status, 500);
  assert.match(res.body.error, /Ring oss/);
});

// ---------- F1 (server), SPEC R1: a retry with the same requestId stores once and counts once ----------
const RID = "rq_7fK2mQ9xLp4Z";
const PASSWORD = "fake-admin-password";
const live = (d) => d.getStore({ name: "bookings", consistency: "strong" });
const hitsOf = async (d, kind, value) => {
  const ref = kind === "all" ? ALL_KEY : counterRef(await limiterSecret(live(d)), kind, value);
  return counterHits(d.blobs, ref).length;
};
async function withDevice() {
  const dev = makeDevice("fcm");
  const push = fakePushService({ devices: [dev] });
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PASSWORD }, fetch: push.fetch });
  await vapidKeys(live(d), { now: d.now() });
  await saveSubscription(live(d), parseSubscription(dev.subscription).value, { now: d.now(), gen: pushGen(PASSWORD), until: new Date(Date.parse(NOW) + 864e5) });
  return Object.assign(d, { push });
}

test("bookings: the same body and requestId twice give 201 twice with one booking, one push and one count", async () => {
  const d = await withDevice();
  const a = await read(await handle(post({ ...BODY, requestId: RID }), PRODUCTION, d));
  const b = await read(await handle(post({ ...BODY, requestId: RID }), PRODUCTION, d));
  assert.deepEqual([a.status, b.status], [201, 201]);
  assert.equal(b.body.booking.id, a.body.booking.id);
  assert.deepEqual(b.body, a.body, "the replay answers exactly like the first reply");
  assert.equal(storedItems(d.blobs).length, 1);
  assert.equal(storedItems(d.blobs)[0].requestId, RID);
  assert.equal(d.push.deliveries.length, 1, "one «Ny time»");
  assert.equal(await hitsOf(d, "phone", "91234567"), 1);
  assert.equal(await hitsOf(d, "all"), 1);
});

test("bookings: a reply lost after the booking was stored (502 on every write attempt) gives 500, and the retry is a 201 replay", async (t) => {
  quiet(t);
  const d = testDeps({ now: NOW });
  d.blobs.inject({ method: "PUT", key: /^m\//, fault: "fail-after", status: 502, times: 6 });
  const first = await read(await handle(post({ ...BODY, requestId: RID }), PRODUCTION, d));
  assert.equal(first.status, 500);
  assert.match(first.body.error, /Ring oss/);
  assert.equal(storedItems(d.blobs).length, 1, "the write itself was committed");
  const retry = await read(await handle(post({ ...BODY, requestId: RID }), PRODUCTION, d));
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
  assert.equal(retry.body.booking.id, storedItems(d.blobs)[0].id);
  assert.equal(storedItems(d.blobs).length, 1);
  assert.equal(await hitsOf(d, "phone", "91234567"), 1, "the retry is not counted again");
});

test("bookings: another requestId for the same slot is 409, and that attempt's phone and global hits are given back", async () => {
  const d = testDeps({ now: NOW });
  assert.equal((await handle(post({ ...BODY, requestId: RID }), PRODUCTION, d)).status, 201);
  const other = await read(await handle(post({ ...BODY, name: "Kari", phone: "41234567", requestId: "rq_other_0001" }), PRODUCTION, d));
  assert.deepEqual([other.status, other.body.code], [409, "taken"]);
  assert.equal(await hitsOf(d, "phone", "41234567"), 0);
  assert.equal(await hitsOf(d, "all"), 1);
  assert.equal(storedItems(d.blobs).length, 1);
});

test("bookings: a requestId only replays the same time; a malformed one is ignored and never stored", async () => {
  const d = testDeps({ now: NOW });
  for (const bad of ["short", "x".repeat(65), "has space 123", "ÆØÅ-æøå-123", 12345678, { a: 1 }, ["rq_7fK2mQ9xLp4Z"]]) {
    const v = validateCustomer({ ...BODY, requestId: bad }, new Date(NOW));
    assert.equal(v.error, undefined);
    assert.equal("requestId" in v.value, false, JSON.stringify(bad));
  }
  assert.equal(validateCustomer({ ...BODY, requestId: RID }, new Date(NOW)).value.requestId, RID);
  assert.equal(validateCustomer(BODY, new Date(NOW)).value.requestId, undefined);
  // malformed: no replay, the second post is an ordinary clash
  assert.equal((await handle(post({ ...BODY, requestId: "bad id" }), PRODUCTION, d)).status, 201);
  assert.equal((await handle(post({ ...BODY, requestId: "bad id" }), PRODUCTION, d)).status, 409);
  assert.deepEqual(Object.keys(storedItems(d.blobs)[0]).sort(), STORED_FIELDS);
  // the same requestId for another time is not a replay of the first booking: the page makes a new requestId for
  // every change, so a reuse is refused (409 request_reused) and stores nothing (round 2, SPEC R5)
  assert.equal((await handle(post({ ...BODY, start: 660, requestId: RID }), PRODUCTION, d)).status, 201);
  const again = await read(await handle(post({ ...BODY, start: 690, requestId: RID }), PRODUCTION, d));
  assert.deepEqual([again.status, again.body.code], [409, "request_reused"]);
  assert.equal(storedItems(d.blobs).length, 2);
});

test("bookings: a phone over 30 characters is 400 bad_phone and stores nothing (F25: it was cut and saved)", async () => {
  const d = testDeps({ now: NOW });
  const phone = "409 63 911" + " ".repeat(20) + "1"; // 31 characters, 9 digits
  const res = await read(await handle(post({ ...BODY, phone }), PRODUCTION, d));
  assert.deepEqual([res.status, res.body.code], [400, "bad_phone"]);
  assert.equal(storedItems(d.blobs).length, 0);
});

// ---------- Fix-up round 2: a replay is answered before every clock- or state-dependent rule ----------
// s2-too-early-retry.mjs: the customer books today 11:00 at 10:00:40, the booking is stored but the reply is lost,
// and the retry with the same requestId comes after 10:00 (the lead time has passed). validateCustomer ran before the
// replay lookup, so the retry got 400 too_early, the page said «Tiden du valgte er ikke ledig lenger», and the
// customer booked a second time. Rule: a replay of a stored requestId (same date and start, still active) answers
// 201 with the stored booking before the date window, the lead time, the opening hours or the caps are checked.
const RID2 = "retry-req-0001";
const today = { ...BODY, date: "2026-11-12", start: 660, requestId: RID2 }; // Thursday 12 Nov 11:00
// Oslo time on 12 Nov (UTC+1) as an ISO instant. From the lead time (CONFIG.leadMin), so the cases hold for any value:
// BOOKED_AT is the last minute at which 11:00 is still offered, RETRY_AT the first one at which it is too early.
const osloAt = (min, sec) => new Date(Date.UTC(2026, 10, 12, 0, 0, sec) + (min - 60) * 60e3).toISOString();
const BOOKED_AT = osloAt(660 - CONFIG.leadMin - 1, 40);
const RETRY_AT = osloAt(660 - CONFIG.leadMin + 1, 23);
for (const [label, later] of [
  ["the lead time has passed (today, about a minute later)", RETRY_AT],
  ["the date has passed (just after midnight)", "2026-11-12T23:10:00Z"],
]) {
  test(`bookings replay: a stored booking retried after ${label} answers 201 with the stored booking`, async () => {
    const d = testDeps({ now: BOOKED_AT }); // 11:00 is the first time offered
    const first = await read(await handle(post(today), PRODUCTION, d));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    d.clock.set(later);
    const retry = await read(await handle(post(today), PRODUCTION, d));
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    assert.equal(retry.body.booking.id, first.body.booking.id);
    assert.equal(storedItems(d.blobs).length, 1);
  });
}
test("bookings replay: a request with a requestId nobody stored still gets the clock rules (400 too_early)", async () => {
  const d = testDeps({ now: RETRY_AT });
  const r = await read(await handle(post({ ...today, requestId: "never-stored-01" }), PRODUCTION, d));
  assert.deepEqual([r.status, r.body.code], [400, "too_early"]);
  assert.equal(storedItems(d.blobs).length, 0);
});
test("bookings replay: the same requestId on a cancelled booking is not a replay", async () => {
  const d = testDeps({ now: BOOKED_AT });
  const first = await read(await handle(post(today), PRODUCTION, d));
  const doc = d.blobs.json("bookings", "m/2026-11");
  doc.items[0].status = "cancelled";
  d.blobs.seed("bookings", "m/2026-11", doc);
  d.clock.set(RETRY_AT);
  const retry = await read(await handle(post(today), PRODUCTION, d));
  assert.equal(first.status, 201);
  assert.deepEqual([retry.status, retry.body.code], [400, "too_early"]);
});
// Round 3 (still_open 7): the page now takes a clock-rule «no» to the same requestId as «nothing is stored under it»
// (definite: the time is dropped and the customer may pick another). That holds only if a requestId the server HAS
// stored at another time never gets a clock «no»: the customer called about an uncertain booking, the barber moved it,
// and the page retried. Rule (SPEC R36): before any clock rule, an active booking with this requestId at another time
// answers 409 request_reused, as it does on the normal path.
test("bookings replay: a booking the barber moved, retried with its requestId after the lead time, answers 409 request_reused, never too_early", async () => {
  const d = testDeps({ now: BOOKED_AT });
  const first = await read(await handle(post(today), PRODUCTION, d));
  assert.equal(first.status, 201);
  const doc = d.blobs.json("bookings", "m/2026-11");
  doc.items[0].start = 720; // moved to 12:00 in /admin
  d.blobs.seed("bookings", "m/2026-11", doc);
  d.clock.set(RETRY_AT);
  const retry = await read(await handle(post(today), PRODUCTION, d));
  assert.deepEqual([retry.status, retry.body.code], [409, "request_reused"]);
  assert.equal(storedItems(d.blobs).length, 1);
  // a requestId nobody stored still gets the clock rule
  const other = await read(await handle(post({ ...today, requestId: "never-stored-02" }), PRODUCTION, d));
  assert.deepEqual([other.status, other.body.code], [400, "too_early"]);
});
