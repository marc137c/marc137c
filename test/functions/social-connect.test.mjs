// Fix-up round 2 (retired-social-takeover.mjs): a retired deploy still ran /api/connect/instagram with its old
// SOCIAL_ADMIN_KEY and wrote an OAuth state to the site-wide «social» store, and the LIVE callback accepted it, so a
// stranger with a leaked old key could connect their own Instagram account to the front page after the key was
// rotated. Now: a retired deploy answers 410 before anything else, and an OAuth state records the origin that
// created it; the callback refuses a state from another origin. The owner's own flow on one origin still works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { fakeFetch } from "../helpers/fake-fetch.mjs";
import { handle } from "../../netlify/functions/social-connect.mjs";

const NOW = "2026-11-16T10:00:00Z";
const LIVE = "https://www.viggosbarbershop.no";
const OLD = "https://6730a1b2c3d4e5f6a7b8c9d0--boisterous-salamander-9c6b34.netlify.app";
const RETIRED = { deploy: { context: "production", id: "deploy-old", published: false } };
const env = { SOCIAL_ADMIN_KEY: "rotated-key", INSTAGRAM_APP_ID: "app", INSTAGRAM_APP_SECRET: "secret" };
const instagram = () => fakeFetch([
  ["https://api.instagram.com/oauth/access_token", () => ({ access_token: "SHORT" })],
  ["https://graph.instagram.com/access_token", () => ({ access_token: "NEW-TOKEN", expires_in: 5184000 })],
  [/graph\.instagram\.com\/me\/media/, () => ({ data: [] })],
]);
const at = (origin, path, ctx, d) => handle(new Request(origin + path), { ...ctx, params: { platform: "instagram" } }, d).then(read);
const stateOf = (res) => new URL(res.headers.location).searchParams.get("state");

test("social connect: a retired deploy answers 410 with the old key and writes no state", async () => {
  const d = testDeps({ now: NOW, env: { ...env, SOCIAL_ADMIN_KEY: "old-leaked-key" } });
  const res = await at(OLD, "/api/connect/instagram?key=old-leaked-key", RETIRED, d);
  assert.equal(res.status, 410);
  assert.deepEqual(d.blobs.opened, []);
});

test("social connect: a state created on another origin is refused by the live callback, and the stored token stays", async (t) => {
  quiet(t);
  const d = testDeps({ now: NOW, env, fetch: instagram() });
  d.blobs.seed("social", "instagram-token", { access_token: "OWNERS-TOKEN", refreshed_at: Date.parse(NOW), expires_at: Date.parse(NOW) + 50 * 864e5 });
  // the state is written on a deploy that is not retired (no published field), at another origin
  const start = await at(OLD, "/api/connect/instagram?key=rotated-key", { deploy: { context: "production" } }, d);
  assert.equal(start.status, 302);
  const res = await at(LIVE, `/api/connect/instagram/callback?state=${stateOf(start)}&code=ATTACKER-CODE`, PRODUCTION, d);
  assert.equal(res.status, 400, res.body);
  assert.equal(d.blobs.json("social", "instagram-token").access_token, "OWNERS-TOKEN");
  assert.deepEqual(d.fetch.calls, [], "no code exchanged");
});

test("social connect: the owner's start and callback on the live origin connect the account", async (t) => {
  quiet(t);
  const d = testDeps({ now: NOW, env, fetch: instagram() });
  const start = await at(LIVE, "/api/connect/instagram?key=rotated-key", PRODUCTION, d);
  assert.equal(start.status, 302);
  const state = stateOf(start);
  assert.deepEqual(Object.keys(d.blobs.json("social", `oauth-state-${state}`)).sort(), ["created_at", "origin", "platform"]);
  const res = await at(LIVE, `/api/connect/instagram/callback?state=${state}&code=OWNER-CODE`, PRODUCTION, d);
  assert.equal(res.status, 200, res.body);
  assert.equal(d.blobs.json("social", "instagram-token").access_token, "NEW-TOKEN");
  assert.equal(d.blobs.has("social", `oauth-state-${state}`), false, "a state is used once");
});
