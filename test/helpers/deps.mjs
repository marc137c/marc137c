// Test deps for the function handlers: handle(req, context, testDeps({ env, sveve: true })).
// Everything is fake and hermetic: Blobs = FakeBlobs (a fresh site per call), env = only what the test gives
// (never process.env), clock = FakeClock (deps.now/deps.sleep, the store's latency/retries and the fake
// Sveve all share it), fetch = the fake Sveve (sveve: true or its options) or fakeFetch with no routes, so
// every external call throws unless the test asked for a fake.
// The returned object is the deps AND gives the test its fakes: d.blobs, d.clock, d.sveve, d.fetch.calls.
import "./no-network.mjs";
import { FakeBlobs } from "./fake-blobs.mjs";
import { FakeClock } from "./clock.mjs";
import { fakeFetch } from "./fake-fetch.mjs";
import { fakeSveve } from "./fake-sveve.mjs";

export function testDeps({ env = {}, clock, blobs, fetch, now, sveve } = {}) {
  clock = clock || blobs?.clock || fetch?.clock || new FakeClock(now);
  blobs = blobs || new FakeBlobs({ clock });
  if (sveve) fetch = fakeSveve({ clock, ...(sveve === true ? {} : sveve) });
  fetch = fetch || fakeFetch();
  return {
    getStore: blobs.getStore,
    env,
    now: () => clock.date(),
    fetch,
    sleep: (ms) => clock.sleep(ms),
    clock,
    blobs,
    sveve: sveve ? fetch : undefined,
  };
}

export const SITE = "https://viggos.test";

// The context Netlify gives a function (Functions API, context.deploy). The handlers use the real booking store
// and send SMS only in PRODUCTION; deploy previews, branch deploys, netlify dev or no context get their own store.
export const PRODUCTION = Object.freeze({ deploy: Object.freeze({ context: "production", id: "deploy-prod", published: true }) });
export const PREVIEW = Object.freeze({ deploy: Object.freeze({ context: "deploy-preview", id: "deploy-pr1", published: false }) });
export const BRANCH = Object.freeze({ deploy: Object.freeze({ context: "branch-deploy", id: "deploy-branch", published: false }) });

// A Request like Netlify gives the function. json → JSON body with Content-Type application/json.
export function request(path, { method = "GET", json, body, headers = {} } = {}) {
  const h = { ...headers };
  if (json !== undefined && !Object.keys(h).some((k) => k.toLowerCase() === "content-type")) h["Content-Type"] = "application/json";
  return new Request(SITE + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body });
}

// { status, headers, body } with body parsed as JSON when it is JSON, else text.
export async function read(res) {
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: Object.fromEntries(res.headers), body };
}

// Silence and capture console output for one test: const out = quiet(t); … out.error → [[args], …]
export function quiet(t) {
  const out = { log: [], error: [], warn: [] };
  for (const k of Object.keys(out)) t.mock.method(console, k, (...args) => { out[k].push(args); });
  return out;
}
