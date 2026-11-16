// Guard (fix-up round 2, SPEC R16): every admin write B, run as a whole request before each store call of every
// admin write A on the same booking (same expect = v0), single and bulk (cancel-phone) alike. The fault matrix only
// modelled synthetic competing writes; a second real operation between another operation's store calls found a
// DELETE answering «ok» while the booking lived on in December, and a move racing «Avlys alle fra nummeret» left
// two copies and «2 avlyst» for one booking. Invariants for every pair and every k:
//  (a) one copy per booking id suffix;
//  (b) the 2xx replies are a serial order that explains the final state (and cancel-phone's count);
//  (c) two requests that both carried expect = v0 never both get 2xx unless their changes give the same result.
// Adapted from audit/round2/verify-server/r3/interleave-all.mjs (whose cancel-phone model and old-tab rule are
// corrected here: cancel-phone only cancels an active booking with its number; a request without expect has no
// precondition to break).
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { item, seedItems, storedItems, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { oslo } from "../helpers/clock.mjs";
import { makeToken, retryDelay } from "../../netlify/lib/booking-core.mjs";
import { handle } from "../../netlify/functions/admin.mjs";

retryDelay.ms = () => 0;
const PW = "fake-admin-password";
const FROM = "2026-11-27";
const live = (s) => s && s.status !== "cancelled";
// op: how to send it; model(state) → { state, count } for the store a successful reply stands for
const OPS = {
  MOVE_DEC: { patch: { date: "2026-12-02" } },
  MOVE_JAN: { patch: { date: "2027-01-08" } },
  MOVE_DEC_1100: { patch: { date: "2026-12-02", start: 660 } },
  SAME_MONTH: { patch: { start: 660 } },
  CANCEL: { patch: { status: "cancelled" } },
  PHONE: { patch: { phone: "400 11 222" } },
  DELETE: { del: true },
  DELETE_OLDTAB: { del: true, noExpect: true },
  CANCEL_PHONE: { bulk: true, noExpect: true },
};
function model(name, s) {
  const op = OPS[name];
  if (!s) return { state: null, count: 0 };
  if (op.del) return { state: null, count: 0 };
  if (op.bulk) return live(s) && s.phone === CUSTOMER_PHONE ? { state: { ...s, status: "cancelled" }, count: 1 } : { state: s, count: 0 };
  return { state: { ...s, ...op.patch }, count: 0 };
}

async function run(aName, bName, k) {
  const d = testDeps({ env: { ADMIN_PASSWORD: PW }, now: oslo("2026-11-20", 9, 0) });
  const [b] = seedItems(d.blobs, [item({ date: FROM, start: 600 })]);
  const v0 = b.updatedAt;
  const auth = { Authorization: "Bearer " + makeToken(PW, d.clock.now(), 12 * 3600e3) };
  const call = (deps, name) => {
    const op = OPS[name];
    if (op.bulk) return handle(request("/api/admin/cancel-phone", { method: "POST", json: { phone: CUSTOMER_PHONE }, headers: auth }), PRODUCTION, deps).then(read);
    const ctx = { ...PRODUCTION, params: { id: b.id } };
    if (op.del) return handle(request(`/api/admin/items/${b.id}${op.noExpect ? "" : `?expect=${encodeURIComponent(v0)}`}`, { method: "DELETE", headers: auth }), ctx, deps).then(read);
    return handle(request(`/api/admin/items/${b.id}`, { method: "PATCH", json: { ...op.patch, expect: v0 }, headers: auth }), ctx, deps).then(read);
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
  const suffix = b.id.slice(b.id.indexOf("_"));
  return { byA, byB, all: storedItems(d.blobs).filter((i) => i.id.endsWith(suffix)), b };
}

const pick = (i) => i && { date: i.date, start: i.start, status: i.status, phone: i.phone };
const same = (x, y) => JSON.stringify(pick(x)) === JSON.stringify(pick(y));
const ok = (r) => r && r.status >= 200 && r.status < 300;

function problemsOf(aName, bName, k, { byA, byB, all, b }) {
  const out = [];
  if (all.length > 1) out.push(`${all.length} copies: ${all.map((i) => `${i.id}:${i.status}`).join(",")}`);
  const final = all[0] || null;
  const succ = [[aName, byA], [bName, byB]].filter(([, r]) => ok(r));
  const orders = succ.length === 2 ? [succ, [succ[1], succ[0]]] : [succ];
  const explains = (order) => {
    let s = b;
    for (const [name, r] of order) {
      const m = model(name, s);
      if (OPS[name].bulk && r.body.cancelled !== m.count) return false;
      s = m.state;
    }
    return s === null ? final === null : final !== null && same(s, final);
  };
  if (!orders.some(explains)) out.push(`final ${JSON.stringify(pick(final))} (cancel-phone: ${[byA, byB].map((r) => r.body && r.body.cancelled).join("/")}) matches no serial order of the 2xx replies`);
  if (ok(byA) && ok(byB) && !OPS[aName].noExpect && !OPS[bName].noExpect && aName !== bName) {
    const ab = model(bName, model(aName, b).state).state, ba = model(aName, model(bName, b).state).state;
    if (!(ab === null && ba === null) && !(ab && ba && same(ab, ba))) out.push("both answered 2xx although both carried expect = v0");
  }
  return out;
}

test("interleaving: every admin write B before every store call of every admin write A keeps one copy, and the 2xx replies explain the store", async (t) => {
  quiet(t);
  const problems = [];
  let pairs = 0;
  for (const aName of Object.keys(OPS)) for (const bName of Object.keys(OPS)) {
    for (let k = 0; k < 40; k++) {
      const r = await run(aName, bName, k);
      if (!r.byB) break; // A finished before its k-th call: every point tried
      pairs++;
      for (const p of problemsOf(aName, bName, k, r)) problems.push(`A ${aName} (${r.byA.status}) × B ${bName} (${r.byB.status}) before A's call ${k}: ${p}`);
    }
  }
  assert.ok(pairs > 300, `${pairs} interleavings tried`);
  assert.deepEqual(problems, []);
});
