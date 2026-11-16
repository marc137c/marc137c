// Owner decision D5: Norwegian is the default for every visitor (en-US, sv-SE, no language at all). English shows
// only when the visitor chooses it (the toggle or ?lang=en), and that choice is remembered (F13). Toggling after
// arriving with ?lang= rewrites the parameter, so a reload keeps what the visitor chose last (F52).
// Runs the real i18n.js on the real index.html (test/helpers/site-page.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSite } from "../helpers/site-page.mjs";
import { click } from "../helpers/mini-dom.mjs";

const htmlLang = (site) => site.doc.documentElement.getAttribute("lang");

for (const languages of [["en-US", "en"], ["sv-SE"], ["de-DE", "en-GB"], []]) {
  test(`D5/F13: a first visit with browser languages ${JSON.stringify(languages)} gets Norwegian`, async () => {
    const site = await loadSite({ languages });
    assert.equal(site.I18N.lang, "no");
    assert.equal(htmlLang(site), "no");
    assert.equal(site.$("lang-toggle").querySelector(".lang-label").textContent, "English", "the toggle offers English");
  });
}

test("D5/F13: ?lang=en gives English, and so does a saved choice of English", async () => {
  const viaUrl = await loadSite({ search: "?lang=en", languages: ["nb-NO"] });
  assert.equal(htmlLang(viaUrl), "en");
  const saved = await loadSite({ languages: ["nb-NO"], before: (ctx) => ctx.localStorage.setItem("lang", "en") });
  assert.equal(htmlLang(saved), "en");
  const savedNo = await loadSite({ languages: ["en-US"], before: (ctx) => ctx.localStorage.setItem("lang", "no") });
  assert.equal(htmlLang(savedNo), "no");
  const junk = await loadSite({ languages: ["en-US"], before: (ctx) => ctx.localStorage.setItem("lang", "fr") });
  assert.equal(htmlLang(junk), "no", "an unknown saved value is Norwegian");
});

test("D5/F13: choosing English with the toggle is remembered on the next visit", async () => {
  const first = await loadSite({ languages: ["nb-NO"] });
  click(first.$("lang-toggle"));
  assert.equal(htmlLang(first), "en");
  const next = await loadSite({ languages: ["nb-NO"], storage: first.storage });
  assert.equal(htmlLang(next), "en");
});

test("F52: arriving with ?lang=en and toggling rewrites the address to lang=no, and a reload stays Norwegian", async () => {
  const site = await loadSite({ search: "?lang=en&x=1", languages: ["en-US"] });
  assert.equal(htmlLang(site), "en");
  click(site.$("lang-toggle"));
  assert.equal(htmlLang(site), "no");
  assert.equal(site.replaced.length, 1, "one history.replaceState");
  assert.match(site.replaced[0], /^\/\?lang=no&x=1$/);
  const reload = await loadSite({ search: site.location.search, languages: ["en-US"], storage: site.storage });
  assert.equal(htmlLang(reload), "no");
});

test("F52: without a lang parameter the toggle leaves the address alone", async () => {
  const site = await loadSite({ search: "?x=1" });
  click(site.$("lang-toggle"));
  assert.equal(htmlLang(site), "en");
  assert.deepEqual(site.replaced, []);
});

test("F52: a browser without history.replaceState still switches language", async () => {
  const site = await loadSite({ search: "?lang=no", before: (ctx) => { ctx.history = {}; } });
  click(site.$("lang-toggle"));
  assert.equal(htmlLang(site), "en");
});
