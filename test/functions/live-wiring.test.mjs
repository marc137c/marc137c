// The default exports Netlify calls still run the handlers with liveDeps(): the real @netlify/blobs client
// (strong consistency), process.env and the real clock. The real client is pointed at the fake Blobs server
// through globalThis.netlifyBlobsContext, and the global fetch reaches only the fake Blobs server (anything else
// is recorded in `outside` and fails), so these tests can never touch the live store or use the network.
import { blobsContextFor } from "../helpers/real-blobs.mjs"; // first: NODE_ENV=test before the client loads
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { request, read, PRODUCTION, PREVIEW } from "../helpers/deps.mjs";
import { FakeBlobs } from "../helpers/fake-blobs.mjs";
import { storedItems, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { osloNow, addDays, dayOfWeek, makeToken } from "../../netlify/lib/booking-core.mjs";
import bookings from "../../netlify/functions/bookings.mjs";
import availability from "../../netlify/functions/availability.mjs";
import admin from "../../netlify/functions/admin.mjs";

const ENV_VARS = ["ADMIN_PASSWORD"];
let blobs, outside, savedEnv, savedFetch;

beforeEach(() => {
  blobs = new FakeBlobs();
  outside = [];
  savedEnv = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  for (const k of ENV_VARS) delete process.env[k]; // the build may have real settings: never use them here
  savedFetch = globalThis.fetch;
  globalThis.netlifyBlobsContext = blobsContextFor(blobs);
  globalThis.fetch = async (input, init) => {
    const url = String(input && typeof input === "object" && "url" in input && !(input instanceof URL) ? input.url : input);
    if (url.startsWith(blobs.edgeURL) || url.startsWith(blobs.uncachedEdgeURL)) return blobs.fetch(input, init);
    outside.push(url);
    throw new Error(`Network is disabled in tests (global fetch called for ${url})`);
  };
});

afterEach(() => {
  for (const k of ENV_VARS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  globalThis.fetch = savedFetch;
  delete globalThis.netlifyBlobsContext;
});

const strongHttpOnly = () => blobs.log.length > 0 && blobs.log.every((e) => e.via === "http" && e.store === "bookings" && e.consistency === "strong");

test("live wiring: POST /api/bookings stores through the real client in the strong 'bookings' store", async () => {
  let date = addDays(osloNow().date, 7);
  if (dayOfWeek(date) === 0) date = addDays(date, 1); // closed on Sundays
  const req = request("/api/bookings", { method: "POST", json: { service: "Herreklipp", date, start: 600, addons: [], name: "Ola Nordmann", phone: CUSTOMER_PHONE } });
  const res = await read(await bookings(req, PRODUCTION));
  assert.equal(res.status, 201);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual(storedItems(blobs).map((i) => [i.id, i.source]), [[res.body.booking.id, "nettside"]]);
  assert.ok(strongHttpOnly(), JSON.stringify(blobs.log));
  assert.deepEqual(outside, [], "nothing but Netlify Blobs is fetched");
});

test("live wiring: GET /api/availability reads the strong 'bookings' store", async () => {
  const res = await read(await availability(request("/api/availability"), PRODUCTION));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.busy, {});
  assert.ok(strongHttpOnly(), JSON.stringify(blobs.log));
  assert.deepEqual(outside, []);
});

test("live wiring: /api/admin on a deploy preview reads and writes only the preview store, never 'bookings' (F10)", async () => {
  process.env.ADMIN_PASSWORD = "fake-admin-password";
  const auth = { Authorization: "Bearer " + makeToken("fake-admin-password") };
  blobs.seed("bookings", "m/2026-12", { items: [{ id: "2026-12-01_live01", type: "booking", status: "confirmed", date: "2026-12-01", start: 600, dur: 30, name: "Ekte kunde", phone: CUSTOMER_PHONE }] });
  const before = JSON.stringify(blobs.snapshot().bookings);
  const created = await read(await admin(request("/api/admin/items", { method: "POST", headers: auth, json: { date: "2026-12-01", start: 600, dur: 30, service: "Herreklipp", name: "Test", phone: CUSTOMER_PHONE } }), PREVIEW));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const listed = await read(await admin(request("/api/admin/items?from=2026-12-01&to=2026-12-01", { headers: auth }), PREVIEW));
  assert.deepEqual(listed.body.items.map((i) => i.name), ["Test"], "the preview admin never sees live customers");
  assert.equal(JSON.stringify(blobs.snapshot().bookings), before, "the live store is untouched");
  assert.ok(blobs.log.every((e) => e.store === "bookings-preview"), JSON.stringify(blobs.log.map((e) => e.store)));
  // The same admin on production works on the live store
  const prod = await read(await admin(request("/api/admin/items?from=2026-12-01&to=2026-12-01", { headers: auth }), PRODUCTION));
  assert.deepEqual(prod.body.items.map((i) => i.name), ["Ekte kunde"]);
});
