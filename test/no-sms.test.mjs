// Owner decision 1 (2026-11-14): no SMS of any kind. Sveve is gone, there is no reminder run, and nothing on the
// site may promise an SMS. Invariants:
//   1. no file in the repository (code, page, style, doc, config, test) mentions SMS or Sveve, promises a text
//      message, or uses the old SMS fields on a booking; no file is named after them. This file is the only
//      exception, because it has to name what it forbids. «påminnelse» on its own is allowed (a calendar alarm
//      may use the word); «SMS-påminnelse» is caught by the SMS rule.
//   2. the only scheduled function is the Instagram refresh;
//   3. no code path calls Sveve, or anything else outside Netlify Blobs, even with the old Sveve variables still
//      set in Netlify: a booking's whole life (book, see availability, move, cancel, delete) fetches nothing else,
//      and the replies and the stored booking carry no SMS state.
import { blobsContextFor } from "./helpers/real-blobs.mjs"; // first: NODE_ENV=test before the client loads
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { testDeps, request, read, PRODUCTION } from "./helpers/deps.mjs";
import { fakeFetch } from "./helpers/fake-fetch.mjs";
import { FakeBlobs } from "./helpers/fake-blobs.mjs";
import { storedItems, CUSTOMER_PHONE } from "./helpers/bookings.mjs";
import { makeToken } from "../netlify/lib/booking-core.mjs";
import * as bookingsFn from "../netlify/functions/bookings.mjs";
import * as availabilityFn from "../netlify/functions/availability.mjs";
import admin from "../netlify/functions/admin.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const BINARY = /\.(jpe?g|png|webp|gif|ico|avif|woff2?|ttf|otf|pdf|zip)$/i;
// Not preceded by a letter, digit, + or / so a word like "prisms" or a base64 data URI never trips it
const FORBIDDEN = [
  ["SMS", /(?<![a-z0-9+/])sms/i],
  ["Sveve", /(?<![a-z0-9+/])sveve/i],
  ["a promised text message", /tekstmelding|text message/i],
  ["an old SMS field", /\b(remindedAt|reminderRun|reminderSentAt|reminderError|reminderFails|reminderTestAt|confirmPending|confirmSentAt|shopPending|shopSentAt)\b/],
];
// The old Sveve settings may still be set in Netlify: they must change nothing
const OLD_ENV = { SVEVE_USER: "old-user", SVEVE_PASSWD: "old-pass", SVEVE_FROM: "Viggos", SVEVE_TEST: "false", SHOP_SMS_TO: "40963911" };

function* repoFiles(dir = ROOT) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || (e.name.startsWith(".") && e.isDirectory())) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* repoFiles(p);
    else if (e.isFile()) yield p;
  }
}
const rel = (p) => relative(ROOT, p).split(sep).join("/");

test("no SMS: no file mentions SMS or Sveve, promises a text message or uses an old SMS field", () => {
  const hits = [];
  let scanned = 0;
  for (const file of repoFiles()) {
    if (file === SELF || rel(file) === "package-lock.json" || BINARY.test(file)) continue;
    scanned++;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      for (const [what, re] of FORBIDDEN) if (re.test(line)) hits.push(`${rel(file)}:${i + 1} ${what}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.ok(scanned >= 30, `scanned ${scanned} files`);
  assert.deepEqual(hits, []);
});

test("no SMS: no file or folder is named after SMS, Sveve or reminders", () => {
  const named = [...repoFiles()].map(rel).filter((p) => p !== rel(SELF) && /sms|sveve|remind/i.test(p));
  assert.deepEqual(named, []);
  for (const gone of ["netlify/lib/sms.mjs", "netlify/lib/reminders.mjs", "netlify/functions/sms-reminders.mjs"]) {
    assert.equal(existsSync(join(ROOT, gone)), false, gone);
  }
});

test("no SMS: the only scheduled function is the hourly Instagram refresh", () => {
  const dir = join(ROOT, "netlify", "functions");
  const scheduled = readdirSync(dir).filter((f) => /\bschedule\s*:/.test(readFileSync(join(dir, f), "utf8")));
  assert.deepEqual(scheduled, ["social-refresh.mjs"]);
  assert.doesNotMatch(readFileSync(join(ROOT, "netlify.toml"), "utf8"), /schedule/i);
});

test("no SMS: with the old Sveve settings set, a web booking calls nothing and replies and stores no SMS state", async () => {
  const fetch = fakeFetch([[() => true, () => ({ ok: true })]]); // would answer anything: every call is recorded
  const d = testDeps({ now: "2026-11-12T09:00:00Z", env: OLD_ENV, fetch });
  const res = await read(await bookingsFn.handle(request("/api/bookings", { method: "POST", json: {
    service: "Herreklipp", date: "2026-11-13", start: 600, addons: [], name: "Ola Nordmann", phone: CUSTOMER_PHONE, lang: "en",
  } }), PRODUCTION, d));
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.body).sort(), ["booking", "ok"]);
  const av = await read(await availabilityFn.handle(request("/api/availability"), PRODUCTION, d));
  assert.equal(av.status, 200);
  assert.equal("sms" in av.body, false);
  assert.deepEqual(Object.keys(storedItems(d.blobs)[0]).sort(),
    ["addons", "createdAt", "date", "dur", "id", "name", "note", "phone", "service", "source", "start", "status", "type", "updatedAt"]);
  assert.deepEqual(fetch.calls, []);
});

test("no SMS: a booking's whole life through the live handlers fetches nothing but Netlify Blobs, even with the old Sveve settings in process.env", async (t) => {
  const blobs = new FakeBlobs();
  const outside = [];
  const vars = { ...OLD_ENV, ADMIN_PASSWORD: "fake-admin-password" };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const savedFetch = globalThis.fetch;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    globalThis.fetch = savedFetch;
    delete globalThis.netlifyBlobsContext;
  });
  Object.assign(process.env, vars);
  globalThis.netlifyBlobsContext = blobsContextFor(blobs);
  globalThis.fetch = async (input, init) => {
    const url = String(input && typeof input === "object" && "url" in input && !(input instanceof URL) ? input.url : input);
    if (url.startsWith(blobs.edgeURL) || url.startsWith(blobs.uncachedEdgeURL)) return blobs.fetch(input, init);
    outside.push(url);
    return Response.json({ ok: true }); // answer, so a call that slipped through would not even show as an error
  };
  // A Monday a week or two ahead (the live handlers use the real clock), 10:00
  const day = new Date(Date.now() + 8 * 864e5);
  while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1);
  const date = day.toISOString().slice(0, 10);
  const booked = await read(await bookingsFn.default(request("/api/bookings", { method: "POST", json: {
    service: "Herreklipp", date, start: 600, addons: [], name: "Ola Nordmann", phone: CUSTOMER_PHONE,
  } }), PRODUCTION));
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  assert.equal("sms" in (await read(await availabilityFn.default(request("/api/availability"), PRODUCTION))).body, false);
  const auth = { Authorization: "Bearer " + makeToken("fake-admin-password") };
  const id = booked.body.booking.id;
  const moved = await read(await admin(request(`/api/admin/items/${id}`, { method: "PATCH", headers: auth, json: { start: 660 } }), { ...PRODUCTION, params: { id } }));
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const cancelled = await read(await admin(request(`/api/admin/items/${id}`, { method: "PATCH", headers: auth, json: { status: "cancelled" } }), { ...PRODUCTION, params: { id } }));
  assert.equal(cancelled.body.item.status, "cancelled");
  const deleted = await read(await admin(request(`/api/admin/items/${id}`, { method: "DELETE", headers: auth }), { ...PRODUCTION, params: { id } }));
  assert.equal(deleted.status, 200);
  assert.deepEqual(outside, []);
});
