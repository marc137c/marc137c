// RC2 (failure paths never ran): every server write under every way a Blobs write can go wrong.
// Writes: web create, admin create, same-month PATCH, cross-month PATCH (the new month's write failing, and the old
// month's removal failing), DELETE, cancel-phone and a rate-limit take(). Faults, on the key that write touches:
//   fail-before 500 on every attempt (nothing stored), a lost response (stored, the reply never came),
//   fail-after 502 on every attempt (stored, then an error), and 8 CAS losses in a row to a competing write.
// Invariant: one copy per booking id suffix, and the reply matches the store: a 2xx means the change is stored;
// a 5xx (or a throw) means a plain retry, with the fault gone, converges to exactly the intended state. The one
// state with two copies is a cross-month move whose removal failed, and its reply is the 503 that says so.
// Side effects too (round 2, SPEC R15): with one subscribed device, after the retry converges each stored web
// booking has produced exactly one «Ny time» delivery, whichever request did the write (none for admin writes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { item, seedItems, storedItems, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { makeToken, retryDelay } from "../../netlify/lib/booking-core.mjs";
import { calendarFor } from "../../netlify/lib/calendar.mjs";
import { take } from "../../netlify/lib/limits.mjs";
import * as bookings from "../../netlify/functions/bookings.mjs";
import * as admin from "../../netlify/functions/admin.mjs";
import { makeDevice, fakePushService } from "../helpers/fake-push.mjs";
import { vapidKeys, saveSubscription, parseSubscription, pushGen } from "../../netlify/lib/push.mjs";

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
    newTimePushes: 1,
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
const newTimes = (push) => push.deliveries.filter((x) => x.payload && x.payload.title === "Ny time").length;
// One device with push on (a 60-day login), before any fault is injected
async function subscribed(d, push) {
  const store = d.getStore({ name: "bookings", consistency: "strong" });
  await vapidKeys(store, { now: d.now() });
  const r = await saveSubscription(store, parseSubscription(push.devices[0].subscription).value, { now: d.now(), gen: pushGen(PW), until: new Date(d.clock.now() + 60 * 864e5) });
  assert.equal(r.ok, true);
}
const content = (d) => JSON.stringify(storedItems(d.blobs).map(({ updatedAt, ...rest }) => rest));

for (const [writeName, w] of Object.entries(WRITES)) {
  for (const [faultName, inject] of Object.entries(FAULTS)) {
    test(`fault matrix: ${writeName} with ${faultName}: the reply matches the store, and a retry converges to one copy`, async (t) => {
      quiet(t);
      const push = fakePushService({ devices: [makeDevice("fcm")] });
      const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PW }, fetch: push.fetch });
      await subscribed(d, push);
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
      assert.equal(newTimes(push), w.newTimePushes || 0, `«Ny time» deliveries after convergence: ${newTimes(push)}`);
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

// ---------- Round 2: the interleaved competing write axis (SPEC R16) ----------
// A cross-month move is two documents: add to the new month, remove from the old. Its precondition (expect) was
// checked on a read taken before both writes, so another device's change landing in between was lost (a cancel
// came back as confirmed), and two moves at once left the booking twice. Here device B's PATCH or DELETE runs
// right before each store call device A makes during the move. Invariant: one copy per id suffix; whoever lost
// gets 412 (or 404 when the booking is already gone), never 2xx, unless both asked for the very same result; and
// the store holds exactly the winner's change.
const MOVE_FROM = "2026-11-27";
const B_ACTIONS = {
  "cancel": { patch: { status: "cancelled" }, expect: (s) => s.length === 1 && s[0].date === MOVE_FROM && s[0].status === "cancelled" },
  "a new phone number": { patch: { phone: "400 11 222" }, expect: (s) => s.length === 1 && s[0].date === MOVE_FROM && s[0].phone === "400 11 222" },
  "a move to 8 January": { patch: { date: "2027-01-08" }, expect: (s) => s.length === 1 && s[0].date === "2027-01-08" },
  "a move to 8 December (the same month as A's)": { patch: { date: "2026-12-08" }, expect: (s) => s.length === 1 && s[0].date === "2026-12-08" },
  "DELETE": { del: true, expect: (s) => s.length === 0 },
  "the very same move": { patch: { date: "2026-12-02" }, same: true, expect: (s) => s.length === 1 && s[0].date === "2026-12-02" },
};
const A_DONE = (s) => s.length === 1 && s[0].date === "2026-12-02" && s[0].status === "confirmed" && s[0].phone === CUSTOMER_PHONE;

// deps for device A whose store runs hook(n) before its n-th call (get, getWithMetadata, setJSON, delete)
function hooked(d, hook) {
  let n = 0;
  return { ...d, getStore: (o) => {
    const s = d.getStore(o);
    return new Proxy(s, { get(t, p) {
      const v = t[p];
      if (typeof v !== "function") return v;
      if (!["get", "getWithMetadata", "setJSON", "delete"].includes(p)) return v.bind(t);
      return async (...args) => { await hook(n++); return v.apply(t, args); };
    } });
  } };
}
const patchAs = (deps, id, json) => admin.handle(request(`/api/admin/items/${id}`, { method: "PATCH", json, headers: auth(deps) }), { ...PRODUCTION, params: { id } }, deps).then(read);
const deleteAs = (deps, id) => admin.handle(request(`/api/admin/items/${id}`, { method: "DELETE", headers: auth(deps) }), { ...PRODUCTION, params: { id } }, deps).then(read);

function moveSetup() {
  const d = testDeps({ now: "2026-11-20T08:00:00Z", env: { ADMIN_PASSWORD: PW } });
  const [b] = seedItems(d.blobs, [item({ date: MOVE_FROM, start: 600 })]);
  return { d, b };
}
// How many store calls an undisturbed move makes
async function callsInMove() {
  const { d, b } = moveSetup();
  let calls = 0;
  const r = await patchAs(hooked(d, async () => { calls++; }), b.id, { date: "2026-12-02", expect: b.updatedAt });
  assert.equal(r.status, 200);
  return calls;
}

test("fault matrix (interleaved): another device's change at every step of a cross-month move: one copy, and the loser gets 412, never 2xx", async (t) => {
  quiet(t);
  const calls = await callsInMove();
  assert.ok(calls >= 4, `a move makes ${calls} store calls`);
  for (const [label, bAct] of Object.entries(B_ACTIONS)) {
    for (let k = 0; k < calls; k++) {
      const { d, b } = moveSetup();
      let byB;
      const depsA = hooked(d, async (n) => {
        if (n !== k) return;
        d.clock.advance(1000);
        byB = bAct.del ? await deleteAs(d, b.id) : await patchAs(d, b.id, { ...bAct.patch, expect: b.updatedAt });
        d.clock.advance(1000);
      });
      const byA = await patchAs(depsA, b.id, { date: "2026-12-02", expect: b.updatedAt });
      const where = `B: ${label} before A's store call ${k}: A ${byA.status}, B ${byB && byB.status}`;
      const ids = storedItems(d.blobs).map((i) => suffix(i.id));
      assert.equal(new Set(ids).size, ids.length, `${where}: one copy per id suffix: ${storedItems(d.blobs).map((i) => i.id)}`);
      const stored = storedItems(d.blobs);
      const aWon = byA.status >= 200 && byA.status < 300;
      const bWon = byB.status >= 200 && byB.status < 300;
      if (bAct.same) {
        assert.ok(aWon || bWon, where);
        assert.ok(bAct.expect(stored), `${where} | stored ${JSON.stringify(stored.map((i) => [i.id, i.status]))}`);
        continue;
      }
      assert.ok(aWon !== bWon, `${where}: exactly one wins`);
      const loser = aWon ? byB : byA;
      assert.ok([412, 404].includes(loser.status), `${where}: the loser is told (${loser.status} ${JSON.stringify(loser.body)})`);
      assert.ok((aWon ? A_DONE : bAct.expect)(stored), `${where} | stored ${JSON.stringify(stored.map((i) => [i.id, i.status, i.phone]))}`);
    }
  }
});

// demo-crossmonth-race.mjs and demo-crossmonth-double.mjs, as found: B acts right before A writes December
test("fault matrix: a cancel made while another device moves the booking to December is kept, and the move answers 412", async (t) => {
  quiet(t);
  const { d, b } = moveSetup();
  let byB;
  const depsA = { ...d, getStore: (o) => new Proxy(d.getStore(o), { get(tg, p) {
    if (p === "setJSON") return async (key, val, opts) => {
      if (key === "m/2026-12" && !byB) { d.clock.advance(1000); byB = await patchAs(d, b.id, { status: "cancelled", expect: b.updatedAt }); }
      return tg.setJSON(key, val, opts);
    };
    const v = tg[p]; return typeof v === "function" ? v.bind(tg) : v;
  } }) };
  const byA = await patchAs(depsA, b.id, { date: "2026-12-02", expect: b.updatedAt });
  assert.equal(byB.status, 200);
  assert.equal(byA.status, 412, JSON.stringify(byA.body));
  assert.deepEqual(storedItems(d.blobs).map((i) => `${i.id} ${i.status}`), [`${b.id} cancelled`]);
});

test("fault matrix: two moves at once (to 2 December and to 8 January) leave one copy and one VEVENT", async (t) => {
  quiet(t);
  const { d, b } = moveSetup();
  let byB;
  const depsA = { ...d, getStore: (o) => new Proxy(d.getStore(o), { get(tg, p) {
    if (p === "setJSON") return async (key, val, opts) => {
      if (key === "m/2026-12" && !byB) byB = await patchAs(d, b.id, { date: "2027-01-08", expect: b.updatedAt });
      return tg.setJSON(key, val, opts);
    };
    const v = tg[p]; return typeof v === "function" ? v.bind(tg) : v;
  } }) };
  const byA = await patchAs(depsA, b.id, { date: "2026-12-02", expect: b.updatedAt });
  assert.deepEqual([byA.status, byB.status], [412, 200]);
  assert.deepEqual(storedItems(d.blobs).map((i) => i.id), [`2027-01-08_${suffix(b.id)}`]);
  const ics = await calendarFor(d.getStore({ name: "bookings", consistency: "strong" }), d.now());
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
});

// Round 2, fix-up: a DELETE racing a cross-month move (interleave-show.mjs, interleave-all.mjs). Device B moves the
// booking out of November between device A's read of m/2026-11 and A's conditional write; A's write misses, the
// re-run finds the booking gone and used to answer 200 «ok» because of a flag set by the attempt that never stored.
// Now a delete recognises its own earlier attempt only by its tombstone in the month document (deletedOut).
const MOVES_OUT = {
  "a move to 2 December": { date: "2026-12-02" },
  "a move to 8 January": { date: "2027-01-08" },
  "a move to 2 December at 11:00": { date: "2026-12-02", start: 660 },
};
const deleteWith = (deps, id, expect) => admin.handle(request(`/api/admin/items/${id}${expect ? `?expect=${encodeURIComponent(expect)}` : ""}`, { method: "DELETE", headers: auth(deps) }), { ...PRODUCTION, params: { id } }, deps).then(read);
for (const [tab, withExpect] of [["this device's DELETE (expect)", true], ["an old tab's DELETE (no expect)", false]]) {
  test(`fault matrix: ${tab} racing a cross-month move never answers 2xx while the booking lives on`, async (t) => {
    quiet(t);
    for (const [label, patch] of Object.entries(MOVES_OUT)) {
      for (let k = 0; k < 4; k++) {
        const { d, b } = moveSetup();
        let byB = null;
        const depsA = hooked(d, async (n) => {
          if (n !== k) return;
          d.clock.advance(1000);
          byB = await patchAs(d, b.id, { ...patch, expect: b.updatedAt });
          d.clock.advance(1000);
        });
        const byA = await deleteWith(depsA, b.id, withExpect ? b.updatedAt : null);
        if (!byB) continue;
        const stored = storedItems(d.blobs).filter((i) => suffix(i.id) === suffix(b.id) && i.status === "confirmed");
        const where = `B: ${label} before A's store call ${k}: A ${byA.status} ${JSON.stringify(byA.body)}, B ${byB.status}`;
        if (byA.status >= 200 && byA.status < 300) assert.equal(stored.length, 0, `${where}: A said deleted, but ${stored.map((i) => i.id)} is active`);
        else assert.equal(byA.status, 412, `${where}: the moved booking is reported as changed elsewhere`);
        if (byB.status === 200) assert.equal(stored.length, 1, where);
      }
    }
  });
}

test("fault matrix: a DELETE whose stored write lost its reply finds its own tombstone on the re-run (200), and a DELETE of a booking another device deleted answers 404", async (t) => {
  quiet(t);
  const { d, b } = moveSetup();
  // stored, reply lost: the client's retry of the conditional PUT gets 412, and the re-run of the mutate function
  // finds the booking gone; only the tombstone with this call's mark says that was this call
  d.blobs.inject({ method: "PUT", key: "m/2026-11", fault: "lost-response" });
  const first = await deleteWith(d, b.id, b.updatedAt);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  d.blobs.clearFaults();
  assert.deepEqual(storedItems(d.blobs), []);
  // the month document keeps a short tombstone list: id, a random mark and the time; no customer data
  const doc = d.blobs.json("bookings", "m/2026-11");
  assert.ok(Array.isArray(doc.deletedOut) && doc.deletedOut.length === 1, JSON.stringify(doc));
  assert.deepEqual(Object.keys(doc.deletedOut[0]).sort(), ["at", "id", "m"]);
  // another device (or an old tab) deleting it again: 404, not «ok»
  const other = await deleteWith(d, b.id);
  assert.equal(other.status, 404);
});

test("fault matrix: an old tab's DELETE of a booking that was moved to another month answers 412 (open it again), not 404", async (t) => {
  quiet(t);
  const { d, b } = moveSetup();
  const moved = await patchAs(d, b.id, { date: "2026-12-02", expect: b.updatedAt });
  assert.equal(moved.status, 200);
  const r = await deleteWith(d, b.id);
  assert.equal(r.status, 412, JSON.stringify(r.body));
  assert.equal(r.body.code, "stale");
  assert.equal(storedItems(d.blobs).length, 1);
});
