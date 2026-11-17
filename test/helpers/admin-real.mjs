// The /admin page (admin-page.mjs, the real admin.js in a fake DOM) wired to the REAL admin handler
// (netlify/functions/admin.mjs) on FakeBlobs, so a page test sees what the server really answers: 412 for a stale
// expect, 404 for a booking that is gone, the cancel-phone reply. Nothing leaves the process.
//
//   const s = await realServer();                 // its own FakeBlobs and FakeClock (2026-11-19 09:00 Oslo)
//   const t = await s.login();                    // a 60-day token ({ remember: false } for 12 h)
//   const ali = await s.web({ start: 660, name: "Ali", phone: "911 22 333" });   // a web booking, stored for real
//   const page = await loadRealAdmin({ token: t, routes: { "GET /api/admin/items": s.route, … } });
//   s.route forwards one page call to the handler (query, body and Authorization kept; a write 1 s after the last);
//   s.call(path, opts) is the same for the test itself; s.items(t) lists the stored bookings of the day;
//   s.deps.clock.advance(ms) moves time.
// The handler's store calls take more promise turns than the harness's flush() waits for, so loadRealAdmin's
// flush() and advance() wait longer.
import { loadAdmin } from "./admin-page.mjs";
import { testDeps, request, PRODUCTION } from "./deps.mjs";
import { handle } from "../../netlify/functions/admin.mjs";
import { createItem } from "../../netlify/lib/booking-core.mjs";

export const PASSWORD = "riktig-passord-123";
export const DAY = "2026-11-19";

export async function realServer(now = "2026-11-19T08:00:00.000Z") {
  const deps = testDeps({ env: { ADMIN_PASSWORD: PASSWORD }, now });
  const call = async (path, { method = "GET", json, token } = {}) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await handle(request(path, { method, json, headers }), PRODUCTION, deps);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  };
  const login = async ({ remember = true } = {}) => (await call("/api/admin/login", { method: "POST", json: { password: PASSWORD, remember } })).body.token;
  // Every write from the page reaches the server one second after the last, so each stored version gets its own
  // updatedAt, as it would on a real phone (with a clock that never moves, a stale expect would still match)
  const route = (c) => {
    if (c.method !== "GET") deps.clock.advance(1000);
    const auth = c.headers && c.headers.Authorization;
    return call(c.url, { method: c.method, json: c.body, token: auth ? String(auth).replace(/^Bearer\s+/, "") : undefined });
  };
  const store = deps.getStore({ name: "bookings", consistency: "strong" });
  // A booking made on the website (source «nettside»), stored the way bookings.mjs stores it
  const web = async (fields) => (await createItem(store, Object.assign({ date: DAY, dur: 30, service: "Herreklipp", addons: [] }, fields), { source: "nettside", now: deps.now() })).item;
  const items = async (token, day = DAY) => (await call(`/api/admin/items?from=${day}&to=${day}`, { token })).body.items;
  return { deps, call, login, route, web, items };
}

export async function loadRealAdmin(opts) {
  const page = await loadAdmin(opts);
  const flush = page.flush, advance = page.advance;
  page.flush = async () => { for (let i = 0; i < 40; i++) await flush(); };
  page.advance = async (ms) => { await advance(ms); await page.flush(); };
  await page.flush();
  return page;
}
