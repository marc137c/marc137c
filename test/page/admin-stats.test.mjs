// viggos-barbershop/admin-stats.js (the visitor statistics panel in /admin) in node:vm with a small fake page:
// it asks GET /api/stats with the admin token and draws the panel; a request that never answers is given up
// after 15 s (R2: no fetch outside withTimeout), never piles up behind the 60-s timer, and the next try works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../../viggos-barbershop/admin-stats.js", import.meta.url), "utf8");
const STATS = { days: [{ date: "2026-11-16", views: 7 }, { date: "2026-11-15", views: 3 }], totals: { today: 7, week: 10, month: 10 }, sources: { google: 6, direkte: 4 } };

function run({ answer, token = "tok" }) {
  const clock = { now: 0, timers: [] };
  const intervals = [];
  const calls = [];
  const app = { hidden: false, children: [], appendChild(c) { this.children.push(c); return c; } };
  const doc = {
    hidden: false, listeners: {},
    getElementById: (id) => (id === "app" ? app : null),
    createElement: () => ({ className: "", innerHTML: "", setAttribute() {} }),
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
  };
  const store = { getItem: (k) => (k === "viggo-admin-token" ? token : null) };
  const ctx = {
    document: doc, localStorage: store, sessionStorage: { getItem: () => null },
    setTimeout: (fn, ms) => { clock.timers.push({ fn, at: clock.now + ms }); return clock.timers.length; },
    clearTimeout: (id) => { if (clock.timers[id - 1]) clock.timers[id - 1].fn = () => {}; },
    setInterval: (fn) => { intervals.push(fn); },
    fetch: (url, opts) => { calls.push({ url, auth: opts && opts.headers && opts.headers.Authorization }); return answer(); },
    Promise, console,
  };
  ctx.window = ctx; // as in a browser
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "admin-stats.js" });
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const advance = async (ms) => {
    clock.now += ms;
    for (const t of clock.timers.filter((x) => x.at <= clock.now && !x.done)) { t.done = true; t.fn(); await flush(); }
  };
  return { app, calls, intervals, flush, advance };
}

test("stats panel: draws the numbers from /api/stats with the admin token", async () => {
  const page = run({ answer: () => Promise.resolve({ ok: true, json: () => Promise.resolve(STATS) }) });
  await page.advance(1200);
  assert.deepEqual(page.calls.map((c) => [c.url, c.auth]), [["/api/stats", "Bearer tok"]]);
  assert.equal(page.app.children.length, 1);
  assert.match(page.app.children[0].innerHTML, /<strong>7<\/strong><span>i dag<\/span>/);
});

test("stats panel: a request that never answers is given up after 15 s, never piles up, and the next try works", async () => {
  let hang = true;
  const page = run({ answer: () => (hang ? new Promise(() => {}) : Promise.resolve({ ok: true, json: () => Promise.resolve(STATS) })) });
  await page.advance(1200);
  assert.equal(page.calls.length, 1);
  page.intervals[0]();
  await page.flush();
  assert.equal(page.calls.length, 1, "no second request while the first is still waiting");
  await page.advance(15000);
  hang = false;
  page.intervals[0]();
  await page.flush();
  assert.equal(page.calls.length, 2, "after the limit the next timer tick asks again");
  assert.equal(page.app.children.length, 1, "and draws the panel");
});

test("stats panel: no token, or a 401, draws nothing", async () => {
  const none = run({ token: null, answer: () => { throw new Error("must not fetch"); } });
  await none.advance(1200);
  assert.equal(none.calls.length, 0);
  const denied = run({ answer: () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }) });
  await denied.advance(1200);
  assert.equal(denied.app.children.length, 0);
});

// ---------- Round 2: with the real admin.html + admin.js in the page harness ----------
// The panel only appeared up to 60 s after a fresh login: load() returned early while #app was hidden, and nothing
// told admin-stats.js that the app was shown. Guard (SPEC R29): every panel inside #app renders on the same event
// that shows #app; the harness logs in fresh (no stored token) and asserts the panel within 1.5 s.
import { loadAdmin } from "../helpers/admin-page.mjs";
const panel = (page) => page.$("app").children.filter((c) => c.className === "stats-panel")[0] || null;
test("stats panel: shown within 1.5 s after a fresh login (no stored token)", async () => {
  const page = await loadAdmin({ stats: true, token: null, now: "2026-11-16T09:00", routes: {
    "POST /api/admin/login": () => ({ token: "new", expiresIn: 43200000, device: "dev" }),
    "GET /api/stats": () => STATS,
  } });
  await page.advance(5000); // the page's own first try finds the login page and does nothing
  assert.equal(panel(page), null);
  page.$("pw").value = "riktig";
  page.submit("login-form");
  await page.flush();
  await page.advance(1500);
  assert.ok(panel(page), "the panel is there");
  assert.match(panel(page).innerHTML, /<strong>7<\/strong><span>i dag<\/span>/);
  assert.equal(page.calls.filter((c) => c.path === "/api/stats")[0].headers.Authorization, "Bearer new");
});
test("stats panel: still shown after a reload with a remembered login", async () => {
  const page = await loadAdmin({ stats: true, now: "2026-11-16T09:00", routes: { "GET /api/stats": () => STATS } });
  await page.advance(1500);
  assert.ok(panel(page));
});

// The note says what is counted. Guard (SPEC R29): it is tested against the same list the server counts
// (stats.mjs PAGES), so a page that starts sending the beacon cannot be left out of the text again.
test("stats panel: the note names every page stats.mjs counts", async () => {
  const { PAGES } = await import("../../netlify/functions/stats.mjs");
  const NAMES = { forside: "forsiden", personvern: "personvernsiden" };
  const page = run({ answer: () => Promise.resolve({ ok: true, json: () => Promise.resolve(STATS) }) });
  await page.advance(1200);
  const note = /<p class="sp-note">([^<]*)<\/p>/.exec(page.app.children[0].innerHTML)[1];
  for (const p of PAGES) {
    assert.ok(NAMES[p], `a Norwegian name for the counted page «${p}»`);
    assert.ok(note.includes(NAMES[p]), `the note «${note}» names ${NAMES[p]}`);
  }
});
