// Oversiktens side (oversikt/public/app.js) kjørt i en enkel falsk DOM: escaping, «–» uten bookingtall, ukjente kilder,
// og at én rar bedrift ikke tømmer siden for de andre.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../oversikt/public/app.js", import.meta.url), "utf8");

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.style = {}; this.innerHTML = ""; this.textContent = ""; this.hidden = false; this.checked = true; this.value = ""; this.className = ""; this.q = {}; }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener() {}
  focus() {}
  querySelector(s) { return this.q[s] || (this.q[s] = new El(s)); }
  // all markup som er skrevet i dette elementet og barna
  html() { return this.innerHTML + this.children.map((c) => c.html()).join(""); }
}

function render(payload) {
  const ids = {};
  const byId = (id) => ids[id] || (ids[id] = new El("#" + id));
  const document = { getElementById: byId, createElement: (t) => new El(t), querySelector: () => new El("q"), querySelectorAll: () => [] };
  const mem = () => { const s = { "oversikt-token": "t" }; return { getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, removeItem: (k) => { delete s[k]; } }; };
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype = { open() {}, setRequestHeader() {}, send() { this.status = 200; this.responseText = JSON.stringify(payload); this.onload(); } };
  vm.runInNewContext(APP, { document, sessionStorage: mem(), localStorage: mem(), XMLHttpRequest });
  const tbody = byId("compare").querySelector("tbody");
  return { table: tbody.innerHTML, cards: byId("cards").html(), cardList: byId("cards").children, msg: byId("app-msg").textContent };
}
const day = (date, o = {}) => ({ date, visits: 2, views: 3, booked: null, web: null, cancelled: null, ...o });
const kitSite = (o = {}) => ({ id: "anna", name: "Frisør Anna", url: "https://anna.example", ok: true,
  data: { today: "2026-11-17", range: 7, visits: 4, views: 6, sources: { instagram: 2, snapchat: 1, qr: 1, direkte: 0 }, bookings: null, days: [day("2026-11-17"), day("2026-11-16")], ...o } });
const viggo = () => ({ id: "viggos", name: "Viggo's Barbershop", url: "https://www.viggosbarbershop.no", ok: true,
  data: { today: "2026-11-17", range: 7, visits: 10, views: 12, sources: { qr: 6, instagram: 3, google: 1 },
    bookings: { web: 4, admin: 1, cancelled: 1, upcoming7: 2, weekdays: [0, 1, 0, 0, 0, 2, 1], services: { Herreklipp: 3 } },
    days: [day("2026-11-17", { booked: 2, web: 1, cancelled: 0 })] } });

test("app: en side uten bookingtall viser «–» for Andel (ikke «0 %»)", () => {
  const r = render({ range: 7, sites: [kitSite()] });
  const cells = r.table.match(/<td>([^<]*)<\/td>/g).map((c) => c.replace(/<\/?td>/g, ""));
  assert.deepEqual(cells.slice(0, 6), ["4", "–", "–", "–", "–", "–"]);
  assert.equal(/0 %/.test(r.cards), false, "kortet viser ikke 0 % andel");
  assert.match(r.cards, /<strong>–<\/strong><span>andel/);
});

test("app: tall og tjenestenavn escapes, så HTML fra en bedrift aldri blir markup (andre lag i tillegg til slim)", () => {
  const bad = "<meta http-equiv=\"refresh\" content=\"0;url=https://evil.example/\">";
  const s = viggo();
  s.data.visits = bad; s.data.sources = { google: "<a href=\"https://evil.example/\">x</a>" };
  s.data.bookings.web = "<h1>x</h1>"; s.data.bookings.services = { "<b>Klipp</b>": "<form action=/>" };
  const r = render({ range: 7, sites: [s] });
  for (const out of [r.table, r.cards]) {
    assert.equal(/<meta|<a href="https:\/\/evil|<h1>|<form|<b>Klipp/.test(out), false, out.slice(0, 300));
  }
});

test("app: ukjente kilder vises med eget navn (aldri «undefined»), og alle kildene står i lista", () => {
  const s = kitSite({ sources: { nyhetsbrev: 5, instagram: 2, constructor: 1 } });
  const r = render({ range: 7, sites: [s] });
  assert.match(r.table, /nyhetsbrev 63 %/);
  assert.equal(/undefined|function/.test(r.table + r.cards), false);
  assert.match(r.cards, /nyhetsbrev <strong>5/);
  assert.match(r.cards, /Instagram <strong>2/);
});

test("app: én bedrift med feil form blir en feilrad – de andre vises fortsatt", () => {
  const broken = [
    kitSite({ bookings: {} }),
    kitSite({ days: [{ date: 20261117, visits: 1 }] }),
    kitSite({ days: "tull" }),
    { id: "x", name: "X", url: "https://x.example", ok: true, data: null },
  ];
  for (const b of broken) {
    const r = render({ range: 7, sites: [viggo(), b] });
    assert.match(r.table, /Viggo&#39;s Barbershop/);
    assert.match(r.table, /class="err"/);
    assert.match(r.cards, /Viggo&#39;s Barbershop/);
  }
});

test("app: eieren får beskjed når bedriftslisten ikke kunne leses eller oppføringer ble hoppet over", () => {
  const r = render({ range: 7, sites: [viggo()], registryError: true, skipped: ["lang-navn", "<b>"] });
  assert.match(r.msg, /Bedriftslisten kunne ikke leses/);
  assert.match(r.msg, /lang-navn/);
});

test("app: alle kildene i statistikk-settet har et norsk navn i oversikten", async () => {
  const { SOURCES } = await import("../stats-kit/netlify/functions/stats.mjs");
  const m = /var SRC = (\{[\s\S]*?\});/.exec(APP);
  assert.ok(m, "fant ikke SRC i app.js");
  const SRC = vm.runInNewContext("(" + m[1] + ")");
  for (const k of SOURCES) assert.ok(typeof SRC[k] === "string" && SRC[k] !== k, "mangler navn for " + k);
});
