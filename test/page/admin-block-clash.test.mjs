// /admin: blocking time over existing bookings (X2.3, barber workflow 'block a vacation'). The server answers 409;
// the question lists the customers ('HH:MM navn telefon') and says plainly that the block cancels nothing and
// nobody is told: call them and tick «Avlyst». No 'dobbeltbooking' wording. Avbryt says the time can still be
// booked online.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin, itemsRoute } from "../helpers/admin-page.mjs";
import { item } from "../fixtures/admin-days.mjs";

const DAY = "2026-11-19", NEXT = "2026-11-26";
const list = [
  item(DAY, 660, 30, { name: "Kunde A", phone: "400 00 010" }),
  item(DAY, 780, 60, { name: "Kunde B", phone: "400 00 011" }),
  item(DAY, 840, 30, { name: "Avlyst C", phone: "400 00 012", status: "cancelled" }),
  item(NEXT, 900, 30, { name: "Neste uke", phone: "400 00 013" }),
];
const CLASH = { status: 409, body: { error: "Tidspunktet er allerede booket." } };
const SAY = "Blokkeringen avlyser dem ikke, og kundene får ingen beskjed. Ring dem og huk av «Avlyst». Lagre blokkeringen likevel?";

async function blockDay({ answer, date }) {
  const page = await loadAdmin({ now: DAY + "T09:00", confirm: () => answer, routes: {
    "GET /api/admin/items": itemsRoute(list),
    "POST /api/admin/items": (c) => (c.url.includes("force=1") ? { status: 201, body: { ok: true, item: {} } } : CLASH),
  } });
  page.$("block").click();
  if (date) page.field("date").value = date;
  page.field("note").value = "Ferie";
  page.submit();
  await page.flush();
  return page;
}
const posts = (page) => page.calls.filter((c) => c.method === "POST" && c.path === "/api/admin/items");

test("block clash X2.3: the question lists the customers under the block and says the block cancels nothing", async () => {
  const page = await blockDay({ answer: true });
  assert.equal(page.confirms.length, 1);
  assert.equal(page.confirms[0], `2 kunder har time her:\n11:00 Kunde A 400 00 010\n13:00 Kunde B 400 00 011\n\n${SAY}`);
  assert.doesNotMatch(page.confirms[0], /dobbeltbooking|Avlyst C/);
  assert.deepEqual(posts(page).map((c) => c.url), ["/api/admin/items", "/api/admin/items?force=1"]);
  assert.deepEqual(posts(page)[1].body, posts(page)[0].body, "the same block is saved");
  assert.equal(page.$("editor").open, false);
});

test("block clash X2.3: Avbryt saves nothing and says the time can still be booked online", async () => {
  const page = await blockDay({ answer: false });
  assert.equal(posts(page).length, 1);
  assert.equal(page.$("edit-msg").textContent, "Ikke lagret – tiden kan fortsatt bestilles på nett.");
  assert.equal(page.$("editor").open, true);
});

test("block clash X2.3: a block on a day that is not on screen fetches that day to name its customers", async () => {
  const page = await blockDay({ answer: false, date: NEXT });
  assert.ok(page.calls.some((c) => c.url === `/api/admin/items?from=${NEXT}&to=${NEXT}`));
  assert.equal(page.confirms[0], `1 kunde har time her:\n15:00 Neste uke 400 00 013\n\n${SAY}`);
});

test("block clash X2.3: a booking (not a block) keeps the dobbeltbooking question", async () => {
  const page = await loadAdmin({ now: DAY + "T09:00", confirm: () => false, routes: { "GET /api/admin/items": itemsRoute(list), "POST /api/admin/items": () => CLASH } });
  page.$("add").click();
  page.field("service").value = "Herreklipp";
  page.field("name").value = "Ny";
  page.field("start").value = "11:00";
  page.submit();
  await page.flush();
  assert.match(page.confirms[0], /^Ny 11:00: Tidspunktet er allerede booket\.\n\nVil du lagre likevel \(dobbeltbooking\)\?$/);
});
