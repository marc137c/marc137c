// docs/contracts/*.md (RC3): every third-party rule the code relies on has its doc address and the test that holds
// the code to it. Invariants: each "## " rule has a **Docs:** line with an official https address and a **Test:**
// line naming at least one test file; every test/ or scripts/ path a contract names exists; the Google Places and
// Instagram contracts cover the rules the plan lists, and the code that relies on them points to them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIR = join(ROOT, "docs", "contracts");
const read = (f) => readFileSync(join(DIR, f), "utf8").replace(/\r\n/g, "\n");
const OFFICIAL = /^https:\/\/(developers\.google\.com|developers\.facebook\.com|docs\.netlify\.com)\//;

function rules(src) {
  return src.split(/\n(?=## )/).slice(1).map((s) => ({ title: s.split("\n")[0], body: s }));
}

test("contracts: every rule names official docs and a test, and every named file exists", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".md")).sort();
  assert.deepEqual(files, ["google-places.md", "instagram.md", "netlify.md"]);
  for (const f of files) {
    const src = read(f);
    const list = rules(src);
    assert.ok(list.length >= 4, `${f} has rules`);
    for (const r of list) {
      const docs = /^- \*\*Docs:\*\* (.+)$/m.exec(r.body);
      assert.ok(docs, `${f} ${r.title}: a **Docs:** line`);
      const urls = docs[1].match(/https:\/\/[^\s),]+/g) || [];
      assert.ok(urls.length && urls.every((u) => OFFICIAL.test(u)), `${f} ${r.title}: official doc addresses: ${urls.join(" ")}`);
      const t = /^- \*\*Test:\*\* (.+)$/m.exec(r.body);
      assert.ok(t && /`test\/[^`]+\.test\.mjs`/.test(t[1]), `${f} ${r.title}: a **Test:** line naming a test file`);
    }
    for (const m of src.matchAll(/`((?:test|scripts|netlify|viggos-barbershop|docs)\/[^`\s]+)`/g)) {
      const p = m[1].includes("*") ? m[1].slice(0, m[1].lastIndexOf("/")) : m[1]; // a pattern: its folder exists
      assert.ok(existsSync(join(ROOT, p)), `${f} names ${m[1]}, which exists`);
    }
  }
});

test("contracts: Google Places covers attribution, review links, the ordering notice, storage limits, billing and the place check", () => {
  const src = read("google-places.md");
  for (const [what, re] of [
    ["attribution", /attributed "Google Maps"/],
    ["googleMapsUri", /googleMapsUri/],
    ["ordering notice", /ordered and filtered/],
    ["storage limit", /3 days after it was fetched/],
    ["billing", /BILLING_DISABLED/],
    ["place check", /Violgata 22/],
    ["test file", /test\/lib\/reviews\.test\.mjs/],
    ["widget test", /test\/page\/site-widgets\.test\.mjs/],
  ]) assert.match(src, re, what);
  assert.match(readFileSync(join(ROOT, "netlify/lib/reviews.mjs"), "utf8"), /docs\/contracts\/google-places\.md/);
});

test("contracts: Instagram covers the 60-day token, code 190, expiring CDN links and the env-var seed", () => {
  const src = read("instagram.md");
  for (const [what, re] of [
    ["60-day token", /60 days/],
    ["code 190", /code 190/],
    ["CDN expiry", /oe=/],
    ["2-day limit", /2 days after the last good fetch/],
    ["seed", /INSTAGRAM_ACCESS_TOKEN/],
    ["test file", /test\/lib\/social\.test\.mjs/],
  ]) assert.match(src, re, what);
  assert.match(readFileSync(join(ROOT, "netlify/lib/social.mjs"), "utf8"), /docs\/contracts\/instagram\.md/);
});
