// /admin saves that are still on their way while the barber closes the sheet and opens another (F27, RC2): each
// save keeps its own target and body from the moment Lagre was tapped. A 409 question names that booking and its
// forced retry sends that same body; an error for a closed sheet becomes an alert naming the booking; a late
// answer never closes or writes into a different sheet. A new booking carries a requestId (SPEC R1), the same one
// when the same sheet is saved again after a lost answer, and a new one when something was changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin, itemsRoute, held, netFail } from "../helpers/admin-page.mjs";
import { item } from "../fixtures/admin-days.mjs";

const DAY = "2026-11-19";
const nils = item(DAY, 720, 30, { name: "Nils", phone: "400 00 002" });
const CLASH = { status: 409, body: { error: "Tidspunktet er allerede booket." } };
const REQ = /^[A-Za-z0-9_-]{8,64}$/;

async function aliPendingThenNils({ confirm = () => true } = {}) {
  const post = held();
  const page = await loadAdmin({ now: DAY + "T09:00", confirm, routes: {
    "GET /api/admin/items": itemsRoute([nils]),
    "POST /api/admin/items": post.route,
    [`PATCH /api/admin/items/${encodeURIComponent(nils.id)}`]: () => { throw new Error("Nils must not be changed"); },
  } });
  page.$("add").click();
  page.field("service").value = "Herreklipp";
  page.field("name").value = "Ali";
  page.field("start").value = "11:00";
  page.submit();
  await page.flush();
  assert.equal(post.pending(), 1, "Ali's POST is on its way");
  page.$("cancel-edit").click();
  page.tap("timeline", `[data-id="${nils.id}"] button.item-open`);
  page.field("note").value = "Nils-notat";
  assert.equal(page.$("save").disabled, false, "Nils's Lagre is usable while Ali's save is pending");
  return { page, post };
}
const posts = (page) => page.calls.filter((c) => c.method === "POST" && c.path === "/api/admin/items");
const nilsStillOpen = (page) => {
  assert.equal(page.$("editor").open, true, "Nils's sheet is still open");
  assert.equal(page.field("name").value, "Nils");
  assert.equal(page.field("note").value, "Nils-notat");
};

test("pending F27: a 409 for Ali after Nils's sheet was opened asks about Ali, and the forced retry is Ali's own body", async () => {
  const { page, post } = await aliPendingThenNils();
  post.release(CLASH);
  await page.flush();
  assert.equal(page.confirms.length, 1);
  assert.equal(page.confirms[0], "Ali 11:00: Tidspunktet er allerede booket.\n\nVil du lagre likevel (dobbeltbooking)?");
  assert.equal(post.pending(), 1, "the forced retry is on its way");
  const [first, retry] = posts(page);
  assert.equal(retry.url, "/api/admin/items?force=1");
  assert.deepEqual(retry.body, first.body, "Ali's body, not Nils's form");
  assert.equal(retry.body.name, "Ali");
  assert.match(retry.body.requestId, REQ);
  assert.equal(page.calls.filter((c) => c.method === "PATCH").length, 0, "Nils gets no PATCH");
  post.release({ status: 201, body: { ok: true, item: {} } });
  await page.flush();
  nilsStillOpen(page);
});

test("pending F27: a 500 for Ali after his sheet was closed is an alert naming Ali; Nils's sheet is untouched", async () => {
  const { page, post } = await aliPendingThenNils();
  post.release({ status: 500, body: { error: "Noe gikk galt på serveren." } });
  await page.flush();
  assert.equal(page.alerts.length, 1);
  assert.match(page.alerts[0], /^Ble ikke lagret \(Ali\): Noe gikk galt på serveren\./);
  assert.equal(page.$("edit-msg").textContent, "", "nothing written into Nils's sheet");
  nilsStillOpen(page);
});

test("pending F27: a late 201 for Ali never closes Nils's sheet", async () => {
  const { page, post } = await aliPendingThenNils();
  post.release({ status: 201, body: { ok: true, item: {} } });
  await page.flush();
  nilsStillOpen(page);
  assert.equal(page.$("save").disabled, false);
  assert.deepEqual(page.alerts, []);
});

test("pending F27: answering Avbryt to Ali's 409 tells about Ali, not in Nils's sheet", async () => {
  const { page, post } = await aliPendingThenNils({ confirm: () => false });
  post.release(CLASH);
  await page.flush();
  assert.equal(posts(page).length, 1, "no retry");
  assert.match(page.alerts[0], /^Ble ikke lagret \(Ali\): Tidspunktet er allerede booket\./);
  nilsStillOpen(page);
});

test("R1: a new booking carries a requestId; Lagre again after a lost answer sends the same one, a changed booking a new one", async () => {
  let fail = true;
  const page = await loadAdmin({ now: DAY + "T09:00", routes: {
    "GET /api/admin/items": itemsRoute([]),
    "POST /api/admin/items": (c) => (fail ? netFail("Load failed")(c) : { status: 201, body: { ok: true, item: {} } }),
  } });
  page.$("add").click();
  page.field("service").value = "Herreklipp";
  page.field("name").value = "Ali";
  page.submit();
  await page.flush();
  page.submit();
  await page.flush();
  page.field("start").value = "15:00";
  fail = false;
  page.submit();
  await page.flush();
  const ids = posts(page).map((c) => c.body.requestId);
  assert.equal(ids.length, 3);
  ids.forEach((id) => assert.match(id, REQ));
  assert.equal(ids[1], ids[0], "the same booking again: the same requestId (the server stores it once)");
  assert.notEqual(ids[2], ids[0], "a changed booking: a new requestId");
  page.$("add").click();
  page.field("service").value = "Herreklipp";
  page.field("name").value = "Ali";
  page.field("start").value = "15:00";
  page.submit();
  await page.flush();
  assert.notEqual(posts(page)[3].body.requestId, ids[2], "a new sheet is a new booking");
});
