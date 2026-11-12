// In-memory Netlify Blobs for tests, modelled on @netlify/blobs 11.1.4 exactly as installed in
// node_modules (dist/main.js Store + dist/chunk-*.js Client/fetchAndRetry). Two halves:
//
//  1. A fake Blobs *server* (one per FakeBlobs = one Netlify site with named stores). It answers like the
//     Blobs edge: GET/HEAD/PUT/DELETE per key, If-Match / If-None-Match:* → 412, If-None-Match:<etag> → 304,
//     list pages with prefix/directories/cursor, a new ETag on every write.
//  2. A model of the *client* (FakeStore, returned by blobs.getStore) that copies the installed client's
//     semantics line by line, including the parts that surprise people:
//       - every request goes through fetchAndRetry: on 429/5xx or a thrown network error it retries up to
//         5 times (6 attempts) with 5 s between attempts (virtual time on the shared FakeClock);
//       - a conditional setJSON/set (onlyIfMatch/onlyIfNew) never throws on an HTTP error: 412 resolves
//         {modified:false}, ANY other status (also a 5xx after all retries, 401, 403) resolves
//         {modified:true, etag:''} (etag is '' because the error response has no ETag header);
//       - a write that commits but whose response is lost (or answered 5xx) is retried with the same
//         condition, so the client's OWN write now fails the condition: {modified:false};
//       - unconditional set/setJSON, get, getWithMetadata, getMetadata, delete and list throw
//         BlobsInternalError on a final non-OK status; a final network error is re-thrown (TypeError).
//
// The same server also speaks HTTP (blobs.fetch), so the REAL client can be pointed at it
// (test/helpers/real-blobs.mjs). test/helpers/fake-blobs.test.mjs runs one scenario matrix through the real
// client and through this model and requires identical results, server state and request logs.
// Server-side details the client source cannot show (list page size, how directories are grouped, 204 vs 200
// on delete) follow the Netlify docs and are marked "server assumption".
//
// Faults (blobs.inject) apply per HTTP attempt, so they interact with the client's retries exactly like real
// outages do:
//   blobs.inject({ method: "PUT", key: "m/2026-11", fault: "lost-response" })      // committed, reply lost
//   blobs.inject({ method: "PUT", fault: "fail-after", status: 502 })              // committed, then 502
//   blobs.inject({ method: "GET", fault: "fail-before", status: 500, times: Infinity }) // outage, nothing read
//   blobs.inject({ fault: "network-down", times: 6 })                              // connection refused
//   blobs.inject({ method: "PUT", latencyMs: 4000 })                               // slow write
//   blobs.inject({ method: "PUT", skip: 1, match: (req) => req.json().items.some((i) => i.remindedAt), ... })
// Rule fields: method ("GET" | "HEAD" | "PUT" | "DELETE" | "LIST"), store, key (string | RegExp | fn),
// match(req), skip (let n matching attempts through first), times (default 1; Infinity = until cleared),
// fault, status (default 500), latencyMs. inject() returns the rule; rule.hits counts the attempts it hit.
import { FakeClock } from "./clock.mjs";

// The client version this model was read from. fake-blobs.test.mjs fails when node_modules has another one.
export const MODELLED_CLIENT_VERSION = "11.1.4";

const SITE_STORE_PREFIX = "site:";
const DEPLOY_STORE_PREFIX = "deploy:";
const METADATA_HEADER_INTERNAL = "x-amz-meta-user";
const METADATA_HEADER_EXTERNAL = "netlify-blobs-metadata";
const METADATA_MAX_SIZE = 2 * 1024;
const BASE64_PREFIX = "b64;";
const FAULTS = new Set(["fail-before", "fail-after", "lost-response", "network-down"]);

// ---------- errors (same names, messages and fields as the client) ----------
function blobsErrorMessage(res, context, responseBody) {
  const nfError = res.headers["x-nf-error"];
  let details = nfError || `${res.status} status code`;
  if (res.headers["x-nf-request-id"]) details += `, ID: ${res.headers["x-nf-request-id"]}`;
  const deniedWrite = (res.status === 401 || res.status === 403) && (context.method === "put" || context.method === "delete") &&
    context.storeName !== undefined && !context.storeName.startsWith(DEPLOY_STORE_PREFIX);
  if (deniedWrite) {
    const storeName = context.storeName.startsWith(SITE_STORE_PREFIX) ? context.storeName.slice(SITE_STORE_PREFIX.length) : context.storeName;
    return `Netlify Blobs could not write to store '${storeName}' (${details}).`; // functions always have edge access
  }
  let message = `Netlify Blobs has generated an internal error (${details})`;
  if (!nfError && responseBody) message += `: ${responseBody}`;
  return message;
}

export class BlobsInternalError extends Error {
  constructor(res, context = {}, responseBody) {
    super(blobsErrorMessage(res, context, responseBody));
    this.name = "BlobsInternalError";
    this.status = res.status;
    this.responseBody = responseBody;
  }
}

export class MissingBlobsEnvironmentError extends Error {
  constructor(requiredProperties) {
    super(`The environment has not been configured to use Netlify Blobs. To use it manually, supply the following properties when creating a store: ${requiredProperties.join(", ")}`);
    this.name = "MissingBlobsEnvironmentError";
  }
}

const networkError = (message, code) => new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });

// ---------- validation copied from Store ----------
function validateKey(key) {
  if (key === "") throw new Error("Blob key must not be empty.");
  if (key.startsWith("/") || key.startsWith("%2F")) throw new Error("Blob key must not start with forward slash (/).");
  if (new TextEncoder().encode(key).length > 600) {
    throw new Error("Blob key must be a sequence of Unicode characters whose UTF-8 encoding is at most 600 bytes long.");
  }
}

function validateStoreName(name) {
  if (name.includes("/") || name.includes("%2F")) throw new Error("Store name must not contain forward slashes (/).");
  if (new TextEncoder().encode(name).length > 64) {
    throw new Error("Store name must be a sequence of Unicode characters whose UTF-8 encoding is at most 64 bytes long.");
  }
}

function getConditions(options) {
  if ("onlyIfMatch" in options && "onlyIfNew" in options) {
    throw new Error(`The 'onlyIfMatch' and 'onlyIfNew' options are mutually exclusive. Using 'onlyIfMatch' will make the write succeed only if there is an entry for the key with the given content, while 'onlyIfNew' will make the write succeed only if there is no entry for the key.`);
  }
  if ("onlyIfMatch" in options && options.onlyIfMatch) {
    if (typeof options.onlyIfMatch !== "string") throw new Error(`The 'onlyIfMatch' property expects a string representing an ETag.`);
    return { onlyIfMatch: options.onlyIfMatch };
  }
  if ("onlyIfNew" in options && options.onlyIfNew) {
    if (typeof options.onlyIfNew !== "boolean") {
      throw new Error(`The 'onlyIfNew' property expects a boolean indicating whether the write should fail if an entry for the key already exists.`);
    }
    return { onlyIfNew: true };
  }
  return undefined;
}

// ---------- metadata (b64;<base64 JSON> in a header, max 2 KB) ----------
function encodeMetadata(metadata) {
  if (!metadata) return null;
  const payload = `${BASE64_PREFIX}${Buffer.from(JSON.stringify(metadata)).toString("base64")}`;
  if (METADATA_HEADER_EXTERNAL.length + payload.length > METADATA_MAX_SIZE) throw new Error("Metadata object exceeds the maximum size");
  return payload;
}

function metadataFromResponse(res) {
  const value = res.headers[METADATA_HEADER_EXTERNAL] || res.headers[METADATA_HEADER_INTERNAL];
  try {
    if (!value?.startsWith(BASE64_PREFIX)) return {};
    return JSON.parse(Buffer.from(value.slice(BASE64_PREFIX.length), "base64").toString());
  } catch {
    throw new Error("An internal error occurred while trying to retrieve the metadata for an entry. Please try updating to the latest version of the Netlify Blobs client.");
  }
}

// Read a response body the way the client does (it calls these methods on a fetch Response).
function readBody(res, type, onInvalidType) {
  const r = new Response(res.body);
  if (type === undefined || type === "text") return r.text();
  if (type === "arrayBuffer") return r.arrayBuffer();
  if (type === "blob") return r.blob();
  if (type === "json") return r.json();
  if (type === "stream") return r.body;
  return onInvalidType();
}

const toBuffer = async (data) => (data === undefined ? undefined : Buffer.from(await new Response(data).arrayBuffer()));

// ---------- the client model ----------
export class FakeStore {
  constructor(blobs, name, consistency) {
    validateStoreName(name);
    this.blobs = blobs;
    this.storeName = name;                  // as passed to getStore
    this.name = SITE_STORE_PREFIX + name;   // as the client names it
    this.consistency = consistency ?? "eventual";
  }

  // Client.makeRequest + fetchAndRetry
  _request({ method, key, conditions = {}, consistency, headers = {}, body, metadata, parameters = {} }) {
    const encodedMetadata = encodeMetadata(metadata); // throws before any request, like getFinalRequest
    const ifNoneMatch = conditions.onlyIfMatch ? undefined : conditions.onlyIfNew ? "*" : headers["if-none-match"];
    return this.blobs._fetchAndRetry({
      via: "model",
      method: method.toUpperCase(),
      store: this.storeName,
      key,
      ifMatch: conditions.onlyIfMatch || undefined,
      ifNoneMatch,
      metadata: encodedMetadata ?? undefined,
      body,
      params: { ...parameters },
      consistency: consistency ?? this.consistency,
    });
  }

  _context(method) { return { edgeAccess: true, method, storeName: this.name }; }

  async get(key, options) {
    const { consistency, type } = options ?? {};
    const res = await this._request({ consistency, key, method: "get" });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new BlobsInternalError(res);
    return readBody(res, type, () => { throw new BlobsInternalError(res); });
  }

  async getMetadata(key, options = {}) {
    const res = await this._request({ consistency: options.consistency, key, method: "head" });
    if (res.status === 404) return null;
    if (res.status !== 200 && res.status !== 304) throw new BlobsInternalError(res);
    return { etag: res.headers.etag ?? undefined, metadata: metadataFromResponse(res) };
  }

  async getWithMetadata(key, options) {
    const { consistency, etag: requestETag, type } = options ?? {};
    const headers = requestETag ? { "if-none-match": requestETag } : undefined;
    const res = await this._request({ consistency, headers, key, method: "get" });
    const responseETag = res.headers.etag ?? undefined;
    if (res.status === 404) return null;
    if (res.status !== 200 && res.status !== 304) throw new BlobsInternalError(res);
    const result = { etag: responseETag, metadata: metadataFromResponse(res) };
    if (res.status === 304 && requestETag) return { data: null, ...result };
    const data = await readBody(res, type, () => {
      throw new Error(`Invalid 'type' property: ${type}. Expected: arrayBuffer, blob, json, stream, or text.`);
    });
    return { data, ...result };
  }

  async set(key, data, options = {}) {
    validateKey(key);
    const conditions = getConditions(options);
    const res = await this._request({ conditions, body: await toBuffer(data), key, metadata: options.metadata, method: "put" });
    const etag = res.headers.etag ?? "";
    if (conditions) return res.status === 412 ? { modified: false } : { etag, modified: true };
    if (res.status === 200) return { etag, modified: true };
    throw new BlobsInternalError(res, this._context("put"), res.body ? res.body.toString() : "");
  }

  async setJSON(key, data, options = {}) {
    validateKey(key);
    const conditions = getConditions(options);
    const payload = JSON.stringify(data);
    const res = await this._request({
      conditions, body: payload === undefined ? undefined : Buffer.from(payload),
      headers: { "content-type": "application/json" }, key, metadata: options.metadata, method: "put",
    });
    const etag = res.headers.etag ?? "";
    if (conditions) return res.status === 412 ? { modified: false } : { etag, modified: true };
    if (res.status === 200) return { etag, modified: true };
    throw new BlobsInternalError(res, this._context("put"));
  }

  async delete(key) {
    const res = await this._request({ key, method: "delete" });
    if (![200, 204, 404].includes(res.status)) throw new BlobsInternalError(res, this._context("delete"));
  }

  async deleteAll() {
    let deletedBlobs = 0;
    let hasMore = true;
    while (hasMore) {
      const res = await this._request({ method: "delete" });
      if (res.status !== 200) throw new BlobsInternalError(res, this._context("delete"));
      const data = await new Response(res.body).json();
      if (typeof data.blobs_deleted !== "number") throw new BlobsInternalError(res);
      deletedBlobs += data.blobs_deleted;
      hasMore = typeof data.has_more === "boolean" && data.has_more;
    }
    return { deletedBlobs };
  }

  list(options = {}) {
    const iterator = this._listIterator(options);
    if (options.paginate) return iterator;
    return (async () => {
      const pages = [];
      for await (const page of iterator) pages.push(page);
      return pages.reduce((acc, p) => ({ blobs: [...acc.blobs, ...p.blobs], directories: [...acc.directories, ...p.directories] }), { blobs: [], directories: [] });
    })();
  }

  _listIterator(options) {
    const store = this;
    const parameters = {};
    if (options?.prefix) parameters.prefix = options.prefix;
    if (options?.directories) parameters.directories = "true";
    return {
      [Symbol.asyncIterator]() {
        let currentCursor = null;
        let done = false;
        return {
          async next() {
            if (done) return { done: true, value: undefined };
            const nextParameters = { ...parameters };
            if (currentCursor !== null) nextParameters.cursor = currentCursor;
            const res = await store._request({ method: "get", parameters: nextParameters });
            let blobs = [];
            let directories = [];
            if (![200, 204, 404].includes(res.status)) throw new BlobsInternalError(res);
            if (res.status === 404) {
              done = true;
            } else {
              const page = await new Response(res.body).json();
              if (page.next_cursor) currentCursor = page.next_cursor; else done = true;
              blobs = (page.blobs ?? []).map((b) => (b.key ? { etag: b.etag, key: b.key } : null)).filter(Boolean);
              directories = page.directories ?? [];
            }
            return { done: false, value: { blobs, directories } };
          },
        };
      },
    };
  }
}

// ---------- the fake site: server, faults, HTTP adapter, inspection ----------
export class FakeBlobs {
  constructor({ clock = new FakeClock(), retryDelayMs = 5000, maxRetries = 5, latencyMs = 0, listPageSize = 1000 } = {}) {
    this.clock = clock;
    this.retryDelayMs = retryDelayMs;   // DEFAULT_RETRY_DELAY in the client (5 s unless NODE_ENV=test)
    this.maxRetries = maxRetries;       // MAX_RETRY in the client
    this.latencyMs = latencyMs;         // number or (req) => number, per attempt, on the virtual clock
    this.listPageSize = listPageSize;   // server assumption
    this.siteID = "fake-site";
    this.token = "fake-token";
    this.edgeURL = "https://blobs-edge.test";
    this.uncachedEdgeURL = "https://blobs-uncached.test";
    this.stores = new Map();            // store name → Map(key → { body: Buffer, etag, metadata })
    this.faults = [];
    this.log = [];                      // one entry per HTTP attempt
    this.opened = [];                   // every getStore() call: { name, consistency }
    this.etagCounter = 0;
    this.getStore = this.getStore.bind(this);
    this.fetch = this.fetch.bind(this);
  }

  // Same signature as getStore from @netlify/blobs (site stores only).
  getStore(input, options) {
    let store;
    if (typeof input === "string") {
      store = new FakeStore(this, input, options?.consistency);
    } else if (typeof input?.name === "string") {
      if (!input.name) throw new MissingBlobsEnvironmentError(["name"]);
      store = new FakeStore(this, input.name, input.consistency);
    } else if (typeof input?.deployID === "string") {
      throw new Error("FakeBlobs does not model deploy stores");
    } else {
      throw new Error("The `getStore` method requires the name of the store as a string or as the `name` property of an options object");
    }
    this.opened.push({ name: store.storeName, consistency: store.consistency });
    return store;
  }

  // ----- faults -----
  inject(rule) {
    if (rule.fault !== undefined && !FAULTS.has(rule.fault)) throw new Error(`FakeBlobs.inject: unknown fault ${rule.fault}`);
    if (rule.fault === undefined && !rule.latencyMs) throw new Error("FakeBlobs.inject: give a fault or latencyMs");
    const r = { times: 1, skip: 0, status: 500, ...rule, hits: 0, skipped: 0 };
    this.faults.push(r);
    return r;
  }

  clearFaults() { this.faults = []; }

  _takeFault(req) {
    for (const r of this.faults) {
      if (r.hits >= r.times) continue;
      if (r.method && r.method !== req.op) continue;
      if (r.store && r.store !== req.store) continue;
      if (r.key !== undefined) {
        const ok = typeof r.key === "function" ? r.key(req.key) : r.key instanceof RegExp ? r.key.test(req.key ?? "") : r.key === req.key;
        if (!ok) continue;
      }
      if (r.match && !r.match(req)) continue;
      if (r.skipped < r.skip) { r.skipped++; continue; }
      r.hits++;
      return r;
    }
    return undefined;
  }

  // fetchAndRetry from the client: 6 attempts, retry on 429/5xx and on thrown errors, never on 4xx.
  async _fetchAndRetry(req) {
    for (let attemptsLeft = this.maxRetries; ; attemptsLeft--) {
      let res;
      try {
        res = await this._attempt(req);
      } catch (err) {
        if (attemptsLeft === 0) throw err;
        await this.clock.sleep(this.retryDelayMs);
        continue;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (attemptsLeft > 0 && retryable) {
        const reset = res.headers["x-ratelimit-reset"];
        await this.clock.sleep(reset ? Math.max(Number(reset) * 1000 - this.clock.now(), 1000) : this.retryDelayMs);
        continue;
      }
      return res;
    }
  }

  // One HTTP attempt: latency, then the fault (if any), then the server.
  async _attempt(input) {
    const req = { ...input, op: input.method === "GET" && input.key === undefined ? "LIST" : input.method };
    req.json = () => JSON.parse(req.body ? req.body.toString() : "");
    const fault = this._takeFault(req);
    const base = typeof this.latencyMs === "function" ? this.latencyMs(req) : this.latencyMs;
    const latency = (base || 0) + (fault?.latencyMs || 0);
    if (latency > 0) await this.clock.sleep(latency); else await new Promise((resolve) => setImmediate(resolve));
    const entry = { at: this.clock.now(), via: req.via, method: req.op, store: req.store, key: req.key, consistency: req.consistency };
    if (fault?.fault) entry.fault = fault.fault;
    this.log.push(entry);
    const failure = () => ({ status: fault.status, headers: { ...(fault.headers || {}) }, body: Buffer.from(fault.body || "") });
    switch (fault?.fault) {
      case "network-down":
        entry.error = "network-down";
        throw networkError("connect ECONNREFUSED", "ECONNREFUSED");
      case "fail-before":
        entry.status = fault.status;
        entry.committed = false;
        return failure();
      default: {
        const res = this._serve(req);
        entry.committed = Boolean(res.committed);
        if (fault?.fault === "fail-after") { entry.status = fault.status; return failure(); }
        if (fault?.fault === "lost-response") { entry.error = "lost-response"; throw networkError("read ECONNRESET", "ECONNRESET"); }
        entry.status = res.status;
        return res;
      }
    }
  }

  // ----- the server (synchronous, so every request is atomic) -----
  _data(store) {
    if (!this.stores.has(store)) this.stores.set(store, new Map());
    return this.stores.get(store);
  }

  _nextEtag() { return `"etag-${++this.etagCounter}"`; }

  _serve(req) {
    const data = this._data(req.store);
    const empty = (status, headers = {}) => ({ status, headers, body: null });
    const headersOf = (e) => ({ etag: e.etag, ...(e.metadata ? { [METADATA_HEADER_EXTERNAL]: e.metadata } : {}) });
    if (req.method === "GET" && req.key === undefined) return this._list(data, req.params || {});
    if (req.method === "GET" || req.method === "HEAD") {
      const e = data.get(req.key);
      if (!e) return empty(404);
      if (req.method === "HEAD") return empty(200, headersOf(e));
      if (req.ifNoneMatch !== undefined && (req.ifNoneMatch === "*" || req.ifNoneMatch === e.etag)) return empty(304, headersOf(e));
      return { status: 200, headers: headersOf(e), body: e.body };
    }
    if (req.method === "PUT") {
      const cur = data.get(req.key);
      if (req.ifMatch !== undefined && (!cur || cur.etag !== req.ifMatch)) return empty(412);
      if (req.ifNoneMatch === "*" && cur) return empty(412);
      const etag = this._nextEtag();
      data.set(req.key, { body: req.body ?? Buffer.alloc(0), etag, metadata: req.metadata });
      return { ...empty(200, { etag }), committed: true };
    }
    if (req.method === "DELETE") {
      if (req.key === undefined) { // deleteAll (server assumption: everything in one page)
        const n = data.size;
        data.clear();
        return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ blobs_deleted: n, has_more: false })), committed: n > 0 };
      }
      const existed = data.delete(req.key);
      return { ...empty(existed ? 204 : 404), committed: existed }; // server assumption: 204 / 404
    }
    return empty(405);
  }

  // Server assumption (Netlify docs): with directories, keys below the prefix that contain another "/" are
  // grouped into directory names (prefix + first segment, no trailing slash), listed on the first page.
  _list(data, params) {
    const prefix = params.prefix || "";
    const blobs = [];
    const dirs = new Set();
    for (const key of [...data.keys()].filter((k) => k.startsWith(prefix)).sort()) {
      const rest = key.slice(prefix.length);
      if (params.directories === "true" && rest.includes("/")) { dirs.add(prefix + rest.slice(0, rest.indexOf("/"))); continue; }
      blobs.push(key);
    }
    const start = params.cursor ? Number(params.cursor) : 0;
    const page = {
      blobs: blobs.slice(start, start + this.listPageSize).map((key) => ({ key, etag: data.get(key).etag, size: data.get(key).body.length })),
      directories: start === 0 ? [...dirs] : [],
    };
    if (start + this.listPageSize < blobs.length) page.next_cursor = String(start + this.listPageSize);
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(page)) };
  }

  // ----- HTTP adapter: lets the real @netlify/blobs client talk to this server -----
  async fetch(input, init = {}) {
    const url = new URL(String(input && typeof input === "object" && "url" in input && !(input instanceof URL) ? input.url : input));
    const consistency = url.origin === new URL(this.uncachedEdgeURL).origin ? "strong"
      : url.origin === new URL(this.edgeURL).origin ? "eventual" : null;
    if (!consistency) throw new TypeError(`fetch failed: ${url.href} is not the fake Blobs edge (tests never use the network)`);
    const headers = new Headers(init.headers || {});
    if (headers.get("authorization") !== `Bearer ${this.token}`) return new Response("bad token", { status: 401 });
    const segments = url.pathname.split("/").slice(1).map(decodeURIComponent);
    if (segments[0]?.startsWith("region:")) segments.shift();
    const [siteID, storeName = "", ...keyParts] = segments;
    if (siteID !== this.siteID) return new Response("unknown site", { status: 404 });
    if (!storeName.startsWith(SITE_STORE_PREFIX)) throw new Error(`FakeBlobs only models site stores, got '${storeName}'`);
    const method = String(init.method || "GET").toUpperCase();
    const res = await this._attempt({
      via: "http",
      method,
      store: storeName.slice(SITE_STORE_PREFIX.length),
      key: keyParts.length ? keyParts.join("/") : undefined,
      ifMatch: headers.get("if-match") ?? undefined,
      ifNoneMatch: headers.get("if-none-match") ?? undefined,
      metadata: headers.get(METADATA_HEADER_INTERNAL) ?? undefined,
      body: init.body == null ? undefined : await toBuffer(init.body),
      params: Object.fromEntries(url.searchParams),
      consistency,
    });
    const nullBody = res.body == null || res.status === 204 || res.status === 304 || method === "HEAD";
    return new Response(nullBody ? null : res.body, { status: res.status, headers: res.headers });
  }

  // ----- inspection and seeding (server side: no faults, no log, no latency) -----
  keys(store) { return [...this._data(store).keys()].sort(); }
  has(store, key) { return this._data(store).has(key); }
  etag(store, key) { return this._data(store).get(key)?.etag; }
  text(store, key) { return this._data(store).get(key)?.body.toString(); }
  json(store, key) {
    const t = this.text(store, key);
    return t === undefined ? undefined : JSON.parse(t);
  }
  seed(store, key, value) {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    const etag = this._nextEtag();
    this._data(store).set(key, { body, etag, metadata: undefined });
    return etag;
  }
  remove(store, key) { return this._data(store).delete(key); }
  snapshot() {
    const out = {};
    for (const name of [...this.stores.keys()].sort()) {
      out[name] = {};
      for (const key of this.keys(name)) {
        const e = this._data(name).get(key);
        out[name][key] = { etag: e.etag, body: e.body.toString(), metadata: e.metadata ?? null };
      }
    }
    return out;
  }
  // Attempts in the log, optionally filtered: blobs.requests({ method: "PUT", store: "bookings" })
  requests(filter = {}) {
    return this.log.filter((e) => Object.entries(filter).every(([k, v]) => e[k] === v));
  }
}
