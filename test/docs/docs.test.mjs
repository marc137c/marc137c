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

// ---------- F33: every sentence about changing the admin password also says to publish again ----------
// (test/docs/password.test.mjs checks admin.js, admin.html and README for «publiser»; this adds DEPLOY.md and the
// exact words «publiser… på nytt» everywhere, since an env change only applies to a new deploy)
const passwordSentences = (text) => text.replace(/\\n/g, "\n").replace(/<[^>]+>/g, " ")
  .split(/(?<=[.!?»])\s+|\n+/).filter((s) => /\bbytt(?:e|er)?\b[^.!?]*passord/i.test(s));

for (const f of ["viggos-barbershop/README.md", "DEPLOY.md", "viggos-barbershop/admin.js", "viggos-barbershop/admin.html"]) {
  test(`F33: ${f}: every sentence about changing the admin password says «publiser på nytt»`, () => {
    assert.ok(existsSync(ROOT + f), f + " exists");
    const found = passwordSentences(read(f));
    if (f !== "viggos-barbershop/admin.html") assert.ok(found.length > 0, f + " mentions changing the password");
    for (const s of found) assert.match(s, /publiser\w* på nytt/i, `${f}: «${s.trim()}»`);
  });
}

// ---------- F6/F73: no Forms copy, so the manual never sets one up ----------
test("F6/F73: README has no Netlify Forms notification instructions, and says Forms is not used", () => {
  const readme = read("viggos-barbershop/README.md");
  for (const re of [/Form notifications/i, /Forms\s*→\s*(Form )?notifications/i, /Add notification/i, /skjemavarsl/i, /e-postvarsel/i, /data-netlify/]) {
    assert.doesNotMatch(readme, re);
  }
  assert.match(readme, /Netlify Forms brukes ikke/);
});

// ---------- F83: the Google set-up names the billing account, and how to see that it is missing ----------
test("F83: README's Google set-up links a billing account and explains 403 BILLING_DISABLED", () => {
  const readme = read("viggos-barbershop/README.md");
  const google = readme.slice(readme.indexOf("## Google-anmeldelser"), readme.indexOf("\n## ", readme.indexOf("## Google-anmeldelser") + 5));
  assert.match(google, /betalingskonto/);
  assert.match(google, /Billing → Link a billing account/);
  assert.match(google, /BILLING_DISABLED/);
  assert.match(google, /GOOGLE_PLACE_ID/);
  assert.match(read("netlify/lib/reviews.mjs"), /BILLING_DISABLED/, "the log line the README points to exists");
});

// ---------- DEPLOY.md: the release and domain checklist (F10, F2, F3, F6/F73 ops, F33, NEW-domain-switch) ----------
test("DEPLOY.md: every step is a checkbox, and the release, Netlify and domain steps are all there", () => {
  const deploy = read("DEPLOY.md");
  const items = deploy.split(/\r?\n/).filter((l) => /^\s*- \[[ x]\] /.test(l));
  assert.ok(items.length >= 20, `${items.length} checkable lines`);
  for (const [what, re] of [
    ["delete older deploys (F10)", /Delete deploy/],
    ["deploy-preview-1/-2 (F2)", /deploy-preview-1/],
    ["Deploy Previews off or approval-only", /Deploy Previews/],
    ["form detection off and old submissions deleted (F6/F73)", /skjemagjenkjenning/],
    ["never create the old message-service variables (F3)", "test/no-sms.test.mjs"],
    ["an env change needs a new deploy", /Trigger deploy/],
    ["the smoke check after each publish", /scripts\/smoke-live\.mjs/],
    ["the primary domain", /https:\/\/www\.viggosbarbershop\.no/],
    ["netlify.app answers 301", /boisterous-salamander-9c6b34\.netlify\.app[^\n]*301/],
    ["the website in the Google Business Profile", /Google-bedriftsprofil/],
    ["push turned on again on the new domain", /Slå på varsler/],
    ["the calendar link made again", /Lag kalenderlenke/],
    ["the Instagram callback on the new domain", /www\.viggosbarbershop\.no\/api\/connect\/instagram\/callback/],
    ["photo consent", /samtykke/i],
    ["the owner's single final yes", /endelige ja/],
  ]) if (typeof re === "string") assert.ok(deploy.includes(re), what); else assert.match(deploy, re, what);
});
