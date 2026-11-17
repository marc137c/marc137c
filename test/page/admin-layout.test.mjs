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

// ---------- Round 2: layout guards from the device run (SPEC R27) ----------
// The CSS value of a horizontal side from a margin/padding shorthand: «24px 16px 40px» → "16px", «0 auto» → "auto"
function side(body, prop) {
  const m = new RegExp(`(^|;|\\s)${prop}\\s*:\\s*([^;]+)`).exec(body);
  if (!m) return null;
  const v = m[2].trim().split(/\s+/);
  return v.length === 1 ? v[0] : v[1];
}
// Every direct child block of #app (in admin.html, plus the stats panel admin-stats.js appends) keeps at least
// 12 px on each side from 320 to 768 px: a card (side borders) through its own margin, a full-width bar through
// its padding. A card centred with margin auto gets it only from a min-width of its max-width + 24 px.
test("layout round 2: every direct child of #app keeps a 12-px side gutter on phones and tablets", () => {
  const app = between(HTML.replace(/\r\n/g, "\n"), '<div class="app" id="app" hidden>', '\n  </div>\n');
  const classes = [...app.matchAll(/\n    <(?:header|main|section|div|nav)\s+class="([^" ]+)/g)].map((m) => m[1]);
  const statsJs = readFileSync(new URL("admin-stats.js", SITE), "utf8");
  assert.match(statsJs, /className = "stats-panel"/);
  assert.match(statsJs, /app\.appendChild\(section\)/);
  classes.push("stats-panel");
  assert.deepEqual(classes, ["top", "day", "stats-panel"]);
  for (const c of classes) {
    const body = ruleIn(null, "." + c);
    const card = /(^|;|\s)border(-left|-right)?\s*:/.test(body);
    const v = card ? side(body, "margin") : side(body, "padding");
    assert.ok(v && /^\d+px$/.test(v) && parseInt(v, 10) >= 12, `.${c}: ${card ? "margin" : "padding"} side is ${v} in «${body.trim()}»`);
    // and where it is centred with auto, only from a width that still leaves 12 px
    const maxW = /max-width:\s*(\d+)px/.exec(body);
    const autoAt = [...CSS.matchAll(/@media \(min-width:\s*(\d+)px\)\s*\{\s*\.([\w-]+)\s*\{([^}]*)\}/g)].filter((m) => m[2] === c && /margin:[^;]*auto/.test(m[3]));
    for (const m of autoAt) assert.ok(maxW && Number(m[1]) >= Number(maxW[1]) + 24, `.${c} is centred from ${m[1]} px, but max-width is ${maxW && maxW[1]} px`);
  }
});

// Phone landscape (844×390, 667×375): the sticky header (title, date row, week strip) took 51–53 % of the screen,
// and a tap on «+ Ny avtale» hit the header. Sticky chrome may cover at most 35 % of innerHeight: below 500 px of
// height the header scrolls with the page, and the browser's own focus/scroll-into-view keeps clear of it.
test("layout round 2: in phone landscape (height ≤ 500 px) the header is not sticky; scroll-padding keeps focus out from under it", () => {
  assert.match(ruleIn("@media (max-height: 500px)", ".top"), /position:\s*static/);
  const html = ruleIn(null, "html");
  const pad = /scroll-padding-top:\s*(\d+)px/.exec(html);
  assert.ok(pad && Number(pad[1]) >= 200, `html scroll-padding-top in «${html.trim()}»`);
  assert.match(ruleIn("@media (max-height: 500px)", "html"), /scroll-padding-top:\s*0/);
});

// 320–340 px in Chrome/Samsung: min-width: 0 let the date field shrink to about 112 px, cutting the year
// («17.11.20»). A form control keeps its own text width at 320 px: the field keeps 7.6em (the whole date and the
// calendar icon) and the round buttons, the gaps and «I dag» give way instead.
test("layout round 2: at 359 px and below the date field keeps room for the whole date, and the row still fits 320 px", () => {
  const q = "@media (max-width: 359px)";
  const input = ruleIn(q, ".day-nav input");
  const em = /min-width:\s*([\d.]+)em/.exec(input);
  assert.ok(em && Number(em[1]) >= 7.5, input);
  const icon = px(ruleIn(q, ".day-nav .icon"), "width");
  const gap = px(ruleIn(q, ".day-nav"), "gap");
  const chipPad = /padding:\s*0\s+(\d+)px/.exec(ruleIn(q, ".day-nav .chip"));
  assert.ok(chipPad, "the «I dag» chip's side padding");
  // 320 - 2 × 16 px padding; «I dag» at 16 px ≈ 40 px of text; the field at 16 px
  const used = 2 * icon + Number(em[1]) * 16 + (40 + 2 * Number(chipPad[1])) + 3 * gap;
  assert.ok(used <= 288, `the row needs ${used} px of 288`);
});

// Fix-up round 2 (probe-misc6b.log, old-fresh.jsonl): html { scroll-padding-top: 210px } was one number taken at
// 390 px, but the sticky header is 221 px at 320–360 px (the top row wraps), 244 px in Chromium 60 and 249 px in
// Firefox 57, so a focused row still landed partly under it. Guard: an offset that has to clear a sticky element is
// set from that element's measured height (plus a margin) on start, on resize and when the header's text changes,
// at every guard width and engine height; 0 when the header is not sticky (phone landscape).
async function padPage(position) {
  const resize = [];
  const page = await loadAdmin({ globals: {
    getComputedStyle: () => ({ position }),
    addEventListener: (type, fn) => { if (type === "resize") resize.push(fn); },
  } });
  page.doc.documentElement = { style: {} };
  return { page, resize: (h) => { page.$("top").offsetHeight = h; resize.forEach((fn) => fn()); return page.doc.documentElement.style.scrollPaddingTop; } };
}
test("layout fix-up: scroll-padding-top follows the sticky header's measured height at every guard width and engine", async () => {
  const { resize } = await padPage("sticky");
  // 320/360 px (wrapped top row), 390/768/1280 px, Chromium 60 and Firefox 57 at a 373-px content width
  for (const h of [221, 221, 201, 201, 201, 244, 249]) {
    const pad = resize(h);
    assert.match(String(pad), /^\d+px$/, `set for ${h}`);
    assert.ok(parseInt(pad, 10) >= h, `${pad} clears a ${h}-px header`);
  }
  assert.equal(resize(249), "257px");
});
test("layout fix-up: -webkit-sticky counts as sticky, and a static header (phone landscape) gets 0", async () => {
  assert.equal((await padPage("-webkit-sticky")).resize(230), "238px");
  assert.equal((await padPage("static")).resize(230), "0px");
});
test("layout fix-up: the CSS fallback (before the script has measured) clears the old engines' 249-px header below 375 px", () => {
  const css = readFileSync(new URL("../../viggos-barbershop/admin.css", import.meta.url), "utf8");
  const m = /@media \(max-width: 374px\) \{\s*html \{ scroll-padding-top: (\d+)px; \}/.exec(css);
  assert.ok(m && Number(m[1]) >= 249, "a ≤374-px fallback of at least 249 px");
  assert.ok(css.indexOf(m[0]) < css.indexOf("@media (max-height: 500px)"), "before the landscape rule, which sets 0 and must win");
});

// Fix-up round 2 (c60-admin-320content.png, c60-admin-320-nospin.png): 7.6em was tuned to current Chrome. Chromium 60
// (Samsung Internet 8 is Chromium 63) reserves room inside the date field for the clear, spin and picker controls:
// at 136 px it showed «11/17/2», and with clear and spin hidden «11/17/202», so about 146 px are needed at 16 px.
// Guard: at 359 px and below the field gets at least 9.5em (152 px) with the clear and spin buttons hidden, and the
// row (round buttons, gaps, «I dag») still fits 288 px, also with the margin fallback for browsers without flex gap.
// (The whole value must still be checked by eye in Chromium 60 at a 320-px content width: DEPLOY §4.)
test("layout fix-up: at 359 px and below the date field has room for «11/17/2026» in Chromium 60, and the row fits 288 px", () => {
  const q = "@media (max-width: 359px)";
  const em = /min-width:\s*([\d.]+)em/.exec(ruleIn(q, ".day-nav input"));
  assert.ok(em && Number(em[1]) * 16 >= 146 + 6, `min-width ${em && em[1]}em`);
  const css = readFileSync(new URL("../../viggos-barbershop/admin.css", import.meta.url), "utf8");
  assert.match(css, /\.day-nav input::-webkit-clear-button, \.day-nav input::-webkit-inner-spin-button \{ display: none; \}/);
  const icon = px(ruleIn(q, ".day-nav .icon"), "width");
  const gap = px(ruleIn(q, ".day-nav"), "gap");
  const chipPad = Number(/padding:\s*0\s+(\d+)px/.exec(ruleIn(q, ".day-nav .chip"))[1]);
  const fallbackGap = Number(/@media \(max-width: 359px\) \{ \.day-nav > \* \+ \* \{ margin-left: (\d+)px; \} \}/.exec(css)[1]);
  for (const g of [gap, fallbackGap]) {
    const used = 2 * icon + Number(em[1]) * 16 + (40 + 2 * chipPad) + 3 * g;
    assert.ok(used <= 288, `the row needs ${used} px of 288 (gap ${g})`);
  }
  assert.ok(icon >= 32, "the round buttons stay easy to hit");
});
