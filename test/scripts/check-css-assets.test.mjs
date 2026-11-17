// scripts/check-css-assets.mjs, the background-clip:text rule (owner decision D13, merged from main 99e374e). Root
// cause: gold text is painted only inside the element's box, and the script font's loops (the V of «Viggo's», the g)
// reach above and below a line-height of 1, so with no padding there they were cut off. Rule: a CSS rule with
// background-clip: text (also -webkit-) has padding of at least .3em above and .15em below in that same rule
// (shorthand or longhand). Invariant: each bad case fails the check, each good one passes, and the real site and the
// owner's overview (oversikt/public) pass as `npm run check` runs them.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "check-css-assets.mjs");
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function check(css) {
  const dir = mkdtempSync(join(tmpdir(), "css-check-"));
  dirs.push(dir);
  writeFileSync(join(dir, "site.css"), css);
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}
const GOLD = "background: linear-gradient(#c9a227, #f5e6a8); -webkit-background-clip: text; background-clip: text; color: transparent;";

const BAD = [
  ["no padding", `.logo { ${GOLD} }`],
  ["side padding only (the cut V)", `.logo { ${GOLD} padding: 0 .35em; margin: 0 -.2em; }`],
  ["too little above", `.logo { ${GOLD} padding: .2em .35em .2em; }`],
  ["too little below", `.logo { ${GOLD} padding: .35em .35em .1em; }`],
  ["one value too small", `.logo { ${GOLD} padding: .1em; }`],
  ["px instead of em", `.logo { ${GOLD} padding: 12px 8px 6px; }`],
  ["-webkit- only", ".logo { -webkit-background-clip: text; color: transparent; padding: 0 .3em; }"],
  ["longhand too small", `.logo { ${GOLD} padding-top: .25em; padding-bottom: .2em; }`],
];
const GOOD = [
  ["main's .logo-script", `.logo-script { ${GOLD} padding: .35em .45em .2em; margin: -.35em 0 -.1em; }`],
  ["main's .brand-script", `.brand-script { ${GOLD} padding: .35em .35em .2em; margin: -.35em -.2em -.2em; }`],
  ["one value", `.logo { ${GOLD} padding: .3em; }`],
  ["two values", `.logo { ${GOLD} padding: .3em .5em; }`],
  ["longhands", `.logo { ${GOLD} padding-top: .3em; padding-bottom: .15em; }`],
  ["no clip text", ".logo { background: #000; padding: 0; }"],
];

for (const [label, css] of BAD) {
  test(`check-css-assets: background-clip:text with ${label} fails`, () => {
    const r = check(css);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /background-clip: text trenger padding over \(minst \.3em\) og under \(minst \.15em\)/);
  });
}
for (const [label, css] of GOOD) {
  test(`check-css-assets: ${label} passes`, () => {
    const r = check(css);
    assert.equal(r.status, 0, r.out);
  });
}

test("check-css-assets: the site and the owner's overview pass, and npm run check covers both", async () => {
  for (const dir of ["viggos-barbershop", join("oversikt", "public")]) {
    const r = spawnSync(process.execPath, [SCRIPT, dir], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, dir + ": " + r.stdout + r.stderr);
  }
  const { default: pkg } = await import("../../package.json", { with: { type: "json" } });
  for (const part of ["node scripts/check-es2015.mjs oversikt/public", "node scripts/check-css-assets.mjs oversikt/public"]) {
    assert.ok(pkg.scripts.check.includes(part), "npm run check runs: " + part);
  }
});

// Round 3 (still_open 20, SPEC R45): /admin kept focus out from under its sticky header with scroll-padding-top alone.
// Chrome < 69 (Samsung Internet < 10) and Firefox < 68 do not use it when focus or an anchor moves the page, and Safari
// before 14.1 only for scroll snapping, so the focused row stayed hidden there. Rule: a scroll-padding-* or
// scroll-margin-* value other than 0/auto names, in the same rule, what does the job in those browsers
// («/* reserve: … */»), and that reserve has its own test. Zero needs none (it relies on nothing).
const SCROLL_BAD = [
  ["scroll-padding-top without a reserve", "html { scroll-padding-top: 210px; }"],
  ["scroll-padding shorthand", "html { scroll-padding: 80px 0 0; }"],
  ["scroll-margin-top on a section", "#bestill { scroll-margin-top: 76px; }"],
  ["inside a media query", "@media (max-width: 374px) { html { scroll-padding-top: 256px; } }"],
  ["a reserve comment in another rule", "/* reserve: x */ html { scroll-padding-top: 76px; }"],
];
const SCROLL_GOOD = [
  ["a named reserve", "html { scroll-padding-top: 210px; /* reserve: clearOfTop i admin.js */ }"],
  ["zero", "@media (max-height: 500px) { html { scroll-padding-top: 0; } }"],
  ["auto", "html { scroll-padding-top: auto; }"],
];
for (const [label, css] of SCROLL_BAD) {
  test(`check-css-assets: ${label} fails`, () => {
    const r = check(css);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /virker ikke for fokus og ankre i Chrome < 69/);
  });
}
for (const [label, css] of SCROLL_GOOD) {
  test(`check-css-assets: scroll offset with ${label} passes`, () => {
    const r = check(css);
    assert.equal(r.status, 0, r.out);
  });
}

// Round 3 (still_open 21): at 320–354 px the Instagram «Følg oss» button squashed its round icon into an oval in
// Chromium (12x30 at 320 px) and ran past the 16-px gutter in Firefox 57. Root cause: the svg is a flex item of the
// inline-flex .btn-follow with the default flex-shrink: 1, and the unbreakable «@viggos.barbershop» made the content
// wider than the box; Chromium shrank the icon, Firefox kept its minimum and grew the button. Layout checks tested only
// overflow, never shape. Rule (SPEC R49): every «.x svg» / «.x img» rule whose .x is a flex or inline-flex box has a
// «.x svg» (or img) rule with flex: none, flex: 0 0 …, or flex-shrink: 0.
const ICON_BAD = [
  ["an icon in an inline-flex button", ".b { display: inline-flex; } .b svg { width: 18px; height: 18px; }"],
  ["an icon in a flex row", ".row { display: flex; gap: 6px; } .row img { width: 40px; }"],
  ["only a variant sets colours", ".b { display: inline-flex; } .b[href*=\"x\"] svg { background: red; }"],
  ["flex: 1 does not count", ".b { display: inline-flex; } .b svg { flex: 1; }"],
  ["the fix inside a media query only", ".b { display: inline-flex; } .b svg { width: 18px; } @media (max-width: 359px) { .b svg { flex: none; } }"],
];
const ICON_GOOD = [
  ["flex: none", ".b { display: inline-flex; } .b svg { width: 18px; flex: none; }"],
  ["flex-shrink: 0", ".b { display: flex; } .b > svg { width: 18px; flex-shrink: 0; }"],
  ["flex: 0 0 auto in another rule", ".b { display: inline-flex; } .b svg { width: 18px; } .b svg { flex: 0 0 auto; }"],
  ["not a flex box", ".b { display: block; } .b svg { width: 18px; }"],
  ["a marked exception", ".b { display: flex; } .b img { position: absolute; /* compat-ok: not a flex item */ }"],
];
for (const [label, css] of ICON_BAD) {
  test(`check-css-assets: ${label} without flex: none fails`, () => {
    const r = check(css);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /flex-element og krymper/);
  });
}
for (const [label, css] of ICON_GOOD) {
  test(`check-css-assets: icon in a flex box with ${label} passes`, () => {
    const r = check(css);
    assert.equal(r.status, 0, r.out);
  });
}
