// Round 3 (still_open 20): «Sist oppdatert 16. november 2026» on personvern.html was already wrong (the counter
// paragraph changed on the 17th), and DEPLOY §6 asked for one more text change before publishing, so it would have
// been wrong again: a hand-written date that no rule tied to the page's content. Guard: scripts/stamp-privacy.mjs
// keeps the date as the date of the last change to the page's text. scripts/personvern-stamp.json holds that date and
// a fingerprint of the text; npm test (which Netlify runs before every deploy) fails while the text differs from the
// fingerprint, so a page whose text changed without a new date never builds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PAGE, STAMP, content, fingerprint, shownDate, norwegianDate, osloToday, problems, restamp } from "../../scripts/stamp-privacy.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (f) => readFileSync(ROOT + f, "utf8");
const page = () => read(PAGE);
const stamp = () => JSON.parse(read(STAMP));

test("stamp-privacy: «Sist oppdatert» on personvern.html is the stamped date, and the text is the stamped text", () => {
  assert.deepEqual(problems(page(), stamp()), [], "run node scripts/stamp-privacy.mjs after changing personvern.html");
  const shown = shownDate(page());
  assert.match(page(), new RegExp(`Sist oppdatert <time datetime="${shown.iso}">${norwegianDate(shown.iso)}</time>\\.`));
});

test("stamp-privacy: a text change, a link change or a new paragraph needs a new stamp; markup, spacing and the date line do not", () => {
  const html = page();
  const s = stamp();
  const changed = [
    html.replace("Formålet er å gi deg timen du ber om.", "Formålet er å gi deg timen."),
    html.replace('href="https://www.netlify.com/privacy/"', 'href="https://www.netlify.com/privacy-old/"'),
    html.replace("<h2>Dine rettigheter</h2>", "<h2>Dine rettigheter</h2>\n      <p>Ny setning.</p>"),
  ];
  for (const c of changed) {
    assert.notEqual(c, html, "the fixture edit applies");
    assert.ok(problems(c, s).some((p) => /run node scripts\/stamp-privacy\.mjs/.test(p)), "a changed text fails until it is stamped");
  }
  const same = [
    html.replace(/\r?\n/g, "\r\n"),
    html.replace("<p>Formålet er", "<p>\n        Formålet er"),
    html.replace(/(<p class="small">Sist oppdatert <time datetime=")[^"]+(">)[^<]+/, (m, a, b) => `${a}2030-01-02${b}2. januar 2030`),
    html.replace("// Besøksteller uten informasjonskapsler", "// Besøksteller"),
  ];
  for (const c of same) assert.equal(content(c), content(html), "not a change of the text");
});

test("stamp-privacy: the stamp step gives a changed text today's Oslo date and leaves an unchanged one alone", () => {
  const html = page();
  const s = stamp();
  const again = restamp(html, s, "2031-05-06");
  assert.deepEqual(again.stamp, s, "an unchanged text keeps its date, whatever day the step runs");
  assert.equal(again.html, html);
  const edited = html.replace("Formålet er å gi deg timen du ber om.", "Formålet er å gi deg timen.");
  const next = restamp(edited, s, "2031-05-06");
  assert.deepEqual(next.stamp, { date: "2031-05-06", text: fingerprint(edited) });
  assert.match(next.html, /Sist oppdatert <time datetime="2031-05-06">6\. mai 2031<\/time>\./);
  assert.deepEqual(problems(next.html, next.stamp), []);
  assert.deepEqual(problems(edited, s).length, 1, "before the step: one problem");
  // the page states the date in Norwegian, and today is the Oslo date (23:30 UTC on 31 Dec is already 1 Jan in Oslo)
  assert.equal(norwegianDate("2026-11-17"), "17. november 2026");
  assert.equal(osloToday(new Date("2026-12-31T23:30:00Z")), "2027-01-01");
  assert.equal(osloToday(new Date("2026-07-01T21:59:00Z")), "2026-07-01");
  assert.equal(osloToday(new Date("2026-07-01T22:00:00Z")), "2026-07-02");
});

test("stamp-privacy: a page whose date reads otherwise than its datetime, or has no date line, fails", () => {
  const html = page();
  const s = stamp();
  const wrongText = html.replace(/(<time datetime="[^"]+">)[^<]+/, (m, a) => `${a}16. november 2026`);
  assert.ok(problems(wrongText, s).some((p) => /datetime/.test(p)));
  const noLine = html.replace(/<p class="small">Sist oppdatert[^\n]*<\/p>/, "");
  assert.ok(problems(noLine, s).length > 0);
  assert.equal(restamp(noLine, s, "2031-05-06").html, null, "the step does not invent a place for the date");
});

test("stamp-privacy: --check exits 0 on the repository, and DEPLOY says when to run the step", () => {
  const r = spawnSync(process.execPath, [ROOT + "scripts/stamp-privacy.mjs", "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const deploy = read("DEPLOY.md");
  assert.ok(deploy.slice(0, deploy.indexOf("## 2.")).includes("node scripts/stamp-privacy.mjs --check"), "DEPLOY §1 checks the date before publishing");
  const six = deploy.slice(deploy.indexOf("## 6."));
  assert.ok(six.includes("node scripts/stamp-privacy.mjs"), "DEPLOY §6: a text change after the approval is stamped");
});
