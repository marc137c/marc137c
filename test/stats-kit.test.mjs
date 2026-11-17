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

// ---------- Grenser, norsk tid hele året, periodene, feil, sletting og beaconene ----------
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { prune, KEEP_DAYS } from "../stats-kit/netlify/functions/stats.mjs";
import { handle as viggoHandle } from "../netlify/functions/stats.mjs";

// fakeStore + list/delete (det statistikk-settet bruker for å slette gamle dager)
function fullStore() {
  const s = fakeStore();
  s.list = async ({ prefix = "" } = {}) => ({ blobs: [...s.m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) });
  s.delete = async (k) => { s.m.delete(k); };
  return s;
}
const seed = (s, date, doc) => s.m.set("d/" + date, { body: JSON.stringify(doc), etag: "seed-" + date });
const CUBOT = "Mozilla/5.0 (Linux; Android 12; KINGKONG 7 Build/SP1A; wv) AppleWebKit/537.36 Chrome/119.0 Mobile Safari/537.36 Instagram 307.0.0.34.111 Android (31/12; 480dpi; 1080x2400; CUBOT; KINGKONG 7; KINGKONG_7; mt6789; nb_NO; 532310281)";

test("sidenavn: tusen tilfeldige navn gir høyst 31 nøkler per dag, og «constructor» er et vanlig tall", async () => {
  const s = fullStore();
  for (let i = 0; i < 1000; i++) await hit(s, { p: "/" + Math.random().toString(36).slice(2, 12), r: "www.frisor.example" });
  for (let i = 0; i < 3; i++) await hit(s, { p: "/constructor", r: "www.frisor.example" });
  const d = await s.get("d/" + osloDate(NOW));
  assert.ok(Object.keys(d.pages).length <= 31, Object.keys(d.pages).length + " sidenavn lagret");
  assert.equal(d.views, 1003);
  const fresh = fullStore();
  for (let i = 0; i < 3; i++) await hit(fresh, { p: "/constructor", r: "www.frisor.example" });
  assert.equal((await fresh.get("d/" + osloDate(NOW))).pages.constructor, 3);
});

test("norsk dato hele året: sommertid og begge omstillingsnettene", () => {
  assert.equal(osloDate(new Date("2026-07-01T22:30:00Z")), "2026-07-02"); // 00:30 sommertid
  assert.equal(osloDate(new Date("2026-07-01T21:30:00Z")), "2026-07-01");
  assert.equal(osloDate(new Date("2026-03-28T23:00:00Z")), "2026-03-29"); // midnatt natt til sommertid
  assert.equal(osloDate(new Date("2026-10-24T22:00:00Z")), "2026-10-25"); // midnatt (sommertid) natt til vintertid
  assert.equal(osloDate(new Date("2026-10-25T22:59:00Z")), "2026-10-25");
});

test("periodene: 7/30/90 dager summerer riktige dager; uke og måned følger dagene", async () => {
  const s = fullStore();
  const today = osloDate(NOW);
  for (const back of [0, 6, 7, 29, 30, 89, 90]) seed(s, addDays(today, -back), { views: 1, visits: 1, pages: {}, sources: { qr: 1 } });
  const get = async (days) => (await handle(new Request("https://www.frisor.example/api/stats?days=" + days, { headers: { "x-stats-key": "eier-nokkel-123" } }), PROD, deps(s, { STATS_READ_KEY: "eier-nokkel-123" }))).json();
  for (const [days, want] of [[7, 2], [30, 4], [90, 6]]) {
    const j = await get(days);
    assert.deepEqual([j.totals.views, j.totals.visits, j.sources.qr], [want, want, want], days + " dager");
    assert.deepEqual([j.totals.week, j.totals.month, j.totals.today], [2, 4, 1]);
    assert.equal(j.days.length, Math.max(days, 30));
    assert.equal(j.days[0].date, today);
    for (const k of TAGS) assert.equal(typeof j.sources[k], "number", "kilden " + k + " er med");
  }
});

test("statistikk: 503 (ikke nuller) når lageret ikke kan leses", async () => {
  const s = fullStore();
  s.get = async () => { throw new Error("Blobs nede"); };
  const r = await handle(new Request("https://www.frisor.example/api/stats?days=7", { headers: { "x-stats-key": "eier-nokkel-123" } }), PROD, deps(s, { STATS_READ_KEY: "eier-nokkel-123" }));
  assert.equal(r.status, 503);
});

test("for gammel @netlify/blobs (ingen betinget skriving): et besøk telles aldri seks ganger", async () => {
  const s = fullStore();
  const real = s.setJSON;
  s.setJSON = async (k, v) => { await real(k, v); return undefined; }; // versjon 9: ignorerer onlyIfMatch, svarer undefined
  await hit(s, { p: "/", r: "", f: "instagram" });
  const d = await s.get("d/" + osloDate(NOW));
  assert.ok(!d || d.views <= 1, "telt " + (d && d.views) + " ganger");
});

test("sletting: første besøk en ny dag sletter dager eldre enn 400 dager (ingenting lagres for alltid)", async () => {
  const s = fullStore();
  const today = osloDate(NOW);
  seed(s, addDays(today, -(KEEP_DAYS + 30)), { views: 1 });
  seed(s, addDays(today, -(KEEP_DAYS + 1)), { views: 1 });
  seed(s, addDays(today, -KEEP_DAYS), { views: 1 });
  seed(s, addDays(today, -1), { views: 1 });
  await hit(s, { p: "/", r: "" });
  const keys = [...s.m.keys()].sort();
  assert.deepEqual(keys, ["d/" + addDays(today, -KEEP_DAYS), "d/" + addDays(today, -1), "d/" + today]);
  assert.equal(await prune(s, today), 0);
});

test("roboter: Googlebot telles ikke, men en ekte Cubot-telefon (…CUBOT… i nettleser-ID) telles", async () => {
  const s = fullStore();
  const ua = (u) => handle(new Request("https://www.frisor.example/api/hit", { method: "POST", headers: { "user-agent": u }, body: "{}" }), PROD, deps(s));
  await ua("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)");
  await ua("Mozilla/5.0 (compatible; AhrefsBot/7.0)");
  await ua(CUBOT);
  assert.equal((await s.get("d/" + osloDate(NOW))).views, 1);
});

test("beacon (settet): sender merket kilde fra ?fra= i små bokstaver, avsender og side – og ingenting annet", () => {
  const src = readFileSync(new URL("../stats-kit/public/stats-beacon.js", import.meta.url), "utf8");
  const sent = [];
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype = { open(m, u) { this.m = m; this.u = u; }, setRequestHeader() {}, send(b) { sent.push({ m: this.m, u: this.u, b: JSON.parse(b) }); } };
  vm.runInNewContext(src, { XMLHttpRequest, location: { pathname: "/priser", search: "?lang=en&fra=QR" }, document: { referrer: "https://l.instagram.com/x" } });
  assert.deepEqual(sent, [{ m: "POST", u: "/api/hit", b: { p: "/priser", r: "l.instagram.com", f: "qr" } }]);
});

test("beacon (Viggo's script.js): sender også den merkede kilden", () => {
  const src = readFileSync(new URL("../viggos-barbershop/script.js", import.meta.url), "utf8");
  const m = /\(\(\) => \{\s*try \{\s*const tag = [\s\S]*?\n\}\)\(\);/.exec(src);
  assert.ok(m, "fant ikke telleren i script.js");
  const sent = [];
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype = { open() {}, setRequestHeader() {}, send(b) { sent.push(JSON.parse(b)); } };
  vm.runInNewContext(m[0], { XMLHttpRequest, location: { pathname: "/", search: "?fra=Visittkort" }, document: { referrer: "" } });
  assert.deepEqual(sent, [{ p: "/", r: "", f: "visittkort" }]);
});

test("Viggo's /api/hit + /api/stats: merket lenke telles som egen kilde, alle kildene er med, 503 ved lagerfeil", async () => {
  const stats = fullStore(), bookings = fullStore();
  const vd = (env = {}) => ({ env, now: () => NOW, stats: () => stats, bookings: () => bookings });
  const send = (body, u = UA) => viggoHandle(new Request("https://www.viggosbarbershop.no/api/hit", { method: "POST", headers: { "user-agent": u }, body: JSON.stringify(body) }), PROD, vd());
  assert.equal((await send({ p: "/", r: "", f: "qr" })).status, 204);
  await send({ p: "/", r: "", f: "visittkort" }, CUBOT);
  await send({ p: "/", r: "" }, "Googlebot/2.1");
  const get = () => viggoHandle(new Request("https://www.viggosbarbershop.no/api/stats?days=7", { headers: { "x-stats-key": "eier" } }), PROD, vd({ STATS_READ_KEY: "eier" }));
  const j = await (await get()).json();
  assert.equal(j.sources.qr, 1); assert.equal(j.sources.visittkort, 1); assert.equal(j.totals.views, 2);
  for (const k of VIGGO_TAGS) assert.equal(typeof j.sources[k], "number", "kilden " + k + " er med");
  stats.get = async () => { throw new Error("nede"); };
  assert.equal((await get()).status, 503);
});
