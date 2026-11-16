// /admin open on two devices (X1.1, X1.2, X1.3; SPEC R3): a change sends only the fields the barber changed, plus
// expect = the booking's updatedAt as this device saw it. A booking changed elsewhere since (412 stale) or moved or
// deleted elsewhere (404) is never overwritten: the sheet closes, the list reloads, and an alert says why, with
// no 'dobbeltbooking' question. A sheet left open while the booking changes elsewhere says so when the page wakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin, itemsRoute } from "../helpers/admin-page.mjs";
import { item } from "../fixtures/admin-days.mjs";

const DAY = "2026-11-19";
const U1 = "2026-11-18T10:00:00.000Z", U2 = "2026-11-19T08:55:00.000Z";
const kari = () => item(DAY, 660, 30, { name: "Kari", phone: "400 00 001", note: "", updatedAt: U1 });
const STALE = "Avtalen er endret på en annen enhet, så endringen ble ikke lagret. Listen oppdateres nå.";
const STALE_BODY = { status: 412, body: { error: "Avtalen er endret på en annen enhet. Lukk og åpne den på nytt.", code: "stale" } };

async function setup(patch, list = [kari()]) {
  const page = await loadAdmin({ now: DAY + "T09:00", routes: { "GET /api/admin/items": itemsRoute(() => list), [`PATCH /api/admin/items/${encodeURIComponent(list[0].id)}`]: patch } });
  page.tap("timeline", `[data-id="${list[0].id}"] button.item-open`);
  assert.equal(page.$("editor").open, true);
  return page;
}
const patches = (page) => page.calls.filter((c) => c.method === "PATCH");
const gets = (page) => page.calls.filter((c) => c.method === "GET" && c.path === "/api/admin/items").length;

test("two devices X1.2: a PATCH sends only the changed fields plus expect=updatedAt", async () => {
  const page = await setup(() => ({ ok: true, item: {} }));
  page.field("start").value = "11:30";
  page.field("note").value = "Kommer litt senere";
  page.submit();
  await page.flush();
  assert.deepEqual(patches(page).map((c) => c.body), [{ start: 690, note: "Kommer litt senere", expect: U1 }]);
  assert.equal(page.$("editor").open, false);
});

test("two devices X1.2: Lagre with nothing changed sends nothing and just closes", async () => {
  const page = await setup(() => { throw new Error("no PATCH expected"); });
  page.submit();
  await page.flush();
  assert.equal(patches(page).length, 0);
  assert.equal(page.$("editor").open, false);
});

test("two devices X1.1: a 412 stale closes the sheet, reloads and says why, with no dobbeltbooking question", async () => {
  const page = await setup(() => STALE_BODY);
  page.field("note").value = "ny";
  const before = gets(page);
  page.submit();
  await page.flush();
  assert.deepEqual(page.confirms, [], "no confirm()");
  assert.deepEqual(page.alerts, [STALE]);
  assert.equal(page.$("editor").open, false);
  assert.ok(gets(page) > before, "the list is fetched again");
  assert.equal(patches(page).length, 1, "and nothing is retried");
});

test("two devices X1.2: waking with the sheet open after the booking changed elsewhere says so; the PATCH is exactly {note, expect}", async () => {
  const list = [kari()];
  const page = await setup(() => STALE_BODY, list);
  // The other device cancels Kari while this tab is in the background
  list[0] = Object.assign({}, list[0], { status: "cancelled", updatedAt: U2 });
  page.wake();
  await page.flush();
  assert.equal(page.$("edit-msg").textContent, "Avtalen er endret et annet sted – lukk og åpne den på nytt.");
  assert.equal(page.$("editor").open, true, "what the barber typed is still there");
  page.field("note").value = "ringte";
  page.submit();
  await page.flush();
  assert.deepEqual(patches(page)[0].body, { note: "ringte", expect: U1 }, "never the whole form (it would undo the cancel)");
  assert.deepEqual(page.alerts, [STALE]);
});

test("two devices X1.2: a booking stored before versions existed (no updatedAt) is changed without expect", async () => {
  const old = Object.assign(kari(), { updatedAt: undefined });
  delete old.updatedAt;
  const page = await setup(() => ({ ok: true, item: {} }), [old]);
  page.field("note").value = "x";
  page.submit();
  await page.flush();
  assert.deepEqual(patches(page)[0].body, { note: "x" });
});
