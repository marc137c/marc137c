// X2.4: after a flood of fake web bookings from one number, the barber frees the slots for real customers with one
// call: POST /api/admin/cancel-phone { phone } cancels every coming web booking from that number, however it is
// written. Invariants:
//   1. it cancels exactly the active web bookings (source "nettside") from today on whose phone matches by
//      phoneKey («400 00 000» = «+47 400 00 000»); admin-entered bookings, past ones, blocks and other numbers stay;
//   2. each cancelled booking gets status "cancelled" and a new updatedAt; nothing is deleted;
//   3. a second call cancels 0, and a lost response inside the call still reports the true total;
//   4. it needs the admin token, and a phone with fewer than 8 digits is 400;
//   5. (round 3) the reply names each booking this request cancelled with the version it stored ({ id, updatedAt }),
//      also when the same request is repeated, so /admin recognises exactly its own versions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, PRODUCTION } from "../helpers/deps.mjs";
import { item, seedItems, storedItems } from "../helpers/bookings.mjs";
import { makeToken } from "../../netlify/lib/booking-core.mjs";
import * as admin from "../../netlify/functions/admin.mjs";

const PW = "fake-admin-password";
const NOW = "2026-11-12T09:00:00Z"; // Thursday 10:00 in Oslo
const cancelPhone = (d, json, token = makeToken(PW, d.clock.now())) =>
  admin.handle(request("/api/admin/cancel-phone", { method: "POST", json, headers: token ? { Authorization: "Bearer " + token } : {} }), PRODUCTION, d).then(read);

function flood(d) {
  return seedItems(d.blobs, [
    item({ date: "2026-11-13", start: 600, phone: "400 00 000", name: "Falsk 1" }),
    item({ date: "2026-11-20", start: 660, phone: "400 00 000", name: "Falsk 2" }),
    item({ date: "2026-12-04", start: 720, phone: "400 00 000", name: "Falsk 3" }),
    item({ date: "2027-01-08", start: 600, phone: "+47 400 00 000", name: "Falsk 4" }),
    item({ date: "2026-11-13", start: 660, phone: "400 00 000", name: "Lagt inn av Viggo", source: "admin" }),
    item({ date: "2026-11-11", start: 600, phone: "400 00 000", name: "I går" }),
    item({ date: "2026-11-16", start: 600, phone: "400 00 000", name: "Allerede avlyst", status: "cancelled" }),
    item({ date: "2026-11-17", start: 600, phone: "400 00 000", name: "Blokk", type: "block", source: "admin" }),
    item({ date: "2026-11-13", start: 720, phone: "912 34 567", name: "Ekte kunde" }),
    item({ date: "2026-11-18", start: 600, phone: "400 00 0001", name: "Annet nummer" }),
  ]);
}
// { id, updatedAt } sorted by id: what the reply names, or what the store holds for the cancelled «Falsk» bookings
const versions = (list) => list.map((i) => ({ id: i.id, updatedAt: i.updatedAt })).sort((a, b) => (a.id < b.id ? -1 : 1));
const falsk = (d) => storedItems(d.blobs).filter((i) => i.name.startsWith("Falsk"));
const statusOf = (d) => Object.fromEntries(storedItems(d.blobs).map((i) => [i.name, i.status]));

test("cancel-phone: cancels the 4 coming web bookings from the number, however it is written, and nothing else", async () => {
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
  const before = flood(d);
  d.clock.advance(60e3);
  const res = await cancelPhone(d, { phone: "400 00 000" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual({ ok: res.body.ok, cancelled: res.body.cancelled }, { ok: true, cancelled: 4 });
  assert.deepEqual(statusOf(d), {
    "Falsk 1": "cancelled", "Falsk 2": "cancelled", "Falsk 3": "cancelled", "Falsk 4": "cancelled",
    "Lagt inn av Viggo": "confirmed", "I går": "confirmed", "Allerede avlyst": "cancelled", "Blokk": "confirmed",
    "Ekte kunde": "confirmed", "Annet nummer": "confirmed",
  });
  const stamp = new Date(d.clock.now()).toISOString();
  for (const i of storedItems(d.blobs)) {
    const was = before.find((b) => b.id === i.id);
    if (i.name.startsWith("Falsk")) assert.equal(i.updatedAt, stamp, i.name);
    else assert.deepEqual(i, was, `${i.name} is untouched`);
  }
  assert.equal(storedItems(d.blobs).length, before.length, "nothing is deleted");
});

test("cancel-phone: a second call cancels 0", async () => {
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
  flood(d);
  assert.equal((await cancelPhone(d, { phone: "+47 400 00 000" })).body.cancelled, 4);
  const snapshot = JSON.stringify(storedItems(d.blobs));
  assert.deepEqual((await cancelPhone(d, { phone: "400 00 000" })).body, { ok: true, cancelled: 0, items: [] });
  assert.equal(JSON.stringify(storedItems(d.blobs)), snapshot, "and writes nothing");
});

test("cancel-phone: a lost response inside the call still reports the true total of 4", async () => {
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
  flood(d);
  for (const key of ["m/2026-11", "m/2026-12", "m/2027-01"]) d.blobs.inject({ method: "PUT", key, fault: "lost-response" });
  const res = await cancelPhone(d, { phone: "400 00 000" });
  assert.deepEqual([res.status, res.body.cancelled, versions(res.body.items)], [200, 4, versions(falsk(d))]);
  assert.equal(storedItems(d.blobs).filter((i) => i.name.startsWith("Falsk") && i.status === "cancelled").length, 4);
});

test("cancel-phone: a store outage answers 503 with what was cancelled so far, and calling again finishes the job", async (t) => {
  t.mock.method(console, "error", () => {});
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
  flood(d);
  d.blobs.inject({ method: "PUT", key: "m/2026-12", fault: "fail-before", status: 500, times: 6 });
  const first = await cancelPhone(d, { phone: "400 00 000" });
  assert.equal(first.status, 503, JSON.stringify(first.body));
  assert.equal(typeof first.body.error, "string");
  assert.equal(first.body.cancelled, 2, "November was done before December failed");
  const again = await cancelPhone(d, { phone: "400 00 000" });
  assert.deepEqual([again.body.cancelled, again.body.items.length], [2, 2]);
  assert.equal(storedItems(d.blobs).filter((i) => i.name.startsWith("Falsk") && i.status === "cancelled").length, 4);
});

test("cancel-phone: needs the admin token, POST and a phone with at least 8 digits", async () => {
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
  flood(d);
  const snapshot = JSON.stringify(storedItems(d.blobs));
  assert.equal((await cancelPhone(d, { phone: "400 00 000" }, null)).status, 401);
  assert.equal((await cancelPhone(d, { phone: "400 00 000" }, makeToken("other", d.clock.now()))).status, 401);
  for (const phone of ["1234567", "", undefined, 40000000, "x".repeat(31)]) {
    assert.equal((await cancelPhone(d, { phone })).status, 400, String(phone));
  }
  const get = await read(await admin.handle(request("/api/admin/cancel-phone", { headers: { Authorization: "Bearer " + makeToken(PW, d.clock.now()) } }), PRODUCTION, d));
  assert.equal(get.status, 404);
  assert.equal(JSON.stringify(storedItems(d.blobs)), snapshot);
  assert.ok(admin.config.path.includes("/api/admin/cancel-phone"));
});

// Round 3 (still_open 12, probe R3-OWN1): the reply gave only a count, so /admin recognised its own cancels by the
// number (any later cancelled booking from it was «endret fra denne enheten», also one cancelled on another device).
test("cancel-phone round 3: the reply names every booking it cancelled with the stored version, also when the request is repeated", async () => {
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
  flood(d);
  d.clock.advance(60e3);
  const first = await cancelPhone(d, { phone: "400 00 000", requestId: "tap-0001-abcd" });
  assert.equal(first.status, 200);
  assert.deepEqual(versions(first.body.items), versions(falsk(d)), "exactly the four it cancelled, with the stored updatedAt");
  for (const v of first.body.items) assert.deepEqual(Object.keys(v).sort(), ["id", "updatedAt"], "ids and versions only, no customer data");
  d.clock.advance(60e3);
  const again = await cancelPhone(d, { phone: "400 00 000", requestId: "tap-0001-abcd" }); // the reply was lost: same key
  assert.deepEqual([again.body.cancelled, versions(again.body.items)], [4, versions(first.body.items)], "the first call's versions");
  const other = await cancelPhone(d, { phone: "400 00 000", requestId: "tap-0002-abcd" });
  assert.deepEqual(other.body, { ok: true, cancelled: 0, items: [] }, "a new tap cancelled nothing, and names nothing");
});
