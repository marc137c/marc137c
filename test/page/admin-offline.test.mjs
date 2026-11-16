// /admin without a connection (F29, RC2): the day info, week strip and timeline show data for exactly the day on
// screen, or nothing, never the previous day's numbers or a 'stengt' guessed before the hours are known.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin, itemsRoute, netFail, hang } from "../helpers/admin-page.mjs";
import { item } from "../fixtures/admin-days.mjs";

const THU = "2026-11-19", FRI = "2026-11-20";
const list = [item(FRI, 600, 30, { name: "Fre 1" }), item(FRI, 660, 30, { name: "Fre 2" })];

for (const [label, broken] of [["Load failed", netFail("Load failed")], ["Failed to fetch", netFail("Failed to fetch")]]) {
  test(`offline (${label}): after a good load, › to a day that was never fetched shows no '0 avtaler', and says it could not fetch`, async () => {
    let online = true;
    const good = itemsRoute(list);
    const page = await loadAdmin({ now: THU + "T09:00", routes: { "GET /api/admin/items": (c) => (online ? good(c) : broken(c)) } });
    assert.match(page.$("day-info").textContent, /^Åpent 10:00–18:00 · 0 avtaler/, "Thursday itself is loaded and empty");
    online = false;
    page.$("next").click();
    await page.flush();
    assert.doesNotMatch(page.$("day-info").textContent, /avtale/, "no count for Friday from Thursday's list: " + page.$("day-info").textContent);
    assert.match(page.$("timeline").innerHTML, /Kunne ikke hente avtaler – prøver igjen …/);
    assert.doesNotMatch(page.$("timeline").innerHTML, /Ledig/, "nothing shown as free");
    assert.equal(page.$("sync").textContent, "Ingen forbindelse");
    online = true;
    page.tick();
    await page.flush();
    assert.match(page.$("day-info").textContent, /· 2 avtaler/, "the next timer tick fetches Friday");
  });
}

test("offline from the start: › shows no 'stengt' in the week strip and no 'Stengt' day info (the hours are not known yet)", async () => {
  const page = await loadAdmin({ now: THU + "T09:00", routes: { "GET /api/admin/items": netFail("Load failed") } });
  page.$("next").click();
  await page.flush();
  assert.doesNotMatch(page.$("week").innerHTML, /stengt|is-closed/);
  assert.doesNotMatch(page.$("day-info").textContent, /^Stengt/);
  assert.match(page.$("timeline").innerHTML, /Kunne ikke hente avtaler/);
});

test("offline: a day still being fetched says 'Henter avtaler …' and has no day info", async () => {
  let slow = false;
  const good = itemsRoute(list);
  const page = await loadAdmin({ now: THU + "T09:00", routes: { "GET /api/admin/items": (c) => (slow ? hang()(c) : good(c)) } });
  slow = true;
  page.$("next").click();
  await page.flush();
  assert.equal(page.$("day-info").textContent, "");
  assert.match(page.$("timeline").innerHTML, /Henter avtaler …/);
});
