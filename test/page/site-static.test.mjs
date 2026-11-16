// Static checks of the public site's files (step 6). Each block names the finding it guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
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
