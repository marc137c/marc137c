// Static checks of the public site's files (step 6). Each block names the finding it guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDocument } from "../helpers/mini-dom.mjs";

const SITE = fileURLToPath(new URL("../../viggos-barbershop/", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (f) => readFileSync(SITE + f, "utf8");
const readRoot = (f) => readFileSync(ROOT + f, "utf8");
const localUrls = (html) => Array.from(html.matchAll(/\s(?:href|src|action)="([^"]+)"/g), (m) => m[1])
  .filter((u) => !/^(https?:|mailto:|tel:|data:|#)/i.test(u));

// ---------- F75: a branded, Norwegian 404 page ----------
test("F75: 404.html is Norwegian, says the page does not exist and offers the front page, booking and the phone", () => {
  assert.ok(existsSync(SITE + "404.html"), "viggos-barbershop/404.html exists (Netlify serves it with status 404)");
  const html = read("404.html");
  assert.match(html, /<html lang="nb">/);
  assert.match(html, /<title>Siden finnes ikke – Viggo's Barbershop<\/title>/);
  assert.ok(html.includes("Denne siden finnes ikke."), "the plain sentence");
  assert.match(html, /href="\/"/, "a link to the front page");
  assert.match(html, /href="\/#bestill"/, "a link to booking");
  assert.match(html, /href="tel:\+4740963911"[^>]*>409 63 911</, "the phone number as a tel: link");
  assert.doesNotMatch(html, /<form\b/i, "no form");
  assert.match(html, /<meta name="robots" content="noindex">/, "not indexed");
});

test("F75: every local URL in 404.html is root-absolute (the page is served at any depth)", () => {
  const urls = localUrls(read("404.html"));
  assert.ok(urls.length >= 2);
  for (const u of urls) assert.ok(u.startsWith("/"), `${u} starts with /`);
});

// ---------- F66: the header's DOM order is its visual order (Tab follows what the eye sees) ----------
test("F66: in the header the menu comes right after the brand, before the social icons and the language toggle", () => {
  const doc = parseDocument(read("index.html"));
  const nav = doc.querySelector(".site-header .nav");
  const order = nav.children.map((el) => (el.getAttribute("id") ? "#" + el.getAttribute("id") : "." + el.getAttribute("class").split(" ")[0]));
  assert.deepEqual(order, [".brand", "#nav-menu", ".socials", "#lang-toggle", ".nav-toggle"]);
});

// ---------- F89: «Til toppen» targets the body, which starts at y = 0 ----------
test("F89: id=top is on <body>, not on the sticky header, and no rule makes it sticky or fixed", () => {
  const doc = parseDocument(read("index.html"));
  const top = doc.getElementById("top");
  assert.ok(top, "an element with id=top");
  assert.equal(top.localName, "body");
  assert.ok(!doc.querySelector(".site-header").hasAttribute("id"), "the header has no id");
  assert.doesNotMatch(read("styles.css"), /(^|[\s,}])(body|#top)\s*\{[^}]*position:\s*(-webkit-)?(sticky|fixed)/);
  assert.ok(doc.querySelectorAll('a[href="#top"]').length >= 2, "the brand and the footer link still point at it");
});

// ---------- F69: bigger tap targets in the narrow header, without moving anything ----------
test("F69: under 480 px the language toggle and the header icons get invisible ::after hit areas", () => {
  const css = read("styles.css");
  const blocks = Array.from(css.matchAll(/@media \(max-width: 480px\) \{([\s\S]*?)\n\}/g), (m) => m[1]).join("\n");
  assert.match(blocks, /\.lang-toggle \{[^}]*position: relative;/);
  assert.match(blocks, /\.lang-toggle::after \{[^}]*content: "";[^}]*position: absolute;[^}]*top: -11px;[^}]*bottom: -11px;/);
  assert.match(blocks, /\.socials\.header-socials a \{[^}]*position: relative;/);
  assert.match(blocks, /\.socials\.header-socials a::after \{[^}]*content: "";[^}]*position: absolute;[^}]*top: -8px;[^}]*bottom: -8px;/);
});

// ---------- F47: no third-party request before the visitor asks for one ----------
const siteFiles = () => readdirSync(SITE).filter((f) => /\.(html|css|js|webmanifest)$/.test(f));

test("F47: no page, style or script loads Google Fonts", () => {
  for (const f of siteFiles()) {
    const src = read(f);
    assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(src), `${f} references Google Fonts`);
  }
});

test("F47: Cinzel 500/600/700 and Great Vibes 400 are self-hosted: woff2 then woff, swap, files and licence present", () => {
  const css = read("styles.css");
  const faces = Array.from(css.matchAll(/@font-face\s*\{([^}]*)\}/g), (m) => m[1]);
  const got = faces.map((f) => /font-family:\s*"([^"]+)"/.exec(f)[1] + " " + /font-weight:\s*(\d+)/.exec(f)[1]).sort();
  assert.deepEqual(got, ["Cinzel 500", "Cinzel 600", "Cinzel 700", "Great Vibes 400"]);
  for (const f of faces) {
    assert.match(f, /font-display:\s*swap/);
    const urls = Array.from(f.matchAll(/url\("([^"]+)"\)\s*format\("([^"]+)"\)/g), (m) => [m[1], m[2]]);
    assert.deepEqual(urls.map((u) => u[1]), ["woff2", "woff"], "woff2 first, woff for Safari 10 on macOS 10.11");
    for (const [u] of urls) {
      assert.ok(u.startsWith("fonts/"), u);
      assert.ok(existsSync(SITE + u), `${u} exists`);
    }
  }
  const ofl = read("fonts/OFL.txt");
  assert.match(ofl, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(ofl, /Cinzel/);
  assert.match(ofl, /Great Vibes/);
});

test("F47: the map iframe has no src at load, keeps its address in data-src and sends no referrer", () => {
  const doc = parseDocument(read("index.html"));
  const frames = doc.querySelectorAll("iframe");
  assert.equal(frames.length, 1);
  const map = frames[0];
  assert.equal(map.hasAttribute("src"), false, "nothing loads from Google until the visitor asks");
  assert.match(map.getAttribute("data-src"), /^https:\/\/www\.google\.com\/maps\?q=Violgata\+22/);
  assert.equal(map.getAttribute("referrerpolicy"), "no-referrer");
  const btn = doc.getElementById("map-load");
  assert.ok(btn && btn.localName === "button" && btn.getAttribute("type") === "button");
  assert.equal(btn.textContent.trim(), "Vis kart (Google Maps)");
});

// ---------- Round 3 (SPEC R45): the reserve for scroll-padding-top on the front page ----------
// html { scroll-padding-top } keeps «Bestill time» out from under the fixed menu only where the browser uses it for
// anchors (Chrome 69+, Firefox 68+, Safari 14.1+). check-css-assets.mjs makes every such rule name its reserve; here
// it is tested: #bestill gets at least the same room as padding-top inside «@supports not (aspect-ratio: 1)», which
// every browser without scroll-padding reads (aspect-ratio came later in each: Chrome 88, Firefox 89, Safari 15).
test("round 3: the front page's scroll-padding-top has its reserve for browsers without it", () => {
  const css = read("styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const pad = /(^|\})\s*html\s*\{[^}]*scroll-padding-top:\s*(\d+)px/.exec(css);
  assert.ok(pad, "html has scroll-padding-top");
  const at = css.indexOf("@supports not (aspect-ratio: 1)");
  assert.ok(at >= 0, "an «@supports not (aspect-ratio: 1)» block");
  let depth = 0, i = css.indexOf("{", at);
  const start = i;
  for (; i < css.length; i++) { if (css[i] === "{") depth++; else if (css[i] === "}" && --depth === 0) break; }
  const block = css.slice(start + 1, i);
  const reserve = /(^|[\s}])#bestill\s*\{[^}]*padding-top:\s*(\d+)px/.exec(block);
  assert.ok(reserve, "#bestill gets padding-top inside the block");
  assert.ok(Number(reserve[2]) >= Number(pad[2]), `#bestill's ${reserve[2]} px clears the ${pad[2]}-px menu`);
  const SUPPORT = { scrollPadding: { chrome: 69, firefox: 68, safari: 14.1 }, aspectRatio: { chrome: 88, firefox: 89, safari: 15 } };
  for (const b of Object.keys(SUPPORT.scrollPadding)) assert.ok(SUPPORT.aspectRatio[b] >= SUPPORT.scrollPadding[b], b);
});

// Round 3 (still_open 21): the Instagram «Følg oss» button at 320–354 px. Its text («Instagram» + the unbreakable
// «@viggos.barbershop») is wider than a 320-px phone's 288-px content box, so Chromium squashed the round icon (12x30)
// and Firefox 57 let the button run past the 16-px gutter. The icon keeps its size (flex: none, also enforced for every
// icon in a flex box by scripts/check-css-assets.mjs, SPEC R49) and the button may wrap the handle onto its own line,
// centred, never wider than the row. Real-browser check: DEPLOY part 4 (320/340/354/360 px).
test("R49: the follow buttons keep a round icon and wrap the handle instead of growing past the gutter", () => {
  const css = read("styles.css").replace(/\r\n/g, "\n");
  // the bodies of every top-level rule with exactly this selector, joined
  const rule = (sel) => {
    const out = [];
    for (let at = css.indexOf("\n" + sel + " {"); at >= 0; at = css.indexOf("\n" + sel + " {", at + 1)) {
      out.push(css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at)));
    }
    assert.ok(out.length, "styles.css has a top-level «" + sel + "» rule");
    return out.join(";");
  };
  const btn = rule(".btn-follow");
  assert.match(btn, /display: inline-flex;/);
  assert.match(btn, /flex-wrap: wrap;/, "the handle can move to its own line");
  assert.match(btn, /justify-content: center;/, "both lines are centred");
  assert.match(btn, /max-width: 100%;/, "never wider than the row");
  assert.match(rule(".btn-follow svg"), /flex: none;/, "the icon never shrinks");
  const html = read("index.html");
  assert.match(html, /<a class="btn btn-ghost btn-follow" href="https:\/\/www\.instagram\.com\/viggos\.barbershop\/"[^>]*><svg [^>]*>[\s\S]*?<\/svg>Instagram <span class="handle">@viggos\.barbershop<\/span><\/a>/,
    "the Instagram button is icon, name and handle, as the rule assumes");
});
