// RC2 (failure paths never ran): every server write under every way a Blobs write can go wrong.
// Writes: web create, admin create, same-month PATCH, cross-month PATCH (the new month's write failing, and the old
// month's removal failing), DELETE, cancel-phone and a rate-limit take(). Faults, on the key that write touches:
//   fail-before 500 on every attempt (nothing stored), a lost response (stored, the reply never came),
//   fail-after 502 on every attempt (stored, then an error), and 8 CAS losses in a row to a competing write.
// Invariant: one copy per booking id suffix, and the reply matches the store: a 2xx means the change is stored;
// a 5xx (or a throw) means a plain retry, with the fault gone, converges to exactly the intended state. The one
// state with two copies is a cross-month move whose removal failed, and its reply is the 503 that says so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { item, seedItems, storedItems, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { makeToken, retryDelay } from "../../netlify/lib/booking-core.mjs";
import { calendarFor } from "../../netlify/lib/calendar.mjs";
import { take } from "../../netlify/lib/limits.mjs";
import * as bookings from "../../netlify/functions/bookings.mjs";
import * as admin from "../../netlify/functions/admin.mjs";

const PW = "fake-admin-password";
// mutateJSON backs off in real time between CAS attempts (about 5 s for 8 losses); no waiting in this file
retryDelay.ms = () => 0;
const NOW = "2026-11-12T09:00:00Z"; // Thursday 10:00 in Oslo

// A competing writer that rewrites the document (same content, new ETag) just before each of our next n writes
function competing(blobs, key, n) {
  let left = n;
  return blobs.inject({ method: "PUT", key, latencyMs: 1, times: Infinity, match: (req) => {
    if (left > 0) {
      left--;
      const cur = blobs.text(req.store, req.key);
      blobs.seed(req.store, req.key, cur !== undefined ? cur : req.key.startsWith("m/") ? { items: [] } : {});
    }
    return false;
  } });
}

const FAULTS = {
  "fail-before 500 on every attempt": (blobs, key) => blobs.inject({ method: "PUT", key, fault: "fail-before", status: 500, times: 6 }),
  "a lost response": (blobs, key) => blobs.inject({ method: "PUT", key, fault: "lost-response" }),
  "fail-after 502 on every attempt": (blobs, key) => blobs.inject({ method: "PUT", key, fault: "fail-after", status: 502, times: 6 }),
  "8 CAS losses to a competing write": (blobs, key) => competing(blobs, key, 8),
};

const HALF_DONE = "Avtalen er lagt inn på den nye datoen, men den gamle tiden ble ikke fjernet. Trykk Lagre én gang til.";
const auth = (d) => ({ Authorization: "Bearer " + makeToken(PW, d.clock.now()) });
const adminCall = (d, path, method, json) => admin.handle(request(path, { method, json, headers: auth(d) }), PRODUCTION, d).then(read);
const suffix = (id) => id.slice(id.indexOf("_") + 1);

// Each write: setup(d) seeds and returns ctx; call(d, ctx) → { status, body } (a throw counts as 500); key: the
// faulted key; done(d, ctx): asserts the intended state is in the store; retryOk: statuses a retry may give.
const WRITES = {
  "web create": {
    key: "m/2026-11",
    setup: () => ({}),
    call: (d) => bookings.handle(request("/api/bookings", { method: "POST", json: {
      service: "Herreklipp", date: "2026-11-20", start: 600, addons: [], name: "Kari Nordmann", phone: CUSTOMER_PHONE, requestId: "web-req-0001",
    } }), PRODUCTION, d).then(read),
    done: (d) => {
      const items = storedItems(d.blobs);
      assert.equal(items.length, 1, JSON.stringify(items));
      assert.deepEqual([items[0].date, items[0].start, items[0].requestId], ["2026-11-20", 600, "web-req-0001"]);
    },
  },
  "admin create": {
    key: "m/2026-11",
    setup: () => ({}),
    call: (d) => adminCall(d, "/api/admin/items", "POST", { date: "2026-11-20", start: 600, dur: 30, service: "Herreklipp", name: "Per", requestId: "adm-req-0001" }),
    done: (d) => {
      const items = storedItems(d.blobs);
      assert.equal(items.length, 1, JSON.stringify(items));
      assert.deepEqual([items[0].date, items[0].start, items[0].source], ["2026-11-20", 600, "admin"]);
    },
  },
  "same-month PATCH": {
    key: "m/2026-11",
    setup: (d) => ({ b: seedItems(d.blobs, [item({ date: "2026-11-20", start: 600 })])[0] }),
    call: (d, { b }) => adminCall(d, `/api/admin/items/${b.id}`, "PATCH", { start: 660, expect: b.updatedAt }),
    done: (d, { b }) => {
      const items = storedItems(d.blobs);
      assert.equal(items.length, 1);
      assert.deepEqual([items[0].id, items[0].start], [b.id, 660]);
    },
  },
  "cross-month PATCH (the new month's write fails)": {
    key: "m/2026-12",
    setup: (d) => ({ b: seedItems(d.blobs, [item({ date: "2026-11-27", start: 600 })])[0] }),
    call: (d, { b }) => adminCall(d, `/api/admin/items/${b.id}`, "PATCH", { date: "2026-12-02", expect: b.updatedAt }),
    done: (d, { b }) => {
      const items = storedItems(d.blobs);
      assert.equal(items.length, 1, JSON.stringify(items.map((i) => i.id)));
      assert.deepEqual([items[0].date, suffix(items[0].id)], ["2026-12-02", suffix(b.id)], "the move keeps the id suffix");
    },
  },
  "cross-month PATCH (the old month's removal fails)": {
    key: "m/2026-11",
    setup: (d) => ({ b: seedItems(d.blobs, [item({ date: "2026-11-27", start: 600 })])[0] }),
    call: (d, { b }) => adminCall(d, `/api/admin/items/${b.id}`, "PATCH", { date: "2026-12-02", expect: b.updatedAt }),
    done: (d, { b }) => {
      const items = storedItems(d.blobs);
      assert.equal(items.length, 1, JSON.stringify(items.map((i) => i.id)));
      assert.deepEqual([items[0].date, suffix(items[0].id)], ["2026-12-02", suffix(b.id)]);
    },
  },
  "DELETE": {
    key: "m/2026-11",
    setup: (d) => ({ b: seedItems(d.blobs, [item({ date: "2026-11-20" }), item({ date: "2026-11-21", name: "Blir" })])[0] }),
    call: (d, { b }) => adminCall(d, `/api/admin/items/${b.id}`, "DELETE"),
    done: (d) => assert.deepEqual(storedItems(d.blobs).map((i) => i.name), ["Blir"]),
    retryOk: [200, 404], // the delete is in: «Fant ikke avtalen» matches the store
  },
  "cancel-phone": {
    key: "m/2026-11",
    setup: (d) => ({ seeded: seedItems(d.blobs, [
      item({ date: "2026-11-13", phone: "400 00 000", name: "Falsk 1" }),
      item({ date: "2026-11-20", phone: "+47 400 00 000", name: "Falsk 2" }),
      item({ date: "2026-11-20", start: 720, phone: CUSTOMER_PHONE, name: "Ekte" }),
    ]) }),
    call: (d) => adminCall(d, "/api/admin/cancel-phone", "POST", { phone: "400 00 000" }),
    done: (d) => assert.deepEqual(storedItems(d.blobs).map((i) => `${i.name} ${i.status}`), ["Falsk 1 cancelled", "Falsk 2 cancelled", "Ekte confirmed"]),
  },
  "take() on a rate-limit counter": {
    key: "rl/test",
    setup: () => ({}),
    call: async (d) => {
      const store = d.getStore({ name: "bookings", consistency: "strong" });
      const r = await take(store, "rl/test", [{ max: 5, windowMs: 3600e3 }], { nowMs: d.clock.now(), token: "tok-1" });
      return { status: r.error ? r.status : r.ok ? 200 : 429, body: r };
    },
    done: (d) => assert.deepEqual(d.blobs.json("bookings", "rl/test").hits.map((h) => h.id), ["tok-1"]),
  },
};

const attempt = (fn) => fn().catch((err) => ({ status: 500, body: { thrown: err && err.message } }));
const oneCopyPerSuffix = (d) => {
  const ids = storedItems(d.blobs).map((i) => suffix(i.id));
  assert.equal(new Set(ids).size, ids.length, "one copy per booking id suffix: " + ids.join(", "));
};
const content = (d) => JSON.stringify(storedItems(d.blobs).map(({ updatedAt, ...rest }) => rest));

for (const [writeName, w] of Object.entries(WRITES)) {
  for (const [faultName, inject] of Object.entries(FAULTS)) {
    test(`fault matrix: ${writeName} with ${faultName}: the reply matches the store, and a retry converges to one copy`, async (t) => {
      quiet(t);
      const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
      const ctx = w.setup(d);
      inject(d.blobs, w.key);
      const first = await attempt(() => w.call(d, ctx));
      if (first.status >= 200 && first.status < 300) {
        oneCopyPerSuffix(d);
        w.done(d, ctx);
      } else {
        assert.ok(first.status >= 500, `${writeName}: a failure is a 5xx, not ${first.status} ${JSON.stringify(first.body)}`);
        // The only state with two copies is a move whose second half failed, and then the reply says exactly that
        const ids = storedItems(d.blobs).map((i) => suffix(i.id));
        if (new Set(ids).size !== ids.length) assert.deepEqual([first.status, first.body.error], [503, HALF_DONE]);
        d.blobs.clearFaults();
        const retry = await attempt(() => w.call(d, ctx));
        assert.ok((w.retryOk || [200, 201]).includes(retry.status), `retry: ${retry.status} ${JSON.stringify(retry.body)}`);
        oneCopyPerSuffix(d);
        w.done(d, ctx);
      }
      // One more retry changes nothing
      d.blobs.clearFaults();
      const before = content(d);
      const again = await attempt(() => w.call(d, ctx));
      assert.ok((w.retryOk || [200, 201]).includes(again.status), `second retry: ${again.status} ${JSON.stringify(again.body)}`);
      oneCopyPerSuffix(d);
      w.done(d, ctx);
      assert.equal(content(d), before);
    });
  }
}

// demo-f17 (audit/ready/server): moving 27 Nov → 2 Dec while the old month's write fails
test("fault matrix: a failed removal after a cross-month move says so (503), and saving again leaves one copy and one VEVENT", async (t) => {
  quiet(t);
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW } });
  const [b] = seedItems(d.blobs, [item({ date: "2026-11-27", start: 600 })]);
  d.blobs.inject({ method: "PUT", key: "m/2026-11", fault: "fail-before", status: 500, times: Infinity });
  const patch = () => adminCall(d, `/api/admin/items/${b.id}`, "PATCH", { date: "2026-12-02" });
  const r1 = await patch();
  assert.equal(r1.status, 503, JSON.stringify(r1.body));
  assert.equal(r1.body.error, "Avtalen er lagt inn på den nye datoen, men den gamle tiden ble ikke fjernet. Trykk Lagre én gang til.");
  d.blobs.clearFaults();
  const r2 = await patch();
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.deepEqual(storedItems(d.blobs).map((i) => i.id), [`2026-12-02_${suffix(b.id)}`]);
  const ics = await calendarFor(d.getStore({ name: "bookings", consistency: "strong" }), d.now());
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
});
