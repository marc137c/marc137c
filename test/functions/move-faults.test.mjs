// Guard (round 3, SPEC R33): a fault at step k of a cross-month move B, then every other admin write A from a
// device that acts on what it sees, then B's retry (the «Trykk Lagre én gang til» the 503 asks for).
// The interleaving suite (interleave.test.mjs) only puts whole requests between another request's store calls;
// here B stops half-way for real: its k-th Blobs call fails on every attempt, either before anything is stored
// (fail-before 500) or after (fail-after 502: stored, but answered as an error). A then acts on:
//   sheet: the booking as its sheet showed it before the move (the original id, expect = v0);
//   original / copy: an entry a GET /api/admin/items shows now (both halves of an unfinished move are visible),
//   with the updatedAt it shows.
// Found by audit/round2/verify-server/r4/halfdone-delete.mjs: after a move whose removal step failed, a DELETE of
// the original answered 200 «ok», and the copy on the new date stayed active (busy for customers), because only
// the copy carried the move's mark and the DELETE looked only at the original.
// Invariants for every direction, fault, k, A and target:
//   (a) one copy per id suffix, and no move mark left once B's retry has answered;
//   (b) the 2xx replies (B counts as one write whether its first try or its retry answered 2xx) form a serial
//       order that explains the final state and cancel-phone's count: a booking never vanishes without a 2xx
//       DELETE, and never stays active after one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { item, seedItems, storedItems, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { oslo } from "../helpers/clock.mjs";
import { makeToken, retryDelay } from "../../netlify/lib/booking-core.mjs";
import { handle } from "../../netlify/functions/admin.mjs";

retryDelay.ms = () => 0;
const PW = "fake-admin-password";
const MOVES = {
  "forward (27 Nov → 2 Dec)": { from: "2026-11-27", to: "2026-12-02" },
  "backward (8 Dec → 27 Nov)": { from: "2026-12-08", to: "2026-11-27" },
};
const FAULTS = {
  "fail-before 500": (blobs, method, key) => blobs.inject({ method, key, fault: "fail-before", status: 500, times: 6 }),
  "fail-after 502": (blobs, method, key) => blobs.inject({ method, key, fault: method === "PUT" ? "fail-after" : "fail-before", status: 502, times: 6 }),
};
// A's writes; patch(move) for a PATCH. model(state) → { state, count }
const A_OPS = {
  DELETE: { del: true },
  DELETE_OLDTAB: { del: true, noExpect: true },
  CANCEL: { patch: () => ({ status: "cancelled" }) },
  PHONE: { patch: () => ({ phone: "400 11 222" }) },
  SAME_MONTH: { patch: () => ({ start: 660 }) },
  MOVE_ON: { patch: () => ({ date: "2027-01-15" }) },
  MOVE_BACK: { patch: (mv) => ({ date: mv.from }) },
  CANCEL_PHONE: { bulk: true },
};
const live = (s) => s && s.status !== "cancelled";
function model(op, s, mv) {
  if (!s) return { state: null, count: 0 };
  if (op === "B") return { state: { ...s, date: mv.to }, count: 0 };
  const a = A_OPS[op];
  if (a.del) return { state: null, count: 0 };
  if (a.bulk) return live(s) && s.phone === CUSTOMER_PHONE ? { state: { ...s, status: "cancelled" }, count: 1 } : { state: s, count: 0 };
  return { state: { ...s, ...a.patch(mv) }, count: 0 };
}
const pick = (i) => i && { date: i.date, start: i.start, status: i.status, phone: i.phone };
const same = (x, y) => JSON.stringify(pick(x)) === JSON.stringify(pick(y));
const ok = (r) => r && r.status >= 200 && r.status < 300;

async function run(mv, faultName, k, aName, target) {
  const d = testDeps({ env: { ADMIN_PASSWORD: PW }, now: oslo("2026-11-20", 9, 0) });
  const [b] = seedItems(d.blobs, [item({ date: mv.from, start: 600 })]);
  const suffix = b.id.slice(b.id.indexOf("_"));
  const auth = { Authorization: "Bearer " + makeToken(PW, d.clock.now(), 12 * 3600e3) };
  const move = (deps) => handle(request(`/api/admin/items/${b.id}`, { method: "PATCH", json: { date: mv.to, expect: b.updatedAt }, headers: auth }), { ...PRODUCTION, params: { id: b.id } }, deps)
    .then(read, (err) => ({ status: 500, body: { thrown: err && err.message } }));
  // B's store: its k-th call fails on every attempt
  let n = 0, faulted = null;
  const depsB = { ...d, getStore: (o) => new Proxy(d.getStore(o), { get(t, p) {
    const v = t[p];
    if (typeof v !== "function") return v;
    if (!["get", "getWithMetadata", "setJSON"].includes(p)) return v.bind(t);
    return async (...args) => {
      if (n++ === k) { faulted = `${p} ${args[0]}`; FAULTS[faultName](d.blobs, p === "setJSON" ? "PUT" : "GET", args[0]); }
      return v.apply(t, args);
    };
  } }) };
  const first = await move(depsB);
  d.blobs.clearFaults();
  if (!faulted) return null; // B made fewer than k + 1 calls
  d.clock.advance(60e3);
  // A acts on what it sees
  let byA;
  const op = A_OPS[aName];
  if (op.bulk) {
    byA = await handle(request("/api/admin/cancel-phone", { method: "POST", json: { phone: CUSTOMER_PHONE }, headers: auth }), PRODUCTION, d).then(read);
  } else {
    let id = b.id, expect = b.updatedAt;
    if (target !== "sheet") {
      const seen = await handle(request("/api/admin/items?from=2026-11-20&to=2027-02-10", { headers: auth }), PRODUCTION, d).then(read);
      const halves = seen.body.items.filter((i) => i.id.endsWith(suffix));
      const it = halves.find((i) => (target === "original" ? i.id === b.id : i.id !== b.id));
      if (!it) return { skipped: true };
      id = it.id;
      expect = it.updatedAt;
    }
    const ctx = { ...PRODUCTION, params: { id } };
    byA = op.del
      ? await handle(request(`/api/admin/items/${id}${op.noExpect ? "" : `?expect=${encodeURIComponent(expect)}`}`, { method: "DELETE", headers: auth }), ctx, d).then(read)
      : await handle(request(`/api/admin/items/${id}`, { method: "PATCH", json: { ...op.patch(mv), expect }, headers: auth }), ctx, d).then(read);
  }
  d.clock.advance(60e3);
  const retry = await move(d);
  return { b, first, byA, retry, faulted, all: storedItems(d.blobs).filter((i) => i.id.endsWith(suffix)) };
}

function problemsOf(mv, aName, { b, first, byA, retry, all }) {
  const out = [];
  if (all.length > 1) out.push(`${all.length} copies: ${all.map((i) => `${i.id}:${i.status}`).join(",")}`);
  const marks = all.filter((i) => "mv" in i || "moving" in i);
  if (marks.length) out.push(`a move mark was left: ${JSON.stringify(marks.map((i) => ({ id: i.id, mv: i.mv, moving: i.moving })))}`);
  const final = all[0] || null;
  const succ = [];
  if (ok(first) || ok(retry)) succ.push(["B", null]);
  if (ok(byA)) succ.push([aName, byA]);
  const orders = succ.length === 2 ? [succ, [succ[1], succ[0]]] : [succ];
  const explains = (order) => {
    let s = b;
    for (const [name, r] of order) {
      const m = model(name, s, mv);
      if (name !== "B" && A_OPS[name].bulk && r.body.cancelled !== m.count) return false;
      s = m.state;
    }
    return s === null ? final === null : final !== null && same(s, final);
  };
  if (!orders.some(explains)) out.push(`final ${JSON.stringify(pick(final))} matches no serial order of the 2xx replies`);
  return out;
}

test("move faults: a fault at every store call of a cross-month move (both directions), then every other admin write on what a device sees, then the move's retry: one copy, no mark left, and the 2xx replies explain the store", async (t) => {
  quiet(t);
  const problems = [];
  let tried = 0, halfDone = 0;
  for (const [dir, mv] of Object.entries(MOVES)) for (const faultName of Object.keys(FAULTS)) {
    for (let k = 0; k < 30; k++) {
      let reached = false;
      for (const aName of Object.keys(A_OPS)) for (const target of A_OPS[aName].bulk ? ["-"] : ["sheet", "original", "copy"]) {
        const r = await run(mv, faultName, k, aName, target);
        if (r === null) continue;
        reached = true;
        if (r.skipped) continue;
        tried++;
        if (r.first.status === 503 && r.first.body.code === "move_half_done") halfDone++;
        for (const p of problemsOf(mv, aName, r)) {
          problems.push(`${dir}, ${faultName} at B's call ${k} (${r.faulted}): B ${r.first.status}${r.first.body.code ? " " + r.first.body.code : ""}, A ${aName} on ${target} ${r.byA.status}, B's retry ${r.retry.status}: ${p}`);
        }
      }
      if (!reached) break;
    }
  }
  assert.ok(tried > 400, `${tried} cases tried`);
  assert.ok(halfDone > 20, `${halfDone} cases where the move answered «Trykk Lagre én gang til»`);
  assert.deepEqual(problems, []);
});
