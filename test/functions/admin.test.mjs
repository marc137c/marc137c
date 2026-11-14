// /api/admin/* through handle(req, context, deps): the password comes from deps.env, the clock from deps.now,
// the store from deps.getStore (production or the preview store, F10). Nothing here uses process.env, the real
// clock or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, PRODUCTION, PREVIEW } from "../helpers/deps.mjs";
import { item, seedItems, storedItems, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { makeToken } from "../../netlify/lib/booking-core.mjs";
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
  assert.equal(d.blobs.json("bookings", "auth/ip/203.0.113.9").n, 1);
  assert.equal(d.blobs.json("bookings", "auth/all").start, before);
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
