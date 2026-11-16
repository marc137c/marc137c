// Runs the real viggos-barbershop/index.html with i18n.js and chosen site scripts in node:vm on the mini DOM
// (test/helpers/mini-dom.mjs), with a fake fetch and a manual clock. Nothing reaches the network.
//
//   const site = await loadSite({ scripts: ["reviews.js"], routes: { "/api/reviews": { body: {...} } } });
//   route answer: { status = 200, body } (a string body is HTML: .json() rejects like a real proxy page),
//                 { network: true } (fetch rejects), { hang: true } (never answers). A URL without a route rejects.
//   site.advance(ms) moves the clock and runs due timers; site.html lists every string a script assigned to
//   innerHTML ({ id, html }), so a test can check what was generated, not only what the parser made of it.
//   site.setLang("en") switches the language like the toggle does.
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, Event } from "./mini-dom.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SITE_DIR = path.join(ROOT, "viggos-barbershop");
export const readSite = (f) => fs.readFileSync(path.join(SITE_DIR, f), "utf8");

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

export async function loadSite({ scripts = [], routes = {}, lang = null, now = "2026-11-16T12:00:00+01:00", languages = ["nb-NO", "nb", "no"] } = {}) {
  const clock = { ms: Date.parse(now) };
  const timers = [];
  let seq = 0;
  const addTimer = (fn, ms, every) => { const id = ++seq; timers.push({ id, at: clock.ms + Math.max(0, ms || 0), fn, every }); return id; };
  const clearTimer = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  async function advance(ms) {
    const end = clock.ms + ms;
    for (;;) {
      await flush();
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      clock.ms = Math.max(clock.ms, due.at);
      if (due.every) due.at += due.every; else clearTimer(due.id);
      due.fn();
    }
    clock.ms = end;
    await flush();
  }
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(clock.ms); else super(...a); }
    static now() { return clock.ms; }
  }

  const doc = parseDocument(readSite("index.html"));
  const html = [];
  doc.onInnerHTML = (el, s) => html.push({ id: el.getAttribute("id") || el.localName, html: s });
  const requests = [];
  const fetch = (url, init = {}) => {
    requests.push({ url: String(url), init, at: clock.ms });
    const ans = routes[String(url).split("?")[0]];
    return Promise.resolve().then(() => {
      if (!ans || ans.network) throw new TypeError("Failed to fetch");
      if (ans.hang) return new Promise(() => {});
      const status = ans.status || 200;
      const body = ans.body;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        json: () => (body === undefined || typeof body === "string" ? Promise.reject(new SyntaxError("Unexpected token <")) : Promise.resolve(clone(body))),
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
      };
    });
  };
  const ctx = {
    document: doc,
    navigator: { languages, language: languages[0] || "", userAgent: "mini-dom" },
    location: { search: "", pathname: "/", hash: "", href: "https://www.viggosbarbershop.no/" },
    history: { replaceState() {} },
    localStorage: memStorage(),
    sessionStorage: memStorage(),
    Date: FakeDate,
    setTimeout: (fn, ms) => addTimer(fn, ms, 0),
    clearTimeout: clearTimer,
    setInterval: (fn, ms) => addTimer(fn, ms, Math.max(1, ms)),
    clearInterval: clearTimer,
    fetch,
    console,
    Event,
    innerHeight: 740,
    innerWidth: 375,
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of ["i18n.js", ...scripts]) vm.runInContext(readSite(f), ctx, { filename: f });
  await flush();
  if (lang) { ctx.I18N.set(lang); await flush(); }

  const $ = (id) => doc.getElementById(id);
  return {
    doc, ctx, html, requests, clock, advance, flush, $,
    I18N: ctx.I18N,
    s: () => ctx.I18N.s(),
    qs: (sel) => doc.querySelector(sel),
    qsa: (sel) => doc.querySelectorAll(sel),
    async setLang(l) { ctx.I18N.set(l); await flush(); },
    timers: () => timers.length,
  };
}
