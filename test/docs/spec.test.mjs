// docs/SPEC.md lists the owner's decisions and the plan's rules, each with the test that enforces it (RC7).
// Invariants: every D…/R… row names at least one enforcing file (test/… or scripts/…); a row whose status is
// "now" is enforced today, so every file it names exists; the privacy facts and domain match the owner's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SPEC = join(ROOT, "docs", "SPEC.md");
const read = () => readFileSync(SPEC, "utf8");

// | D1 | decision | `test/x.test.mjs`, … | now |
function rows(src) {
  return src.split(/\r?\n/).filter((l) => /^\|\s*[DR]\d+\s*\|/.test(l)).map((l) => {
    const cells = l.split("|").slice(1, -1).map((c) => c.trim());
    return { id: cells[0], text: cells[1], enforcedBy: cells[2] || "", status: cells[3] || "", line: l };
  });
}
const paths = (cell) => Array.from(cell.matchAll(/`((?:test|scripts|netlify|viggos-barbershop)\/[^`\s]+)`/g), (m) => m[1]);

test("spec: docs/SPEC.md exists and lists owner decisions (D…) and plan rules (R…)", () => {
  assert.ok(existsSync(SPEC), "docs/SPEC.md exists");
  const r = rows(read());
  assert.ok(r.some((x) => x.id.startsWith("D")), "has D rows");
  assert.ok(r.some((x) => x.id.startsWith("R")), "has R rows");
  assert.equal(new Set(r.map((x) => x.id)).size, r.length, "row ids are unique");
});

test("spec: every rule names the file that enforces it, and 'now' rules name files that exist", () => {
  for (const r of rows(read())) {
    const p = paths(r.enforcedBy);
    assert.ok(p.some((x) => /^(test|scripts)\//.test(x)), `${r.id} names a test/ or scripts/ file: ${r.line}`);
    assert.match(r.status, /^(now|steps? \d(?:[-,] ?\d)*)$/, `${r.id} status is 'now' or 'step N': ${r.line}`);
    if (r.status === "now") for (const x of p) assert.ok(existsSync(join(ROOT, x)), `${r.id} is 'now' but ${x} does not exist`);
  }
});

test("spec: the decisions the owner gave are on the page", () => {
  const s = read();
  for (const fact of ["409 63 911", "Viggos Barbershop Kurti", "937 845 812", "Violgata 22, 1776 Halden", "kurtivigan1@gmail.com",
    "6(1)(b)", "Datatilsynet", "90 days", "https://www.viggosbarbershop.no", "'Herreklipp + skjeggtrim' = 30", "6 per 24 h"]) {
    assert.ok(s.includes(fact), "SPEC.md mentions " + fact);
  }
});
