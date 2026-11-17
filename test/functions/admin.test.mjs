// /api/admin/* through handle(req, context, deps): the password comes from deps.env, the clock from deps.now,
// the store from deps.getStore (production or the preview store, F10). Nothing here uses process.env, the real
// clock or the network.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION, PREVIEW } from "../helpers/deps.mjs";
import { item, seedItems, storedItems, counterHits, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { FakeBlobs } from "../helpers/fake-blobs.mjs";
import { FakeClock } from "../helpers/clock.mjs";
import { makeToken, makeDeviceMark, verifyDeviceMark } from "../../netlify/lib/booking-core.mjs";
import { counterRef, limiterSecret, clientKey, BUCKETS } from "../../netlify/lib/limits.mjs";
import { handle, config } from "../../netlify/functions/admin.mjs";

const PASSWORD = "fake-admin-password";
const NOW = "2026-11-12T09:00:00Z";
const env = { ADMIN_PASSWORD: PASSWORD };
const auth = (d) => ({ Authorization: "Bearer " + makeToken(PASSWORD, d.clock.now()) });

test("admin: paths", () => {
  assert.deepEqual(config.path.slice(0, 3), ["/api/admin/login", "/api/admin/items", "/api/admin/items/:id"]);
});

test("admin: without ADMIN_PASSWORD in deps.env it is closed (503), whatever process.env says", async (t) => {
  const saved = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = PASSWORD;
  t.after(() => { if (saved === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = saved; });
  const res = await read(await handle(request("/api/admin/items"), PRODUCTION, testDeps({ now: NOW })));
  assert.equal(res.status, 503);
});

test("admin: login with the right password gives a token that the next request accepts", async () => {
  const d = testDeps({ now: NOW, env });
  const login = await read(await handle(request("/api/admin/login", { method: "POST", json: { password: PASSWORD, remember: true } }), PRODUCTION, d));
  assert.equal(login.status, 200);
  assert.equal(login.headers["cache-control"], "no-store");
  const res = await read(await handle(request("/api/admin/items?from=2026-11-12&to=2026-11-12", { headers: { Authorization: "Bearer " + login.body.token } }), PRODUCTION, d));
  assert.equal(res.status, 200);
  assert.equal(res.body.today, "2026-11-12", "today comes from the injected clock");
});

test("admin: a wrong password waits 500 ms on the injected clock, counts the failure and answers 401", async () => {
  const d = testDeps({ now: NOW, env });
  const before = d.clock.now();
  const res = await read(await handle(request("/api/admin/login", { method: "POST", json: { password: "nope" } }), { ...PRODUCTION, ip: "203.0.113.9" }, d));
  assert.equal(res.status, 401);
  assert.ok(d.clock.now() - before >= 500);
  const ipRef = counterRef(await limiterSecret(d.getStore({ name: "bookings", consistency: "strong" })), "login/ip", "203.0.113.9");
  assert.deepEqual(counterHits(d.blobs, ipRef).map((h) => h.t), [before]);
  assert.deepEqual(d.blobs.json("bookings", "rl/login/all").hits.map((h) => h.t), [before]);
  assert.equal(d.blobs.keys("bookings").filter((k) => k.startsWith("auth/")).length, 0, "the old auth/* counters are gone");
});

test("admin: a token expires by the injected clock (12 h without «Hold meg innlogget»)", async () => {
  const d = testDeps({ now: NOW, env });
  const login = await read(await handle(request("/api/admin/login", { method: "POST", json: { password: PASSWORD, remember: false } }), PRODUCTION, d));
  const headers = { Authorization: "Bearer " + login.body.token };
  assert.equal((await handle(request("/api/admin/items", { headers }), PRODUCTION, d)).status, 200);
  d.clock.advance(12 * 3600e3 + 1);
  assert.equal((await handle(request("/api/admin/items", { headers }), PRODUCTION, d)).status, 401);
});

test("admin: no token, a bad token or a token for another password is 401", async () => {
  const d = testDeps({ now: NOW, env });
  for (const headers of [{}, { Authorization: "Bearer x.y" }, { Authorization: "Bearer " + makeToken("other", d.clock.now()) }]) {
    const res = await read(await handle(request("/api/admin/items", { headers }), PRODUCTION, d));
    assert.equal(res.status, 401, JSON.stringify(headers));
    assert.equal(res.body.items, undefined);
  }
});

test("admin: create, move and delete use the injected clock and the deploy's own store", async () => {
  const d = testDeps({ now: NOW, env });
  seedItems(d.blobs, [item({ date: "2026-11-20", start: 600, name: "Ekte kunde" })]);
  const created = await read(await handle(request("/api/admin/items", { method: "POST", headers: auth(d), json: {
    date: "2026-11-20", start: 720, dur: 30, service: "Herreklipp", name: "Kari", phone: CUSTOMER_PHONE,
  } }), PRODUCTION, d));
  assert.equal(created.status, 201);
  assert.equal(created.body.item.createdAt, new Date(NOW).toISOString());
  const id = created.body.item.id;
  d.clock.advance(60e3);
  const moved = await read(await handle(request(`/api/admin/items/${id}`, { method: "PATCH", headers: auth(d), json: { start: 780 } }), { ...PRODUCTION, params: { id } }, d));
  assert.equal(moved.body.item.updatedAt, new Date(Date.parse(NOW) + 60e3).toISOString());
  const deleted = await read(await handle(request(`/api/admin/items/${id}`, { method: "DELETE", headers: auth(d) }), { ...PRODUCTION, params: { id } }, d));
  assert.equal(deleted.status, 200);
  assert.deepEqual(storedItems(d.blobs).map((i) => i.name), ["Ekte kunde"]);
  // A preview never sees or changes the live store
  const listed = await read(await handle(request("/api/admin/items?from=2026-11-20&to=2026-11-20", { headers: auth(d) }), PREVIEW, d));
  assert.deepEqual(listed.body.items, []);
  assert.equal(d.fetch.calls.length, 0);
});

// ---------- Login limits (F4, F5): counted atomically before the password is checked ----------
const live = (d) => d.getStore({ name: "bookings", consistency: "strong" });
const loginKey = async (d, ip) => counterRef(await limiterSecret(live(d)), "login/ip", clientKey(ip));
const hitCount = (d, ref) => counterHits(d.blobs, ref).length;
const tryLogin = (d, password, ip, extra = {}) =>
  handle(request("/api/admin/login", { method: "POST", json: { password, ...extra } }), { ...PRODUCTION, ip }, d).then(read);
const tally = (rs) => rs.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});

test("admin login: 50 parallel wrong logins from one IP check the password at most 10 times; the rest are 429", async () => {
  const clock = new FakeClock(NOW);
  const blobs = new FakeBlobs({ clock, latencyMs: 30 });
  const d = testDeps({ clock, blobs, env });
  const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => tryLogin(d, "guess" + i, "203.0.113.5")));
  const st = tally(rs);
  assert.ok((st[401] || 0) <= 10, JSON.stringify(st));
  assert.equal((st[401] || 0) + (st[429] || 0), 50, JSON.stringify(st));
  assert.equal(hitCount(d, await loginKey(d, "203.0.113.5")), 10, "the counter holds exactly 10 hits");
  for (const r of rs.filter((x) => x.status === 429)) assert.match(r.body.error, /For mange feil forsøk/);
});

test("admin login: an IPv6 /64 is one client for the login limit too", async () => {
  const d = testDeps({ now: NOW, env });
  const rs = [];
  for (let i = 1; i <= 12; i++) rs.push(await tryLogin(d, "nope", `2a01:79c:cebd:1000::${i.toString(16)}`));
  assert.deepEqual(rs.map((r) => r.status), [401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 429, 429]);
});

test("admin login: 100 failures from 100 /64s still let a barber in with a device mark, and lock out the rest", async (t) => {
  quiet(t);
  const d = testDeps({ now: NOW, env });
  const first = await tryLogin(d, PASSWORD, "84.210.1.1", { remember: true });
  assert.equal(first.status, 200);
  const device = first.body.device;
  assert.equal(typeof device, "string");
  for (let i = 0; i < 100; i++) assert.equal((await tryLogin(d, "guess" + i, `2a01:79c:${i.toString(16)}:1::1`)).status, 401);
  assert.equal(hitCount(d, "rl/login/all"), 100);
  const without = await tryLogin(d, PASSWORD, "84.210.1.2");
  assert.equal(without.status, 429, "without the mark the global limit holds");
  const withMark = await tryLogin(d, PASSWORD, "84.210.1.3", { device });
  assert.equal(withMark.status, 200, JSON.stringify(withMark.body));
  assert.equal(typeof withMark.body.token, "string");
  // a mark for another password, a tampered or a junk mark do not skip the limit
  for (const bad of [makeDeviceMark("other", d.clock.now()), device.replace(/.$/, (c) => (c === "A" ? "B" : "A")), "x.y", 5]) {
    assert.equal((await tryLogin(d, PASSWORD, "84.210.1.4", { device: bad })).status, 429, String(bad));
  }
  // the mark lasts a year
  d.clock.advance(364 * 864e5);
  for (let i = 0; i < 100; i++) await tryLogin(d, "guess" + i, `2a01:79d:${i.toString(16)}:1::1`);
  assert.equal((await tryLogin(d, PASSWORD, "84.210.1.5", { device })).status, 200);
  d.clock.advance(2 * 864e5);
  for (let i = 0; i < 100; i++) await tryLogin(d, "guess" + i, `2a01:79e:${i.toString(16)}:1::1`);
  assert.equal((await tryLogin(d, PASSWORD, "84.210.1.6", { device })).status, 429, "an expired mark does not");
});

test("admin login: a successful login gives back its hits and returns a device mark", async () => {
  const d = testDeps({ now: NOW, env });
  for (let i = 0; i < 9; i++) assert.equal((await tryLogin(d, "nope", "203.0.113.7")).status, 401);
  const ok = await tryLogin(d, PASSWORD, "203.0.113.7");
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body).sort(), ["device", "expiresIn", "token"]);
  assert.equal(verifyDeviceMark(ok.body.device, PASSWORD, d.clock.now()), true);
  assert.equal(hitCount(d, await loginKey(d, "203.0.113.7")), 9, "the successful attempt left no hit");
  assert.equal(hitCount(d, "rl/login/all"), 9);
  assert.equal((await tryLogin(d, PASSWORD, "203.0.113.7")).status, 200, "the barber can log in again");
});

test("admin login: a store outage gives 503 and checks no password", async (t) => {
  quiet(t);
  const d = testDeps({ now: NOW, env });
  d.blobs.inject({ method: "GET", fault: "fail-before", status: 500, times: Infinity });
  const r = await tryLogin(d, PASSWORD, "203.0.113.8");
  assert.equal(r.status, 503);
  assert.equal(r.body.token, undefined);
  assert.equal(d.blobs.requests({ method: "PUT" }).length, 0);
});

test("admin login: the 60-day token only with remember === true, otherwise 12 hours (F34)", async () => {
  const d = testDeps({ now: NOW, env });
  for (const [remember, ttl] of [[true, 60 * 864e5], [false, 864e5 / 2], [undefined, 864e5 / 2], ["true", 864e5 / 2], [1, 864e5 / 2]]) {
    const r = await tryLogin(d, PASSWORD, "203.0.113.20", remember === undefined ? {} : { remember });
    assert.equal(r.status, 200);
    assert.equal(r.body.expiresIn, ttl, JSON.stringify(remember));
  }
});

// ---------- Edits (F32, X1.1/X1.2) ----------
const patch = (d, id, json) => handle(request(`/api/admin/items/${id}`, { method: "PATCH", headers: auth(d), json }), { ...PRODUCTION, params: { id } }, d).then(read);

test("admin edit: a booking under a block can get a new phone (200), but moving it inside the block is still 409 (F32)", async () => {
  const d = testDeps({ now: NOW, env });
  const [b] = seedItems(d.blobs, [
    item({ date: "2026-11-20", start: 600, dur: 30 }),
    item({ date: "2026-11-20", start: 600, dur: 120, type: "block", name: "", phone: "", service: "" }),
  ]);
  const phone = await patch(d, b.id, { phone: "400 00 000" });
  assert.equal(phone.status, 200, JSON.stringify(phone.body));
  assert.equal(phone.body.item.phone, "400 00 000");
  assert.equal((await patch(d, b.id, { note: "Kommer litt sent" })).status, 200);
  assert.equal((await patch(d, b.id, { start: 630 })).status, 409);
  assert.equal((await patch(d, b.id, { status: "cancelled" })).status, 200);
  assert.equal((await patch(d, b.id, { status: "confirmed" })).status, 409, "reactivating it under the block is a time change");
});

for (const [label, change] of [["same month (a new note)", { note: "Fra A" }], ["cross month (a move to 2 Dec)", { date: "2026-12-02" }]]) {
  test(`admin edit: a stale edit is 412 'stale' and the cancel made on the other device stays, ${label} (X1.1)`, async () => {
    const d = testDeps({ now: NOW, env });
    const [b] = seedItems(d.blobs, [item({ date: "2026-11-27", start: 600 })]);
    const seenByA = b.updatedAt;
    d.clock.advance(60e3);
    const byB = await patch(d, b.id, { status: "cancelled", expect: seenByA });
    assert.equal(byB.status, 200);
    d.clock.advance(60e3);
    const byA = await patch(d, b.id, { ...change, expect: seenByA });
    assert.equal(byA.status, 412, JSON.stringify(byA.body));
    assert.equal(byA.body.code, "stale");
    assert.equal(byA.body.error, "Avtalen er endret på en annen enhet. Lukk og åpne den på nytt.");
    const items = storedItems(d.blobs);
    assert.deepEqual(items.map((i) => [i.id, i.status, i.note, i.date]), [[b.id, "cancelled", "", "2026-11-27"]]);
    // With the current version it goes through
    const fresh = await patch(d, b.id, { ...change, expect: byB.body.item.updatedAt });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  });
}

test("admin edit: a PATCH without expect (an old admin tab) still works, and expect is never stored", async () => {
  const d = testDeps({ now: NOW, env });
  const [b] = seedItems(d.blobs, [item({ date: "2026-11-27", start: 600 })]);
  assert.equal((await patch(d, b.id, { note: "Uten versjon" })).status, 200);
  assert.equal((await patch(d, b.id, { note: "Med versjon", expect: storedItems(d.blobs)[0].updatedAt })).status, 200);
  assert.equal("expect" in storedItems(d.blobs)[0], false);
  assert.equal((await patch(d, b.id, { note: "x", expect: "y".repeat(41) })).status, 400);
});

test("admin edit: a body that is not a JSON object is 400, not a server error", async () => {
  const d = testDeps({ now: NOW, env });
  const [b] = seedItems(d.blobs, [item({ date: "2026-11-27" })]);
  for (const body of ["{", "[]", "null", "5"]) {
    const res = await read(await handle(request(`/api/admin/items/${b.id}`, { method: "PATCH", headers: { ...auth(d), "Content-Type": "application/json" }, body }), { ...PRODUCTION, params: { id: b.id } }, d));
    assert.equal(res.status, 400, body);
    const created = await read(await handle(request("/api/admin/items", { method: "POST", headers: { ...auth(d), "Content-Type": "application/json" }, body }), PRODUCTION, d));
    assert.equal(created.status, 400, body);
  }
});

// ---------- Round 2: every mutating /api/admin/items/:id route carries the updatedAt precondition (SPEC R3) ----------
// DELETE had none: a sheet left open on one device deleted a booking another device had just moved.
const SRC = readFileSync(fileURLToPath(new URL("../../netlify/functions/admin.mjs", import.meta.url)), "utf8");
const MUTATING = {
  PATCH: (d, id, expect) => handle(request(`/api/admin/items/${id}`, { method: "PATCH", json: { note: "Fra den gamle fanen", expect }, headers: auth(d) }), { ...PRODUCTION, params: { id } }, d),
  DELETE: (d, id, expect) => handle(request(`/api/admin/items/${id}?expect=${encodeURIComponent(expect)}`, { method: "DELETE", headers: auth(d) }), { ...PRODUCTION, params: { id } }, d),
};

test("admin: every mutating route on /api/admin/items/:id is in the stale-expect table", () => {
  const methods = [...SRC.matchAll(/\bid && req\.method === "([A-Z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(methods, Object.keys(MUTATING).sort());
});

for (const [method, call] of Object.entries(MUTATING)) {
  test(`admin: ${method} with a stale expect is 412 'stale' and leaves the store unchanged`, async () => {
    const d = testDeps({ now: NOW, env });
    const [b] = seedItems(d.blobs, [item({ date: "2026-11-27", start: 600 })]);
    const seenByA = b.updatedAt;
    d.clock.advance(60e3);
    const moved = await patch(d, b.id, { start: 900, note: "Flyttet av B", expect: seenByA });
    assert.equal(moved.status, 200);
    const before = JSON.stringify(storedItems(d.blobs));
    const res = await read(await call(d, b.id, seenByA));
    assert.deepEqual([res.status, res.body.code], [412, "stale"], JSON.stringify(res.body));
    assert.equal(JSON.stringify(storedItems(d.blobs)), before);
    // with the version B left, it goes through
    assert.equal((await read(await call(d, b.id, moved.body.item.updatedAt))).status, 200);
  });
}

test("admin: DELETE with the current expect deletes; without expect (an old tab) it still works; a too long expect is 400", async () => {
  const d = testDeps({ now: NOW, env });
  const [a, b] = seedItems(d.blobs, [item({ date: "2026-11-27", start: 600 }), item({ date: "2026-11-27", start: 660 })]);
  const del = (id, q = "") => handle(request(`/api/admin/items/${id}${q}`, { method: "DELETE", headers: auth(d) }), { ...PRODUCTION, params: { id } }, d).then(read);
  assert.equal((await del(a.id, "?expect=" + "y".repeat(41))).status, 400);
  assert.equal((await del(a.id, `?expect=${encodeURIComponent(a.updatedAt)}`)).status, 200);
  assert.equal((await del(b.id)).status, 200);
  assert.deepEqual(storedItems(d.blobs), []);
  assert.equal((await del(a.id, `?expect=${encodeURIComponent(a.updatedAt)}`)).status, 404, "already gone: 404 as before");
});

// Round 2: a 401 says why, so /admin's login page can tell the truth about this device's notifications.
// expired: the token's own time ran out; revoked: made before auth/epoch («Slå av varsler på alle andre enheter»);
// invalid: not a token of this password (a new ADMIN_PASSWORD, or garbage).
test("admin: a 401 carries code expired, revoked or invalid", async () => {
  const d = testDeps({ now: NOW, env });
  const get = (token) => handle(request("/api/admin/items", { headers: { Authorization: "Bearer " + token } }), PRODUCTION, d).then(read);
  const short = makeToken(PASSWORD, d.clock.now(), 3600e3);
  const old = makeToken(PASSWORD, d.clock.now());
  d.clock.advance(2 * 3600e3);
  let r = await get(short);
  assert.deepEqual([r.status, r.body.code], [401, "expired"]);
  d.blobs.seed("bookings", "auth/epoch", { t: d.clock.now() });
  r = await get(old);
  assert.deepEqual([r.status, r.body.code], [401, "revoked"]);
  r = await get(makeToken("another-password", d.clock.now()));
  assert.deepEqual([r.status, r.body.code], [401, "invalid"]);
  r = await get("garbage");
  assert.deepEqual([r.status, r.body.code], [401, "invalid"]);
  assert.equal((await get(makeToken(PASSWORD, d.clock.now()))).status, 200);
});

// ---------- Fix-up round 2: a refused attempt creates no state (retention-load.mjs) ----------
// Refused logins used to take a hit and give it back, leaving an empty counter document per client; 600 cheap
// requests from 600 /64s left 600 documents for the 30-s daily clean-up. Abuse-suite rule: a refused request
// (any 429) leaves zero new keys and writes nothing; a successful login leaves no document for its client.
const writes = (d, from) => d.blobs.log.slice(from).filter((e) => e.method === "PUT" || e.method === "DELETE");
test("admin login abuse: a refused attempt (429, the client cap) writes nothing and leaves zero new keys", async () => {
  const d = testDeps({ now: NOW, env });
  for (let i = 0; i < 10; i++) assert.equal((await tryLogin(d, "nope" + i, "203.0.113.20")).status, 401);
  const keys = JSON.stringify(d.blobs.keys("bookings"));
  const from = d.blobs.log.length;
  for (let i = 0; i < 5; i++) assert.equal((await tryLogin(d, "nope", "203.0.113.20")).status, 429);
  assert.deepEqual(writes(d, from), []);
  assert.equal(JSON.stringify(d.blobs.keys("bookings")), keys);
});
test("admin login abuse: 600 wrong logins from 600 /64s leave only the counted attempts' documents, none empty", async () => {
  const d = testDeps({ now: NOW, env });
  const st = {};
  for (let i = 0; i < 600; i++) {
    const r = await tryLogin(d, "gjett" + i, `2001:db8:77:${i.toString(16)}::1`);
    st[r.status] = (st[r.status] || 0) + 1;
    if (i % 50 === 49) d.clock.advance(60e3);
  }
  assert.deepEqual(st, { 401: 100, 429: 500 });
  // Round 3 (SPEC R44): no document per client any more. The 100 counted attempts sit in the fixed set of login
  // buckets, one hit each; the 500 refused ones left nothing.
  const docs = d.blobs.keys("bookings").filter((k) => k.startsWith("rl/") && !["rl/secret", "rl/login/all"].includes(k));
  assert.ok(docs.length <= BUCKETS && docs.every((k) => /^rl\/b\/login\/ip\/[0-9a-f]$/.test(k)), docs.join(" "));
  assert.equal(docs.reduce((n, k) => n + d.blobs.json("bookings", k).hits.length, 0), 100, "one hit per counted attempt, none for a refused one");
  assert.equal(hitCount(d, "rl/login/all"), 100);
});
test("admin login abuse: a successful login gives its hit back and leaves no document of its own", async () => {
  const d = testDeps({ now: NOW, env });
  assert.equal((await tryLogin(d, PASSWORD, "203.0.113.21")).status, 200);
  const ref = await loginKey(d, "203.0.113.21");
  assert.equal(hitCount(d, ref), 0);
  assert.deepEqual(d.blobs.keys("bookings").filter((k) => k.startsWith("rl/") && k !== ref.key), ["rl/login/all", "rl/secret"], "only its bucket, the shared counter and the secret");
});
