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
