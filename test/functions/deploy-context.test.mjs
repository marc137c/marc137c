// Audit finding F10 and owner decision (f): test bookings on deploy previews and branch deploys must never land
// in the live booking store or trigger a real SMS. Netlify tells a Functions v2 handler which deploy it belongs to
// in context.deploy.context (https://docs.netlify.com/build/functions/api/#deploy): "production", "deploy-preview",
// "branch-deploy", "preview-server", "dev" or a branch name.
// Invariant: only context.deploy.context === "production" touches the "bookings" store or sends SMS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION, PREVIEW, BRANCH } from "../helpers/deps.mjs";
import { oslo } from "../helpers/clock.mjs";
import { item, seedItems, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { isProduction } from "../../netlify/lib/runtime.mjs";
import * as bookings from "../../netlify/functions/bookings.mjs";
import * as availability from "../../netlify/functions/availability.mjs";
import * as smsReminders from "../../netlify/functions/sms-reminders.mjs";

const SVEVE_ENV = { SVEVE_USER: "u", SVEVE_PASSWD: "p" };
const NON_PRODUCTION = [
  ["a deploy preview", PREVIEW],
  ["a branch deploy", BRANCH],
  ["netlify dev", { deploy: { context: "dev" } }],
  ["a preview server", { deploy: { context: "preview-server" } }],
  ["a custom branch context", { deploy: { context: "staging" } }],
  ["a context without deploy info", {}],
  ["a call without context", undefined],
];
// Friday 20 Nov 14:00, booked on Thursday 19 Nov 09:00 Oslo: due for the 24 h reminder on Thursday 14:00–15:00
const BOOKED_AT = oslo("2026-11-19", 9, 0);
const BODY = { service: "Herreklipp", date: "2026-11-20", start: 840, addons: [], name: "Test Testesen", phone: CUSTOMER_PHONE };
const post = () => request("/api/bookings", { method: "POST", json: BODY });
const tick = () => request("/.netlify/functions/sms-reminders", { method: "POST", json: { next_run: "x" } });

test("deploy context: only context.deploy.context 'production' counts as production", () => {
  assert.equal(isProduction(PRODUCTION), true);
  assert.equal(isProduction({ deploy: { context: "production", published: false } }), true, "an older production deploy is still production");
  for (const [, ctx] of NON_PRODUCTION) assert.equal(isProduction(ctx), false, JSON.stringify(ctx));
  assert.equal(isProduction({ deploy: { context: "Production" } }), false);
  assert.equal(isProduction({ site: { name: "production" } }), false);
});

for (const [label, ctx] of NON_PRODUCTION) {
  test(`deploy context: a booking from ${label} never reaches the live store and never sends an SMS`, async () => {
    const d = testDeps({ now: BOOKED_AT, env: SVEVE_ENV, sveve: true });
    const live = seedItems(d.blobs, [item({ date: "2026-11-20", start: 600, name: "Ekte kunde" })]);
    const liveBefore = d.blobs.json("bookings", "m/2026-11");
    const res = await read(await bookings.handle(post(), ctx, d));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.sms, "off");
    assert.deepEqual(d.blobs.json("bookings", "m/2026-11"), liveBefore, "the live store is unchanged");
    assert.deepEqual(d.blobs.json("bookings-preview", "m/2026-11").items.map((i) => i.name), ["Test Testesen"]);
    assert.ok(d.blobs.opened.every((o) => o.name === "bookings-preview" && o.consistency === "strong"), JSON.stringify(d.blobs.opened));
    assert.ok(d.blobs.log.every((e) => e.store === "bookings-preview"));
    // Its availability is the preview's own: the live customer's 10:00 is not shown as busy there
    const av = await read(await availability.handle(request("/api/availability"), ctx, d));
    assert.deepEqual(av.body.busy["2026-11-20"], [[840, 870]]);
    assert.equal(av.body.sms, false, "the preview form never promises an SMS");
    // The live reminder run the next afternoon only knows the live booking (10:00 is not due, so nothing is sent)
    d.clock.set(oslo("2026-11-19", 14, 15));
    await smsReminders.handle(tick(), PRODUCTION, d);
    assert.equal(d.sveve.calls.length, 0, "no confirmation, no barber SMS, no reminder for a test booking");
    assert.equal(live.length, 1);
  });
}

test("deploy context: production uses the live store and sends SMS", async () => {
  const d = testDeps({ now: BOOKED_AT, env: SVEVE_ENV, sveve: true });
  const res = await read(await bookings.handle(post(), PRODUCTION, d));
  assert.equal(res.status, 201);
  assert.notEqual(res.body.sms, "off");
  assert.deepEqual(d.blobs.json("bookings", "m/2026-11").items.map((i) => i.name), ["Test Testesen"]);
  assert.equal(d.blobs.has("bookings-preview", "m/2026-11"), false);
  assert.ok(d.sveve.sent.length >= 1);
  const av = await read(await availability.handle(request("/api/availability"), PRODUCTION, d));
  assert.deepEqual(av.body.busy["2026-11-20"], [[840, 870]]);
  assert.equal(av.body.sms, true);
});

test("deploy context: the scheduled reminder run does nothing when the context says it is not production", async (t) => {
  quiet(t);
  for (const [, ctx] of NON_PRODUCTION.filter(([, c]) => c && c.deploy)) {
    const d = testDeps({ now: oslo("2026-11-19", 14, 15), env: SVEVE_ENV, sveve: true });
    seedItems(d.blobs, [item({ date: "2026-11-20", start: 840 })]);
    await smsReminders.handle(tick(), ctx, d);
    assert.equal(d.blobs.log.length, 0, JSON.stringify(ctx));
    assert.equal(d.sveve.calls.length, 0, JSON.stringify(ctx));
  }
  // Scheduled functions only run on the published production deploy; without deploy info it still runs there
  for (const ctx of [PRODUCTION, {}]) {
    const d = testDeps({ now: oslo("2026-11-19", 14, 15), env: SVEVE_ENV, sveve: true });
    seedItems(d.blobs, [item({ date: "2026-11-20", start: 840 })]);
    await smsReminders.handle(tick(), ctx, d);
    assert.equal(d.sveve.sent.length, 1, JSON.stringify(ctx));
  }
});
