// The Google reviews and Instagram widgets on the front page (reviews.js, social-feed.js, i18n.js), run for real on
// index.html in node:vm (test/helpers/site-page.mjs) with the fixture library in test/fixtures/widgets.mjs.
// Invariants:
//   D10  until /api/reviews is configured (or when it fails), the section shows the owner's three real Google
//        reviews with '5,0 ★★★★★ på Google', initials and links, and the hero badge stays hidden.
//   every string the widgets write into the page is well-formed Unicode (checked once more at the end of the file
//   over everything every test wrote).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSite } from "../helpers/site-page.mjs";
import { REVIEWS, FEATURED, FEATURED_URL, feed } from "../fixtures/widgets.mjs";

const SITES = [];
async function open(scripts, routes, opts = {}) {
  const site = await loadSite(Object.assign({ scripts, routes }, opts));
  SITES.push(site);
  return site;
}
const reviewsPage = (body, opts) => open(["reviews.js"], { "/api/reviews": body && body.status ? body : { body } }, opts);
const socialPage = (body, opts) => open(["social-feed.js"], { "/api/social": body && body.status ? body : { body } }, opts);
const text = (el) => el.textContent.replace(/\s+/g, " ").trim();
const cards = (site) => site.qsa("#reviews .review");

function assertFeatured(site, lang = "no") {
  const list = site.$("reviews");
  assert.equal(list.hidden, false);
  assert.equal(list.getAttribute("aria-busy"), "false");
  const c = cards(site);
  assert.equal(c.length, 3, "three cards");
  FEATURED.forEach((f, i) => {
    const card = c[i];
    assert.equal(text(card.querySelector("figcaption strong")), f.author);
    assert.equal(card.querySelector("figcaption strong a").getAttribute("href"), f.link);
    assert.equal(text(card.querySelector(".review-avatar--initial")), f.initial);
    assert.ok(text(card.querySelector("blockquote")).startsWith(f.starts), f.starts);
    assert.equal(card.querySelector(".stars-row").getAttribute("aria-label"), lang === "en" ? "5 out of 5 stars" : "5 av 5 stjerner");
    assert.equal(text(card.querySelector("small")), lang === "en" ? "Google review" : "Google-anmeldelse");
    assert.ok(card.querySelector(".g-logo"), "the Google logo the owner approved");
  });
  const summary = site.$("rating-summary");
  assert.equal(summary.hidden, false);
  assert.equal(text(summary.querySelector(".rating-num")), lang === "en" ? "5.0" : "5,0");
  assert.equal(text(summary.querySelector(".rating-count")), lang === "en" ? "on Google" : "på Google");
  assert.ok(summary.querySelector(".stars-lg"));
  assert.equal(site.$("reviews-link").getAttribute("href"), FEATURED_URL);
  assert.equal(site.$("hero-rating").hidden, true, "no count is known, so no hero badge");
  assert.ok(!site.qs("#reviews .review--cta"));
}

test("D10: unconfigured, the owner's three real Google reviews show with '5,0 på Google' (Norwegian and English)", async () => {
  const site = await reviewsPage(REVIEWS.unconfigured);
  assertFeatured(site);
  await site.setLang("en");
  assertFeatured(site, "en");
});

test("D10: when /api/reviews fails (network, 500, an HTML error page) the same three reviews show", async () => {
  for (const ans of [{ network: true }, { status: 500, body: { error: "x" } }, { status: 502, body: "<html>Bad gateway</html>" }]) {
    const site = await open(["reviews.js"], { "/api/reviews": ans });
    assertFeatured(site);
  }
});

test("reviews: a configured answer shows the summary and up to four cards with text", async () => {
  const site = await reviewsPage(REVIEWS.many);
  assert.equal(site.$("rating-summary").hidden, false);
  assert.equal(text(site.$("rating-summary").querySelector(".rating-num")), "4,7");
  assert.deepEqual(cards(site).map((c) => text(c.querySelector("figcaption strong"))), ["Fixture Kunde 1", "Fixture Kunde 3", "Fixture Kunde 4", "Fixture Kunde 5"]);
  assert.equal(site.$("reviews-link").getAttribute("href"), REVIEWS.many.url);
});

test("reviews: only https links and photos are used; text is escaped", async () => {
  const site = await reviewsPage(REVIEWS.rtl);
  const second = cards(site)[1];
  assert.equal(second.querySelector("figcaption strong a"), null, "a javascript: author link is not linked");
  assert.equal(second.querySelector("img"), null, "an http photo is not loaded");
  assert.ok(second.querySelector(".review-avatar--initial"));
  assert.equal(second.querySelector("blockquote b"), null, "markup in a review stays text");
  assert.ok(text(second.querySelector("blockquote")).includes("<b>ikke fet</b>"));
  assert.ok(!site.html.some((w) => /javascript:/i.test(w.html)), "no javascript: URL is written anywhere");
});

test("social: posts render as links to Instagram with their images", async () => {
  const site = await socialPage(feed(2));
  const posts = site.qsa("#social-feed .post:not(.post--follow)");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].getAttribute("href"), "https://www.instagram.com/p/Fixture1/");
  assert.equal(posts[0].querySelector("img").getAttribute("src"), feed(2).instagram[0].image);
  assert.equal(site.$("social-feed").getAttribute("aria-busy"), "false");
});

// F84: Places content shown without a Google map is attributed with the text 'Google Maps' (translate="no"),
// not a hand-drawn logo: in the summary, on every card and in the hero badge.
test("F84: Google data is attributed 'Google Maps' in the summary, every card and the hero badge, in both languages", async () => {
  for (const lang of ["no", "en"]) {
    const site = await reviewsPage(REVIEWS.many, { lang: lang === "en" ? "en" : null });
    const places = [site.$("rating-summary"), ...cards(site), site.$("hero-rating")];
    assert.equal(places.length, 6);
    for (const el of places) {
      assert.equal(el.hidden, false);
      const attr = el.querySelectorAll("[translate=no]").filter((x) => text(x) === "Google Maps");
      assert.equal(attr.length, 1, `${lang}: one 'Google Maps' label in ${el.outerHTML.slice(0, 80)}`);
      assert.equal(el.querySelector(".g-logo"), null, "no hand-drawn G logo next to Places data");
    }
    assert.equal(text(site.$("rating-summary").querySelector(".rating-count")), lang === "en" ? "based on 41 reviews on Google Maps" : "basert på 41 anmeldelser på Google Maps");
    assert.equal(text(site.$("hero-rating")), lang === "en" ? "4.7 on Google Maps · 41 reviews" : "4,7 på Google Maps · 41 anmeldelser");
  }
  // The owner's FEATURED reviews are not Places data and keep their look (D10)
  assertFeatured(await reviewsPage(REVIEWS.unconfigured));
});

test("F51: one review is 'anmeldelse' / 'review', two are plural, in the strings and on the page", async () => {
  const site = await reviewsPage(REVIEWS.one);
  const no = site.s();
  assert.equal(no.basedOn(1), "basert på 1 anmeldelse på Google Maps");
  assert.equal(no.heroRating("5,0", 1), "5,0 på Google Maps · 1 anmeldelse");
  assert.equal(no.basedOn(2), "basert på 2 anmeldelser på Google Maps");
  assert.equal(no.heroRating("4,5", 2), "4,5 på Google Maps · 2 anmeldelser");
  assert.equal(text(site.$("rating-summary").querySelector(".rating-count")), "basert på 1 anmeldelse på Google Maps");
  await site.setLang("en");
  const en = site.s();
  assert.equal(en.basedOn(1), "based on 1 review on Google Maps");
  assert.equal(en.heroRating("5.0", 1), "5.0 on Google Maps · 1 review");
  assert.equal(en.basedOn(2), "based on 2 reviews on Google Maps");
  assert.equal(en.heroRating("4.5", 2), "4.5 on Google Maps · 2 reviews");
  assert.equal(text(site.$("rating-summary").querySelector(".rating-count")), "based on 1 review on Google Maps");
  const two = await reviewsPage(REVIEWS.two);
  assert.equal(text(two.$("rating-summary").querySelector(".rating-count")), "basert på 2 anmeldelser på Google Maps");
});

// F76: Places policy: each review links to itself on Google Maps (googleMapsUri), and the page says how the
// reviews shown were picked and ordered.
const NOTE_NO = "Et utvalg av anmeldelsene med tekst, i den rekkefølgen Google Maps viser dem (mest relevante først).";
const NOTE_EN = "A selection of the reviews with text, in the order Google Maps shows them (most relevant first).";
test("F76: every Google card links to the review on Google Maps, and one line says how the reviews are picked and ordered", async () => {
  const site = await reviewsPage(REVIEWS.many);
  const shown = [1, 3, 4, 5];
  cards(site).forEach((c, i) => {
    const a = c.querySelectorAll("a.review-more");
    assert.equal(a.length, 1);
    assert.equal(a[0].getAttribute("href"), `https://www.google.com/maps/reviews/data=fixture-review-${shown[i]}`);
    assert.equal(a[0].getAttribute("target"), "_blank");
    assert.equal(a[0].getAttribute("rel"), "noopener");
    assert.equal(text(a[0]), "Les hele på Google");
  });
  const notes = site.qsa("#reviews .reviews-note");
  assert.equal(notes.length, 1);
  assert.equal(text(notes[0]), NOTE_NO);
  assert.equal(notes[0].querySelector("[translate=no]").textContent, "Google Maps");
  await site.setLang("en");
  assert.deepEqual(site.qsa("#reviews a.review-more").map(text), ["Read on Google", "Read on Google", "Read on Google", "Read on Google"]);
  assert.equal(text(site.qs("#reviews .reviews-note")), NOTE_EN);

  // A link that is not https is left out, the card stays
  const rtl = await reviewsPage(REVIEWS.rtl);
  assert.equal(cards(rtl).length, 2);
  assert.equal(cards(rtl)[0].querySelectorAll("a.review-more").length, 1);
  assert.equal(cards(rtl)[1].querySelectorAll("a.review-more").length, 0);

  // The owner's FEATURED reviews are picked by the owner: no Google ordering note and no extra links
  const featured = await reviewsPage(REVIEWS.unconfigured);
  assert.equal(featured.qsa("#reviews .reviews-note").length, 0);
  assert.equal(featured.qsa("#reviews a.review-more").length, 0);
  assertFeatured(featured);
});

test("widgets: every string reviews.js, social-feed.js and i18n.js wrote in this file is well-formed Unicode", () => {
  const writes = SITES.reduce((all, s) => all.concat(s.html), []);
  assert.ok(writes.length > 20, `${writes.length} writes checked`);
  const bad = writes.filter((w) => !w.html.isWellFormed());
  assert.deepEqual(bad.map((w) => `#${w.id}: ${JSON.stringify(w.html.slice(0, 120))}`), []);
});
