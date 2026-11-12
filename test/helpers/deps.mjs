// Test deps for the function handlers: handle(req, context, testDeps({ env })).
// Everything is fake and hermetic: Blobs = FakeBlobs (a fresh site per call), env = only what the test gives
// (never process.env), clock = FakeClock (deps.now/deps.sleep and the store's latency/retries share it),
// fetch = fakeFetch with no routes (every external call throws unless the test adds a route).
// The returned object is the deps AND gives the test its fakes: d.blobs, d.clock, d.fetch.calls.
import "./no-network.mjs";
import { FakeBlobs } from "./fake-blobs.mjs";
import { FakeClock } from "./clock.mjs";
import { fakeFetch } from "./fake-fetch.mjs";

export function testDeps({ env = {}, clock, blobs, fetch, now } = {}) {
  clock = clock || blobs?.clock || new FakeClock(now);
  blobs = blobs || new FakeBlobs({ clock });
  fetch = fetch || fakeFetch();
  return {
    getStore: blobs.getStore,
    env,
    now: () => clock.date(),
    fetch,
    sleep: (ms) => clock.sleep(ms),
    clock,
    blobs,
  };
}

export const SITE = "https://viggos.test";

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
