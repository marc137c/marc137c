// Smoke test: POST /api/bookings through handle(req, context, deps) with fake Blobs, env and clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { storedItems, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { handle, config } from "../../netlify/functions/bookings.mjs";

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
  const d = testDeps({ now: NOW });
  const res = await read(await handle(post({ ...BODY, date: "2026-11-12", start: 630 }), PRODUCTION, d));
  assert.deepEqual([res.status, res.body.code], [400, "too_early"]);
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
