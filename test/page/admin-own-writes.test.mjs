// /admin never blames «another device» for what this device did itself (round 3, still_open 10 and 11; SPEC R39).
// Real admin handler on FakeBlobs (test/helpers/admin-real.mjs), so every 412 and 404 here is the server's own answer.
// Root cause: «the request belongs to the booking it is about» was written into a few branches only. A sheet reopened
// for the same booking could start a second write while the first was on its way; its expect was then made stale by
// this device's own first write, and the 412 or 404 was reported as «endret/slettet på en annen enhet». After an
// expired login the reopened sheet said «trykk Lagre» with Slett greyed out.
// Rule: while a write from this device for a booking is on its way, every sheet for that booking (the one it was
// started in, or one reopened) has Lagre, Slett and «Avlys alle» locked and says what is on its way; a reopened sheet
// shows what is being saved. The answer is written in that sheet (closed on success), a 401 brings it back naming the
// interrupted action with its control usable. A write whose answer never came (lost reply) may have changed the
// booking: a later 412 or 404 for it says so, never «en annen enhet».
// Matrix: first control × (the same sheet | the booking reopened) × second control, then the second control after the
// first has landed; and the lost-reply column.
import { test } from "node:test";
import assert from "node:assert/strict";
import { held } from "../helpers/admin-page.mjs";
import { realServer, loadRealAdmin, DAY } from "../helpers/admin-real.mjs";

const BLAME = /annen enhet|annet sted/;
const PHONE = "911 22 333";
const said = (page) => [page.$("edit-msg").textContent].concat(page.alerts).join(" | ");
const enc = encodeURIComponent;
const CONTROLS = {
  "Lagre": { id: "save", route: (ali) => `PATCH /api/admin/items/${enc(ali.id)}`, start: (page, n) => { page.field("note").value = "Notat " + n; page.submit(); } },
  "Slett": { id: "delete", route: (ali) => `DELETE /api/admin/items/${enc(ali.id)}`, start: (page) => page.$("delete").click() },
  "Avlys alle": { id: "cancel-phone", route: () => "POST /api/admin/cancel-phone", start: (page) => page.$("cancel-phone").click() },
};
const BUSY = { "Lagre": "Lagrer …", "Slett": "Sletter …", "Avlys alle": "Avlyser …" };
const sent = (page, route) => page.calls.filter((c) => `${c.method} ${c.path}` === route).length;

// Ali has two web bookings from one number (so «Avlys alle nettbestillinger» shows); the first control's request
// waits for the test: release("go") lets it reach the server, release("lost") too but its reply never arrives,
// fail() drops it before the server.
async function setup(first, { login = {} } = {}) {
  const s = await realServer();
  const t = await s.login(login);
  const ali = await s.web({ start: 660, name: "Ali", phone: PHONE });
  await s.web({ start: 900, name: "Ali", phone: PHONE });
  const h = held();
  const routes = {
    "GET /api/admin/items": s.route, "POST /api/admin/login": s.route, "GET /api/admin/push": s.route,
    [CONTROLS["Lagre"].route(ali)]: s.route, [CONTROLS["Slett"].route(ali)]: s.route, [CONTROLS["Avlys alle"].route(ali)]: s.route,
  };
  // Only the first request waits; anything sent after it was released goes straight through
  let holding = true;
  routes[CONTROLS[first].route(ali)] = (c) => (holding ? h.route(c).then((how) => { holding = false; return s.route(c).then((r) => {
    if (how === "lost") throw new TypeError("Load failed");
    return r;
  }); }) : s.route(c));
  const page = await loadRealAdmin({ token: t, now: DAY + "T09:00", confirm: () => true, routes });
  const open = async () => { page.tap("timeline", `[data-id="${ali.id}"] button.item-open`); await page.flush(); };
  await open();
  assert.equal(page.$("cancel-phone").hidden, false, "«Avlys alle» is shown for Ali");
  return { s, t, ali, h, page, open };
}

for (const first of Object.keys(CONTROLS)) {
  for (const where of ["the same sheet", "the booking reopened"]) {
    for (const second of Object.keys(CONTROLS)) {
      test(`own writes: ${first} pending, ${second} in ${where}: nothing is sent until ${first} has landed, and nothing blames another device`, async () => {
        const { s, t, ali, h, page, open } = await setup(first);
        CONTROLS[first].start(page, 1);
        await page.flush();
        assert.equal(h.pending(), 1, `${first} is on its way`);
        if (where === "the booking reopened") {
          page.$("cancel-edit").click();
          await open();
          assert.equal(page.$("edit-msg").textContent, BUSY[first], "the reopened sheet says what is on its way");
        }
        for (const id of ["save", "delete", "cancel-phone"]) assert.equal(page.$(id).disabled, true, `${id} is locked`);
        const route = CONTROLS[second].route(ali), before = sent(page, route);
        CONTROLS[second].start(page, 2);
        await page.flush();
        assert.equal(sent(page, route), before, `${second} sent nothing while ${first} was on its way`);
        h.release("go");
        await page.flush();
        assert.doesNotMatch(said(page), BLAME, said(page));
        assert.equal(page.$("editor").open, false, `${first} closed the booking's sheet`);
        // Now the second control, on what the server has after the first
        const left = (await s.items(t)).filter((i) => i.id === ali.id)[0];
        if (!left) return; // deleted
        await open();
        if (page.$(CONTROLS[second].id).hidden) return; // «Avlys alle» after the number's bookings were cancelled
        page.alerts.length = 0;
        CONTROLS[second].start(page, 2);
        await page.flush();
        assert.equal(sent(page, route), before + 1, `${second} was sent`);
        assert.doesNotMatch(said(page), BLAME, said(page));
        const after = (await s.items(t)).filter((i) => i.id === ali.id)[0];
        if (second === "Lagre") assert.equal(after && after.note, "Notat 2", "the second change is stored");
        if (second === "Slett") assert.equal(after, undefined, "Ali is deleted");
      });
    }
  }
}

// The first write reached the server but its reply was lost: the sheet says «Ingen forbindelse … Oppdater siden for å se
// om endringen ble lagret». A second control from that sheet then meets this device's own change. Never «en annen enhet».
for (const first of Object.keys(CONTROLS)) {
  for (const second of Object.keys(CONTROLS)) {
    test(`own writes: ${first} reached the server but its reply was lost, then ${second}: nothing blames another device`, async () => {
      const { s, t, ali, h, page } = await setup(first);
      CONTROLS[first].start(page, 1);
      await page.flush();
      h.release("lost");
      await page.flush();
      assert.equal(page.$("editor").open, true);
      assert.match(page.$("edit-msg").textContent, /Ingen forbindelse/);
      assert.equal(page.$(CONTROLS[second].id).disabled, false, `${second} can be pressed`);
      CONTROLS[second].start(page, first === second ? 1 : 2);
      await page.flush();
      assert.doesNotMatch(said(page), BLAME, said(page));
      if (/annen|endret siden|flyttet eller slettet siden/.test(said(page))) assert.match(said(page), /kanskje av endringen herfra/, said(page));
      const after = (await s.items(t)).filter((i) => i.id === ali.id)[0];
      if (first === "Slett") assert.equal(after, undefined, "Ali stays deleted");
    });
  }
}

// Still_open 10 (probe R3-D8): Slett pending, the sheet closed and reopened, then the 12-h login runs out before the
// DELETE arrives. After logging in the sheet names Slett, Slett can be pressed, and it deletes Ali.
test("own writes: Slett pending in a reopened sheet gets 401; after logging in the sheet says «trykk Slett» and Slett deletes", async () => {
  const { s, t, ali, h, page, open } = await setup("Slett", { login: { remember: false } });
  CONTROLS["Slett"].start(page);
  await page.flush();
  page.$("cancel-edit").click();
  await open();
  assert.equal(page.$("delete").disabled, true);
  s.deps.clock.advance(13 * 3600e3); // the 12-h login runs out while the DELETE is on its way
  h.release("go");
  await page.flush();
  assert.equal(page.$("login").hidden, false, "the login page shows");
  assert.deepEqual(page.alerts, [], "the sheet itself will say it");
  page.$("pw").value = "riktig-passord-123";
  page.submit("login-form");
  await page.flush();
  assert.equal(page.$("editor").open, true, "the sheet is back");
  assert.equal(page.$("edit-msg").textContent, "Du er logget inn igjen – trykk Slett for å slette avtalen.");
  assert.equal(page.$("delete").disabled, false, "Slett can be pressed");
  page.$("delete").click();
  await page.flush();
  assert.deepEqual(page.alerts, []);
  assert.equal((await s.items(await s.login())).filter((i) => i.id === ali.id).length, 0, "Ali is deleted"); // t has run out
});

// Between this device's own answer and the reload, the timeline still shows the old card. Opening it gives the
// version this device got back (a save) or nothing (a delete), never a sheet whose expect its own write made stale.
test("own writes: the card tapped before the list has reloaded opens the version this device saved", async () => {
  const s = await realServer();
  const t = await s.login();
  const ali = await s.web({ start: 660, name: "Ali", phone: PHONE });
  const gets = held();
  let holdGets = false;
  const page = await loadRealAdmin({ token: t, now: DAY + "T09:00", confirm: () => true, routes: {
    "GET /api/admin/items": (c) => (holdGets ? gets.route(c).then(() => s.route(c)) : s.route(c)),
    [CONTROLS["Lagre"].route(ali)]: s.route, [CONTROLS["Slett"].route(ali)]: s.route,
  } });
  page.tap("timeline", `[data-id="${ali.id}"] button.item-open`);
  await page.flush();
  holdGets = true; // the reload after the save does not answer yet
  CONTROLS["Lagre"].start(page, 1);
  await page.flush();
  assert.equal(page.$("editor").open, false);
  page.tap("timeline", `[data-id="${ali.id}"] button.item-open`); // the old card
  await page.flush();
  assert.equal(page.$("editor").open, true);
  assert.equal(page.field("note").value, "Notat 1", "the sheet shows what this device saved");
  page.$("delete").click();
  await page.flush();
  assert.doesNotMatch(said(page), BLAME, said(page));
  assert.equal((await s.items(t)).filter((i) => i.id === ali.id).length, 0, "the delete carried the saved version and was stored");
  // The deleted booking's old card (the reload is still held) opens nothing
  page.tap("timeline", `[data-id="${ali.id}"] button.item-open`);
  await page.flush();
  assert.equal(page.$("editor").open, false, "no sheet for a booking this device deleted");
  assert.doesNotMatch(said(page), BLAME, said(page));
});

// Still_open 12 (probe R3-OWN1): «endret fra denne enheten» was claimed by the phone number: after «Avlys alle» for a
// number, any later cancelled booking from it counted as this device's own change, also one cancelled on the PC.
// Root cause: the cancel-phone reply gave only a count, so the page could not know which versions it wrote. Rule:
// «own change» is claimed only for a stored version (id + updatedAt) this device received in a reply.
test("own writes: a later cancel made on another device, of a booking from a number this device bulk-cancelled, is «et annet sted»", async () => {
  const s = await realServer();
  const phone = await s.login(), pc = await s.login();
  const spam = await s.web({ start: 780, name: "Falsk 1", phone: PHONE });
  await s.web({ start: 810, name: "Falsk 2", phone: PHONE });
  const page = await loadRealAdmin({ token: phone, now: DAY + "T09:00", confirm: () => true, routes: {
    "GET /api/admin/items": s.route, "POST /api/admin/cancel-phone": s.route } });
  page.tap("timeline", `[data-id="${spam.id}"] button.item-open`);
  await page.flush();
  page.$("cancel-phone").click();
  await page.flush();
  assert.match(page.alerts[0] || "", /^2 nettbestillinger fra 911 22 333 er avlyst/);
  // An hour later the same customer books for real; the phone opens it, and Viggo cancels it on the PC
  s.deps.clock.advance(3600e3);
  const real = await s.web({ start: 840, name: "Kari Ekte", phone: PHONE });
  page.wake();
  await page.flush();
  page.tap("timeline", `[data-id="${real.id}"] button.item-open`);
  await page.flush();
  s.deps.clock.advance(60e3);
  const r = await s.call(`/api/admin/items/${enc(real.id)}`, { method: "PATCH", token: pc, json: { status: "cancelled", expect: real.updatedAt } });
  assert.equal(r.status, 200);
  page.wake();
  await page.flush();
  assert.equal(page.$("editor").open, true);
  assert.equal(page.$("edit-msg").textContent, "Avtalen er endret et annet sted – lukk og åpne den på nytt.");
});

test("own writes: after «Avlys alle», the other booking's card tapped before the reload opens it as this device cancelled it, and saving it works", async () => {
  const s = await realServer();
  const t = await s.login();
  const ali = await s.web({ start: 660, name: "Ali", phone: PHONE });
  const ali2 = await s.web({ start: 900, name: "Ali", phone: PHONE });
  const gets = held();
  let holdGets = false;
  const page = await loadRealAdmin({ token: t, now: DAY + "T09:00", confirm: () => true, routes: {
    "GET /api/admin/items": (c) => (holdGets && /from=2026-11-19&to=2026-11-19/.test(c.url) ? gets.route(c).then(() => s.route(c)) : s.route(c)),
    "POST /api/admin/cancel-phone": s.route, [CONTROLS["Lagre"].route(ali2)]: s.route,
  } });
  page.tap("timeline", `[data-id="${ali.id}"] button.item-open`);
  await page.flush();
  holdGets = true; // the reload after the cancel does not answer yet: the timeline still shows Ali2 as booked
  page.$("cancel-phone").click();
  await page.flush();
  assert.match(page.alerts[0] || "", /^2 nettbestillinger/);
  page.tap("timeline", `[data-id="${ali2.id}"] button.item-open`);
  await page.flush();
  assert.equal(page.field("cancelled").checked, true, "the sheet shows Ali2 as this device cancelled it");
  CONTROLS["Lagre"].start(page, 1);
  await page.flush();
  assert.doesNotMatch(said(page), BLAME, said(page));
  const stored = (await s.items(t)).filter((i) => i.id === ali2.id)[0];
  assert.deepEqual([stored.status, stored.note], ["cancelled", "Notat 1"], "the note is saved on the cancelled booking");
});
