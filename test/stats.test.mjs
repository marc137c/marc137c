// Statistikk: besøk vs. sidevisninger, kilder, lesenøkkel, og bookingtall regnet fra bookingene (med frosne dager).
import test from "node:test";
import assert from "node:assert/strict";
import { aggregateByCreatedDay, bookingStats, sumDays, SNAPSHOT_AFTER } from "../netlify/lib/stats-bookings.mjs";
import { sourceOf, isInternal, keyMatches, bump } from "../netlify/functions/stats.mjs";
import { addDays } from "../netlify/lib/booking-core.mjs";

// Minimal Netlify Blobs: get / getWithMetadata / setJSON med onlyIfNew og onlyIfMatch (ETag)
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
const TODAY = "2026-11-17";
const at = (date, hh = "10") => `${date}T${hh}:00:00.000Z`; // 10 UTC = 11 norsk tid, samme dato
const item = (o) => ({ type: "booking", status: "confirmed", source: "nettside", service: "Herreklipp", start: 600, dur: 30, ...o });
function bookingsWith(items) {
  const s = fakeStore();
  const byMonth = {};
  for (const i of items) (byMonth[i.date.slice(0, 7)] = byMonth[i.date.slice(0, 7)] || []).push(i);
  for (const ym of Object.keys(byMonth)) s.m.set(`m/${ym}`, { body: JSON.stringify({ items: byMonth[ym] }), etag: "x" });
  return s;
}

test("besøk: bare visninger utenfra teller, med riktig kilde", () => {
  assert.equal(isInternal("www.viggosbarbershop.no", "www.viggosbarbershop.no"), true);
  assert.equal(isInternal("viggosbarbershop.no", "www.viggosbarbershop.no"), true);
  assert.equal(isInternal("", "www.viggosbarbershop.no"), false);
  assert.equal(isInternal("l.instagram.com", "www.viggosbarbershop.no"), false);
  assert.equal(sourceOf(""), "direkte");
  assert.equal(sourceOf("l.instagram.com"), "instagram");
  assert.equal(sourceOf("m.facebook.com"), "facebook");
  assert.equal(sourceOf("lm.fb.me"), "facebook");
  assert.equal(sourceOf("www.google.no"), "google");
  assert.equal(sourceOf("www.tiktok.com"), "tiktok");
  assert.equal(sourceOf("notgoogle.example"), "annet");
});

test("bump: intern navigering øker visninger, ikke besøk; gamle dager får besøk anslått fra kildene", async () => {
  const s = fakeStore();
  await bump(s, "d/x", "forside", "instagram");
  await bump(s, "d/x", "personvern", null);
  let d = await s.get("d/x");
  assert.deepEqual([d.views, d.visits, d.sources.instagram, d.pages.personvern], [2, 1, 1, 1]);
  s.m.set("d/old", { body: JSON.stringify({ views: 5, pages: { forside: 5 }, sources: { direkte: 3, google: 2 } }), etag: "o" });
  await bump(s, "d/old", "forside", "google");
  d = await s.get("d/old");
  assert.deepEqual([d.views, d.visits, d.sources.google], [6, 6, 3]);
});

test("bump: samtidige treff telles alle", async () => {
  const s = fakeStore();
  await Promise.all(Array.from({ length: 12 }, () => bump(s, "d/y", "forside", "direkte")));
  const d = await s.get("d/y");
  assert.equal(d.views, 12); assert.equal(d.visits, 12);
});

test("lesenøkkel: må finnes og være lik", () => {
  assert.equal(keyMatches("abc", "abc"), true);
  assert.equal(keyMatches("abd", "abc"), false);
  assert.equal(keyMatches("", "abc"), false);
  assert.equal(keyMatches("abc", undefined), false);
  assert.equal(keyMatches(null, ""), false);
});

test("aggregering: nettside vs. admin, avlyste, stengt tid og gammelt tjenestenavn", () => {
  const items = [
    item({ id: "a", date: "2026-11-20", createdAt: at("2026-11-16") }),
    item({ id: "b", date: "2026-11-21", createdAt: at("2026-11-16"), source: "admin", service: "Full service" }),
    item({ id: "c", date: "2026-11-21", createdAt: at("2026-11-16"), status: "cancelled" }),
    item({ id: "d", date: "2026-11-21", createdAt: at("2026-11-16"), type: "block" }),
    item({ id: "e", date: "2026-11-22", createdAt: at("2026-11-16"), service: "Herreklipp + skjeggtrim (maskin)" }),
    item({ id: "f", date: "2026-11-22", createdAt: at("2026-11-15", "23") }), // 23 UTC = 00 norsk tid 16.11
  ];
  const out = aggregateByCreatedDay(items, "2026-11-10", TODAY);
  const d = out["2026-11-16"];
  assert.deepEqual([d.web, d.admin, d.cancelled], [4, 1, 1]);
  assert.deepEqual(d.services, { "Herreklipp": 2, "Full service": 1, "Herreklipp + skjeggtrim": 1 });
  assert.equal(d.weekdays[5] + d.weekdays[6] + d.weekdays[0], 4); // fre 20., lør 21., søn 22.
  assert.equal(out["2026-11-15"], undefined);
});

test("bookingStats: gamle dager fryses og overlever at bookingene slettes; nye regnes fra bookingene", async () => {
  const old = addDays(TODAY, -(SNAPSHOT_AFTER + 1));
  const items = [
    item({ id: "o1", date: addDays(old, 2), createdAt: at(old) }),
    item({ id: "o2", date: addDays(old, 3), createdAt: at(old), source: "admin" }),
    item({ id: "n1", date: addDays(TODAY, 2), createdAt: at(TODAY) }),
    item({ id: "n2", date: addDays(TODAY, 9), createdAt: at(TODAY), status: "cancelled" }),
  ];
  const bookings = bookingsWith(items);
  const stats = fakeStore();
  const dates = Array.from({ length: 30 }, (_, i) => addDays(TODAY, -i));
  const dayDocs = () => Object.fromEntries(dates.map((d) => [d, stats.m.has(`d/${d}`) ? JSON.parse(stats.m.get(`d/${d}`).body) : null]));

  let r = await bookingStats(bookings, stats, dates, TODAY, dayDocs());
  let t = sumDays(r.perDay);
  assert.deepEqual([t.web, t.admin, t.cancelled], [3, 1, 1]); // gjort fra nettsiden = også de som senere ble avlyst
  assert.equal(r.upcoming7, 1); // n1 om 2 dager; n2 er avlyst og utenfor uka
  assert.ok(JSON.parse(stats.m.get(`d/${old}`).body).bookings, "dagen eldre enn grensen er frosset");
  assert.equal(stats.m.has(`d/${TODAY}`), false, "dagens tall fryses ikke");

  bookings.m.clear(); // alle bookinger slettet (som etter 90 dager)
  r = await bookingStats(bookings, stats, dates, TODAY, dayDocs());
  t = sumDays(r.perDay);
  assert.deepEqual([t.web, t.admin], [1, 1], "den frosne dagen står igjen, dagens er borte");
});

test("bookingStats: en frossen dag skrives ikke over, og en dag med hits beholder visningene", async () => {
  const old = addDays(TODAY, -(SNAPSHOT_AFTER + 2));
  const stats = fakeStore();
  stats.m.set(`d/${old}`, { body: JSON.stringify({ views: 7, visits: 6, pages: {}, sources: {} }), etag: "s" });
  const bookings = bookingsWith([item({ id: "x", date: addDays(old, 1), createdAt: at(old) })]);
  const dates = Array.from({ length: 30 }, (_, i) => addDays(TODAY, -i));
  const docs = Object.fromEntries(dates.map((d) => [d, stats.m.has(`d/${d}`) ? JSON.parse(stats.m.get(`d/${d}`).body) : null]));
  await bookingStats(bookings, stats, dates, TODAY, docs);
  const saved = JSON.parse(stats.m.get(`d/${old}`).body);
  assert.equal(saved.views, 7); assert.equal(saved.bookings.web, 1);
  const etag = stats.m.get(`d/${old}`).etag;
  docs[old] = saved;
  await bookingStats(bookings, stats, dates, TODAY, docs);
  assert.equal(stats.m.get(`d/${old}`).etag, etag, "ingen ny skriving når dagen er frosset");
});
