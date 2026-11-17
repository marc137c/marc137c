// Guard (round 3, SPEC R1): every mutating booking route of /api/admin carries a client idempotency key, and the
// same request sent again after its reply was lost on the network answers the same 2xx: never 404, 412 or «0
// avlyst», and never a text that names another device. Found by audit/round2/verify-server/r4/
// client-retry-after-timeout.mjs: the first DELETE committed and answered 200, the reply never reached the phone,
// /admin gave up after 15 s, and the barber's second tap got 404, which /admin shows as «Avtalen er flyttet eller
// slettet fra en annen enhet, så den ble ikke slettet her». The same for «Avlys alle fra nummeret»: {cancelled: 2}
// lost, then {cancelled: 0}, shown as «0 nettbestillinger … er avlyst». DELETE's mark was drawn per server call,
// so it only recognised retries inside one call.
// The keys: POST items sends requestId, PATCH sends expect (a change already stored is a retry), DELETE sends
// ?req=<id> (kept as its tombstone's mark in deletedOut) and cancel-phone sends requestId (kept beside each booking
// it cancelled in the month's cancelLog). Each case: send, drop the reply, send the same request again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { item, seedItems, storedItems, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { makeToken, retryDelay, pruneOutLogs, OUT_LOG_MS } from "../../netlify/lib/booking-core.mjs";
import { handle } from "../../netlify/functions/admin.mjs";

retryDelay.ms = () => 0;
const PW = "fake-admin-password";
const NOW = "2026-11-20T08:00:00Z";
const KEY = "lq2x9k-a1b2c3d4e5f6"; // what admin.js's newRequestId() makes: time in base 36, a dash, 12 random characters
const auth = (d) => ({ Authorization: "Bearer " + makeToken(PW, d.clock.now()) });
const call = (d, path, method, json, id) => handle(request(path, { method, json, headers: auth(d) }), { ...PRODUCTION, params: id ? { id } : {} }, d).then(read);
const OTHER_DEVICE = /annen enhet/;

// setup(d) → ctx; send(d, ctx) → reply; same(first, second): the parts of the reply that must agree; after(d, ctx):
// the store after both
const ROUTES = {
  "POST /api/admin/items (requestId)": {
    setup: () => ({}),
    send: (d) => call(d, "/api/admin/items", "POST", { date: "2026-11-27", start: 600, dur: 30, type: "booking", name: "Kari", requestId: KEY }),
    same: (a, b) => assert.equal(b.body.item.id, a.body.item.id),
    after: (d) => assert.equal(storedItems(d.blobs).length, 1),
  },
  "PATCH in the month (expect)": {
    setup: (d) => ({ b: seedItems(d.blobs, [item({ date: "2026-11-27", start: 600 })])[0] }),
    send: (d, { b }) => call(d, `/api/admin/items/${b.id}`, "PATCH", { start: 660, expect: b.updatedAt }, b.id),
    same: (a, b) => assert.equal(b.body.item.id, a.body.item.id),
    after: (d) => assert.deepEqual(storedItems(d.blobs).map((i) => i.start), [660]),
  },
  "PATCH to another month (expect)": {
    setup: (d) => ({ b: seedItems(d.blobs, [item({ date: "2026-11-27", start: 600 })])[0] }),
    send: (d, { b }) => call(d, `/api/admin/items/${b.id}`, "PATCH", { date: "2026-12-02", expect: b.updatedAt }, b.id),
    same: (a, b) => assert.equal(b.body.item.id, a.body.item.id),
    after: (d) => assert.deepEqual(storedItems(d.blobs).map((i) => i.date), ["2026-12-02"]),
  },
  "DELETE (?expect and ?req)": {
    setup: (d) => ({ b: seedItems(d.blobs, [item({ date: "2026-11-27", start: 600 })])[0] }),
    send: (d, { b }) => call(d, `/api/admin/items/${b.id}?expect=${encodeURIComponent(b.updatedAt)}&req=${KEY}`, "DELETE", undefined, b.id),
    same: (a, b) => assert.equal(b.body.ok, true),
    after: (d) => assert.deepEqual(storedItems(d.blobs), []),
  },
  "DELETE from an old tab (?req only)": {
    setup: (d) => ({ b: seedItems(d.blobs, [item({ date: "2026-11-27", start: 600 })])[0] }),
    send: (d, { b }) => call(d, `/api/admin/items/${b.id}?req=${KEY}`, "DELETE", undefined, b.id),
    same: (a, b) => assert.equal(b.body.ok, true),
    after: (d) => assert.deepEqual(storedItems(d.blobs), []),
  },
  "POST /api/admin/cancel-phone (requestId)": {
    setup: (d) => ({ list: seedItems(d.blobs, [item({ date: "2026-11-27", start: 600 }), item({ date: "2026-12-03", start: 660 }), item({ date: "2026-11-28", start: 600, phone: "400 11 222" })]) }),
    send: (d) => call(d, "/api/admin/cancel-phone", "POST", { phone: CUSTOMER_PHONE, requestId: KEY }),
    same: (a, b) => assert.deepEqual([a.body.cancelled, b.body.cancelled], [2, 2]),
    after: (d) => assert.deepEqual(storedItems(d.blobs).map((i) => i.status).sort(), ["cancelled", "cancelled", "confirmed"]),
  },
};

for (const [name, r] of Object.entries(ROUTES)) {
  test(`retry key (SPEC R1): ${name}: the same request again after a lost reply answers the same 2xx`, async (t) => {
    quiet(t);
    const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
    const ctx = r.setup(d);
    const first = await r.send(d, ctx); // committed; the reply never reaches the phone
    assert.ok(first.status >= 200 && first.status < 300, `${first.status} ${JSON.stringify(first.body)}`);
    d.clock.advance(20e3); // /admin gave up after 15 s; the barber taps again
    const second = await r.send(d, ctx);
    assert.equal(second.status, first.status, JSON.stringify(second.body));
    assert.doesNotMatch(JSON.stringify(second.body), OTHER_DEVICE);
    r.same(first, second);
    r.after(d);
  });
}

test("retry key: a DELETE with another key still answers 404 once the booking is gone, and an old tab's DELETE without a key too", async (t) => {
  quiet(t);
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
  const [b] = seedItems(d.blobs, [item({ date: "2026-11-27", start: 600 })]);
  assert.equal((await call(d, `/api/admin/items/${b.id}?req=${KEY}`, "DELETE", undefined, b.id)).status, 200);
  assert.equal((await call(d, `/api/admin/items/${b.id}?req=other-device-key1`, "DELETE", undefined, b.id)).status, 404);
  assert.equal((await call(d, `/api/admin/items/${b.id}`, "DELETE", undefined, b.id)).status, 404);
});

test("retry key: cancel-phone with a new requestId is a new request: it cancels only what is still active («0 avlyst» when nothing is left)", async (t) => {
  quiet(t);
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
  seedItems(d.blobs, [item({ date: "2026-11-27", start: 600 }), item({ date: "2026-12-03", start: 660 })]);
  const first = await call(d, "/api/admin/cancel-phone", "POST", { phone: CUSTOMER_PHONE, requestId: KEY });
  assert.equal(first.body.cancelled, 2);
  const fresh = await call(d, "/api/admin/cancel-phone", "POST", { phone: CUSTOMER_PHONE, requestId: "lq2x9m-zzzzzzzzzzzz" });
  assert.deepEqual([fresh.status, fresh.body.cancelled], [200, 0]);
  // a booking from that number that arrives later is cancelled by a retry of the first request as well, and counted
  seedItems(d.blobs, [item({ date: "2027-01-10", start: 600 })]);
  const retry = await call(d, "/api/admin/cancel-phone", "POST", { phone: CUSTOMER_PHONE, requestId: KEY });
  assert.deepEqual([retry.status, retry.body.cancelled], [200, 3]);
  assert.ok(storedItems(d.blobs).every((i) => i.status === "cancelled"));
});

test("retry key: the cancelLog holds only ids, the request's key and the time, and goes with the other logs after 24 hours", async (t) => {
  quiet(t);
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
  const [b] = seedItems(d.blobs, [item({ date: "2026-11-27", start: 600 })]);
  await call(d, "/api/admin/cancel-phone", "POST", { phone: CUSTOMER_PHONE, requestId: KEY });
  const doc = d.blobs.json("bookings", "m/2026-11");
  assert.deepEqual(doc.cancelLog, [{ id: b.id, m: KEY, at: d.now().toISOString() }]);
  assert.equal(pruneOutLogs({ ...doc }, d.now().getTime() + OUT_LOG_MS - 1), 0, "kept for 24 hours");
  const later = { ...doc };
  assert.equal(pruneOutLogs(later, d.now().getTime() + OUT_LOG_MS + 1), 1);
  assert.equal(later.cancelLog, undefined, "dropped after 24 hours (the daily clean-up runs pruneOutLogs on every month)");
  // without a key (a page from before round 3) nothing is logged
  const d2 = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
  seedItems(d2.blobs, [item({ date: "2026-11-27", start: 600 })]);
  assert.equal((await call(d2, "/api/admin/cancel-phone", "POST", { phone: CUSTOMER_PHONE })).body.cancelled, 1);
  assert.equal(d2.blobs.json("bookings", "m/2026-11").cancelLog, undefined);
});

test("retry key: a malformed key is refused (400) and changes nothing", async (t) => {
  quiet(t);
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
  const [b] = seedItems(d.blobs, [item({ date: "2026-11-27", start: 600 })]);
  for (const bad of ["kort", "x".repeat(65), "has space1", "<script>1"]) {
    const del = await call(d, `/api/admin/items/${b.id}?req=${encodeURIComponent(bad)}`, "DELETE", undefined, b.id);
    assert.equal(del.status, 400, bad);
    const cx = await call(d, "/api/admin/cancel-phone", "POST", { phone: CUSTOMER_PHONE, requestId: bad });
    assert.equal(cx.status, 400, bad);
    const num = await call(d, "/api/admin/cancel-phone", "POST", { phone: CUSTOMER_PHONE, requestId: 12345678 });
    assert.equal(num.status, 400);
  }
  assert.deepEqual(storedItems(d.blobs).map((i) => i.status), ["confirmed"]);
});
