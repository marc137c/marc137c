// Smoke test: POST /api/bookings through handle(req, context, deps) with fake Blobs, env, clock and Sveve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet } from "../helpers/deps.mjs";
import { fakeFetch, sveveReply } from "../helpers/fake-fetch.mjs";
import { storedItems } from "../helpers/bookings.mjs";
import { handle, config } from "../../netlify/functions/bookings.mjs";

const NOW = "2026-11-12T09:00:00Z"; // Thursday 10:00 in Oslo
const BODY = { service: "Herreklipp", date: "2026-11-13", start: 600, addons: [], name: "Ola Nordmann", phone: "409 63 911" };
const post = (json) => request("/api/bookings", { method: "POST", json });
const SVEVE_ENV = { SVEVE_USER: "u", SVEVE_PASSWD: "p" };

test("bookings: path is unchanged", () => {
  assert.deepEqual(config, { path: "/api/bookings" });
});

test("bookings: only POST", async () => {
  const res = await read(await handle(request("/api/bookings"), {}, testDeps()));
  assert.equal(res.status, 405);
});

test("bookings: a valid booking is stored once, with the injected clock, and answered 201", async () => {
  const d = testDeps({ now: NOW });
  const res = await read(await handle(post(BODY), {}, d));
  assert.equal(res.status, 201);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sms, "off");
  assert.deepEqual(Object.keys(res.body.booking).sort(), ["date", "dur", "id", "service", "start"]);
  const items = storedItems(d.blobs);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, res.body.booking.id);
  assert.equal(items[0].source, "nettside");
  assert.equal(items[0].createdAt, new Date(NOW).toISOString());
  assert.deepEqual(d.blobs.opened, [{ name: "bookings", consistency: "strong" }]);
  assert.equal(d.fetch.calls.length, 0, "no SMS without Sveve configured");
});

test("bookings: validation errors carry a code; a taken slot is 409", async () => {
  const d = testDeps({ now: NOW });
  let res = await read(await handle(post({ ...BODY, service: "Nope" }), {}, d));
  assert.deepEqual([res.status, res.body.code], [400, "bad_service"]);
  res = await read(await handle(post({ ...BODY, phone: "12" }), {}, d));
  assert.deepEqual([res.status, res.body.code], [400, "bad_phone"]);
  assert.equal((await handle(post(BODY), {}, d)).status, 201);
  res = await read(await handle(post({ ...BODY, name: "Kari" }), {}, d));
  assert.deepEqual([res.status, res.body.code], [409, "taken"]);
  assert.equal(storedItems(d.blobs).length, 1);
});

test("bookings: today's slots respect the injected clock (lead time)", async () => {
  const d = testDeps({ now: NOW });
  const res = await read(await handle(post({ ...BODY, date: "2026-11-12", start: 630 }), {}, d));
  assert.deepEqual([res.status, res.body.code], [400, "too_early"]);
});

test("bookings: honeypot, oversize and broken JSON", async () => {
  const d = testDeps({ now: NOW });
  let res = await read(await handle(post({ ...BODY, botField: "x" }), {}, d));
  assert.deepEqual([res.status, res.body], [200, { ok: true }]);
  assert.equal(storedItems(d.blobs).length, 0);
  res = await read(await handle(post({ ...BODY, note: "x".repeat(5000) }), {}, d));
  assert.equal(res.status, 413);
  res = await read(await handle(request("/api/bookings", { method: "POST", body: "{nope" }), {}, d));
  assert.equal(res.status, 400);
});

test("bookings: with Sveve configured the confirmation goes through deps.fetch", async () => {
  const fetch = fakeFetch([["https://sveve.no/SMS/SendMessage", () => sveveReply("ok")]]);
  const d = testDeps({ now: NOW, env: SVEVE_ENV, fetch });
  const res = await read(await handle(post(BODY), {}, d));
  assert.equal(res.status, 201);
  assert.equal(res.body.sms, "sent");
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].json().to, "40963911");
  assert.match(fetch.calls[0].json().msg, /i morgen kl\. 10:00/, "the SMS uses the injected clock for «i morgen»");
});

test("bookings: an SMS failure never stops a stored booking", async (t) => {
  const out = quiet(t);
  const fetch = fakeFetch([["https://sveve.no/SMS/SendMessage", () => sveveReply("fatal")]]);
  const d = testDeps({ now: NOW, env: SVEVE_ENV, fetch });
  const res = await read(await handle(post(BODY), {}, d));
  assert.deepEqual([res.status, res.body.sms], [201, "failed"]);
  assert.equal(storedItems(d.blobs).length, 1);
  assert.equal(out.error.length, 1);
});

test("bookings: a Blobs outage gives 500 and the call-us text", async (t) => {
  quiet(t);
  const d = testDeps({ now: NOW });
  d.blobs.inject({ method: "GET", fault: "fail-before", status: 500, times: Infinity });
  const res = await read(await handle(post(BODY), {}, d));
  assert.equal(res.status, 500);
  assert.match(res.body.error, /Ring oss/);
});
