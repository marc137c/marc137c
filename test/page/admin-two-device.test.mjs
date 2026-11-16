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

// X1.3: moved to another month (its id changed) or deleted on the other device
const GONE_SAVE = "Avtalen er flyttet eller slettet fra en annen enhet, så endringen ble ikke lagret. Listen oppdateres nå.";
const GONE_DELETE = "Avtalen er flyttet eller slettet fra en annen enhet, så den ble ikke slettet her. Listen oppdateres nå.";
const NOT_FOUND = { status: 404, body: { error: "Fant ikke avtalen." } };

test("two devices X1.3: a 404 on Lagre closes the sheet, reloads and says the booking was moved or deleted elsewhere", async () => {
  const page = await setup(() => NOT_FOUND);
  page.field("note").value = "ny";
  const before = gets(page);
  page.submit();
  await page.flush();
  assert.deepEqual(page.alerts, [GONE_SAVE]);
  assert.equal(page.$("editor").open, false);
  assert.ok(gets(page) > before, "the list is fetched again");
  assert.deepEqual(page.confirms, []);
});

test("two devices X1.3: a 404 on Slett says the same, and the stale card is gone after the reload", async () => {
  const list = [kari()];
  const page = await loadAdmin({ now: DAY + "T09:00", routes: {
    "GET /api/admin/items": itemsRoute(() => list),
    [`DELETE /api/admin/items/${encodeURIComponent(list[0].id)}`]: () => { list.length = 0; return NOT_FOUND; },
  } });
  page.tap("timeline", `[data-id="${list[0].id}"] button.item-open`);
  page.$("delete").click();
  await page.flush();
  assert.equal(page.confirms.length, 1, "the delete confirm");
  assert.deepEqual(page.alerts, [GONE_DELETE]);
  assert.equal(page.$("editor").open, false);
  assert.doesNotMatch(page.$("timeline").innerHTML, /Kari/);
});

// Round 2: Slett carries the same precondition as Lagre (SPEC R3): ?expect=<updatedAt as this device saw it>.
// A booking moved on the other device since is never deleted from a stale sheet.
test("two devices X1.1: Slett sends expect=updatedAt; a 412 closes the sheet, reloads and says why, and deletes nothing", async () => {
  const list = [kari()];
  const page = await loadAdmin({ now: DAY + "T09:00", routes: {
    "GET /api/admin/items": itemsRoute(() => list),
    [`DELETE /api/admin/items/${encodeURIComponent(list[0].id)}`]: () => STALE_BODY,
  } });
  page.tap("timeline", `[data-id="${list[0].id}"] button.item-open`);
  const before = gets(page);
  page.$("delete").click();
  await page.flush();
  const del = page.calls.filter((c) => c.method === "DELETE");
  assert.equal(del.length, 1);
  assert.equal(del[0].url, `/api/admin/items/${encodeURIComponent(list[0].id)}?expect=${encodeURIComponent(U1)}`);
  assert.deepEqual(page.alerts, ["Avtalen er endret på en annen enhet, så den ble ikke slettet. Listen oppdateres nå."]);
  assert.equal(page.$("editor").open, false);
  assert.ok(gets(page) > before, "the list is fetched again");
});

test("two devices X1.1: every mutating request sent from an existing booking's sheet carries expect", async () => {
  const list = [kari()];
  const page = await loadAdmin({ now: DAY + "T09:00", confirm: () => true, routes: {
    "GET /api/admin/items": itemsRoute(() => list),
    [`PATCH /api/admin/items/${encodeURIComponent(list[0].id)}`]: () => ({ ok: true, item: {} }),
    [`DELETE /api/admin/items/${encodeURIComponent(list[0].id)}`]: () => ({ ok: true }),
  } });
  page.tap("timeline", `[data-id="${list[0].id}"] button.item-open`);
  page.field("note").value = "ny";
  page.submit();
  await page.flush();
  page.tap("timeline", `[data-id="${list[0].id}"] button.item-open`);
  page.$("delete").click();
  await page.flush();
  const mutating = page.calls.filter((c) => c.method !== "GET" && c.path.indexOf("/api/admin/items/") === 0);
  assert.deepEqual(mutating.map((c) => c.method), ["PATCH", "DELETE"]);
  for (const c of mutating) {
    const sent = c.method === "PATCH" ? c.body.expect : new URL(c.url, "https://x").searchParams.get("expect");
    assert.equal(sent, U1, `${c.method} carries expect`);
  }
});
