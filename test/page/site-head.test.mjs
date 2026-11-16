// Owner decision D8 / F62 (the domain switch): the site lives on one origin, https://www.viggosbarbershop.no. The
// canonical address, og:url and the JSON-LD url are that origin + "/", og:image is an absolute URL on the same
// origin that maps to a real file of the stated size, no page names a *.netlify.app address, and the old netlify.app
// host is sent to the origin with a 301.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDocument } from "../helpers/mini-dom.mjs";

const SITE_ORIGIN = "https://www.viggosbarbershop.no";
const OLD_HOST = "boisterous-salamander-9c6b34.netlify.app";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SITE = ROOT + "viggos-barbershop/";
const read = (f) => readFileSync(SITE + f, "utf8");

const head = () => parseDocument(read("index.html")).head;
const meta = (h, attr, name) => {
  const el = h.querySelector(`meta[${attr}="${name}"]`);
  return el ? el.getAttribute("content") : null;
};
const jsonLd = (h) => JSON.parse(h.querySelector('script[type="application/ld+json"]').textContent);

// Width and height of a baseline or progressive JPEG (the SOFn segment)
function jpegSize(buf) {
  assert.equal(buf.readUInt16BE(0), 0xffd8, "a JPEG");
  for (let i = 2; i < buf.length;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error("no SOF segment");
}

test("F62: canonical, og:url and the JSON-LD url are the one origin + '/'", () => {
  const h = head();
  const canonical = h.querySelector('link[rel="canonical"]');
  assert.ok(canonical, "a canonical link");
  const want = SITE_ORIGIN + "/";
  assert.equal(canonical.getAttribute("href"), want);
  assert.equal(meta(h, "property", "og:url"), want);
  assert.equal(jsonLd(h).url, want);
});

test("F62: og:image (with size and alt), twitter:card and the JSON-LD image point at a real file on the same origin", () => {
  const h = head();
  const img = meta(h, "property", "og:image");
  assert.ok(img && img.startsWith(SITE_ORIGIN + "/"), `og:image ${img} is absolute on ${SITE_ORIGIN}`);
  const file = img.slice(SITE_ORIGIN.length + 1);
  assert.ok(existsSync(SITE + file), `${file} exists in viggos-barbershop/`);
  const [w, hgt] = jpegSize(readFileSync(SITE + file));
  assert.equal(meta(h, "property", "og:image:width"), String(w));
  assert.equal(meta(h, "property", "og:image:height"), String(hgt));
  assert.ok((meta(h, "property", "og:image:alt") || "").length > 10, "og:image:alt describes the picture");
  assert.equal(meta(h, "name", "twitter:card"), "summary_large_image");
  assert.equal(jsonLd(h).image, img);
});

test("F62: no page, script, style or the manual names a *.netlify.app address", () => {
  const files = readdirSync(SITE).filter((f) => /\.(html|js|css|md|webmanifest)$/.test(f));
  assert.ok(files.includes("index.html") && files.includes("README.md"));
  for (const f of files) assert.doesNotMatch(read(f), /\.netlify\.app/, f);
});

test("D8: netlify.toml sends the old netlify.app host to the origin with a 301 (deploy permalinks are other hosts)", () => {
  const toml = readFileSync(ROOT + "netlify.toml", "utf8");
  const blocks = toml.split(/^\[\[redirects\]\]\s*$/m).slice(1);
  const rule = blocks.find((b) => b.includes(`from = "https://${OLD_HOST}/*"`));
  assert.ok(rule, "a host redirect for " + OLD_HOST);
  assert.match(rule, new RegExp(`to = "${SITE_ORIGIN.replace(/\./g, "\\.")}/:splat"`));
  assert.match(rule, /status = 301/);
  assert.match(rule, /force = true/);
});
