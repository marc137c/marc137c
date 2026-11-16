// /admin device mark (F5, client side): the login answer's device mark is kept under its own localStorage key and
// sent with every later login, so the barber's own phone gets in even while strangers have filled the site-wide
// login limit. It stays on «Logg ut» (it is not a login), and a browser that cannot store anything still logs in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin } from "../helpers/admin-page.mjs";

const KEY = "viggo-admin-device";
const login = (device) => () => ({ token: "t-" + Math.random().toString(36).slice(2), expiresIn: 43200000, ...(device ? { device } : {}) });
async function logIn(page) {
  page.$("pw").value = "riktig";
  page.submit("login-form");
  await page.flush();
}
const bodies = (page) => page.calls.filter((c) => c.path === "/api/admin/login").map((c) => c.body);

test("device F5: the mark from a login is stored under its own key and sent with the next login", async () => {
  const page = await loadAdmin({ token: null, routes: { "POST /api/admin/login": login("mark-1") } });
  await logIn(page);
  assert.equal(page.local.getItem(KEY), "mark-1");
  assert.equal(bodies(page)[0].device, undefined, "nothing to send the first time");
  const next = await loadAdmin({ token: null, storage: { [KEY]: "mark-1" }, routes: { "POST /api/admin/login": login("mark-2") } });
  await logIn(next);
  assert.equal(bodies(next)[0].device, "mark-1");
  assert.equal(next.local.getItem(KEY), "mark-2", "a fresh mark replaces it");
});

test("device F5: «Logg ut» keeps the mark (and drops the login)", async () => {
  const page = await loadAdmin({ storage: { [KEY]: "mark-1" }, routes: { "GET /api/admin/calendar": () => ({ enabled: false }), "GET /api/admin/push": () => ({ publicKey: "x", devices: 0 }) } });
  page.$("settings-open").click();
  await page.flush();
  page.$("logout").click();
  await page.flush();
  assert.equal(page.$("login").hidden, false);
  assert.equal(page.local.getItem("viggo-admin-token"), null);
  assert.equal(page.local.getItem(KEY), "mark-1");
});

test("device F5: an answer without a mark keeps the old one; a browser that cannot store still logs in", async () => {
  const page = await loadAdmin({ token: null, storage: { [KEY]: "mark-1" }, routes: { "POST /api/admin/login": login(null) } });
  await logIn(page);
  assert.equal(page.local.getItem(KEY), "mark-1");
  const broken = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceededError"); }, removeItem() { throw new Error("SecurityError"); } };
  const priv = await loadAdmin({ token: null, globals: { localStorage: broken, sessionStorage: broken }, routes: { "POST /api/admin/login": login("mark-9") } });
  await logIn(priv);
  assert.equal(priv.$("app").hidden, false, "logged in");
  assert.equal(bodies(priv)[0].device, undefined);
});
