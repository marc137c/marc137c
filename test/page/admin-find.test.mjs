// /admin search (X2.1, barber workflow 'a customer calls to cancel'): a search field under the day navigation
// finds bookings from today and 92 days on by phone (4 or more digits, any spacing or +47) or by part of the
// name. Each hit shows weekday, date, time, service, name, phone, when it was booked, and AVLYST; a tap opens
// that day and the booking's sheet, so the barber reaches the right booking in three taps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadAdmin, itemsRoute } from "../helpers/admin-page.mjs";
import { item } from "../fixtures/admin-days.mjs";

const HTML = readFileSync(new URL("../../viggos-barbershop/admin.html", import.meta.url), "utf8");
const TODAY = "2026-11-19";
const ola = (date, start, extra = {}) => item(date, start, 30, { name: "Ola Nordmann", phone: "912 34 567", source: "nettside", createdAt: "2026-11-12T13:05:00.000Z", ...extra });
const list = [
  ola("2026-11-18", 600), // yesterday: outside the search
  ola("2026-11-20", 660),
  ola("2026-12-05", 720, { status: "cancelled" }),
  ola("2026-12-18", 780, { service: "Full service", dur: 60 }),
  item("2026-11-25", 600, 30, { name: "Ola Nordmann", phone: "987 65 432" }),
  item("2026-11-26", 600, 30, { name: "Kari Hansen", phone: "400 12 345" }),
  item("2026-11-27", 600, 30, { type: "block", name: "", phone: "", service: "", note: "Ola sin ferie" }),
];
const open = () => loadAdmin({ now: TODAY + "T09:00", routes: { "GET /api/admin/items": itemsRoute(list) } });
async function find(page, q) {
  page.$("q").value = q;
  page.submit("find");
  await page.flush();
  return [...page.rendered("hits").querySelectorAll("[data-hit]")];
}

test("find X2.1: the search form sits right under the day navigation, with a label", () => {
  const nav = HTML.indexOf('class="day-nav"'), form = HTML.indexOf('id="find"'), head = HTML.indexOf('class="day-head"');
  assert.ok(nav > 0 && form > nav && form < head, "after .day-nav, before the day view");
  assert.match(HTML, /<form class="find" id="find" role="search">/);
  assert.match(HTML, /<input id="q" type="search" aria-label="Søk etter navn eller telefon"/);
  assert.match(HTML, /<ol class="hits" id="hits"/);
});

for (const q of ["91234567", "912 34 567", "+47 912 34 567", "4567"]) {
  test(`find X2.1: '${q}' gives exactly Ola's 3 bookings from today on, in date order`, async () => {
    const page = await open();
    const hits = await find(page, q);
    assert.equal(hits.length, 3);
    const url = page.calls.at(-1).url;
    assert.equal(url, "/api/admin/items?from=2026-11-19&to=2027-02-19", "today and 92 days on");
    const text = hits.map((h) => h.textContent.replace(/\s+/g, " ").trim());
    assert.match(text[0], /fre\. 20\. nov\.? kl\. 11:00/i);
    assert.match(text[0], /Herreklipp/);
    assert.match(text[0], /Ola Nordmann · 912 34 567/);
    assert.match(text[0], /bestilt 12\.11\. kl\. \d\d:05/);
    assert.match(text[1], /AVLYST/);
    assert.match(text[2], /Full service/);
  });
}

test("find X2.1: part of a name finds both Olas (not the block), case does not matter", async () => {
  const page = await open();
  assert.equal((await find(page, "ola nord")).length, 4);
  assert.equal((await find(page, "KARI")).length, 1);
});

test("find X2.1: fewer than 4 digits asks for more and fetches nothing; nothing found says so", async () => {
  const page = await open();
  const before = page.calls.length;
  await find(page, "91");
  assert.equal(page.calls.length, before);
  assert.match(page.$("hits").innerHTML, /minst 4 sifre/);
  await find(page, "55555555");
  assert.match(page.$("hits").innerHTML, /Ingen treff/);
});

test("find X2.1: a tap on a hit opens that day and that booking's sheet", async () => {
  const page = await open();
  await find(page, "912 34 567");
  page.tap("hits", '[data-hit="2"]');
  await page.flush();
  assert.ok(page.calls.some((c) => c.url === "/api/admin/items?from=2026-12-18&to=2026-12-18"));
  assert.equal(page.$("day").value, "2026-12-18");
  assert.equal(page.$("editor").open, true);
  assert.equal(page.$("edit-title").textContent, "Endre avtale");
  assert.equal(page.field("date").value, "2026-12-18");
  assert.equal(page.field("service").value, "Full service");
  assert.equal(page.field("name").value, "Ola Nordmann");
});

test("find X2.1: a web booking's card says when it was booked", async () => {
  const page = await loadAdmin({ now: "2026-11-20T09:00", routes: { "GET /api/admin/items": itemsRoute(list) } });
  assert.match(page.text("timeline"), /Bestilt på nett 12\.11\. kl\. \d\d:05/);
});

// Round 2 (probe-find S1, S2): the query type came from a Latin-letter regex, so «Мария» and «محمد» were refused,
// and +47 was stripped only from a whole number, so «+47 911 22» searched «4791122» and found nothing. Guard (SPEC
// R25): a table of queries against stored data, for every script and every way to type part of a number.
const intl = [
  item("2026-11-28", 600, 30, { name: "Мария Иванова", phone: "455 66 777" }),
  item("2026-11-28", 660, 30, { name: "محمد علي", phone: "466 77 888" }),
  item("2026-11-28", 720, 30, { name: "Zoë Ærø", phone: "477 88 999" }),
  item("2026-11-28", 780, 30, { name: "Kari Nordmann", phone: "911 22 333" }),
];
const QUERIES = [
  ["Мария", "Мария Иванова"], ["иван", "Мария Иванова"], ["محمد", "محمد علي"], ["zoë", "Zoë Ærø"], ["ærø", "Zoë Ærø"],
  ["+47 911 22", "Kari Nordmann"], ["0047 911 22", "Kari Nordmann"], ["+4791122", "Kari Nordmann"], ["911 22", "Kari Nordmann"],
  ["+47 911 22 333", "Kari Nordmann"], ["91122333", "Kari Nordmann"], ["4791122333", "Kari Nordmann"], ["(911) 22-333", "Kari Nordmann"],
];
for (const [q, who] of QUERIES) {
  test(`find round 2: '${q}' finds ${who}`, async () => {
    const page = await loadAdmin({ now: TODAY + "T09:00", routes: { "GET /api/admin/items": itemsRoute(intl) } });
    const hits = await find(page, q);
    assert.equal(hits.length, 1, `${q}: ${page.rendered("hits").textContent}`);
    assert.match(hits[0].textContent, new RegExp(who));
  });
}
test("find round 2: fewer than 4 digits of a number still asks for more («+47 91», «0047 9»)", async () => {
  const page = await loadAdmin({ now: TODAY + "T09:00", routes: { "GET /api/admin/items": itemsRoute(intl) } });
  for (const q of ["+47 91", "0047 9", "911"]) {
    await find(page, q);
    assert.equal(page.rendered("hits").textContent.trim(), "Skriv minst 4 sifre av telefonnummeret, eller en del av navnet.", q);
  }
});
