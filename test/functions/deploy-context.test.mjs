// Audit finding F10: test bookings on deploy previews and branch deploys must never land in the live booking
// store. Netlify tells a Functions v2 handler which deploy it belongs to in context.deploy.context
// (https://docs.netlify.com/build/functions/api/#deploy): "production", "deploy-preview", "branch-deploy",
// "preview-server", "dev" or a branch name.
// Invariant: only context.deploy.context === "production" touches the "bookings" store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, PRODUCTION, PREVIEW, BRANCH } from "../helpers/deps.mjs";
import { oslo } from "../helpers/clock.mjs";
import { item, seedItems, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { isProduction } from "../../netlify/lib/runtime.mjs";
import * as bookings from "../../netlify/functions/bookings.mjs";
import * as availability from "../../netlify/functions/availability.mjs";

const NON_PRODUCTION = [
  ["a deploy preview", PREVIEW],
  ["a branch deploy", BRANCH],
  ["netlify dev", { deploy: { context: "dev" } }],
  ["a preview server", { deploy: { context: "preview-server" } }],
  ["a custom branch context", { deploy: { context: "staging" } }],
  ["a context without deploy info", {}],
  ["a call without context", undefined],
];
// Thursday 19 Nov 09:00 in Oslo, booking Friday 20 Nov 14:00
const NOW = oslo("2026-11-19", 9, 0);
const BODY = { service: "Herreklipp", date: "2026-11-20", start: 840, addons: [], name: "Test Testesen", phone: CUSTOMER_PHONE };
const post = () => request("/api/bookings", { method: "POST", json: BODY });

test("deploy context: only context.deploy.context 'production' counts as production", () => {
  assert.equal(isProduction(PRODUCTION), true);
  assert.equal(isProduction({ deploy: { context: "production", published: false } }), true, "an older production deploy is still production (isRetiredDeploy, below, makes it refuse everything)");
  for (const [, ctx] of NON_PRODUCTION) assert.equal(isProduction(ctx), false, JSON.stringify(ctx));
  assert.equal(isProduction({ deploy: { context: "Production" } }), false);
  assert.equal(isProduction({ site: { name: "production" } }), false);
});

for (const [label, ctx] of NON_PRODUCTION) {
  test(`deploy context: a booking from ${label} never reaches the live store`, async () => {
    const d = testDeps({ now: NOW });
    seedItems(d.blobs, [item({ date: "2026-11-20", start: 600, name: "Ekte kunde" })]);
    const liveBefore = d.blobs.json("bookings", "m/2026-11");
    const res = await read(await bookings.handle(post(), ctx, d));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(d.blobs.json("bookings", "m/2026-11"), liveBefore, "the live store is unchanged");
    assert.deepEqual(d.blobs.json("bookings-preview", "m/2026-11").items.map((i) => i.name), ["Test Testesen"]);
    assert.ok(d.blobs.opened.every((o) => o.name === "bookings-preview" && o.consistency === "strong"), JSON.stringify(d.blobs.opened));
    assert.ok(d.blobs.log.every((e) => e.store === "bookings-preview"));
    // Its availability is the preview's own: the live customer's 10:00 is not shown as busy there
    const av = await read(await availability.handle(request("/api/availability"), ctx, d));
    assert.deepEqual(av.body.busy["2026-11-20"], [[840, 870]]);
    assert.equal(d.fetch.calls.length, 0, "no network call from a preview booking");
  });
}

test("deploy context: production uses the live store", async () => {
  const d = testDeps({ now: NOW });
  const res = await read(await bookings.handle(post(), PRODUCTION, d));
  assert.equal(res.status, 201);
  assert.deepEqual(d.blobs.json("bookings", "m/2026-11").items.map((i) => i.name), ["Test Testesen"]);
  assert.equal(d.blobs.has("bookings-preview", "m/2026-11"), false);
  const av = await read(await availability.handle(request("/api/availability"), PRODUCTION, d));
  assert.deepEqual(av.body.busy["2026-11-20"], [[840, 870]]);
});

// F10 / F2b: an older production deploy stays reachable at its permalink (<deploy-id>--<site>.netlify.app) with the
// code and env values of its own time, and Netlify Blobs is site-wide, so it would write to the live booking store
// with old rules or an old ADMIN_PASSWORD. Such a deploy is context "production" with published: false. Invariant:
// every handler that writes or reveals the booking store answers 410 'Bruk hovedsiden.' there before it opens a
// store (blobs.log stays empty); published: true or no published field behaves as before.
import { isRetiredDeploy } from "../../netlify/lib/runtime.mjs";
import { makeToken } from "../../netlify/lib/booking-core.mjs";
import * as admin from "../../netlify/functions/admin.mjs";
import * as calendar from "../../netlify/functions/calendar.mjs";
import * as pushRenew from "../../netlify/functions/push-renew.mjs";
import * as bookingIcs from "../../netlify/functions/booking-ics.mjs";

const RETIRED = Object.freeze({ deploy: Object.freeze({ context: "production", id: "deploy-old", published: false }) });
const PASSWORD = "fake-admin-password";
const FEED_TOKEN = "A".repeat(43);

test("retired deploy: isRetiredDeploy is production with published === false, nothing else", () => {
  assert.equal(isRetiredDeploy(RETIRED), true);
  assert.equal(isRetiredDeploy(PRODUCTION), false);
  assert.equal(isRetiredDeploy({ deploy: { context: "production" } }), false, "no published field: as before");
  for (const [, ctx] of NON_PRODUCTION) assert.equal(isRetiredDeploy(ctx), false, JSON.stringify(ctx));
});

const RETIRED_CALLS = [
  ["POST /api/bookings", (d) => bookings.handle(post(), RETIRED, d)],
  ["POST /api/admin/login", (d) => admin.handle(request("/api/admin/login", { method: "POST", json: { password: PASSWORD } }), RETIRED, d)],
  ["GET /api/admin/items with a valid token", (d) => admin.handle(request("/api/admin/items", { headers: { Authorization: "Bearer " + makeToken(PASSWORD, d.clock.now()) } }), RETIRED, d)],
  ["POST /api/admin/push/subscribe with a valid token", (d) => admin.handle(request("/api/admin/push/subscribe", { method: "POST", json: {}, headers: { Authorization: "Bearer " + makeToken(PASSWORD, d.clock.now()) } }), RETIRED, d)],
  ["POST /api/admin/cancel-phone with a valid token", (d) => admin.handle(request("/api/admin/cancel-phone", { method: "POST", json: { phone: CUSTOMER_PHONE }, headers: { Authorization: "Bearer " + makeToken(PASSWORD, d.clock.now()) } }), RETIRED, d)],
  ["GET /api/calendar/<token>.ics", (d) => calendar.handle(request(`/api/calendar/${FEED_TOKEN}.ics`), RETIRED, d)],
  ["POST /api/push/renew", (d) => pushRenew.handle(request("/api/push/renew", { method: "POST", json: {} }), RETIRED, d)],
  ["GET /api/bookings/<id>.ics", (d) => bookingIcs.handle(request("/api/bookings/2026-11-20_abcdef0123.ics"), RETIRED, d)],
];
for (const [label, call] of RETIRED_CALLS) {
  test(`retired deploy: ${label} answers 410 'Bruk hovedsiden.' and touches no store`, async () => {
    const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PASSWORD } });
    const res = await read(await call(d));
    assert.equal(res.status, 410, JSON.stringify(res.body));
    assert.deepEqual(res.body, { error: "Bruk hovedsiden." });
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(d.blobs.log, [], "no Blobs request at all");
    assert.deepEqual(d.blobs.opened, [], "no store opened");
  });
}

test("retired deploy: published: true and a production context without published behave as before", async () => {
  for (const ctx of [PRODUCTION, { deploy: { context: "production" } }]) {
    const d = testDeps({ now: NOW });
    const res = await read(await bookings.handle(post(), ctx, d));
    assert.equal(res.status, 201, JSON.stringify(ctx));
    assert.equal(d.blobs.json("bookings", "m/2026-11").items.length, 1);
  }
});

// ---------- Fix-up round 2: every function file, not a list of endpoints (retired-social-takeover.mjs) ----------
// The F10 fix was applied to a list of endpoints, and social-connect.mjs, the one other function that guards a
// site-wide write with an env secret frozen per deploy, was missed: a retired deploy with an old SOCIAL_ADMIN_KEY
// wrote an OAuth state the live callback accepted. Guard: every file in netlify/functions/ exports
// handle(req, context, deps), its default export is that handle with liveDeps(), and every route it serves answers
// 410 on a retired deploy and opens no store, unless the file is in this commented exemption list.
import { readdirSync, readFileSync } from "node:fs";
const FUNCTIONS_DIR = new URL("../../netlify/functions/", import.meta.url);
const EXEMPT = {
  "availability.mjs": "read-only: busy intervals, no names or numbers; a retired deploy can only read",
  "reviews.mjs": "read-only: Google reviews through the API key, no store",
  "social.mjs": "read-only: the stored Instagram feed",
  "social-refresh.mjs": "scheduled only, no path: Netlify runs schedules only on the published deploy (docs/contracts/netlify.md rule 4)",
};
// A route whose retired answer is not 410, with the reason; it still opens no store
const RETIRED_ANSWER = { "POST /api/hit": [204, "the visitor beacon never shows an error; a retired deploy counts nothing"] };
const sample = (p) => p.replace(":platform", "instagram").replace(":file", "2026-11-20_abcdef0123.ics").replace(":id", "2026-11-20_abcdef0123");
const files = readdirSync(FUNCTIONS_DIR).filter((f) => f.endsWith(".mjs")).sort();

test("retired deploy guard: the exemption list names only files that exist", () => {
  for (const f of Object.keys(EXEMPT)) assert.ok(files.includes(f), f);
});
for (const file of files.filter((f) => !EXEMPT[f])) {
  test(`retired deploy guard: every route of ${file} answers 410 and opens no store`, async () => {
    const mod = await import(new URL(file, FUNCTIONS_DIR));
    assert.equal(typeof mod.handle, "function", `${file} exports handle(req, context, deps)`);
    assert.match(readFileSync(new URL(file, FUNCTIONS_DIR), "utf8"), /export default \(req, context\) => handle\(req, context, liveDeps\(\)\);/);
    const paths = mod.config.path ? [].concat(mod.config.path) : ["/.netlify/functions/" + file.replace(/\.mjs$/, "")];
    for (const p of paths) {
      let answered = 0;
      for (const method of ["GET", "POST"]) {
        const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PASSWORD, SOCIAL_ADMIN_KEY: "old-leaked-key" } });
        const url = sample(p) + (p.startsWith("/api/connect/") ? "?key=old-leaked-key&state=" + "a".repeat(48) + "&code=X" : "");
        const res = await read(await mod.handle(request(url, { method, ...(method === "POST" ? { json: {} } : {}) }), { ...RETIRED, params: { platform: "instagram", file: "2026-11-20_abcdef0123.ics", id: "2026-11-20_abcdef0123" } }, d));
        // 410; or 405 for a method the route does not serve at all (nothing runs); or the documented answer above
        const [status, why] = RETIRED_ANSWER[`${method} ${p}`] || [410];
        assert.ok(res.status === status || res.status === 405, `${method} ${url}: ${res.status} ${JSON.stringify(res.body).slice(0, 120)}${why ? ` (${why})` : ""}`);
        if (res.status !== 405) answered++;
        assert.deepEqual(d.blobs.opened, [], `${method} ${url}: no store opened`);
        assert.deepEqual(d.fetch.calls, [], `${method} ${url}: no outside call`);
      }
      assert.ok(answered > 0, `${p}: a method it serves answers on a retired deploy`);
    }
  });
}
