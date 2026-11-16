// /admin when the login runs out in the middle of an edit (F28, RC5): the login page shows (no modal left over
// it), and after logging in again the sheet comes back with what the barber typed, saying 'Du er logget inn igjen
// – trykk Lagre.'. The next Lagre sends the same change with the new token. Oppsett never comes back by itself:
// it holds the calendar link's secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin, itemsRoute } from "../helpers/admin-page.mjs";
import { item } from "../fixtures/admin-days.mjs";

const DAY = "2026-11-19";
const kari = item(DAY, 660, 30, { name: "Kari", updatedAt: "2026-11-18T10:00:00.000Z" });
const EXPIRED = { status: 401, body: { error: "Logg inn på nytt." } };
const BACK = "Du er logget inn igjen – trykk Lagre.";

async function setup({ patch, items }) {
  const page = await loadAdmin({ now: DAY + "T09:00", routes: {
    "GET /api/admin/items": items,
    [`PATCH /api/admin/items/${encodeURIComponent(kari.id)}`]: patch,
    "POST /api/admin/login": () => ({ token: "new", expiresIn: 43200000, device: "dev-mark" }),
    "GET /api/admin/calendar": () => EXPIRED,
    "GET /api/admin/push": () => ({ publicKey: "x", devices: 0 }),
  } });
  page.tap("timeline", `[data-id="${kari.id}"] button.item-open`);
  page.field("note").value = "Ringer hvis forsinket";
  return page;
}
async function logIn(page) {
  assert.equal(page.$("login").hidden, false, "the login page shows");
  assert.equal(page.$("editor").open, false, "no sheet over it");
  page.$("pw").value = "riktig";
  page.submit("login-form");
  await page.flush();
  assert.equal(page.$("app").hidden, false);
}
const patches = (page) => page.calls.filter((c) => c.method === "PATCH");

test("session F28: a 401 on Lagre, then logging in, brings the sheet back; Lagre sends the same change with the new token", async () => {
  let n = 0;
  const good = itemsRoute([kari]);
  const page = await setup({ items: good, patch: () => (++n === 1 ? EXPIRED : { ok: true, item: {} }) });
  page.submit();
  await page.flush();
  await logIn(page);
  assert.equal(page.$("editor").open, true, "the sheet is back");
  assert.equal(page.$("edit-msg").textContent, BACK);
  assert.equal(page.field("note").value, "Ringer hvis forsinket");
  page.submit();
  await page.flush();
  const [first, second] = patches(page);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.headers.Authorization, "Bearer new");
  assert.equal(page.$("editor").open, false, "saved");
});

test("session F28: a 401 from the list fetched when the tab comes back, while typing, also brings the sheet back", async () => {
  let expired = false;
  const good = itemsRoute([kari]);
  const page = await setup({ items: (c) => (expired ? EXPIRED : good(c)), patch: () => ({ ok: true, item: {} }) });
  expired = true;
  page.wake();
  await page.flush();
  expired = false;
  await logIn(page);
  assert.equal(page.$("editor").open, true);
  assert.equal(page.$("edit-msg").textContent, BACK);
  page.submit();
  await page.flush();
  assert.deepEqual(patches(page).map((c) => [c.body, c.headers.Authorization]), [[{ note: "Ringer hvis forsinket", expect: kari.updatedAt }, "Bearer new"]]);
});

test("session F28: Oppsett never comes back by itself after a new login (it holds the calendar secret)", async () => {
  const page = await setup({ items: itemsRoute([kari]), patch: () => ({ ok: true, item: {} }) });
  page.$("cancel-edit").click();
  page.$("settings-open").click();
  await page.flush();
  await logIn(page);
  assert.equal(page.$("settings").open, false);
  assert.equal(page.$("editor").open, false, "and the editor, closed before, stays closed");
});
