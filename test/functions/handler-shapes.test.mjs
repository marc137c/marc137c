// Guard rule (round 2, SPEC R14): every handler checks that a JSON body is a plain object right after JSON.parse.
// JSON.parse alone lets null, numbers, strings, true and arrays through, and `input.botField` on null threw an
// uncaught TypeError in POST /api/bookings (the platform's crash 500 instead of our JSON reply).
// Test rule: every POST (and PATCH) route gets the bodies null, 1, [], "x" and true and must answer a JSON 4xx with
// Cache-Control no-store, never throw, and change nothing in any store. The beacon /api/hit is the one exception
// by contract: an unreadable body counts as the front page, so it answers 204 like every other hit.
// A coverage check fails when a function file starts accepting POST without a row here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { testDeps, request, read, PRODUCTION } from "../helpers/deps.mjs";
import { makeToken } from "../../netlify/lib/booking-core.mjs";
import * as bookings from "../../netlify/functions/bookings.mjs";
import * as admin from "../../netlify/functions/admin.mjs";
import * as pushRenew from "../../netlify/functions/push-renew.mjs";
import * as stats from "../../netlify/functions/stats.mjs";

const PASSWORD = "fake-admin-password";
const NOW = "2026-11-12T09:00:00Z";
const BODIES = ["null", "1", "[]", '"x"', "true"];
const auth = (d) => ({ Authorization: "Bearer " + makeToken(PASSWORD, d.clock.now()) });
const FN_DIR = fileURLToPath(new URL("../../netlify/functions/", import.meta.url));

// [function file, path, method, needs a login]
const ROUTES = [
  ["bookings.mjs", "/api/bookings", "POST", false],
  ["push-renew.mjs", "/api/push/renew", "POST", false],
  ["admin.mjs", "/api/admin/login", "POST", false],
  ["admin.mjs", "/api/admin/items", "POST", true],
  ["admin.mjs", "/api/admin/items/2026-11-20_abcdef0123", "PATCH", true],
  ["admin.mjs", "/api/admin/cancel-phone", "POST", true],
  ["admin.mjs", "/api/admin/calendar", "POST", true],
  ["admin.mjs", "/api/admin/push/subscribe", "POST", true],
  ["admin.mjs", "/api/admin/push/unsubscribe", "POST", true],
  ["admin.mjs", "/api/admin/push/test", "POST", true],
  ["admin.mjs", "/api/admin/push/reset", "POST", true],
];
const HANDLERS = { "bookings.mjs": bookings, "push-renew.mjs": pushRenew, "admin.mjs": admin, "stats.mjs": stats };

function snapshot(blobs) {
  return [...blobs.stores.keys()].sort().flatMap((s) => blobs.keys(s).map((k) => `${s}/${k}=${JSON.stringify(blobs.json(s, k))}`));
}

for (const [file, path, method, login] of ROUTES) {
  test(`handler shapes: ${method} ${path} answers a JSON 4xx for every non-object body, and stores nothing`, async () => {
    for (const body of BODIES) {
      const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PASSWORD } });
      const before = snapshot(d.blobs);
      const headers = { "Content-Type": "application/json", ...(login ? auth(d) : {}) };
      let res;
      try {
        res = await read(await HANDLERS[file].handle(request(path, { method, body, headers }), PRODUCTION, d));
      } catch (err) {
        assert.fail(`${method} ${path} with ${body} threw ${err && err.name}: ${err && err.message}`);
      }
      assert.ok(res.status >= 400 && res.status < 500, `${method} ${path} ${body} → ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(typeof res.body, "object", `${path} ${body}: a JSON reply`);
      assert.equal(typeof res.body.error, "string", `${path} ${body}: has an error text`);
      assert.equal(res.headers["cache-control"], "no-store", `${path} ${body}`);
      assert.deepEqual(snapshot(d.blobs), before, `${method} ${path} with ${body} changed the store`);
    }
  });
}

test("handler shapes: the beacon /api/hit never throws on a non-object body; it answers 204 and counts the front page, as for any unreadable body", async () => {
  const ctx = { ...PRODUCTION };
  for (const body of BODIES) {
    const d = testDeps({ now: NOW });
    let res;
    try {
      res = await read(await stats.handle(request("/api/hit", { method: "POST", body, headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (iPhone)" } }), ctx, d));
    } catch (err) {
      assert.fail(`/api/hit with ${body} threw ${err && err.name}`);
    }
    assert.equal(res.status, 204, body);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(d.blobs.json("stats", "d/2026-11-12"), { views: 1, pages: { forside: 1 }, sources: { direkte: 1 } }, body);
  }
});

test("handler shapes: every function file that accepts POST has its routes in this table", () => {
  const covered = new Set([...ROUTES.map((r) => r[0]), "stats.mjs"]);
  for (const f of readdirSync(FN_DIR).filter((x) => x.endsWith(".mjs"))) {
    const src = readFileSync(FN_DIR + f, "utf8");
    if (/req\.method\s*[!=]==\s*"(POST|PATCH|PUT)"/.test(src)) assert.ok(covered.has(f), `${f} accepts POST but has no row in handler-shapes.test.mjs`);
  }
  // every admin path that takes a body is in the table (GET /api/admin/push is the only body-less one)
  const adminPaths = admin.config.path.filter((p) => p !== "/api/admin/push").map((p) => p.replace(":id", "2026-11-20_abcdef0123"));
  assert.deepEqual(adminPaths.sort(), ROUTES.filter((r) => r[0] === "admin.mjs").map((r) => r[1]).sort());
});
