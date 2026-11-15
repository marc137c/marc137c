// RC1, the test suite guards itself (rules in test/helpers/meta-rules.mjs). fix/client once shipped a client
// harness that no test ran and that asserted nothing, so it looked like coverage and was none. Invariants:
// - every non-test .mjs under test/helpers, test/client and test/fixtures is reachable from a *.test.mjs;
// - every *.test.mjs calls an assertion (node:assert or t.assert), not only code that might throw.
// The rules are first run on a small made-up tree, so a rule that silently finds nothing fails here too.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { unreachableSupport, testsWithoutAssert } from "./helpers/meta-rules.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = [];
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "meta-rules-"));
  tmp.push(root);
  for (const [p, src] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), src);
  }
  return root;
}

const MADE_UP = {
  "test/a.test.mjs": 'import assert from "node:assert/strict";\nimport { used } from "./helpers/used.mjs";\n' +
    'test("a", async () => { assert.equal(used(), 1); await import("./fixtures/data.mjs"); });',
  "test/helpers/used.mjs": 'export { deep as used } from "./deep.mjs";',
  "test/helpers/deep.mjs": "export const deep = () => 1;",
  "test/helpers/spawned.mjs": "process.exit(0);",
  "test/helpers/orphan.mjs": "export const nobody = 1;",
  "test/client/harness.mjs": "export function boot() {}",
  "test/client/nested/also-orphan.mjs": "export const x = 1;",
  "test/fixtures/data.mjs": "export default [];",
  // imports assert but never calls it; 'assert(' only in a comment and a string
  "test/b.test.mjs": 'import assert from "node:assert/strict";\nimport { boot } from "./client/harness.mjs";\n' +
    '// assert.equal(1, 1)\ntest("b", () => { boot(); console.log("assert(true)"); });',
  "test/c.test.mjs": 'import { test } from "node:test";\nconst u = new URL("./helpers/spawned.mjs", import.meta.url);\n' +
    'test("c", (t) => { t.assert.ok(u); });',
  "test/d.test.mjs": 'import { equal } from "node:assert";\ntest("d", () => { equal(1, 1); });',
  "test/e.test.mjs": 'test("e", () => { if (1 !== 1) throw new Error("x"); });',
};

test("meta: on a made-up tree, harnesses no test reaches are reported, reached ones are not", () => {
  assert.deepEqual(unreachableSupport(tree(MADE_UP)),
    ["test/client/nested/also-orphan.mjs", "test/helpers/orphan.mjs"]);
});

test("meta: on a made-up tree, test files that never call an assertion are reported", () => {
  assert.deepEqual(testsWithoutAssert(tree(MADE_UP)), ["test/b.test.mjs", "test/e.test.mjs"]);
});

test("meta: every non-test .mjs under test/helpers, test/client and test/fixtures is used by a test", () => {
  assert.deepEqual(unreachableSupport(ROOT), [],
    "import these from a *.test.mjs that checks what they do, or delete them");
});

test("meta: every *.test.mjs calls an assertion", () => {
  assert.deepEqual(testsWithoutAssert(ROOT), [],
    "these test files only run code: add assert calls on the outcome");
});
