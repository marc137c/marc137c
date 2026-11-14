// The default exports Netlify calls still run the handlers with liveDeps(): the real @netlify/blobs client
// (strong consistency), process.env and the real clock. The real client is pointed at the fake Blobs server
// through globalThis.netlifyBlobsContext, and the global fetch reaches only the fake Blobs server and the fake
// Sveve, so these tests can never touch the live store, send an SMS or use the network.
import { blobsContextFor } from "../helpers/real-blobs.mjs"; // first: NODE_ENV=test before the client loads
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { request, read, quiet, PRODUCTION, PREVIEW } from "../helpers/deps.mjs";
import { FakeBlobs } from "../helpers/fake-blobs.mjs";
import { fakeSveve, SVEVE_URL } from "../helpers/fake-sveve.mjs";
import { storedItems, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { osloNow, addDays, dayOfWeek, makeToken } from "../../netlify/lib/booking-core.mjs";
import bookings from "../../netlify/functions/bookings.mjs";
import smsReminders from "../../netlify/functions/sms-reminders.mjs";
import availability from "../../netlify/functions/availability.mjs";
import admin from "../../netlify/functions/admin.mjs";

const SMS_VARS = ["SVEVE_USER", "SVEVE_PASSWD", "SVEVE_FROM", "SVEVE_TEST", "SHOP_SMS_TO", "ADMIN_PASSWORD"];
let blobs, sveve, savedEnv, savedFetch;

beforeEach(() => {
  blobs = new FakeBlobs();
  sveve = fakeSveve();
  savedEnv = Object.fromEntries(SMS_VARS.map((k) => [k, process.env[k]]));
  for (const k of SMS_VARS) delete process.env[k]; // the build may have real Sveve settings: never use them here
  savedFetch = globalThis.fetch;
  globalThis.netlifyBlobsContext = blobsContextFor(blobs);
  globalThis.fetch = async (input, init) => {
    const url = String(input && typeof input === "object" && "url" in input && !(input instanceof URL) ? input.url : input);
    if (url.startsWith(blobs.edgeURL) || url.startsWith(blobs.uncachedEdgeURL)) return blobs.fetch(input, init);
    if (url.startsWith(SVEVE_URL)) return sveve(input, init);
    throw new Error(`Network is disabled in tests (global fetch called for ${url})`);
  };
});

afterEach(() => {
  for (const k of SMS_VARS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
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
  assert.equal(res.body.sms, "off", "no Sveve settings in process.env → no SMS");
  assert.deepEqual(storedItems(blobs).map((i) => [i.id, i.source]), [[res.body.booking.id, "nettside"]]);
  assert.ok(strongHttpOnly(), JSON.stringify(blobs.log));
  assert.equal(sveve.calls.length, 0);
});

test("live wiring: GET /api/availability reads the strong 'bookings' store and reports sms from process.env", async () => {
  let res = await read(await availability(request("/api/availability"), PRODUCTION));
  assert.equal(res.status, 200);
  assert.equal(res.body.sms, false);
  assert.ok(strongHttpOnly(), JSON.stringify(blobs.log));
  process.env.SVEVE_USER = "fake-user";
  process.env.SVEVE_PASSWD = "fake-pass";
  res = await read(await availability(request("/api/availability"), PRODUCTION));
  assert.equal(res.body.sms, true);
});

test("live wiring: the scheduled sms-reminders reads the strong 'bookings' store with Sveve settings from process.env", async (t) => {
  const out = quiet(t);
  assert.equal(await smsReminders(request("/.netlify/functions/sms-reminders", { method: "POST", json: { next_run: new Date().toISOString() } }), PRODUCTION), undefined);
  assert.equal(blobs.log.length, 0, "not configured → the store is not even read");
  process.env.SVEVE_USER = "fake-user";
  process.env.SVEVE_PASSWD = "fake-pass";
  await smsReminders(request("/.netlify/functions/sms-reminders", { method: "POST", json: { next_run: new Date().toISOString() } }), PRODUCTION);
  assert.ok(strongHttpOnly(), JSON.stringify(blobs.log));
  assert.ok(blobs.log.every((e) => e.method === "GET"), "an empty store: read only");
  assert.equal(sveve.calls.length, 0);
  assert.deepEqual(out.error, []);
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
