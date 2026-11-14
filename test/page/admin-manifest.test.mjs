// /admin as a Home Screen app: iPhone gets web push only from the Home Screen (iOS 16.4+), which needs a web app
// manifest with display standalone, and an apple-touch-icon for the icon. Invariants:
//   1. admin.html links the manifest, a 180×180 PNG apple-touch-icon and an icon, and names the app «Timebok»;
//   2. the manifest is valid JSON that opens /admin standalone, with its scope limited to /admin (never the public
//      site), Norwegian names, the page's theme colour, and icons whose PNG sizes match what it says (incl. a
//      maskable one for Android);
//   3. the service worker lives at the site root (so it may take the /admin scope without extra headers) and
//      Netlify serves the manifest as JSON and never lets a stale service worker linger.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SITE = ROOT + "viggos-barbershop/";
const html = readFileSync(SITE + "admin.html", "utf8");
const head = html.slice(0, html.indexOf("</head>"));
const pngSize = (file) => { const b = readFileSync(SITE + file.replace(/^\//, "")); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const link = (rel) => (new RegExp(`<link rel="${rel}"[^>]*href="([^"]+)"`).exec(head) || [])[1];

test("admin manifest: admin.html links the manifest, the apple-touch-icon and an icon", () => {
  assert.equal(link("manifest"), "admin.webmanifest");
  assert.equal(link("apple-touch-icon"), "admin-icon-180.png");
  assert.deepEqual(pngSize(link("apple-touch-icon")), [180, 180], "iPhone's Home Screen icon size");
  assert.equal(link("icon"), "admin-icon-192.png");
  assert.match(head, /<meta name="apple-mobile-web-app-title" content="Timebok">/);
  assert.match(head, /<meta name="apple-mobile-web-app-capable" content="yes">/);
});

test("admin manifest: opens /admin standalone, scoped to /admin, Norwegian, with icons of the stated sizes", () => {
  const m = JSON.parse(readFileSync(SITE + "admin.webmanifest", "utf8"));
  assert.equal(m.start_url, "/admin");
  assert.equal(m.scope, "/admin", "the public site stays outside the app");
  assert.equal(m.id, "/admin");
  assert.equal(m.display, "standalone", "iPhone gives web push only to a standalone Home Screen app");
  assert.equal(m.short_name, "Timebok");
  assert.match(m.name, /^Timebok/);
  assert.equal(m.lang, "nb");
  const theme = /<meta name="theme-color" content="([^"]+)">/.exec(head)[1];
  assert.equal(m.theme_color, theme);
  assert.equal(m.background_color, theme);
  assert.ok(m.icons.length >= 2);
  for (const icon of m.icons) {
    assert.ok(existsSync(SITE + icon.src.replace(/^\//, "")), icon.src);
    assert.equal(icon.type, "image/png");
    assert.equal(icon.sizes, pngSize(icon.src).join("x"), `${icon.src} is ${icon.sizes}`);
  }
  assert.ok(m.icons.some((i) => i.sizes === "192x192" && i.purpose === "any"));
  assert.ok(m.icons.some((i) => i.sizes === "512x512" && i.purpose === "any"));
  assert.ok(m.icons.some((i) => i.purpose === "maskable"), "Android crops a maskable icon instead of shrinking it");
});

test("admin manifest: the service worker sits at the root, and Netlify serves the manifest as JSON and the worker uncached", () => {
  assert.ok(existsSync(SITE + "admin-sw.js"), "/admin-sw.js");
  const toml = readFileSync(ROOT + "netlify.toml", "utf8");
  const block = (path) => (new RegExp(`for = "${path.replace(/[.]/g, "\\.")}"\\s*\\n\\s*\\[headers\\.values\\]([^[]*)`).exec(toml) || [])[1] || "";
  assert.match(block("/admin.webmanifest"), /Content-Type = "application\/manifest\+json/);
  assert.match(block("/admin-sw.js"), /Cache-Control = "no-cache"/);
});
