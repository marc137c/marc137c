// SPEC R6 (RC4/RC6): a Blobs write that does not say what it expects to overwrite is a lost update waiting to
// happen (two requests read, both write, one change vanishes). Rule: every `.setJSON(` under netlify/ passes
// onlyIfMatch or onlyIfNew in that call, or carries `// blind-write-ok: <reason>` on the line where the call starts.
// Step 5 emptied the list of files that were still allowed a blind write; there is no such list any more.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const NETLIFY = fileURLToPath(new URL("../../netlify", import.meta.url));

function* mjs(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* mjs(p);
    else if (name.endsWith(".mjs")) yield p;
  }
}

// The text of each `.setJSON(` call (up to its matching parenthesis), with its line number and that line
export function setJsonCalls(src) {
  const out = [];
  const re = /\.setJSON\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) break;
    }
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ line, call: src.slice(m.index, i + 1), lineText: src.split("\n")[line - 1] });
  }
  return out;
}
export const isBlind = ({ call, lineText }) =>
  !/\bonlyIf(Match|New)\b/.test(call) && !/\/\/\s*blind-write-ok:\s*\S/.test(lineText);

test("blind writes: the checker sees conditional calls, the comment with a reason, and blind calls", () => {
  const src = [
    'await store.setJSON("a", doc, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });',
    'await store.setJSON("b", {',
    "  x: 1,",
    "}, { onlyIfNew: true });",
    'await store.setJSON("c", doc); // blind-write-ok: a cache that is rebuilt every hour',
    'await store.setJSON("d", doc);',
    'await store.setJSON("e", doc); // blind-write-ok:',
    'await store.setJSON("f", fn(a, (b)));',
  ].join("\n");
  const calls = setJsonCalls(src);
  assert.deepEqual(calls.map((c) => c.line), [1, 2, 5, 6, 7, 8]);
  assert.deepEqual(calls.filter(isBlind).map((c) => c.line), [6, 7, 8]);
});

test("blind writes: every .setJSON( under netlify/ is conditional or explains itself", () => {
  const blind = [];
  let calls = 0;
  for (const file of mjs(NETLIFY)) {
    const rel = relative(NETLIFY, file).split(sep).join("/");
    for (const c of setJsonCalls(readFileSync(file, "utf8").replace(/\r\n/g, "\n"))) {
      calls++;
      if (isBlind(c)) blind.push(`netlify/${rel}:${c.line} ${c.lineText.trim()}`);
    }
  }
  assert.ok(calls >= 5, `the scan found the server's writes (${calls})`);
  assert.deepEqual(blind, [], "add onlyIfMatch/onlyIfNew (or mutateJSON), or `// blind-write-ok: <reason>`");
});
