// scripts/check-es2015.mjs (part of `npm run check` and the Netlify build): browser code ships as written to
// Safari/iOS 10+, Chrome 60+ and Firefox 55+, so newer APIs must be feature-detected. Invariant: an unguarded
// navigator.clipboard, navigator.serviceWorker, Notification or PushManager fails the check; the check itself
// (typeof, «in», if/&&/?:) and code behind it pass; the real site passes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "check-es2015.mjs");
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// Runs the checker once over a folder with one file per case; returns { status, out }
function checkFiles(files) {
  const dir = mkdtempSync(join(tmpdir(), "es2015-check-"));
  dirs.push(dir);
  writeFileSync(join(dir, "page.html"), "<!doctype html><title>t</title>");
  files.forEach(([, code], i) => writeFileSync(join(dir, `case${i}.js`), code));
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

const FAIL = [
  ["clipboard", 'navigator.clipboard.writeText("x");'],
  ["clipboard through window", 'window.navigator.clipboard.writeText("x");'],
  ["clipboard in a function", 'function copy(t) { return navigator.clipboard.writeText(t); }'],
  ["clipboard guarded by something else", 'if (ok) navigator.clipboard.writeText("x");'],
  ["service worker", 'navigator.serviceWorker.register("/sw.js");'],
  ["Notification", "Notification.requestPermission();"],
  ["window.Notification", "var p = window.Notification.permission;"],
  ["PushManager", "var s = PushManager.supportedContentEncodings;"],
];
const PASS = [
  ["clipboard behind &&", 'if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText("x");'],
  ["clipboard as the check", "var can = !!(navigator.clipboard && navigator.clipboard.writeText);"],
  ["clipboard behind ?:", 'var p = navigator.clipboard ? navigator.clipboard.writeText("x") : null;'],
  ["early return", 'function copy(t) { if (!("clipboard" in navigator)) return; navigator.clipboard.writeText(t); }'],
  ["service worker behind in", 'if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");'],
  ["Notification behind typeof", 'if (typeof Notification === "function") Notification.requestPermission();'],
  ["Notification behind in &&", 'var granted = "Notification" in window && Notification.permission === "granted";'],
  ["PushManager behind in", 'var push = "PushManager" in window;'],
  ["try", "try { navigator.clipboard.writeText('x'); } catch (e) {}"],
  ["compat-ok", "navigator.clipboard.writeText('x'); // compat-ok"],
  ["a property or key with the same name", "var o = { Notification: 1 }; o.Notification = 2; var c = o.clipboard;"],
];

test("check-es2015: every unguarded use fails, each in its own file", () => {
  const r = checkFiles(FAIL);
  assert.notEqual(r.status, 0, r.out);
  FAIL.forEach(([label], i) => assert.match(r.out, new RegExp(`case${i}\\.js:\\d+: .*uten sjekk`), label));
});

test("check-es2015: the checks themselves and code behind them pass", () => {
  const r = checkFiles(PASS);
  assert.equal(r.status, 0, r.out);
});

test("check-es2015: the real site passes", () => {
  const r = spawnSync(process.execPath, [SCRIPT, join(ROOT, "viggos-barbershop")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
