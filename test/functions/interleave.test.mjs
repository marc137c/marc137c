// Guard (fix-up round 2, SPEC R16): every admin write B, run as a whole request before each store call of every
// admin write A on the same booking (same expect = v0), single and bulk (cancel-phone) alike. The fault matrix only
// modelled synthetic competing writes; a second real operation between another operation's store calls found a
// DELETE answering «ok» while the booking lived on in December, and a move racing «Avlys alle fra nummeret» left
// two copies and «2 avlyst» for one booking. Invariants for every pair and every k:
//  (a) one copy per booking id suffix;
//  (b) the 2xx replies are a serial order that explains the final state (and cancel-phone's count);
//  (c) two requests that both carried expect = v0 never both get 2xx unless their changes give the same result;
//  (d) no move mark (moving on the original, mv on the copy) is left once both requests have answered.
// Round 3 (SPEC R33): every move runs in both directions, into a later AND an earlier month (the booking is seeded
// once in November and once in December), against every other write and the bulk writer: cancel-phone walked the
// months once, in order, so a booking moved from a month it had not reached into one it had already read escaped
// it («0 avlyst», still active). And B also acts on what a device sees in the middle of A's move: the copy in the
// new month (GET /api/admin/items shows both halves), with expect = the copy's updatedAt. Moving that copy back
// to its old date used to adopt the untouched original as «the same move from another device», remove the copy,
// and let A remove the original: both answered 200 and the booking was gone.
// Adapted from audit/round2/verify-server/r3/interleave-all.mjs (whose cancel-phone model and old-tab rule are
// corrected here: cancel-phone only cancels an active booking with its number; a request without expect has no
// precondition to break) and audit/round2/verify-server/r4/move-back-race.mjs, backward-move-cancel.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { item, seedItems, storedItems, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { oslo } from "../helpers/clock.mjs";
import { makeToken, retryDelay } from "../../netlify/lib/booking-core.mjs";
import { handle } from "../../netlify/functions/admin.mjs";

retryDelay.ms = () => 0;
const PW = "fake-admin-password";
// Where the booking starts: November (its moves to December and January go forward, «MOVE_NOV» stays in the month)
// and December (MOVE_NOV goes backward, MOVE_DEC stays in the month, MOVE_JAN goes forward)
const SEEDS = ["2026-11-27", "2026-12-08"];
const live = (s) => s && s.status !== "cancelled";
// op: how to send it; model(state) → { state, count } for the store a successful reply stands for.
// onCopy: B acts on the copy a GET shows in the middle of A's cross-month move (another id with the same suffix),
// with that copy's updatedAt as expect; with no such copy visible, B sends nothing (skipped).
const OPS = {
  MOVE_DEC: { patch: { date: "2026-12-02" } },
  MOVE_JAN: { patch: { date: "2027-01-08" } },
  MOVE_NOV: { patch: { date: "2026-11-27" } },
  MOVE_DEC_1100: { patch: { date: "2026-12-02", start: 660 } },
  SAME_MONTH: { patch: { start: 660 } },
  CANCEL: { patch: { status: "cancelled" } },
  PHONE: { patch: { phone: "400 11 222" } },
  DELETE: { del: true },
  DELETE_OLDTAB: { del: true, noExpect: true },
  CANCEL_PHONE: { bulk: true, noExpect: true },
};
const COPY_OPS = {
  COPY_BACK: { patch: (seed) => ({ date: seed }), onCopy: true },
  COPY_BACK_1000: { patch: (seed) => ({ date: seed, start: 600 }), onCopy: true },
  COPY_JAN: { patch: () => ({ date: "2027-01-15" }), onCopy: true },
  COPY_CANCEL: { patch: () => ({ status: "cancelled" }), onCopy: true },
  COPY_DELETE: { del: true, onCopy: true },
};
const ALL = { ...OPS, ...COPY_OPS };
const patchOf = (op, seed) => (typeof op.patch === "function" ? op.patch(seed) : op.patch);
function model(name, s, seed) {
  const op = ALL[name];
  if (!s) return { state: null, count: 0 };
  if (op.del) return { state: null, count: 0 };
  if (op.bulk) return live(s) && s.phone === CUSTOMER_PHONE ? { state: { ...s, status: "cancelled" }, count: 1 } : { state: s, count: 0 };
  return { state: { ...s, ...patchOf(op, seed) }, count: 0 };
}

async function run(aName, bName, k, seed) {
  const d = testDeps({ env: { ADMIN_PASSWORD: PW }, now: oslo("2026-11-20", 9, 0) });
  const [b] = seedItems(d.blobs, [item({ date: seed, start: 600 })]);
  const v0 = b.updatedAt;
  const suffix = b.id.slice(b.id.indexOf("_"));
  const auth = { Authorization: "Bearer " + makeToken(PW, d.clock.now(), 12 * 3600e3) };
  const call = async (deps, name) => {
    const op = ALL[name];
    if (op.bulk) return handle(request("/api/admin/cancel-phone", { method: "POST", json: { phone: CUSTOMER_PHONE }, headers: auth }), PRODUCTION, deps).then(read);
    let id = b.id, expect = v0;
    if (op.onCopy) {
      const seen = await handle(request("/api/admin/items?from=2026-11-20&to=2027-02-10", { headers: auth }), PRODUCTION, deps).then(read);
      const copy = (seen.body.items || []).find((i) => i.id.endsWith(suffix) && i.id !== b.id);
      if (!copy) return { status: 0, skipped: true, body: {} };
      id = copy.id;
      expect = copy.updatedAt;
    }
    const ctx = { ...PRODUCTION, params: { id } };
    if (op.del) return handle(request(`/api/admin/items/${id}${op.noExpect ? "" : `?expect=${encodeURIComponent(expect)}`}`, { method: "DELETE", headers: auth }), ctx, deps).then(read);
    return handle(request(`/api/admin/items/${id}`, { method: "PATCH", json: { ...patchOf(op, seed), expect }, headers: auth }), ctx, deps).then(read);
  };
  let n = 0, byB = null;
  const depsA = { ...d, getStore: (o) => new Proxy(d.getStore(o), { get(t, p) {
    const v = t[p];
    if (typeof v !== "function") return v;
    if (!["get", "getWithMetadata", "getMetadata", "setJSON", "set", "delete", "list"].includes(p)) return v.bind(t);
    return async (...args) => {
      if (n++ === k && !byB) { d.clock.advance(1000); byB = await call(d, bName); d.clock.advance(1000); }
      return v.apply(t, args);
    };
  } }) };
  const byA = await call(depsA, aName);
  return { byA, byB, all: storedItems(d.blobs).filter((i) => i.id.endsWith(suffix)), b };
}

const pick = (i) => i && { date: i.date, start: i.start, status: i.status, phone: i.phone };
const same = (x, y) => JSON.stringify(pick(x)) === JSON.stringify(pick(y));
const ok = (r) => r && r.status >= 200 && r.status < 300;
const carriesV0 = (name) => !ALL[name].noExpect && !ALL[name].onCopy;

function problemsOf(aName, bName, seed, { byA, byB, all, b }) {
  const out = [];
  if (all.length > 1) out.push(`${all.length} copies: ${all.map((i) => `${i.id}:${i.status}`).join(",")}`);
  const marks = all.filter((i) => "mv" in i || "moving" in i);
  if (marks.length) out.push(`a move mark was left: ${JSON.stringify(marks.map((i) => ({ id: i.id, mv: i.mv, moving: i.moving })))}`);
  const final = all[0] || null;
  const succ = [[aName, byA], [bName, byB]].filter(([, r]) => ok(r));
  const orders = succ.length === 2 ? [succ, [succ[1], succ[0]]] : [succ];
  const explains = (order) => {
    let s = b;
    for (const [name, r] of order) {
      const m = model(name, s, seed);
      if (ALL[name].bulk && r.body.cancelled !== m.count) return false;
      s = m.state;
    }
    return s === null ? final === null : final !== null && same(s, final);
  };
  if (!orders.some(explains)) out.push(`final ${JSON.stringify(pick(final))} (cancel-phone: ${[byA, byB].map((r) => r.body && r.body.cancelled).join("/")}) matches no serial order of the 2xx replies`);
  if (ok(byA) && ok(byB) && carriesV0(aName) && carriesV0(bName) && aName !== bName) {
    const ab = model(bName, model(aName, b, seed).state, seed).state, ba = model(aName, model(bName, b, seed).state, seed).state;
    if (!(ab === null && ba === null) && !(ab && ba && same(ab, ba))) out.push("both answered 2xx although both carried expect = v0");
  }
  return out;
}

async function sweep(pairs, seeds = SEEDS) {
  const problems = [];
  let tried = 0, copySeen = 0;
  for (const seed of seeds) for (const [aName, bName] of pairs) {
    for (let k = 0; k < 60; k++) {
      const r = await run(aName, bName, k, seed);
      if (!r.byB) break; // A finished before its k-th call: every point tried
      if (r.byB.skipped) continue;
      tried++;
      if (ALL[bName].onCopy) copySeen++;
      for (const p of problemsOf(aName, bName, seed, r)) problems.push(`${seed}: A ${aName} (${r.byA.status}) × B ${bName} (${r.byB.status}) before A's call ${k}: ${p}`);
    }
  }
  return { problems, tried, copySeen };
}

test("interleaving: every admin write B before every store call of every admin write A, with the booking in November and in December, keeps one copy, and the 2xx replies explain the store", async (t) => {
  quiet(t);
  const pairs = [];
  for (const aName of Object.keys(OPS)) for (const bName of Object.keys(OPS)) pairs.push([aName, bName]);
  const { problems, tried } = await sweep(pairs);
  assert.ok(tried > 800, `${tried} interleavings tried`);
  assert.deepEqual(problems, []);
});

test("interleaving: a device acting on the copy it sees in the middle of a cross-month move (move it back, move it on, cancel, delete) never makes the booking vanish or leaves two", async (t) => {
  quiet(t);
  const pairs = [];
  for (const aName of ["MOVE_DEC", "MOVE_JAN", "MOVE_NOV", "MOVE_DEC_1100"]) for (const bName of Object.keys(COPY_OPS)) pairs.push([aName, bName]);
  const { problems, copySeen } = await sweep(pairs);
  assert.ok(copySeen >= 40, `${copySeen} interleavings where B saw the copy`);
  assert.deepEqual(problems, []);
});
