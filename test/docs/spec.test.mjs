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

// Round 3 (ledger): owner decisions about visible text were carried over by hand without a D-row, so nothing tested
// them. The brief's owner decisions are listed here, each with the D-row that carries it and words that row must
// contain; every D-row must carry at least one of them. A new decision in the brief gets a line here, and this test
// fails until SPEC.md has its row (and the row names its test, above).
const OWNER_DECISIONS = [
  ["nothing is ever sent to a phone number (test/no-sms.test.mjs)", "D1", /Nothing is ever sent to a phone number/],
  ["no Netlify Forms copy", "D2", /No Netlify Forms copy/],
  ["API failure or uncertain outcome: call 409 63 911", "D3", /409 63 911/],
  ["no automatic holidays; a fully blocked day is closed everywhere", "D4", /No automatic holidays.*closed everywhere/],
  ["Norwegian is the default, English only by choice", "D5", /Norwegian is the default/],
  ["personvern.html states verified facts only", "D6", /verified facts only/],
  ["bookings are deleted 90 days after the appointment", "D6", /deleted 90 days after the appointment/],
  ["Full service 60 min, every other service 30 min", "D7", /Full service 60 min, every other service 30 min/],
  ["canonical, og:url and JSON-LD on the owner's domain", "D8", /https:\/\/www\.viggosbarbershop\.no\//],
  ["browser targets", "D9", /Safari\/iOS 10\+, Chrome 60\+, Firefox 55\+ and Samsung 8\+/],
  ["FEATURED Google reviews while /api/reviews is unconfigured", "D10", /FEATURED/],
  ["same-day lead time 15 minutes", "D11", /15 minutes ahead/],
  ["cookie-free visitor statistics, the owner's only", "D12", /Statistics are the owner's only/],
  ["logo padding keeps the whole V", "D13", /whole V/],
  ["hero tagline «Velkommen til Viggo's Barbershop»", "D14", /Velkommen til Viggo's Barbershop/],
  ["no «Timebestilling» eyebrow or lead sentence", "D14", /no eyebrow \('Timebestilling'\) and no lead sentence/],
  ["dropdown placeholder «– Velg –»", "D14", /'– Velg –'/],
  ["svc-dur labels", "D14", /svc-dur label from `CONFIG\.durations`/],
  ["«Herreklipp + skjeggtrim» 5th with the owner's text", "D14", /'Herreklipp \+ skjeggtrim' is 5th.*'Hårklipp og skjeggtrim med maskin \(samme lengde på hele skjegget uten forming og linjer\)\.'/],
  ["the status line is red (class closed) whenever the shop is not open", "D14", /red \(class `closed`\) whenever the shop is not open/],
];

test("spec: every owner decision in the brief has its D-row, and every D-row carries a decision from the brief", () => {
  const byId = new Map(rows(read()).filter((r) => r.id.startsWith("D")).map((r) => [r.id, r]));
  for (const [what, id, words] of OWNER_DECISIONS) {
    assert.ok(byId.has(id), `«${what}» needs SPEC row ${id}`);
    assert.match(byId.get(id).text, words, `${id} states «${what}»`);
  }
  const carried = new Set(OWNER_DECISIONS.map(([, id]) => id));
  for (const id of byId.keys()) assert.ok(carried.has(id), `${id} is listed in OWNER_DECISIONS in test/docs/spec.test.mjs`);
});
