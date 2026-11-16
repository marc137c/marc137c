// /admin when the connection drops or the server fails (F30, RC2): every write and every panel shows a Norwegian
// 'Ingen forbindelse' text (or the server's own Norwegian text), never the browser's 'Load failed' / 'Failed to
// fetch', and a request that never answers gives up after 15 s with the same text. Plus the static rules: no
// fetch outside withTimeout(…) in admin.js, and no `textContent = err.message` outside the one translating helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadAdmin, itemsRoute, netFail, hang, fakePushBrowser } from "../helpers/admin-page.mjs";
import { makeDevice } from "../helpers/fake-push.mjs";
import { item } from "../fixtures/admin-days.mjs";

const ADMIN_JS = readFileSync(new URL("../../viggos-barbershop/admin.js", import.meta.url), "utf8");
const DAY = "2026-11-19";
const it = item(DAY, 660, 30, { name: "Ola", phone: "912 34 567", source: "nettside" });
const enc = encodeURIComponent(it.id);
const RAW = /fetch|Load failed|NetworkError|TypeError|undefined|\[object/i;

const FAILURES = [["Load failed", netFail("Load failed")], ["Failed to fetch", netFail("Failed to fetch")], ["no answer", hang()]];
// Waits long enough for the 15-s limit when the route hangs
const settle = async (page) => { await page.flush(); await page.advance(15000); await page.flush(); };
const open = (routes, extra = {}) => loadAdmin({ now: DAY + "T09:00", routes: { "GET /api/admin/items": itemsRoute([it]), ...routes }, ...extra });

for (const [label, fail] of FAILURES) {
  test(`network (${label}): Lagre on a new booking says 'Ingen forbindelse' and to check whether it was saved`, async () => {
    const page = await open({ "POST /api/admin/items": fail });
    page.$("add").click();
    page.field("service").value = "Herreklipp";
    page.submit();
    await settle(page);
    const m = page.$("edit-msg").textContent;
    assert.match(m, /^Ingen forbindelse – sjekk nettet og prøv igjen\. Oppdater siden for å se om endringen ble lagret\.$/);
    assert.doesNotMatch(m, RAW);
    assert.equal(page.$("save").disabled, false, "Lagre can be tapped again");
    assert.equal(page.$("editor").open, true, "the sheet stays open with what was typed");
  });

  test(`network (${label}): Lagre on an existing booking and Slett say the same`, async () => {
    const page = await open({ [`PATCH /api/admin/items/${enc}`]: fail, [`DELETE /api/admin/items/${enc}`]: fail });
    page.tap("timeline", `[data-id="${it.id}"]`);
    page.field("note").value = "ny";
    page.submit();
    await settle(page);
    assert.match(page.$("edit-msg").textContent, /^Ingen forbindelse/);
    assert.doesNotMatch(page.$("edit-msg").textContent, RAW);
    page.$("edit-msg").textContent = "";
    page.$("delete").click();
    await settle(page);
    assert.match(page.$("edit-msg").textContent, /^Ingen forbindelse/);
    assert.doesNotMatch(page.$("edit-msg").textContent, RAW);
  });

  test(`network (${label}): logging in says 'Ingen forbindelse – prøv igjen.'`, async () => {
    const page = await open({ "POST /api/admin/login": fail }, { token: null });
    page.$("pw").value = "x";
    page.submit("login-form");
    await settle(page);
    assert.equal(page.$("login-msg").textContent, "Ingen forbindelse – prøv igjen.");
    assert.equal(page.$("app").hidden, true);
  });

  test(`network (${label}): Oppsett's calendar link says 'Ingen forbindelse'`, async () => {
    const page = await open({ "GET /api/admin/calendar": fail, "GET /api/admin/push": () => ({ publicKey: "x", devices: 0 }) });
    page.$("settings-open").click();
    await settle(page);
    assert.match(page.$("cal-msg").textContent, /^Ingen forbindelse/);
    assert.doesNotMatch(page.$("cal-msg").textContent, RAW);
  });

  test(`network (${label}): «Send testvarsel» says 'Ingen forbindelse'`, async () => {
    const device = makeDevice();
    const key = device.subscription.keys.p256dh;
    const b = fakePushBrowser({ device, permission: "granted", subscribed: [...Buffer.from(key, "base64url")] });
    const page = await open({
      "GET /api/admin/calendar": () => ({ enabled: false }),
      "GET /api/admin/push": () => ({ publicKey: key, devices: 1 }),
      "POST /api/admin/push/subscribe": () => ({ ok: true, devices: 1, until: "2026-11-20T09:00:00.000Z" }),
      "POST /api/admin/push/test": fail,
    }, { navigator: b.navigator, globals: b.globals });
    page.$("settings-open").click();
    await page.flush();
    assert.equal(page.$("push-test").hidden, false, "notifications are on here");
    page.$("push-test").click();
    await settle(page);
    assert.match(page.$("push-msg").textContent, /^Ingen forbindelse/);
    assert.doesNotMatch(page.$("push-msg").textContent, RAW);
  });
}

// Server failures on a write: 500 with the server's JSON text, a 502/504 HTML page from the platform, a 503 JSON
for (const [label, answer, expect] of [
  ["500 JSON", { status: 500, body: { error: "Noe gikk galt på serveren." } }, /^Noe gikk galt på serveren\. Oppdater siden for å se om endringen ble lagret\.$/],
  ["502 HTML", { status: 502, body: "<html>Bad gateway</html>" }, /^Ingen forbindelse med serveren \(feil 502\) – prøv igjen\. Oppdater siden for å se om endringen ble lagret\.$/],
  ["503 JSON", { status: 503, body: { error: "Kunne ikke lagre akkurat nå." } }, /^Kunne ikke lagre akkurat nå\. Oppdater siden/],
  ["504 HTML", { status: 504, body: "<html>Timeout</html>" }, /^Ingen forbindelse med serveren \(feil 504\)/],
  ["503 move_half_done", { status: 503, body: { error: "Avtalen er lagt inn på den nye datoen, men den gamle tiden ble ikke fjernet. Trykk Lagre én gang til.", code: "move_half_done" } }, /^Avtalen er lagt inn på den nye datoen, men den gamle tiden ble ikke fjernet\. Trykk Lagre én gang til\.$/],
]) {
  test(`server failure (${label}) on Lagre: a Norwegian text that never promises it was saved`, async () => {
    const page = await open({ [`PATCH /api/admin/items/${enc}`]: () => answer });
    page.tap("timeline", `[data-id="${it.id}"]`);
    page.field("note").value = "ny";
    page.submit();
    await page.flush();
    const m = page.$("edit-msg").textContent;
    assert.match(m, expect);
    assert.doesNotMatch(m, RAW);
    assert.equal(page.$("editor").open, true);
  });
}

test("static: every fetch( in admin.js is inside withTimeout(…), and errors are shown through errText(), never err.message directly", () => {
  assert.doesNotMatch(ADMIN_JS, /textContent\s*=\s*err\.message/, "no textContent = err.message");
  assert.doesNotMatch(ADMIN_JS, /(loginMsg|calMsg|pushMsg|loginPushMsg)\(err\.message/, "no message helper fed err.message");
  const fn = /function errText\(err\) \{([\s\S]*?)\n  \}/.exec(ADMIN_JS);
  assert.ok(fn, "errText(err) exists");
  assert.match(fn[1], /err\.status \|\| err\.user/, "only a known error's message is shown as it is");
  const fetches = ADMIN_JS.split("fetch(").length - 1;
  const wrapped = (ADMIN_JS.match(/withTimeout\(fetch\(/g) || []).length;
  assert.equal(wrapped, fetches, "each fetch( is the first argument of withTimeout");
});

// The rest of the RC2 matrix for the barber's writes: the server's own Norwegian text for 404 and 429, and an
// uncertain text for the platform's HTML error pages on Slett and on a new booking
test("server failure matrix: 404 and 429 show the server's text; 502/504 HTML on Slett and on a new booking say to check", async () => {
  const cases = [
    ["POST", { status: 404, body: { error: "Ukjent forespørsel." } }, /^Ukjent forespørsel\.$/],
    ["POST", { status: 429, body: { error: "For mange forespørsler. Vent litt og prøv igjen." } }, /^For mange forespørsler/],
    ["POST", { status: 502, body: "<html>Bad gateway</html>" }, /^Ingen forbindelse med serveren \(feil 502\) – prøv igjen\. Oppdater siden/],
    ["DELETE", { status: 504, body: "<html>Timeout</html>" }, /^Ingen forbindelse med serveren \(feil 504\) – prøv igjen\. Oppdater siden/],
    ["DELETE", { status: 429, body: { error: "For mange forespørsler." } }, /^For mange forespørsler\.$/],
  ];
  for (const [method, answer, expect] of cases) {
    const page = await open({ "POST /api/admin/items": () => answer, [`DELETE /api/admin/items/${enc}`]: () => answer });
    if (method === "POST") {
      page.$("add").click();
      page.field("service").value = "Herreklipp";
      page.submit();
    } else {
      page.tap("timeline", `[data-id="${it.id}"]`);
      page.$("delete").click();
    }
    await page.flush();
    const m = page.$("edit-msg").textContent;
    assert.match(m, expect, `${method} ${answer.status}`);
    assert.doesNotMatch(m, RAW);
  }
});

test("server failure matrix: a 429 on login shows the server's text in red", async () => {
  const page = await open({ "POST /api/admin/login": () => ({ status: 429, body: { error: "For mange forsøk. Vent 15 minutter og prøv igjen." } }) }, { token: null });
  page.$("pw").value = "x";
  page.submit("login-form");
  await page.flush();
  assert.equal(page.$("login-msg").textContent, "For mange forsøk. Vent 15 minutter og prøv igjen.");
  assert.equal(page.$("login-msg").className, "msg");
});
