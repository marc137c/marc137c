// The README is the barber's manual and DEPLOY.md the release checklist (RC3/RC7). A claim that names a feature or a
// selector must be true in the code, and the manual itself is not served as a page. Each test names its finding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (f) => readFileSync(ROOT + f, "utf8");

// netlify.toml [[redirects]] blocks as plain objects (a tiny reader for the keys this repo uses)
function redirects(toml) {
  return toml.split(/^\[\[redirects\]\]\s*$/m).slice(1).map((block) => {
    const out = {};
    for (const line of block.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break;
      const m = /^\s*(\w+)\s*=\s*(?:"([^"]*)"|(\S+))/.exec(line);
      if (m) out[m[1]] = m[2] !== undefined ? m[2] : m[3];
    }
    return out;
  });
}

// ---------- F58: the README is true and is not published ----------
test("F58: README names no feature the site does not have (gold dot, sun/moon switch, light theme)", () => {
  const readme = read("viggos-barbershop/README.md");
  for (const gone of ["gull prikk", "Sol/måne", "data-theme"]) assert.ok(!readme.includes(gone), `README still says «${gone}»`);
  assert.doesNotMatch(read("viggos-barbershop/styles.css"), /\[data-theme/, "styles.css has no theme rule, so the README must not describe one");
});

test("F58: /README.md is answered with the 404 page and status 404, not served", () => {
  const rules = redirects(read("netlify.toml"));
  const rule = rules.find((r) => r.from === "/README.md");
  assert.ok(rule, "netlify.toml has a rule for /README.md");
  assert.equal(rule.to, "/404.html");
  assert.equal(rule.status, "404");
  assert.equal(rule.force, "true", "force, because the file exists in the publish folder");
  assert.ok(existsSync(ROOT + "viggos-barbershop/404.html"));
});

test("F58: the redirect reader reads what it claims", () => {
  assert.deepEqual(redirects('[[redirects]]\n  from = "/a"\n  to = "/b"\n  status = 404\n  force = true\n[[headers]]\n  for = "/c"\n'),
    [{ from: "/a", to: "/b", status: "404", force: "true" }]);
});
