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
  assert.equal(isProduction({ deploy: { context: "production", published: false } }), true, "an older production deploy is still production");
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
