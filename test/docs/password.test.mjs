// F33 (RC3, Netlify env-var semantics): a new ADMIN_PASSWORD only applies after a new deploy ('Each deploy uses the
// environment variable values that were set at the time of deployment'). So every sentence in /admin and the README
// that tells the barber to change the password also says to publish again, and «Slå av varsler på alle andre
// enheter» says what it now does: the other devices are logged out too (step 2, auth/epoch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SITE = new URL("../../viggos-barbershop/", import.meta.url);
const read = (f) => readFileSync(new URL(f, SITE), "utf8");
const FILES = ["admin.js", "admin.html", "README.md"];
const REDEPLOY = "Bytt passordet i Netlify, og publiser på nytt (Deploys → Trigger deploy → Deploy site). Først da gjelder det nye passordet.";

// Sentences that ask for, or describe, changing the admin password ('bytt/bytte/bytter … passord…')
function passwordSentences(text) {
  const plain = text.replace(/\\n/g, "\n").replace(/<[^>]+>/g, " ");
  return plain.split(/(?<=[.!?»])\s+|\n+/).filter((s) => /\bbytt(?:e|er)?\b[^.!?]*passord/i.test(s));
}

test("F33: the sentence finder finds password-change sentences and nothing else", () => {
  assert.deepEqual(passwordSentences("Bytter du passordet, blir alle logget ut. Passordet er byttet. Bytt lenke."), ["Bytter du passordet, blir alle logget ut."]);
});

for (const f of FILES) {
  test(`F33: every sentence in ${f} about changing the admin password says to publish again`, () => {
    const found = passwordSentences(read(f));
    assert.ok(found.length > 0, f + " mentions changing the password");
    for (const s of found) assert.match(s, /publiser/i, `${f}: «${s.trim()}»`);
  });
}

test("F33: the reset question says the other devices are logged out, and how a new password takes effect", () => {
  const js = read("admin.js");
  const i = js.indexOf('$("push-reset").addEventListener');
  assert.ok(i > 0);
  const handler = js.slice(i, js.indexOf("});", js.indexOf("confirm(", i)));
  assert.match(handler, /logge ut alle andre enheter/);
  assert.ok(handler.includes(REDEPLOY), "the exact redeploy sentence");
  assert.doesNotMatch(handler, /slår dem på igjen neste gang/, "no longer true: a reset ends the other logins");
});
