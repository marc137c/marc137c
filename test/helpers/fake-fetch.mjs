// A generic fetch stand-in for external APIs. It answers from routes, records every call, and throws like
// a dead network for any URL without a route: no test can reach the internet by accident. testDeps() uses
// fakeFetch() with no routes as deps.fetch unless the test passes its own.
//
//   const fetch = fakeFetch([
//     ["https://example.test/api", (call) => ({ ok: true })],          // exact URL (query ignored)
//     [/example\.test\/v2\//, () => new Response("x", { status: 500 })], // RegExp on the full URL
//   ]);
//   fetch.calls  → [{ url, method, headers, body, json(), signal }]
//
// A route handler gets the call and returns a Response, a plain object (sent as JSON with status 200),
// or throws (the fetch rejects with that error).

const headerObject = (h) => {
  if (!h) return {};
  if (typeof h.forEach === "function" && !Array.isArray(h)) { const o = {}; h.forEach((v, k) => { o[k] = v; }); return o; }
  return Array.isArray(h) ? Object.fromEntries(h) : { ...h };
};

const bodyText = (b) => {
  if (b == null) return undefined;
  if (typeof b === "string") return b;
  if (b instanceof URLSearchParams) return b.toString();
  if (ArrayBuffer.isView(b)) return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString();
  if (b instanceof ArrayBuffer) return Buffer.from(b).toString();
  return String(b);
};

const matches = (pattern, url, call) => {
  if (typeof pattern === "function") return pattern(url, call);
  if (pattern instanceof RegExp) return pattern.test(url);
  return url.split("?")[0] === pattern.split("?")[0];
};

export function fakeFetch(routes = []) {
  const calls = [];
  const fn = async (input, init = {}) => {
    const url = String(input && typeof input === "object" && "url" in input && !(input instanceof URL) ? input.url : input);
    const call = {
      url,
      method: String(init.method || "GET").toUpperCase(),
      headers: headerObject(init.headers),
      body: bodyText(init.body),
      signal: init.signal,
      json() { return JSON.parse(this.body); },
      form() { return Object.fromEntries(new URLSearchParams(this.body)); },
    };
    calls.push(call);
    const route = routes.find(([pattern]) => matches(pattern, url, call));
    if (!route) throw new TypeError(`fetch failed: no fake route for ${call.method} ${url} (tests never use the network)`);
    const reply = await route[1](call);
    return reply instanceof Response ? reply : Response.json(reply);
  };
  fn.calls = calls;
  fn.route = (pattern, handler) => { routes.unshift([pattern, handler]); return fn; };
  return fn;
}

// A handler that never answers until the request is aborted (models a hanging upstream).
export const hang = (call) => new Promise((resolve, reject) => {
  if (!call.signal) return; // without a signal it hangs for the rest of the test
  const abort = () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
  if (call.signal.aborted) abort(); else call.signal.addEventListener("abort", abort, { once: true });
});
