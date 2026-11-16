// /admin layout rules that keep the page usable on phones and in old browsers. These read the real admin.html and
// admin.css (no browser is started), plus one run of admin.js in the fake DOM. Invariants:
//   1. the sticky header's top row holds only the title, the sync status, «Se nettsiden» and «Oppsett», with a
//      smaller gap at 430 px and below (also where flex gap is missing), so it stays one line on 390–412 px phones;
//      below 390 px (iPhone SE, 12/13 mini, 6/7/8, most Galaxy S: 320–375 px) the row never wraps, and the status and
//      «Se nettsiden» may shrink instead, so «Oppsett» is never alone on a second line of the sticky header;
//      «Logg ut» lives in the Oppsett sheet, and still logs out from there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadAdmin } from "../helpers/admin-page.mjs";

const SITE = new URL("../../viggos-barbershop/", import.meta.url);
const HTML = readFileSync(new URL("admin.html", SITE), "utf8");
const CSS = readFileSync(new URL("admin.css", SITE), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const between = (s, start, end) => { const i = s.indexOf(start); assert.ok(i >= 0, start); const j = s.indexOf(end, i); assert.ok(j > i, end); return s.slice(i, j); };
const ids = (html) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
// The body of the first rule for `selector` inside the block that starts at `at` (or at top level when at is null)
function ruleIn(at, selector) {
  let scope = CSS;
  if (at) {
    const i = scope.indexOf(at);
    assert.ok(i >= 0, `no ${at} in admin.css`);
    let depth = 0, j = scope.indexOf("{", i);
    const start = j + 1;
    for (; j < scope.length; j++) { if (scope[j] === "{") depth++; else if (scope[j] === "}" && --depth === 0) break; }
    scope = scope.slice(start, j);
  }
  const m = new RegExp(`(^|[}\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(scope);
  assert.ok(m, `no rule «${selector}» in ${at || "admin.css"}`);
  return m[2];
}
const px = (body, prop) => { const m = new RegExp(`(^|;|\\s)${prop}\\s*:\\s*(\\d+)px`).exec(body); assert.ok(m, `${prop} in «${body.trim()}»`); return Number(m[2]); };

test("layout: the header's top row is title, status, «Se nettsiden» and «Oppsett»; «Logg ut» is in the Oppsett sheet", () => {
  const top = between(HTML, '<div class="top-row">', "</div>");
  assert.deepEqual(ids(top), ["sync", "settings-open"]);
  assert.match(top, /class="title"/);
  assert.match(top, />Se nettsiden</);
  assert.doesNotMatch(top, /Logg ut|id="logout"/);
  const sheet = between(HTML, '<dialog class="sheet" id="settings"', "</dialog>");
  assert.match(sheet, /<button class="btn btn-ghost" type="button" id="logout">Logg ut<\/button>/);
  assert.equal(ids(HTML).filter((id) => id === "logout").length, 1);
});

test("layout: at 430 px and below the top row's gap shrinks, also in browsers without flex gap", () => {
  assert.equal(px(ruleIn(null, ".top-row"), "gap"), 10);
  assert.ok(px(ruleIn("@media (max-width: 430px)", ".top-row"), "gap") <= 6);
  const old = CSS.slice(CSS.indexOf("@supports not (aspect-ratio: 1)"));
  assert.ok(px(ruleIn("@supports not (aspect-ratio: 1)", ".top-row > * + *"), "margin-left") === 10);
  const nested = /@media \(max-width: 430px\)\s*\{\s*\.top-row > \* \+ \* \{\s*margin-left:\s*(\d+)px;?\s*\}\s*\}/.exec(old.slice(0, old.indexOf("@supports not (display: grid)")));
  assert.ok(nested && Number(nested[1]) <= 6, "the margin fallback shrinks too");
});

for (const oldBrowser of [false, true]) {
  test(`layout: «Oppsett → Logg ut» closes the sheet and shows the login${oldBrowser ? " (compat.js dialog shim)" : ""}`, async () => {
    const page = await loadAdmin({ oldBrowser, routes: { "GET /api/admin/calendar": () => ({ enabled: false }) } });
    page.$("settings-open").click();
    await page.flush();
    assert.equal(page.$("settings").open, true);
    page.$("logout").click();
    await page.flush();
    assert.equal(page.$("settings").open, false);
    assert.equal(page.$("login").hidden, false);
    assert.equal(page.$("login-msg").textContent, "Du er logget ut.");
    assert.equal(page.local.getItem("viggo-admin-token"), null);
  });
}

//   2. a modal sheet («Oppsett», the editor) never spills out of its frame: it scrolls inside, and where the browser
//      has <dialog> (also old Chromium, which places it position: absolute with overflow visible) it is fixed to the
//      screen and at most the screen's height; the compat.js stand-in keeps its own fixed, scrolling style.
test("layout: a modal sheet is fixed to the screen, no taller than it, and scrolls inside (Chrome 60)", () => {
  const sheet = ruleIn(null, ".sheet");
  assert.match(sheet, /max-height:\s*calc\(100% - 24px\)/);
  assert.match(CSS, /\.sheet \{ overflow: auto; -webkit-overflow-scrolling: touch; \}/, "scrolls inside instead of spilling out");
  const modal = ruleIn(null, ".sheet[open]:not(.dialog-shim)");
  assert.match(modal, /position:\s*fixed/);
  assert.match(modal, /top:\s*0/);
  assert.match(modal, /bottom:\s*0/);
  assert.match(modal, /height:\s*fit-content/, "shrinks to its content where it fits, like newer browsers");
  const shim = ruleIn(null, ".dialog-shim[open]");
  assert.match(shim, /position:\s*fixed/);
  assert.match(shim, /overflow:\s*auto/);
  // Both dialogs are .sheet
  for (const id of ["settings", "editor"]) assert.match(HTML, new RegExp(`<dialog class="sheet" id="${id}"`));
});

//   3. opening «Oppsett» puts keyboard focus on «Lukk», never on «Logg ut»: one Enter or Space must not log the
//      barber out. «Lukk» carries autofocus (native <dialog> and the compat.js stand-in both follow it), and admin.js
//      focuses it as well, before the panels have loaded.
test("layout: «Lukk» is the one autofocus control in Oppsett, and «Logg ut» has none", () => {
  const sheet = between(HTML, '<dialog class="sheet" id="settings"', "</dialog>");
  const autofocus = [...sheet.matchAll(/<[a-z]+\b[^>]*\sautofocus\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(autofocus.length, 1, autofocus.join("\n"));
  assert.match(autofocus[0], /id="settings-close"/);
  assert.match(autofocus[0], /^<button\b/);
  assert.doesNotMatch(/<button[^>]*id="logout"[^>]*>/.exec(sheet)[0], /autofocus/);
});

for (const oldBrowser of [false, true]) {
  test(`layout: opening Oppsett focuses «Lukk», also before the panels have loaded${oldBrowser ? " (compat.js dialog shim)" : ""}`, async () => {
    const page = await loadAdmin({ oldBrowser, routes: { "GET /api/admin/calendar": () => new Promise(() => {}), "GET /api/admin/push": () => new Promise(() => {}) } });
    page.$("settings-open").click();
    assert.equal(page.doc.activeElement, page.$("settings-close"), "right after opening");
    await page.flush();
    assert.equal(page.doc.activeElement, page.$("settings-close"), "while the panels are loading");
    assert.notEqual(page.doc.activeElement, page.$("logout"));
    // «Lukk» closes the sheet and leaves the barber logged in
    page.doc.activeElement.click();
    await page.flush();
    assert.equal(page.$("settings").open, false);
    assert.equal(page.$("app").hidden, false);
    assert.equal(page.local.getItem("viggo-admin-token"), "test-admin-token");
  });
}

test("layout: below 390 px the top row never wraps; the status and «Se nettsiden» shrink instead of pushing «Oppsett» down", () => {
  assert.match(ruleIn(null, ".top-row"), /flex-wrap:\s*wrap/, "wider screens may wrap as before");
  const narrow = ruleIn("@media (max-width: 389px)", ".top-row");
  assert.match(narrow, /flex-wrap:\s*nowrap/);
  const shrink = ruleIn("@media (max-width: 389px)", ".top-row .sync, .top-row a.link");
  assert.match(shrink, /min-width:\s*0/);
  assert.doesNotMatch(CSS.slice(CSS.indexOf("@media (max-width: 389px)")), /#settings-open|\.top-row button[^{]*\{[^}]*min-width:\s*0/, "«Oppsett» keeps its full width");
  // The narrow rule comes after the base rule, so it wins (same specificity)
  assert.ok(CSS.indexOf("@media (max-width: 389px)") > CSS.indexOf(".top-row {"));
  // «Se nettsiden» is the a.link and the status is .sync in the top row
  const top = between(HTML, '<div class="top-row">', "</div>");
  assert.match(top, /<span class="sync" id="sync"/);
  assert.match(top, /<a class="link" href="\/"/);
});

// F92: the day title is written with only its first letter upper-case (no CSS capitalize, which gave
// 'I Dag, Torsdag 12. November'), and the date row never squeezes «I dag» onto two lines.
test("layout F92: the day title has only its first letter upper-case, today and any other day", async () => {
  const { itemsRoute } = await import("../helpers/admin-page.mjs");
  const page = await loadAdmin({ now: "2026-11-12T09:00", routes: { "GET /api/admin/items": itemsRoute([]) } });
  assert.equal(page.$("day-title").textContent, "I dag, torsdag 12. november");
  page.$("next").click();
  await page.flush();
  assert.equal(page.$("day-title").textContent, "Fredag 13. november");
  assert.doesNotMatch(ruleIn(null, ".day-head h2"), /text-transform/, "no text-transform on the title");
});

test("layout F92: «I dag» never wraps and keeps its width; the date field may shrink", () => {
  const chip = ruleIn(null, ".chip");
  assert.match(chip, /white-space:\s*nowrap/);
  assert.match(chip, /flex:\s*0 0 auto/);
  assert.match(ruleIn(null, ".day-nav input"), /min-width:\s*0/);
});
