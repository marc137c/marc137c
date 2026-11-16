// scripts/smoke-live.mjs is run by hand after each publish (DEPLOY.md). It is never run against the network here:
// these tests feed it a fake site built from the repository's own files and the real function handlers, so a
// good publish passes every check, and each way a publish can go wrong fails exactly the check that names it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { smoke, OLD_SITE_HOST, AVAILABILITY_KEYS } from "../../scripts/smoke-live.mjs";
import { testDeps, PRODUCTION } from "../helpers/deps.mjs";
import * as availabilityFn from "../../netlify/functions/availability.mjs";
import * as adminFn from "../../netlify/functions/admin.mjs";

const ORIGIN = "https://www.viggosbarbershop.no";
const SITE = fileURLToPath(new URL("../../viggos-barbershop/", import.meta.url));
const file = (f) => readFileSync(SITE + f);
const RETIRED = { deploy: { context: "production", id: "deploy-old", published: false } };
const OLD_PERMALINK = "6730a1b2c3d4e5f6a7b8c9d0--" + OLD_SITE_HOST;

const answer = (status, body = "", headers = {}) => ({
  status,
  headers: { get: (k) => headers[k.toLowerCase()] || null },
  text: async () => (Buffer.isBuffer(body) ? body.toString("utf8") : String(body)),
  arrayBuffer: async () => { const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
});
const fromResponse = async (res) => answer(res.status, await res.text(), Object.fromEntries(res.headers));

// The published site as Netlify would serve this repository; change(url) can replace any answer
function fakeSite(change = () => null) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init.method, redirect: init.redirect });
    const changed = await change(url);
    if (changed) return changed;
    const u = new URL(url);
    if (u.host === OLD_SITE_HOST) return answer(301, "", { location: ORIGIN + u.pathname });
    if (u.host === "viggosbarbershop.no") return answer(301, "", { location: ORIGIN + u.pathname });
    if (u.host !== "www.viggosbarbershop.no") {
      return fromResponse(await adminFn.handle(new Request(url), RETIRED, testDeps())); // an old permalink of a retired deploy
    }
    if (u.pathname === "/") return answer(200, file("index.html"));
    if (u.pathname === "/api/availability") return fromResponse(await availabilityFn.handle(new Request(url), PRODUCTION, testDeps()));
    if (u.pathname === "/README.md") return answer(404, file("404.html"));
    try { return answer(200, file(u.pathname.slice(1))); } catch { return answer(404, file("404.html")); }
  };
  return { fetchFn, calls };
}
const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name);

test("smoke-live: the repository as published passes every check, with GET only", async () => {
  const site = fakeSite();
  const results = await smoke({ origin: ORIGIN, oldHosts: [OLD_PERMALINK], fetchFn: site.fetchFn });
  assert.deepEqual(failed(results), [], JSON.stringify(results.filter((r) => !r.ok)));
  assert.equal(results.length, 10);
  assert.ok(site.calls.every((c) => c.method === "GET"), "GET only");
  assert.ok(site.calls.some((c) => c.url === `https://${OLD_PERMALINK}/api/admin/items`));
});

test("smoke-live: the allowed availability fields are exactly what the server sends", async () => {
  const res = await availabilityFn.handle(new Request(ORIGIN + "/api/availability"), PRODUCTION, testDeps());
  assert.deepEqual(Object.keys(await res.json()).sort(), AVAILABILITY_KEYS);
});

for (const [label, name, change] of [
  ["a Netlify Forms form on the front page", "forsiden", (u) => (u === ORIGIN + "/" ? answer(200, file("index.html").toString().replace("<form ", "<form data-netlify=\"true\" ")) : null)],
  ["og:url still on netlify.app", "forsiden", (u) => (u === ORIGIN + "/" ? answer(200, file("index.html").toString().replace(/og:url" content="[^"]+"/, `og:url" content="https://${OLD_SITE_HOST}/"`)) : null)],
  ["a favicon that is not the repository's", "favicon.ico", (u) => (u.endsWith("/favicon.ico") ? answer(200, Buffer.from("not the icon")) : null)],
  ["Netlify's own English 404 page", "404-siden", (u) => (/finnes-ikke-/.test(u) ? answer(404, "<h1>Page not found</h1>") : null)],
  ["the manual served as a page", "README.md vises ikke", (u) => (u.endsWith("/README.md") ? answer(200, "# Viggo's Barbershop") : null)],
  ["no privacy page", "personvern.html", (u) => (u.endsWith("/personvern.html") ? answer(404, file("404.html")) : null)],
  ["the combo at 60 minutes", "/api/availability", async (u) => {
    if (!u.endsWith("/api/availability")) return null;
    const data = await (await availabilityFn.handle(new Request(u), PRODUCTION, testDeps())).json();
    data.durations["Herreklipp + skjeggtrim"] = 60;
    return answer(200, JSON.stringify(data));
  }],
  ["an unknown field in /api/availability", "/api/availability", async (u) => {
    if (!u.endsWith("/api/availability")) return null;
    const data = await (await availabilityFn.handle(new Request(u), PRODUCTION, testDeps())).json();
    data.reminderState = "pending";
    return answer(200, JSON.stringify(data));
  }],
  ["an old permalink still on old code (401)", `gammel permalenke ${OLD_PERMALINK}`, (u) => (u.includes("--") ? answer(401, "{\"error\":\"Logg inn.\"}") : null)],
  ["the netlify.app host still serving the site", `${OLD_SITE_HOST} sender videre`, (u) => (u.includes(OLD_SITE_HOST) && !u.includes("--") ? answer(200, file("index.html")) : null)],
  ["the apex not sent to www", "viggosbarbershop.no sender til www", (u) => (u === "https://viggosbarbershop.no/" ? answer(200, file("index.html")) : null)],
]) {
  test(`smoke-live: ${label} fails «${name}» and nothing else`, async () => {
    const results = await smoke({ origin: ORIGIN, oldHosts: [OLD_PERMALINK], fetchFn: fakeSite(change).fetchFn });
    assert.deepEqual(failed(results), [name]);
  });
}

test("smoke-live: a request that never answers is a failure, not a hang", async () => {
  const results = await smoke({ origin: ORIGIN, fetchFn: (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("timeout")));
  }), timeoutMs: 20 });
  assert.ok(results.length >= 7 && results.every((r) => !r.ok));
});
