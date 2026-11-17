// Eierens oversikt: innlogging med brems, billett som går ut, og henting fra alle bedriftene (én feil stopper ikke resten).
import test from "node:test";
import assert from "node:assert/strict";
import { handle, makeToken, verifyToken, slim } from "../oversikt/netlify/functions/overview.mjs";

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
    async delete(k) { m.delete(k); },
  };
}
const SITES = [
  { id: "a", name: "A", url: "https://a.example", keyEnv: "KEY_A" },
  { id: "b", name: "B", url: "https://b.example", keyEnv: "KEY_B" },
  { id: "c", name: "C", url: "https://c.example", keyEnv: "KEY_C" },
];
const STATS = { today: "2026-11-17", totals: { visits: 30, views: 34 }, sources: { google: 20, direkte: 10 },
  days: [{ date: "2026-11-17", visits: 3, views: 4, bookings: { web: 1, admin: 1, cancelled: 0 } }, { date: "2026-11-16", visits: 5, views: 5, bookings: { web: 0, admin: 0, cancelled: 0 } }],
  bookings: { web: 4, admin: 1, cancelled: 1, services: { Herreklipp: 3 }, weekdays: [0, 1, 0, 0, 0, 2, 1], upcoming7: 2 } };
function deps(over = {}) {
  let t = 1_800_000_000_000;
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, key: opts.headers["X-Stats-Key"] });
    if (url.startsWith("https://a.example")) return new Response(JSON.stringify(STATS), { status: 200 });
    if (url.startsWith("https://b.example")) return new Response("{}", { status: 401 });
    throw Object.assign(new Error("t"), { name: "TimeoutError" });
  };
  return { env: { OVERVIEW_PASSWORD: "riktig-passord", KEY_A: "ka", KEY_B: "kb" }, store: fakeStore(), fetchImpl, now: () => t, sites: SITES, calls, tick: (ms) => { t += ms; }, ...over };
}
const login = (d, pw, ip = "1.2.3.4") => handle(new Request("https://o.example/api/login", { method: "POST", body: JSON.stringify({ password: pw }) }), { ip }, d);
const overview = (d, token, days = 7) => handle(new Request("https://o.example/api/overview?days=" + days, { headers: { authorization: "Bearer " + token } }), {}, d);

test("innlogging: riktig passord gir billett, feil gir 401, uten passord satt 503", async () => {
  const d = deps();
  const ok = await login(d, "riktig-passord");
  assert.equal(ok.status, 200);
  assert.ok(verifyToken((await ok.json()).token, "riktig-passord", d.now()));
  assert.equal((await login(d, "feil")).status, 401);
  assert.equal((await login(deps({ env: {} }), "x")).status, 503);
});

test("brems: 8 feil fra samme avsender gir 429, også for riktig passord; nytt vindu slipper til", async () => {
  const d = deps();
  for (let i = 0; i < 8; i++) assert.equal((await login(d, "feil" + i)).status, 401);
  assert.equal((await login(d, "riktig-passord")).status, 429);
  assert.equal((await login(d, "riktig-passord", "9.9.9.9")).status, 200, "en annen avsender slipper inn");
  d.tick(16 * 60 * 1000);
  assert.equal((await login(d, "riktig-passord")).status, 200);
});

test("brems: lagringen er begrenset – bare to vinduer finnes samtidig, uansett antall avsendere", async () => {
  const d = deps();
  for (let w = 0; w < 4; w++) {
    for (let i = 0; i < 20; i++) await login(d, "feil", "10.0." + w + "." + i);
    d.tick(15 * 60 * 1000);
  }
  await login(d, "feil", "10.9.9.9");
  assert.ok(d.store.m.size <= 2, "fant " + d.store.m.size + " tellerfiler");
});

test("billett: går ut etter 12 timer og gjelder ikke med et annet passord", () => {
  const t0 = 1_800_000_000_000;
  const tok = makeToken("p", t0);
  assert.equal(verifyToken(tok, "p", t0 + 11 * 3600e3), true);
  assert.equal(verifyToken(tok, "p", t0 + 13 * 3600e3), false);
  assert.equal(verifyToken(tok, "annet", t0), false);
  assert.equal(verifyToken("tull", "p", t0), false);
});

test("oversikt: henter alle bedriftene med hver sin nøkkel; feil hos én stopper ikke de andre", async () => {
  const d = deps();
  const tok = makeToken("riktig-passord", d.now());
  assert.equal((await overview(d, "feil-billett")).status, 401);
  const r = await overview(d, tok, 7);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.range, 7);
  const [a, b, c] = j.sites;
  assert.equal(a.ok, true); assert.equal(a.data.visits, 30); assert.equal(a.data.days[0].booked, 2);
  assert.equal(b.ok, false); assert.match(b.error, /ikke godtatt/);
  assert.equal(c.ok, false); assert.match(c.error, /Mangler lesenøkkel/);
  assert.deepEqual(d.calls.map((x) => x.key), ["ka", "kb"]);
  assert.ok(d.calls[0].url.endsWith("/api/stats?days=7"));
});

test("oversikt: en bedrift som henger blir «Svarte ikke», og ugyldig periode blir 30 dager", async () => {
  const d = deps({ env: { OVERVIEW_PASSWORD: "riktig-passord", KEY_A: "ka", KEY_B: "kb", KEY_C: "kc" } });
  const j = await (await overview(d, makeToken("riktig-passord", d.now()), 12)).json();
  assert.equal(j.range, 30);
  assert.match(j.sites[2].error, /Svarte ikke/);
});

test("slim: bare valgt periode, og ingen bookingtall blir null (ikke 0)", () => {
  const s = slim({ ...STATS, days: [...STATS.days, { date: "2026-11-15", visits: 1, views: 1, bookings: null }] }, 2);
  assert.equal(s.days.length, 2);
  const t = slim({ days: [{ date: "2026-11-15", visits: 1, views: 1, bookings: null }] }, 7);
  assert.equal(t.days[0].booked, null);
});

test("bedriftsliste: bedrifter fra lageret kommer med, ugyldige hoppes over, fast oppføring vinner, nøkkelen sendes ikke videre", async () => {
  const { mergeSites, validEntry } = await import("../oversikt/netlify/functions/overview.mjs");
  const good = { id: "frisor-anna", name: "Frisør Anna", url: "https://anna.example", key: "k".repeat(43) };
  assert.equal(validEntry(good), true);
  for (const bad of [{ ...good, id: "Store Bokstaver" }, { ...good, url: "http://anna.example" }, { ...good, url: "javascript:alert(1)" },
    { ...good, url: "https://user:pw@anna.example" }, { ...good, key: "kort" }, { ...good, name: "" }, null, "tekst"]) assert.equal(validEntry(bad), false);
  const merged = mergeSites(SITES, [good, { ...good, id: "a", name: "Kopi av A" }, { id: "x" }]);
  assert.deepEqual(merged.map((s) => s.id), ["a", "b", "c", "frisor-anna"]);
  assert.equal(merged.find((s) => s.id === "a").name, "A", "fast oppføring vinner ved lik id");

  const d = deps({ registry: async () => [good] });
  const calls = [];
  d.fetchImpl = async (url, opts) => { calls.push({ url, key: opts.headers["X-Stats-Key"] }); return new Response(JSON.stringify(STATS), { status: 200 }); };
  const j = await (await overview(d, makeToken("riktig-passord", d.now()), 7)).json();
  const anna = j.sites.find((s) => s.id === "frisor-anna");
  assert.equal(anna.ok, true);
  assert.ok(calls.some((c) => c.url.startsWith("https://anna.example/api/stats") && c.key === good.key), "henter med nøkkelen fra lageret");
  assert.equal(JSON.stringify(j).includes(good.key), false, "nøkkelen sendes aldri til nettleseren");
});

// ---------- Svar fra bedriftenes sider er utrygge: bare tall, faste former, begrenset størrelse ----------
const HOSTILE = '<meta http-equiv="refresh" content="0;url=https://evil.example/logg-inn">';
const tokenFor = (d) => makeToken("riktig-passord", d.now());
function siteReturning(body, init = { status: 200 }) {
  const d = deps({ sites: [SITES[0]] });
  d.fetchImpl = async (url, opts) => { d.calls.push({ url, opts }); return new Response(typeof body === "string" ? body : JSON.stringify(body), init); };
  return d;
}
// Alle tekstverdier i svaret utenom de oversikten selv setter (id, navn, adresse, datoer). Kilde- og tjenestenavn er nøkler, ikke verdier.
function strayStrings(site) {
  const out = [];
  const walk = (v, path) => {
    if (typeof v === "string") { if (!/^(id|name|url|data\.today|data\.days\.\d+\.date)$/.test(path)) out.push(path + "=" + v); return; }
    if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k], path ? path + "." + k : k);
  };
  walk(site, "");
  return out;
}

test("slim: HTML i tall, kilder og bookinger fra en bedrift blir aldri med – svaret har bare tall", async () => {
  const d = siteReturning({ today: "2026-11-17", totals: { visits: HOSTILE, views: "<b>x</b>" },
    sources: { google: '<a href="https://evil.example/">Logg inn på nytt</a>', qr: 3, "<img src=x>": 5 },
    days: [{ date: "2026-11-17", visits: "<h1>x</h1>", views: 1, bookings: { web: "<i>u</i>", admin: 1, cancelled: "<b>c</b>" } }, { date: 20261116, visits: 1 }],
    bookings: { web: "<h1>x</h1>", admin: 1, cancelled: "<b>c</b>", upcoming7: "<i>u</i>", weekdays: ["<x>"], services: { Klipp: "<form action=/><input name=pw type=password></form>", "<b>Skjegg</b>": 2 } } });
  const j = await (await overview(d, tokenFor(d))).json();
  const s = j.sites[0];
  assert.equal(s.ok, true);
  assert.deepEqual(strayStrings(s), []);
  assert.equal(JSON.stringify(s).includes("evil.example"), false);
  assert.equal(JSON.stringify(s).includes("<form"), false);
  assert.equal(s.data.visits, 0); assert.equal(s.data.sources.google, 0); assert.equal(s.data.sources.qr, 3);
  assert.equal(s.data.sources["<img src=x>"], undefined, "ukjente kildenavn med rare tegn tas ikke med");
  assert.deepEqual(s.data.days.map((x) => x.date), ["2026-11-17"], "datoer som ikke er tekst på formen ÅÅÅÅ-MM-DD hoppes over");
  assert.deepEqual(s.data.bookings.weekdays, [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(s.data.bookings.services.Klipp, 0);
  assert.equal(s.data.bookings.services["<b>Skjegg</b>"], 2, "tjenestenavn er tekst (vises escaped), antallet er et tall");
});

test("slim: en bedrift som sender feil form eller enorme lister gir et lite svar med fast form", () => {
  const big = {}; for (let i = 0; i < 50000; i++) big["k" + i] = i;
  const s = slim({ days: [{ date: "2026-11-17", visits: 1 }], sources: big, bookings: { services: big } }, 7);
  assert.ok(JSON.stringify(s).length < 3000, "svaret er " + JSON.stringify(s).length + " byte");
  assert.equal(Object.keys(s.bookings.services).length, 20);
  assert.equal(s.bookings.services.k49999, 49999, "de mest bookede tjenestene beholdes");
  const empty = slim({ days: [], bookings: {} }, 7);
  assert.deepEqual(empty.bookings, { web: 0, admin: 0, cancelled: 0, upcoming7: 0, weekdays: [0, 0, 0, 0, 0, 0, 0], services: {} });
  assert.equal(slim({ days: [], bookings: "tull" }, 7).bookings, null);
  const extra = slim({ days: [], sources: { nyhetsbrev: 4, constructor: 2, __proto__x: 1 } }, 7).sources;
  assert.equal(extra.nyhetsbrev, 4, "en ny kilde fra en nyere kopi av settet tas med");
});

test("oversikt: for stort svar, ikke-JSON og videresending gir en feilrad (og nøkkelen følger ikke en videresending)", async () => {
  let d = siteReturning("x".repeat(300000));
  let s = (await (await overview(d, tokenFor(d))).json()).sites[0];
  assert.equal(s.ok, false); assert.match(s.error, /for stort/);
  d = siteReturning("<html>ikke json</html>");
  s = (await (await overview(d, tokenFor(d))).json()).sites[0];
  assert.equal(s.ok, false); assert.match(s.error, /Ukjent svar/);
  d = siteReturning("", { status: 302, headers: { location: "https://annen.example/api/stats" } });
  s = (await (await overview(d, tokenFor(d))).json()).sites[0];
  assert.equal(s.ok, false); assert.match(s.error, /videresender/);
  assert.equal(d.calls[0].opts.redirect, "manual", "følger aldri en videresending med nøkkelen");
});

test("oversikt: en bedriftsliste som henger eller feiler stopper ikke de faste bedriftene, og eieren får beskjed", async () => {
  for (const registry of [() => new Promise(() => {}), async () => { throw new Error("Blobs 503"); }, () => { throw new Error("sync"); }]) {
    const d = deps({ registry, registryWaitMs: 50 });
    const t0 = Date.now();
    const j = await (await overview(d, tokenFor(d))).json();
    assert.ok(Date.now() - t0 < 2000, "svarte etter " + (Date.now() - t0) + " ms");
    assert.deepEqual(j.sites.map((s) => s.id), ["a", "b", "c"]);
    assert.equal(j.registryError, true);
  }
  const ok = deps({ registry: async () => [] });
  const j = await (await overview(ok, tokenFor(ok))).json();
  assert.equal(j.registryError, undefined);
});

test("bedriftsliste: ugyldige oppføringer og lik id som en fast bedrift meldes som hoppet over (ikke stille)", async () => {
  const good = { id: "frisor-anna", name: "Frisør Anna", url: "https://anna.example/", key: "k".repeat(43) };
  const d = deps({ registry: async () => [good, { ...good, id: "lang", name: "n".repeat(81) }, { ...good, id: "a" }, { id: "uleselig" }, { id: "<b>" }] });
  const j = await (await overview(d, tokenFor(d))).json();
  assert.deepEqual(j.sites.map((s) => s.id), ["a", "b", "c", "frisor-anna"]);
  assert.deepEqual(j.skipped, ["lang", "a", "uleselig", "(ukjent)"]);
  assert.equal(j.sites[3].url, "https://anna.example", "adressen lagres som opprinnelse (uten sti)");
});

test("loadRegistry: én uleselig oppføring blir et navn i «hoppet over»; feil ved listing kastes videre (vises som registryError)", async () => {
  const { loadRegistry } = await import("../oversikt/netlify/functions/overview.mjs");
  const good = { id: "frisor-anna", name: "Frisør Anna", url: "https://anna.example", key: "k".repeat(43) };
  const store = { async list() { return { blobs: [{ key: "site/frisor-anna" }, { key: "site/odelagt" }] }; },
    async get(k) { if (k === "site/odelagt") throw new Error("500"); return good; } };
  assert.deepEqual(await loadRegistry(store), [good, { id: "odelagt" }]);
  await assert.rejects(loadRegistry({ async list() { throw new Error("Blobs nede"); } }));
});

test("brems: 50 samtidige feil passord fra samme avsender sjekkes høyst 8 ganger (reservert før passordet sjekkes)", async () => {
  const base = fakeStore();
  const lag = () => new Promise((r) => setTimeout(r, Math.random() * 5));
  const store = { m: base.m,
    async get(k, o) { await lag(); return base.get(k, o); },
    async getWithMetadata(k, o) { await lag(); return base.getWithMetadata(k, o); },
    async setJSON(k, v, o) { await lag(); return base.setJSON(k, v, o); },
    async delete(k) { await lag(); return base.delete(k); } };
  const d = deps({ store });
  const statuses = await Promise.all(Array.from({ length: 50 }, (_, i) => login(d, "feil-" + i).then((r) => r.status)));
  const count = (s) => statuses.filter((x) => x === s).length;
  assert.ok(count(401) <= 8, "passordet ble sjekket " + count(401) + " ganger");
  assert.equal(count(401) + count(429), 50);
  assert.equal((await login(d, "riktig-passord")).status, 429, "også riktig passord venter til vinduet er over");
});

test("brems: riktig passord bruker ikke opp kvoten", async () => {
  const d = deps();
  for (let i = 0; i < 12; i++) assert.equal((await login(d, "riktig-passord")).status, 200);
});

test("kilder: oversikten kjenner de samme kildene som statistikk-settet og Viggo's", async () => {
  const { SOURCES } = await import("../oversikt/netlify/functions/overview.mjs");
  const kit = await import("../stats-kit/netlify/functions/stats.mjs");
  assert.deepEqual(SOURCES, kit.SOURCES);
});
