// Statistikk-settet for nye nettsider: merkede lenker, besøk vs. visninger, sidenavn, norsk dato, bare eierens nøkkel.
import test from "node:test";
import assert from "node:assert/strict";
import { handle, sourceOf, pageName, osloDate, addDays, TAGS } from "../stats-kit/netlify/functions/stats.mjs";
import { sourceOf as viggoSourceOf, TAGS as VIGGO_TAGS } from "../netlify/functions/stats.mjs";

function fakeStore() {
  const m = new Map(); let n = 0;
  return {
    m,
    async get(k) { const v = m.get(k); return v ? JSON.parse(v.body) : null; },
    async getWithMetadata(k) { const v = m.get(k); return v ? { data: JSON.parse(v.body), etag: v.etag } : null; },
    async setJSON(k, val, o = {}) {
      const cur = m.get(k);
      if (o.onlyIfNew && cur) return { modified: false };
      if (o.onlyIfMatch && (!cur || cur.etag !== o.onlyIfMatch)) return { modified: false };
      const etag = "e" + ++n; m.set(k, { body: JSON.stringify(val), etag }); return { modified: true, etag };
    },
  };
}
const NOW = new Date("2026-11-17T22:30:00Z"); // 23:30 norsk tid
const deps = (store, env = {}) => ({ env, now: () => NOW, store: () => store });
const PROD = { deploy: { context: "production" } };
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 10_3 like Mac OS X) AppleWebKit/603.1.30 Safari/602.1";
const hit = (store, body, site = "https://www.frisor.example") =>
  handle(new Request(site + "/api/hit", { method: "POST", headers: { "user-agent": UA }, body: JSON.stringify(body) }), PROD, deps(store));

test("merkede lenker vinner over avsender; ukjent merke blir «annet»; samme liste som Viggo's", () => {
  assert.equal(sourceOf("", "instagram"), "instagram");
  assert.equal(sourceOf("www.google.no", "QR"), "qr");
  assert.equal(sourceOf("", "tull"), "annet");
  assert.equal(sourceOf("l.instagram.com", ""), "instagram");
  assert.equal(sourceOf("", ""), "direkte");
  assert.deepEqual(TAGS, VIGGO_TAGS, "kit og Viggo's må ha samme kilder, ellers blir oversikten ulik");
  assert.equal(viggoSourceOf("", "visittkort"), "visittkort");
});

test("treff: besøk utenfra med kilde, intern navigering bare visning, roboter teller ikke", async () => {
  const s = fakeStore();
  await hit(s, { p: "/", r: "", f: "instagram" });
  await hit(s, { p: "/priser.html", r: "www.frisor.example", f: "" });
  await handle(new Request("https://www.frisor.example/api/hit", { method: "POST", headers: { "user-agent": "Googlebot/2.1" }, body: "{}" }), PROD, deps(s));
  const d = await s.get("d/" + osloDate(NOW));
  assert.deepEqual([d.views, d.visits, d.sources.instagram, d.pages.forside, d.pages.priser], [2, 1, 1, 1, 1]);
});

test("treff: forhåndsvisninger telles ikke, og sidenavn kan ikke fylle lagringen", async () => {
  const s = fakeStore();
  await handle(new Request("https://x.example/api/hit", { method: "POST", headers: { "user-agent": UA }, body: "{}" }), { deploy: { context: "deploy-preview" } }, deps(s));
  assert.equal(s.m.size, 0);
  assert.equal(pageName("/" + "a".repeat(200)), "annen");
  assert.equal(pageName("/<script>"), "annen");
  assert.equal(pageName("/om-oss/"), "om-oss");
  assert.equal(pageName(""), "forside");
});

test("norsk dato: 23:30 norsk tid er fortsatt samme dag; addDays over månedsskifte", () => {
  assert.equal(osloDate(NOW), "2026-11-17");
  assert.equal(osloDate(new Date("2026-11-17T23:30:00Z")), "2026-11-18");
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2026-03-29", -1), "2026-03-28"); // sommertid-helgen
});

test("statistikk: bare med riktig lesenøkkel; svaret har ingen bookingtall og riktig periode", async () => {
  const s = fakeStore();
  await hit(s, { p: "/", r: "", f: "qr" });
  const get = (headers, q = "?days=7") => handle(new Request("https://www.frisor.example/api/stats" + q, { headers }), PROD, deps(s, { STATS_READ_KEY: "eier-nokkel-123" }));
  assert.equal((await get({})).status, 401);
  assert.equal((await get({ "x-stats-key": "feil" })).status, 401);
  const r = await get({ "x-stats-key": "eier-nokkel-123" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.range, 7); assert.equal(j.bookings, null); assert.equal(j.totals.visits, 1); assert.equal(j.sources.qr, 1);
  assert.equal((await (await get({ "x-stats-key": "eier-nokkel-123" }, "?days=12")).json()).range, 30);
});
