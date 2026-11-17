// Eierens oversikt: innlogging med brems, billett som går ut, og henting fra alle bedriftene (én feil stopper ikke resten).
// Fra main (7110b71); på fix/server mot FakeBlobs (test/helpers/fake-blobs.mjs, samme oppførsel som @netlify/blobs 11.1.4)
// i stedet for et eget lite lager, som resten av funksjonstestene.
import test from "node:test";
import assert from "node:assert/strict";
import { FakeBlobs } from "./helpers/fake-blobs.mjs";
import { FakeClock } from "./helpers/clock.mjs";
import { handle, makeToken, verifyToken, slim } from "../oversikt/netlify/functions/overview.mjs";

const AUTH_STORE = "oversikt-auth";
function fakeStore() {
  const blobs = new FakeBlobs();
  const store = blobs.getStore({ name: AUTH_STORE, consistency: "strong" });
  store.keys = () => blobs.keys(AUTH_STORE);
  return store;
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
  await new Promise((r) => setTimeout(r, 20)); // slettingen av det eldste vinduet venter ikke på svaret
  assert.ok(d.store.keys().length <= 2, "fant " + d.store.keys().join(", "));
});

// Runde 3 (server): bremsen var «sjekk, så handle» – hvert parallelt forsøk fikk passordet sammenlignet, og nesten ingen
// feil ble skrevet (200 parallelle: 200 sjekket, all=6). Nå tar hvert forsøk plassen sin med en betinget skriving før
// sammenligningen. Lagringen svarer med 30 ms forsinkelse, så forsøkene virkelig overlapper.
function raceDeps() {
  const clock = new FakeClock("2026-11-17T10:00:00Z");
  const blobs = new FakeBlobs({ clock, latencyMs: 30 });
  const store = blobs.getStore({ name: AUTH_STORE, consistency: "strong" });
  return { env: { OVERVIEW_PASSWORD: "riktig-passord" }, store, blobs, clock, fetchImpl: async () => { throw new Error("ingen nett"); }, now: () => clock.now(), sites: [] };
}
const tallyOf = (rs) => rs.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
const recorded = (d) => d.blobs.keys(AUTH_STORE).map((k) => d.blobs.json(AUTH_STORE, k)).reduce((n, doc) => n + ((doc && doc.all) || 0), 0);
// Etter et parallelt utbrudd: feil passord ett og ett til bremsen slår inn; svarer hvor mange som ble sammenlignet
async function untilBrake(d, ipAt) {
  let checked = 0;
  for (let i = 0; i < 60; i++) {
    const r = await login(d, "etterpå-" + i, ipAt(i));
    if (r.status === 429) return checked;
    assert.equal(r.status, 401, "etter utbruddet: " + r.status);
    checked++;
  }
  throw new Error("bremsen slo aldri inn");
}

test("brems: 200 parallel wrong passwords from one sender compare at most 8; the rest get 429 or 503, and every compared one is recorded", async () => {
  const d = raceDeps();
  const rs = await Promise.all(Array.from({ length: 200 }, (_, i) => login(d, "gjett-" + i, "203.0.113.7")));
  const st = tallyOf(rs);
  assert.deepEqual(Object.keys(st).filter((s) => !["401", "429", "503"].includes(s)), [], JSON.stringify(st));
  assert.ok((st[401] || 0) <= 8, "sammenlignet " + (st[401] || 0) + " passord: " + JSON.stringify(st));
  assert.ok(recorded(d) >= (st[401] || 0), "skrevet " + recorded(d) + ", sammenlignet " + (st[401] || 0));
  const more = await untilBrake(d, () => "203.0.113.7");
  assert.equal((st[401] || 0) + more, 8, "i alt 8 sammenlignet i vinduet før 429");
  assert.equal((await login(d, "riktig-passord", "203.0.113.7")).status, 429, "også riktig passord venter");
});

test("brems: 200 parallel wrong passwords from many senders compare at most 40 in all; the rest get 429 or 503", async () => {
  const d = raceDeps();
  const rs = await Promise.all(Array.from({ length: 200 }, (_, i) => login(d, "gjett-" + i, "2001:db8:" + i.toString(16) + "::1")));
  const st = tallyOf(rs);
  assert.deepEqual(Object.keys(st).filter((s) => !["401", "429", "503"].includes(s)), [], JSON.stringify(st));
  assert.ok((st[401] || 0) <= 40, "sammenlignet " + (st[401] || 0) + " passord: " + JSON.stringify(st));
  assert.ok(recorded(d) >= (st[401] || 0), "skrevet " + recorded(d) + ", sammenlignet " + (st[401] || 0));
  const more = await untilBrake(d, (i) => "198.51.100." + i);
  assert.equal((st[401] || 0) + more, 40, "i alt 40 sammenlignet i vinduet før 429");
});

test("brems: when the counter cannot be written, the answer is 503 and the password is never compared", async () => {
  const d = raceDeps();
  d.blobs.inject({ method: "PUT", fault: "fail-before", status: 500, times: Infinity });
  const r = await login(d, "riktig-passord");
  assert.equal(r.status, 503, "et riktig passord gir ikke billett uten at forsøket er telt");
  assert.match((await r.json()).error, /ikke tilgjengelig akkurat nå/);
  d.blobs.clearFaults();
  d.blobs.inject({ fault: "network-down", times: Infinity });
  assert.equal((await login(d, "feil")).status, 503);
});

test("brems: a correct password gives its place back, and a request without a password takes none", async () => {
  const d = deps();
  for (let i = 0; i < 7; i++) assert.equal((await login(d, "feil" + i)).status, 401);
  for (let i = 0; i < 3; i++) assert.equal((await login(d, "riktig-passord")).status, 200);
  const empty = await handle(new Request("https://o.example/api/login", { method: "POST", body: "{}" }), { ip: "1.2.3.4" }, d);
  assert.equal(empty.status, 400);
  assert.equal((await login(d, "feil-8")).status, 401, "plass nummer 8 er fortsatt ledig");
  assert.equal((await login(d, "feil-9")).status, 429);
});

test("brems: rare failures (one every 45 minutes for two days) still leave at most two counter documents", async () => {
  const d = deps();
  for (let i = 0; i < 64; i++) { await login(d, "feil", "10.1.0." + (i % 250)); d.tick(45 * 60 * 1000); }
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(d.store.keys().length <= 2, "fant " + d.store.keys().length + ": " + d.store.keys().slice(0, 5).join(", "));
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
