// Rules about the test suite itself (RC1), used by test/meta.test.mjs. They take a root folder, so they can
// also be run against another branch's tree.
//   unreachableSupport(root): every non-test .mjs under test/helpers, test/client and test/fixtures must be
//     reachable from some *.test.mjs through relative imports (static, export-from, dynamic import("…") or
//     new URL("…", import.meta.url)). A harness nothing runs is a harness that tests nothing.
//   testsWithoutAssert(root): every *.test.mjs under test/ must call an assertion: a binding imported from
//     node:assert (assert(…), assert.equal(…), a named import such as equal(…)), or node:test's t.assert.*.
//     Comments and strings do not count.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { parse } from "acorn";

const SUPPORT_DIRS = ["helpers", "client", "fixtures"];
const ASSERT_MODULES = new Set(["assert", "assert/strict", "node:assert", "node:assert/strict"]);

function listMjs(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listMjs(p));
    else if (name.endsWith(".mjs")) out.push(p);
  }
  return out;
}
const isTest = (p) => p.endsWith(".test.mjs");
const rel = (root, p) => relative(root, p).split(sep).join("/");
const parseModule = (file) => parse(readFileSync(file, "utf8"), { ecmaVersion: "latest", sourceType: "module", locations: true });

function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit));
    else if (v && typeof v === "object" && typeof v.type === "string") walk(v, visit);
  }
}

// Relative module specifiers a file refers to, resolved to absolute paths.
function references(file) {
  const specs = [];
  walk(parseModule(file), (n) => {
    if ((n.type === "ImportDeclaration" || n.type === "ExportAllDeclaration" || n.type === "ExportNamedDeclaration") && n.source) specs.push(n.source.value);
    if (n.type === "ImportExpression" && n.source.type === "Literal") specs.push(n.source.value);
    if (n.type === "NewExpression" && n.callee.type === "Identifier" && n.callee.name === "URL" && n.arguments[0] && n.arguments[0].type === "Literal"
      && n.arguments[1] && n.arguments[1].type === "MemberExpression" && n.arguments[1].object.type === "MetaProperty") specs.push(n.arguments[0].value);
  });
  return specs.filter((s) => typeof s === "string" && /^\.\.?\//.test(s)).map((s) => resolve(dirname(file), s));
}

export function unreachableSupport(root) {
  const testDir = join(root, "test");
  const seen = new Set();
  const queue = listMjs(testDir).filter(isTest);
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const r of references(f)) if (!seen.has(r) && existsSync(r) && r.endsWith(".mjs") && !relative(testDir, r).startsWith("..")) queue.push(r);
  }
  const support = [].concat(...SUPPORT_DIRS.map((d) => listMjs(join(testDir, d)))).filter((p) => !isTest(p));
  return support.filter((p) => !seen.has(p)).map((p) => rel(root, p)).sort();
}

// Does the file call an assertion? Counts calls through bindings imported from node:assert, and t.assert.*.
function callsAssert(file) {
  const ast = parseModule(file);
  const bound = new Set();
  for (const n of ast.body) {
    if (n.type === "ImportDeclaration" && ASSERT_MODULES.has(n.source.value)) n.specifiers.forEach((s) => bound.add(s.local.name));
  }
  let found = false;
  walk(ast, (n) => {
    if (found || n.type !== "CallExpression") return;
    let c = n.callee;
    const chain = [];
    while (c.type === "MemberExpression") { if (!c.computed && c.property.type === "Identifier") chain.unshift(c.property.name); c = c.object; }
    if (c.type === "Identifier" && bound.has(c.name)) found = true;   // assert(…), assert.equal(…), equal(…)
    else if (chain.length >= 2 && chain[0] === "assert") found = true; // t.assert.ok(…) (node:test context)
  });
  return found;
}

export function testsWithoutAssert(root) {
  return listMjs(join(root, "test")).filter(isTest).filter((f) => !callsAssert(f)).map((p) => rel(root, p)).sort();
}

// Round 3 (server): every handler that compares a password must reserve its brake slot with a conditional write
// BEFORE the comparison, and that is only proven by firing many wrong passwords at once. passwordBrakeGaps(root)
// lists each handler under netlify/functions or oversikt/netlify/functions that compares a password (calls
// checkPassword(…) or passwordOk(…), or timingSafeEqual(…) on a line naming a password) and lacks, in a test file
// that imports it, a test titled «parallel wrong … one sender/IP» and one titled «parallel wrong … many senders».
const HANDLER_DIRS = ["netlify/functions", "oversikt/netlify/functions"];
const COMPARES_PASSWORD = /(?<!function\s+)\b(?:checkPassword|passwordOk)\s*\(|timingSafeEqual\([^\n]*(?:password|passord|\bpw\b)/i;
const NEEDS = [["one sender", /\bone (?:sender|IP)\b/i], ["many senders", /\bmany senders\b/i]];
function importsOf(file) {
  const src = readFileSync(file, "utf8");
  const out = [];
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) out.push(resolve(dirname(file), m[1]));
  return out;
}
const titlesOf = (file) => [...readFileSync(file, "utf8").matchAll(/\btest\(\s*(["'`])(.*?)\1/g)].map((m) => m[2]);
export function passwordBrakeGaps(root) {
  const tests = listMjs(join(root, "test")).filter(isTest);
  const gaps = [];
  for (const dir of HANDLER_DIRS) {
    for (const h of listMjs(join(root, dir))) {
      const code = readFileSync(h, "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
      if (!COMPARES_PASSWORD.test(code)) continue;
      const titles = tests.filter((t) => importsOf(t).includes(resolve(h))).flatMap(titlesOf).filter((t) => /parallel wrong/i.test(t));
      for (const [name, re] of NEEDS) if (!titles.some((t) => re.test(t))) gaps.push(rel(root, h) + ": " + name);
    }
  }
  return gaps.sort();
}
