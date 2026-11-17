// /admin after a flood of fake web bookings from one number (X2.4): the delete question names the phone, and a web
// booking's sheet offers 'Avlys alle nettbestillinger fra <phone> (N)' when that number has two or more web
// bookings from today on. It asks first (naming the number and the count), then calls POST /api/admin/cancel-phone,
// which cancels only web bookings from today on, whatever the number's spacing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin, itemsRoute } from "../helpers/admin-page.mjs";
import { item } from "../fixtures/admin-days.mjs";

const DAY = "2026-11-19";
const web = (date, start, phone, extra = {}) => item(date, start, 30, { name: "Falsk", phone, source: "nettside", ...extra });
const list = [
  web(DAY, 600, "400 00 000"), web(DAY, 630, "+47 400 00 000"), web("2026-12-03", 700, "40000000"),
  web("2026-11-18", 600, "400 00 000"), // yesterday: not counted
  web("2026-12-04", 600, "400 00 000", { status: "cancelled" }), // already cancelled: not counted
  item(DAY, 720, 30, { name: "Ekte", phone: "400 00 000", source: "admin" }), // entered by the barber: not counted
  web(DAY, 780, "911 22 333", { name: "Ola" }),
];

async function openCard(id, { confirm = () => true, cancel = () => ({ ok: true, cancelled: 3 }) } = {}) {
  const page = await loadAdmin({ now: DAY + "T09:00", confirm, routes: { "GET /api/admin/items": itemsRoute(list), "POST /api/admin/cancel-phone": cancel, [`DELETE /api/admin/items/${encodeURIComponent(id)}`]: () => ({ ok: true }) } });
  page.tap("timeline", `[data-id="${id}"] button.item-open`);
  await page.flush();
  return page;
}

test("cancel-phone X2.4: the delete question names the phone number", async () => {
  const page = await openCard(list[6].id, { confirm: () => false });
  page.$("delete").click();
  assert.match(page.confirms[0], /^Slette avtalen med Ola \(911 22 333\) 19\. november kl\. 13:00 for godt\?/);
});

test("cancel-phone X2.4: a web booking whose number has 3 web bookings from today on offers to cancel all of them", async () => {
  const page = await openCard(list[0].id);
  const b = page.$("cancel-phone");
  assert.equal(b.hidden, false);
  assert.equal(b.textContent, "Avlys alle nettbestillinger fra 400 00 000 (3)");
  b.click();
  await page.flush();
  assert.match(page.confirms[0], /^Avlyse alle 3 nettbestillingene fra 400 00 000 fra i dag og fremover\?/);
  assert.match(page.confirms[0], /Kundene får ingen beskjed\./);
  const post = page.calls.find((c) => c.path === "/api/admin/cancel-phone");
  // requestId: the tap's idempotency key (SPEC R1, test/page/admin-retry-key.test.mjs)
  assert.deepEqual(Object.keys(post.body).sort(), ["phone", "requestId"]);
  assert.equal(post.body.phone, "400 00 000");
  assert.match(post.body.requestId, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(post.method, "POST");
  assert.deepEqual(page.alerts, ["3 nettbestillinger fra 400 00 000 er avlyst. Kundene har ikke fått beskjed."]);
  assert.equal(page.$("editor").open, false);
});

test("cancel-phone X2.4: Avbryt sends nothing; a number with one web booking, and an admin booking, get no button", async () => {
  const page = await openCard(list[0].id, { confirm: () => false });
  page.$("cancel-phone").click();
  await page.flush();
  assert.equal(page.calls.filter((c) => c.path === "/api/admin/cancel-phone").length, 0);
  for (const id of [list[6].id, list[5].id]) {
    const p = await openCard(id);
    assert.equal(p.$("cancel-phone").hidden, true, id);
  }
});

test("cancel-phone X2.4: a failure is shown in the sheet in Norwegian", async () => {
  const page = await openCard(list[0].id, { cancel: () => { throw new TypeError("Load failed"); } });
  page.$("cancel-phone").click();
  await page.flush();
  assert.match(page.$("edit-msg").textContent, /^Ingen forbindelse/);
  assert.equal(page.$("editor").open, true);
});
