// /admin layout rules that keep the page usable on phones and in old browsers. These read the real admin.html and
// admin.css (no browser is started), plus one run of admin.js in the fake DOM. Invariants:
//   1. the sticky header's top row holds only the title, the sync status, «Se nettsiden» and «Oppsett», with a
//      smaller gap at 430 px and below (also where flex gap is missing), so it stays one line on 390–412 px phones;
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
