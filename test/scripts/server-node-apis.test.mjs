// The functions must not depend on the newest Node: the build pins NODE_VERSION 22 in netlify.toml, but the
// functions' own runtime is chosen by Netlify, and a call to a method that runtime lacks turns every booking into a
// 500. Rule: no API newer than Node 18 under netlify/ (the list grows when one is found). The first one found was
// String.prototype.toWellFormed (Node 20) in booking-core's clean().
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const NETLIFY = fileURLToPath(new URL("../../netlify", import.meta.url));
// The owner's overview (oversikt/, merged from main) is a Netlify site of its own with the same runtime rule
const OVERSIKT = fileURLToPath(new URL("../../oversikt/netlify", import.meta.url));
const ROOTS = [["netlify", NETLIFY], ["oversikt/netlify", OVERSIKT]];
const NEWER_THAN_NODE_18 = [
  ["String.prototype.toWellFormed / isWellFormed (Node 20)", /\.(toWellFormed|isWellFormed)\s*\(/],
  ["Object.groupBy / Map.groupBy (Node 21)", /\b(Object|Map)\.groupBy\s*\(/],
  ["Array.fromAsync (Node 22)", /\bArray\.fromAsync\s*\(/],
  ["Promise.withResolvers (Node 22)", /\bPromise\.withResolvers\s*\(/],
  ["Array.prototype.toSorted / toReversed / toSpliced / with (Node 20)", /\.(toSorted|toReversed|toSpliced)\s*\(/],
  ["Set methods union / intersection / difference (Node 22)", /\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\s*\(/],
  ["RegExp v flag (Node 20)", /\/[dgimsuy]*v[dgimsuy]*\.(test|exec)\b|new RegExp\([^)]*,\s*["'][a-z]*v/],
];

function* mjs(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* mjs(p);
    else if (name.endsWith(".mjs")) yield p;
  }
}

test("server APIs: nothing under netlify/ or oversikt/netlify/ needs a Node newer than 18", () => {
  const hits = [];
  let files = 0;
  for (const [name, root] of ROOTS) for (const file of mjs(root)) {
    files++;
    readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      for (const [what, re] of NEWER_THAN_NODE_18) if (re.test(line)) hits.push(`${name}/${relative(root, file).split(sep).join("/")}:${i + 1} ${what}`);
    });
  }
  assert.ok(files > 10, `the scan sees the functions (${files})`);
  assert.deepEqual(hits, []);
});

test("server APIs: the patterns catch what they name", () => {
  const caught = (src) => NEWER_THAN_NODE_18.filter(([, re]) => re.test(src)).length;
  assert.equal(caught('String(s).toWellFormed()'), 1);
  assert.equal(caught('Object.groupBy(xs, f)'), 1);
  assert.equal(caught('a.toSorted()'), 1);
  assert.equal(caught('new Set(a).union(b)'), 1);
  assert.equal(caught('s.replace(/x/g, "y").trim().slice(0, 5)'), 0);
});
