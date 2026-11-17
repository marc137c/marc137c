// SPEC D14: the owner's content decisions of 2026-11-16, in both languages, on the real index.html with i18n.js.
// Round 3 (ledger): these were carried over by hand and had no D-row and no test, so a merge or an edit could revert
// any of them with every test green (mutation demo: tagline, a «Timebestilling» eyebrow and lead, the placeholder,
// a «30 min» on Full service and the combo moved to 2nd with another text all passed 1189/1189).
//   1. the hero tagline is «Velkommen til Viggo's Barbershop» («Welcome to Viggo's Barbershop»);
//   2. «Bestill time» has no eyebrow (no «Timebestilling») and no lead sentence: its section head is the heading only;
//   3. the service dropdown's placeholder is «– Velg –» («– Choose –»);
//   4. each service's svc-dur label matches CONFIG.durations: 60 → «1 time»/«1 hour», 30 → «30 min»;
//   5. the services list and the dropdown have the same order, with «Herreklipp + skjeggtrim» 5th, and its text is
//      «Hårklipp og skjeggtrim med maskin (samme lengde på hele skjegget uten forming og linjer).».
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSite } from "../helpers/site-page.mjs";
import { CONFIG } from "../../netlify/lib/booking-core.mjs";

const COMBO = "Herreklipp + skjeggtrim";
const ORDER = ["Full service", "Herreklipp", "Knivbarbering", "Skjegg & line-up", COMBO, "Barneklipp"];
const TEXT = {
  no: { tag: "Velkommen til Viggo's Barbershop", book: "Bestill time", choose: "– Velg –", dur: { 60: "1 time", 30: "30 min" },
    combo: "Hårklipp og skjeggtrim med maskin (samme lengde på hele skjegget uten forming og linjer)." },
  en: { tag: "Welcome to Viggo's Barbershop", book: "Book an appointment", choose: "– Choose –", dur: { 60: "1 hour", 30: "30 min" },
    combo: "Haircut and clipper beard trim (same length on the whole beard, no shaping or lines)." },
};
const clean = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);

for (const lang of ["no", "en"]) {
  const want = TEXT[lang];
  const site = () => loadSite(lang === "en" ? { lang: "en" } : {});

  test(`D14 (${lang}): the hero tagline is «${want.tag}»`, async () => {
    const s = await site();
    assert.equal(clean(s.doc.querySelector('[data-i18n="hero.tag"]')), want.tag);
  });

  test(`D14 (${lang}): «${want.book}» has no eyebrow and no lead sentence, only its heading`, async () => {
    const s = await site();
    const head = s.doc.querySelector("#bestill .section-head");
    assert.ok(head, "#bestill has a section head");
    assert.deepEqual(head.children.map((c) => c.localName), ["h2"], "the heading only");
    assert.equal(clean(head.children[0]), want.book);
    assert.equal(s.doc.querySelector("#bestill .eyebrow"), null, "no eyebrow");
    assert.doesNotMatch(clean(s.doc.getElementById("bestill")), /Timebestilling/);
  });

  test(`D14 (${lang}): the service dropdown's placeholder is «${want.choose}»`, async () => {
    const s = await site();
    const first = s.doc.querySelector("#f-service option");
    assert.equal(first.getAttribute("value"), "");
    assert.equal(clean(first), want.choose);
  });

  test(`D14 (${lang}): the services list and the dropdown share one order with the combo 5th, and every svc-dur matches CONFIG.durations`, async () => {
    const s = await site();
    const items = s.doc.querySelectorAll("#tjenester .svc-link[data-service]");
    assert.deepEqual(items.map((a) => a.getAttribute("data-service")), ORDER, "the services list");
    const opts = s.doc.querySelectorAll("#f-service option").filter((o) => o.getAttribute("value"));
    assert.deepEqual(opts.map((o) => o.getAttribute("value")), ORDER, "the dropdown");
    assert.deepEqual(Object.keys(CONFIG.durations).sort(), ORDER.slice().sort(), "CONFIG has exactly these services");
    for (const a of items) {
      const service = a.getAttribute("data-service");
      const min = CONFIG.durations[service];
      assert.equal(clean(a.querySelector(".svc-dur")), want.dur[min], `${service}: ${min} min`);
    }
    assert.equal(CONFIG.durations["Full service"], 60, "Full service is 60 min (D7)");
    for (const name of ORDER.filter((n) => n !== "Full service")) assert.equal(CONFIG.durations[name], 30, name + " is 30 min (D7)");
  });

  test(`D14 (${lang}): «${COMBO}» carries the owner's text`, async () => {
    const s = await site();
    const combo = s.doc.querySelector(`#tjenester .svc-link[data-service="${COMBO}"]`);
    assert.equal(clean(combo.querySelector('[data-i18n="s.combo.d"]')), want.combo);
  });
}
