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
