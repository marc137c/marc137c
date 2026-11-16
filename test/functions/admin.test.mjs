// /api/admin/* through handle(req, context, deps): the password comes from deps.env, the clock from deps.now,
// the store from deps.getStore (production or the preview store, F10). Nothing here uses process.env, the real
// clock or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION, PREVIEW } from "../helpers/deps.mjs";
import { item, seedItems, storedItems, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { FakeBlobs } from "../helpers/fake-blobs.mjs";
import { FakeClock } from "../helpers/clock.mjs";
import { makeToken, makeDeviceMark, verifyDeviceMark } from "../../netlify/lib/booking-core.mjs";
import { counterKey, limiterSecret, clientKey } from "../../netlify/lib/limits.mjs";
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
  const ipKey = counterKey(await limiterSecret(d.getStore({ name: "bookings", consistency: "strong" })), "login/ip", "203.0.113.9");
  assert.deepEqual(d.blobs.json("bookings", ipKey).hits.map((h) => h.t), [before]);
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
const loginKey = async (d, ip) => counterKey(await limiterSecret(live(d)), "login/ip", clientKey(ip));
const hitCount = (d, key) => (d.blobs.json("bookings", key) || { hits: [] }).hits.length;
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
