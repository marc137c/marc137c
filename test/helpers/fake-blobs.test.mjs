// The fake must behave like the real thing, failures included. Every scenario below runs twice, against two
// identical FakeBlobs servers: once through the REAL @netlify/blobs client (as installed) over HTTP, once
// through the FakeStore model. Return values, thrown errors, the final stored data and every HTTP attempt
// (method, key, status, committed or not) must be identical.
import { realGetStoreFor } from "./real-blobs.mjs"; // first: sets NODE_ENV=test before the client loads
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FakeBlobs, MODELLED_CLIENT_VERSION } from "./fake-blobs.mjs";
import { FakeClock } from "./clock.mjs";

async function normalize(v) {
  if (v instanceof ArrayBuffer) return { arrayBuffer: Buffer.from(v).toString() };
  if (v instanceof Blob) return { blob: await v.text() };
  if (v instanceof ReadableStream) return { stream: await new Response(v).text() };
  if (v && typeof v === "object" && typeof v[Symbol.asyncIterator] === "function") {
    const pages = [];
    for await (const p of v) pages.push(await normalize(p));
    return { pages };
  }
  if (Array.isArray(v)) return Promise.all(v.map(normalize));
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = await normalize(v[k]);
    return o;
  }
  return v;
}

async function settle(fn) {
  try {
    return { value: await normalize(await fn()) };
  } catch (err) {
    return { error: { name: err.name, message: err.message, status: err.status, cause: err.cause?.code } };
  }
}

const STORE = { name: "bookings", consistency: "strong" };

async function runBoth(scenario) {
  const out = {};
  for (const side of ["real", "model"]) {
    const blobs = new FakeBlobs({ clock: new FakeClock() });
    const store = side === "real" ? realGetStoreFor(blobs)(STORE) : blobs.getStore(STORE);
    const results = [];
    const step = async (fn) => { const r = await settle(fn); results.push(r); return r.value; };
    await scenario(store, blobs, step);
    out[side] = {
      results,
      state: blobs.snapshot(),
      attempts: blobs.log.map(({ at, via, ...rest }) => rest),
    };
  }
  return out;
}

const json = (v) => JSON.stringify(v);

const SCENARIOS = {
  "missing key: get, getWithMetadata, getMetadata": async (s, b, step) => {
    await step(() => s.get("nope"));
    await step(() => s.get("nope", { type: "json" }));
    await step(() => s.getWithMetadata("nope", { type: "json" }));
    await step(() => s.getMetadata("nope"));
  },
  "setJSON, then read back as every type": async (s, b, step) => {
    await step(() => s.setJSON("m/2026-11", { items: [{ id: "x", start: 600 }] }));
    for (const type of [undefined, "text", "json", "arrayBuffer", "blob", "stream"]) await step(() => s.get("m/2026-11", { type }));
    await step(() => s.getWithMetadata("m/2026-11", { type: "json" }));
    await step(() => s.getWithMetadata("m/2026-11"));
    await step(() => s.getMetadata("m/2026-11"));
    await step(() => s.get("m/2026-11", { type: "nonsense" }));
    await step(() => s.getWithMetadata("m/2026-11", { type: "nonsense" }));
    await step(() => s.get("m/2026-11", { consistency: "eventual", type: "json" }));
  },
  "metadata round trip and the 2 KB limit": async (s, b, step) => {
    await step(() => s.setJSON("k", { a: 1 }, { metadata: { by: "test", n: 1, ø: "æ" } }));
    await step(() => s.getWithMetadata("k", { type: "json" }));
    await step(() => s.getMetadata("k"));
    await step(() => s.setJSON("big", 1, { metadata: { x: "a".repeat(3000) } }));
  },
  "getWithMetadata with the current etag gives 304 and data null": async (s, b, step) => {
    const w = await step(() => s.setJSON("k", 1));
    await step(() => s.getWithMetadata("k", { etag: w.etag, type: "json" }));
    await step(() => s.getWithMetadata("k", { etag: '"other"', type: "json" }));
  },
  "onlyIfNew and onlyIfMatch": async (s, b, step) => {
    await step(() => s.setJSON("k", { v: 1 }, { onlyIfNew: true }));
    await step(() => s.setJSON("k", { v: 2 }, { onlyIfNew: true }));
    const cur = await step(() => s.getWithMetadata("k", { type: "json" }));
    await step(() => s.setJSON("k", { v: 3 }, { onlyIfMatch: cur.etag }));
    await step(() => s.setJSON("k", { v: 4 }, { onlyIfMatch: cur.etag })); // stale etag
    await step(() => s.setJSON("missing", 1, { onlyIfMatch: '"etag-1"' }));
    await step(() => s.setJSON("k", 5, { onlyIfMatch: cur.etag, onlyIfNew: true }));
    await step(() => s.setJSON("k", 5, { onlyIfMatch: 5 }));
    await step(() => s.setJSON("k", 5, { onlyIfNew: "yes" }));
    await step(() => s.setJSON("k", { v: 6 }, { onlyIfMatch: "" })); // empty etag = no condition at all
    await step(() => s.get("k", { type: "json" }));
  },
  "key validation": async (s, b, step) => {
    await step(() => s.setJSON("", 1));
    await step(() => s.setJSON("/x", 1));
    await step(() => s.set("%2Fx", "1"));
    await step(() => s.setJSON("k".repeat(601), 1));
    await step(() => s.setJSON("auth/ip/1.2.3.4", { n: 1 }));
    await step(() => s.get("auth/ip/1.2.3.4", { type: "json" }));
  },
  "set with text and binary bodies": async (s, b, step) => {
    await step(() => s.set("a", "hei æøå"));
    await step(() => s.get("a"));
    await step(() => s.set("b", new Uint8Array([104, 105]).buffer));
    await step(() => s.get("b", { type: "arrayBuffer" }));
    await step(() => s.set("c", new Blob(["blob body"])));
    await step(() => s.get("c"));
    await step(() => s.set("d", "x", { onlyIfNew: true }));
    await step(() => s.set("d", "y", { onlyIfNew: true }));
    b.inject({ method: "PUT", fault: "fail-before", status: 500, times: Infinity });
    await step(() => s.set("e", "z", { onlyIfNew: true }));
    await step(() => s.set("e", "z"));
    b.clearFaults();
    b.inject({ method: "PUT", fault: "fail-after", status: 500 });
    await step(() => s.set("d", "w", { onlyIfMatch: b.etag("bookings", "d") }));
    await step(() => s.get("d"));
  },
  "conditional write: one 5xx before commit is retried and succeeds": async (s, b, step) => {
    const cur = await step(() => s.setJSON("m", { n: 1 }));
    b.inject({ method: "PUT", fault: "fail-before", status: 503 });
    await step(() => s.setJSON("m", { n: 2 }, { onlyIfMatch: cur.etag }));
    await step(() => s.get("m", { type: "json" }));
  },
  "conditional write: persistent 5xx resolves {modified:true, etag:''} and stores nothing": async (s, b, step) => {
    const cur = await step(() => s.setJSON("m", { n: 1 }));
    b.inject({ method: "PUT", fault: "fail-before", status: 500, times: Infinity });
    await step(() => s.setJSON("m", { n: 2 }, { onlyIfMatch: cur.etag }));
    await step(() => s.setJSON("new", { n: 1 }, { onlyIfNew: true }));
    b.clearFaults();
    await step(() => s.get("m", { type: "json" }));
    await step(() => s.get("new", { type: "json" }));
  },
  "conditional write: committed, then 502 → retry hits 412 → {modified:false} although it IS stored": async (s, b, step) => {
    const cur = await step(() => s.setJSON("m", { n: 1 }));
    b.inject({ method: "PUT", fault: "fail-after", status: 502 });
    await step(() => s.setJSON("m", { n: 2 }, { onlyIfMatch: cur.etag }));
    await step(() => s.get("m", { type: "json" }));
  },
  "conditional write: committed, response lost → {modified:false} although it IS stored": async (s, b, step) => {
    const cur = await step(() => s.setJSON("m", { n: 1 }));
    b.inject({ method: "PUT", fault: "lost-response" });
    await step(() => s.setJSON("m", { n: 2 }, { onlyIfMatch: cur.etag }));
    b.inject({ method: "PUT", fault: "lost-response" });
    await step(() => s.setJSON("fresh", { n: 1 }, { onlyIfNew: true }));
    await step(() => s.get("m", { type: "json" }));
    await step(() => s.get("fresh", { type: "json" }));
  },
  "conditional write: 401/403 resolve {modified:true, etag:''} without a retry": async (s, b, step) => {
    const cur = await step(() => s.setJSON("m", { n: 1 }));
    b.inject({ method: "PUT", fault: "fail-before", status: 403 });
    await step(() => s.setJSON("m", { n: 2 }, { onlyIfMatch: cur.etag }));
    b.inject({ method: "PUT", fault: "fail-before", status: 401 });
    await step(() => s.setJSON("x", 1, { onlyIfNew: true }));
  },
  "conditional write: network down on every attempt throws": async (s, b, step) => {
    b.inject({ fault: "network-down", times: Infinity });
    await step(() => s.setJSON("m", { n: 1 }, { onlyIfNew: true }));
    await step(() => s.get("m"));
  },
  "429 is retried like a 5xx": async (s, b, step) => {
    b.inject({ method: "PUT", fault: "fail-before", status: 429, times: 2 });
    await step(() => s.setJSON("m", { n: 1 }, { onlyIfNew: true }));
  },
  "unconditional setJSON: persistent 500 throws, lost response is rewritten, 403 throws 'could not write'": async (s, b, step) => {
    b.inject({ method: "PUT", fault: "fail-before", status: 500, times: Infinity });
    await step(() => s.setJSON("auth/all", { n: 1 }));
    b.clearFaults();
    b.inject({ method: "PUT", fault: "lost-response" });
    await step(() => s.setJSON("auth/all", { n: 2 }));
    b.inject({ method: "PUT", fault: "fail-before", status: 403 });
    await step(() => s.setJSON("auth/all", { n: 3 }));
    b.inject({ method: "PUT", fault: "fail-before", status: 500, times: Infinity });
    await step(() => s.set("plain", "text"));
    b.clearFaults();
    await step(() => s.get("auth/all", { type: "json" }));
  },
  "get: one 500 is retried, persistent 500 throws, bad JSON throws": async (s, b, step) => {
    await step(() => s.set("m", "{not json"));
    b.inject({ method: "GET", fault: "fail-before", status: 500 });
    await step(() => s.get("m"));
    b.inject({ method: "GET", fault: "fail-before", status: 500, times: Infinity });
    await step(() => s.get("m"));
    await step(() => s.getWithMetadata("m"));
    b.clearFaults();
    b.inject({ method: "HEAD", fault: "fail-before", status: 500, times: Infinity });
    await step(() => s.getMetadata("m"));
    b.clearFaults();
    await step(() => s.get("m", { type: "json" }));
    await step(() => s.getWithMetadata("m", { type: "json" }));
  },
  "delete: existing, missing, lost response, persistent 500, 403": async (s, b, step) => {
    await step(() => s.setJSON("a", 1));
    await step(() => s.delete("a"));
    await step(() => s.delete("a"));
    await step(() => s.setJSON("b", 1));
    b.inject({ method: "DELETE", fault: "lost-response" });
    await step(() => s.delete("b"));
    b.inject({ method: "DELETE", fault: "fail-before", status: 500, times: Infinity });
    await step(() => s.delete("c"));
    b.clearFaults();
    b.inject({ method: "DELETE", fault: "fail-before", status: 403 });
    await step(() => s.delete("c"));
  },
  "list: prefix, directories, pages, paginate, failure": async (s, b, step) => {
    b.listPageSize = 2;
    for (const k of ["m/2026-10", "m/2026-11", "m/2026-12", "auth/ip/1.1.1.1", "auth/ip/2.2.2.2", "auth/all", "top"]) await step(() => s.setJSON(k, { k }));
    await step(() => s.list());
    await step(() => s.list({ prefix: "m/" }));
    await step(() => s.list({ prefix: "auth/" }));
    await step(() => s.list({ directories: true }));
    await step(() => s.list({ directories: true, prefix: "auth/" }));
    await step(() => s.list({ paginate: true, prefix: "m/" }));
    b.inject({ method: "LIST", fault: "fail-before", status: 500, times: Infinity });
    await step(() => s.list());
  },
  "deleteAll": async (s, b, step) => {
    for (const k of ["a", "b", "c"]) await step(() => s.setJSON(k, 1));
    await step(() => s.deleteAll());
    await step(() => s.list());
  },
};

describe("FakeStore behaves exactly like the installed @netlify/blobs client", () => {
  test(`node_modules has @netlify/blobs ${MODELLED_CLIENT_VERSION} (the version the model was read from)`, () => {
    const pkg = JSON.parse(readFileSync(new URL(import.meta.resolve("@netlify/blobs/package.json")), "utf8"));
    assert.equal(pkg.version, MODELLED_CLIENT_VERSION,
      "@netlify/blobs changed: re-read node_modules/@netlify/blobs/dist and update test/helpers/fake-blobs.mjs, then MODELLED_CLIENT_VERSION");
  });

  test("the real client runs with its 1 ms test retry delay (real-blobs.mjs was imported first)", async () => {
    const blobs = new FakeBlobs();
    const store = realGetStoreFor(blobs)(STORE);
    blobs.inject({ method: "GET", fault: "fail-before", times: 5 });
    const t0 = Date.now();
    await store.get("x");
    assert.ok(Date.now() - t0 < 2000, "5 retries took seconds: @netlify/blobs was loaded before NODE_ENV=test");
  });

  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    test(name, async () => {
      const { real, model } = await runBoth(scenario);
      assert.deepEqual(model.results, real.results, `results differ\nreal:  ${json(real.results)}\nmodel: ${json(model.results)}`);
      assert.deepEqual(model.state, real.state, "stored data differs");
      assert.deepEqual(model.attempts, real.attempts, `HTTP attempts differ\nreal:  ${json(real.attempts)}\nmodel: ${json(model.attempts)}`);
    });
  }

  test("getStore: same errors for bad names and missing input", () => {
    const capture = (fn) => { try { fn(); return "ok"; } catch (err) { return `${err.name}: ${err.message}`; } };
    for (const input of ["a/b", "x%2Fy", "n".repeat(65), { name: "" }, {}, undefined]) {
      const real = capture(() => realGetStoreFor(new FakeBlobs())(input));
      const model = capture(() => new FakeBlobs().getStore(input));
      assert.equal(model, real, `getStore(${json(input)})`);
    }
  });
});

describe("FakeBlobs fault injection and virtual time", () => {
  test("client retries cost virtual time: a persistent outage takes 5 x 5 s on the shared clock", async () => {
    const clock = new FakeClock("2026-11-12T09:00:00Z");
    const blobs = new FakeBlobs({ clock });
    const store = blobs.getStore(STORE);
    blobs.inject({ method: "PUT", fault: "fail-before", status: 500, times: Infinity });
    const t0 = clock.now();
    assert.deepEqual(await store.setJSON("m", 1, { onlyIfNew: true }), { modified: true, etag: "" });
    assert.equal(clock.now() - t0, 25000);
    assert.equal(blobs.requests({ method: "PUT" }).length, 6);
  });

  test("latency is per attempt and moves the shared clock", async () => {
    const clock = new FakeClock();
    const blobs = new FakeBlobs({ clock, latencyMs: 100 });
    const store = blobs.getStore("x");
    const slow = blobs.inject({ method: "PUT", latencyMs: 4000 });
    const t0 = clock.now();
    await store.setJSON("k", 1);
    await store.get("k");
    assert.equal(clock.now() - t0, 100 + 4000 + 100);
    assert.equal(slow.hits, 1);
  });

  test("skip, times, match and hits select exactly the attempts asked for", async () => {
    const blobs = new FakeBlobs();
    const store = blobs.getStore("bookings");
    const rule = blobs.inject({ method: "PUT", skip: 1, times: 1, fault: "lost-response", match: (req) => req.json().mark === true });
    await store.setJSON("a", { mark: true });                       // skipped (first match)
    await store.setJSON("b", { mark: false });                      // no match
    const r = await store.setJSON("c", { mark: true }, { onlyIfNew: true }); // hit: stored, reply lost, retry → 412
    assert.deepEqual(r, { modified: false });
    assert.deepEqual(blobs.json("bookings", "c"), { mark: true });
    assert.equal(rule.hits, 1);
    const puts = blobs.requests({ method: "PUT", key: "c" });
    assert.deepEqual(puts.map((e) => [e.error || e.status, e.committed]), [["lost-response", true], [412, false]]);
  });

  test("records the consistency every store was opened with", () => {
    const blobs = new FakeBlobs();
    blobs.getStore({ name: "bookings", consistency: "strong" });
    blobs.getStore("reviews");
    assert.deepEqual(blobs.opened, [{ name: "bookings", consistency: "strong" }, { name: "reviews", consistency: "eventual" }]);
  });

  test("seed, json, keys, snapshot and remove work on the server side without faults", async () => {
    const blobs = new FakeBlobs();
    blobs.inject({ fault: "network-down", times: Infinity });
    const etag = blobs.seed("bookings", "m/2026-11", { items: [] });
    assert.match(etag, /^"etag-\d+"$/);
    assert.deepEqual(blobs.json("bookings", "m/2026-11"), { items: [] });
    assert.deepEqual(blobs.keys("bookings"), ["m/2026-11"]);
    assert.equal(blobs.snapshot().bookings["m/2026-11"].etag, etag);
    assert.equal(blobs.remove("bookings", "m/2026-11"), true);
    assert.equal(blobs.json("bookings", "m/2026-11"), undefined);
    assert.equal(blobs.log.length, 0);
  });

  test("inject rejects unknown faults", () => {
    assert.throws(() => new FakeBlobs().inject({ fault: "explode" }), /unknown fault/);
    assert.throws(() => new FakeBlobs().inject({ method: "PUT" }), /fault or latencyMs/);
  });
});
