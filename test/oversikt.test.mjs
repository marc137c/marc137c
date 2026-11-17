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
