// Kompatibilitetssjekken: statistikk-settets beacon skal være ES5 (ikke bare ES2015), og sjekken må kunne håndheve det.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const check = (dir, version) => spawnSync(process.execPath, ["scripts/check-es2015.mjs", dir, ...(version ? [String(version)] : [])], { cwd: root, encoding: "utf8" });

test("ES5-sjekk: pilfunksjon og const stoppes når versjon 5 er valgt, men ikke med standard ES2015", () => {
  const dir = mkdtempSync(join(tmpdir(), "es5-"));
  try {
    writeFileSync(join(dir, "beacon.js"), "(() => {\n  const m = 1;\n})();\n");
    assert.equal(check(dir).status, 0);
    const r = check(dir, 5);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /ES5/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ES5-sjekk: statistikk-settets beacon er ES5, og npm run check sjekker den som ES5", () => {
  const r = check("stats-kit/public", 5);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.match(pkg.scripts.check, /check-es2015\.mjs stats-kit\/public 5\b/);
});
