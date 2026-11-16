// /admin left open overnight (F12, RC5 long-lived page): 'today' follows the clock. A tab opened on Wednesday at
// 23:50 and brought back on Thursday at 07:30 shows Thursday, fetches Thursday, marks it in the week strip, and
// '+ Ny avtale' / 'Blokker tid' default to Thursday. A day the barber picked himself stays picked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin, itemsRoute } from "../helpers/admin-page.mjs";
import { item } from "../fixtures/admin-days.mjs";

const WED = "2026-11-11", THU = "2026-11-12", FRI = "2026-11-13";
const list = [item(WED, 660, 30, { name: "Onsdagskunde" }), item(THU, 600, 30, { name: "Torsdagskunde" }), item(FRI, 600, 30, { name: "Fredagskunde" })];
const open = () => loadAdmin({ now: WED + "T23:50", routes: { "GET /api/admin/items": itemsRoute(list) } });
const dayCalls = (page) => page.calls.filter((c) => c.path === "/api/admin/items").map((c) => c.url).filter((u) => { const q = new URL(u, "https://x").searchParams; return q.get("from") === q.get("to"); });
const active = (page) => { const b = page.rendered("week").querySelector(".is-active"); return b && b.getAttribute("data-day"); };

for (const [how, bringBack] of [["visibilitychange", (p) => p.wake()], ["the 30-s timer", (p) => p.tick()]]) {
  test(`overnight (${how}): Wed 23:50 → Thu 07:30 shows, fetches and marks Thursday`, async () => {
    const page = await open();
    assert.match(page.$("day-title").textContent, /^I dag, onsdag 11\. november$/);
    page.setNow(THU + "T07:30");
    bringBack(page);
    await page.flush();
    assert.match(page.$("day-title").textContent, /^I dag, torsdag 12\. november$/);
    assert.equal(dayCalls(page).at(-1), `/api/admin/items?from=${THU}&to=${THU}`);
    assert.match(page.$("timeline").innerHTML, /Torsdagskunde/);
    assert.doesNotMatch(page.$("timeline").innerHTML, /Onsdagskunde/);
    assert.equal(active(page), THU);
    assert.equal(page.rendered("week").querySelector("[data-day]").getAttribute("data-day"), THU, "the strip starts on the new today");
    assert.equal(page.$("day").value, THU);
  });
}

test("overnight: a Friday the barber picked on Wednesday is still Friday after midnight", async () => {
  const page = await open();
  page.tap("week", `[data-day="${FRI}"]`);
  await page.flush();
  page.setNow(THU + "T07:30");
  page.wake();
  await page.flush();
  assert.equal(active(page), FRI);
  assert.match(page.$("day-title").textContent, /^Fredag 13\. november$/i);
  assert.equal(dayCalls(page).at(-1), `/api/admin/items?from=${FRI}&to=${FRI}`);
});

test("overnight: '+ Ny avtale' and 'Blokker tid' default to the new today, even before anything was fetched again", async () => {
  const page = await open();
  page.setNow(THU + "T00:05");
  page.$("add").click();
  assert.equal(page.field("date").value, THU, "+ Ny avtale");
  page.$("cancel-edit").click();
  await page.flush();
  page.$("block").click();
  assert.equal(page.field("date").value, THU, "Blokker tid");
  assert.equal(page.field("start").value, "10:00", "from Thursday's opening");
});
