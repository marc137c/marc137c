// Runs the real viggos-barbershop/index.html + i18n.js + booking.js in node:vm on the mini DOM,
// with a device clock, fake timers and a fake server that follows the server/browser contracts
// (POST /api/bookings, GET /api/availability, GET /api/bookings/<id>.ics; docs/SPEC.md R1, D3, D4).
// The fake server takes its rules from CONFIG, closedDays and SERVICE_ALIASES in netlify/lib/booking-core.mjs,
// so it cannot drift from the real one. Its clock can differ from the device's.
// Tests can make any request fail: answer { network: true } (fetch rejects), { hang: true } (no answer),
// a Promise of an answer (answer later) or { status, body }.
// SITE_DIR=<folder> runs the same tests against another copy of the site (e.g. the code before a fix).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { parseDocument, Event, click, choose, type, submit } from "../helpers/mini-dom.mjs";
import { CONFIG, closedDays, SERVICE_ALIASES } from "../../netlify/lib/booking-core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SITE = process.env.SITE_DIR ? path.resolve(process.env.SITE_DIR) : path.join(ROOT, "viggos-barbershop");
export const readSite = (f) => fs.readFileSync(path.join(SITE, f), "utf8");

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
// The server's own config (test/config-sync.test.mjs checks these are CONFIG's values)
export const HOURS = clone(CONFIG.hours);
export const DURATIONS = clone(CONFIG.durations);
// The real 429 body from netlify/functions/bookings.mjs
export const RATE_LIMITED = { status: 429, body: { error: "For mange bestillinger akkurat nå. Ring oss på 409 63 911.", code: "rate_limited" } };
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

const OSLO = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function osloParts(ms) {
  const p = {};
  for (const x of OSLO.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, minutes: +p.hour * 60 + +p.minute, date: `${p.year}-${p.month}-${p.day}` };
}
export function addDays(date, n) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dow = (date) => new Date(date + "T00:00:00Z").getUTCDay();
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The server side of the booking contracts, in memory. */
export class FakeServer {
  constructor(nowMs) {
    this.nowMs = nowMs;
    this.items = [];          // { id, type: "booking"|"block", status, date, start, dur, service, name, phone, requestId, addons }
    this.config = { hours: clone(HOURS), slotMin: CONFIG.slotMin, leadMin: CONFIG.leadMin, maxDays: CONFIG.maxDays, durations: clone(DURATIONS) };
    this.overrides = [];      // (req, server) => answer | undefined, tried first
    this.requests = [];
    this.seq = 0;
  }
  oslo() { return osloParts(this.nowMs()); }
  /** Answer the next requests matching `test` with `answer` (a value or (req) => value). Removed after `times` uses. */
  when(test, answer, times = Infinity) {
    const rule = { left: times };
    rule.fn = (req) => {
      if (rule.left <= 0 || !test(req)) return undefined;
      rule.left--;
      return typeof answer === "function" ? answer(req, this) : answer;
    };
    this.overrides.push(rule.fn);
    return rule;
  }
  add(item) {
    const it = Object.assign({ id: `${item.date || "x"}_f${String(++this.seq).padStart(4, "0")}`, type: "booking", status: "confirmed" }, item);
    this.items.push(it);
    return it;
  }
  /** Block a whole day the way the barber does in /admin. */
  blockDay(date) {
    const h = this.config.hours[dow(date)];
    if (h) this.add({ type: "block", date, start: h[0], dur: h[1] - h[0] });
  }
  active() { return this.items.filter((i) => i.status !== "cancelled"); }
  bookings() { return this.active().filter((i) => i.type === "booking"); }
  /** The real rule (booking-core closedDays) over the items in [from, to]. */
  closedDays(from, to) { return closedDays(this.items.filter((i) => i.date >= from && i.date <= to)); }
  availability() {
    const { date: today, minutes } = this.oslo();
    const last = addDays(today, this.config.maxDays);
    const busy = {};
    for (const i of this.active()) if (i.date >= today && i.date <= last) (busy[i.date] || (busy[i.date] = [])).push([i.start, i.start + i.dur]);
    // The old names too, with the new service's length (F24)
    const durations = clone(this.config.durations);
    for (const old of Object.keys(SERVICE_ALIASES)) if (own(this.config.durations, SERVICE_ALIASES[old])) durations[old] = this.config.durations[SERVICE_ALIASES[old]];
    return {
      today, nowMinutes: minutes, lastDate: last,
      hours: this.config.hours, slotMin: this.config.slotMin, leadMin: this.config.leadMin, maxDays: this.config.maxDays,
      durations, busy, closed: this.closedDays(today, last),
    };
  }
  /** POST /api/bookings: the real order (validate, then replay by requestId, then the clash check), simplified. */
  book(req) {
    const ct = Object.keys(req.headers || {}).filter((k) => k.toLowerCase() === "content-type").map((k) => req.headers[k])[0] || "";
    if (!/^application\/json\b/i.test(ct)) return { status: 415, body: { error: "Bruk JSON.", code: "bad_content_type" } };
    const b = req.json;
    if (!b || typeof b !== "object") return { status: 400, body: { error: "Ugyldig JSON." } };
    if (b.botField) return { status: 200, body: { ok: true } };
    const bad = (code, status = 400) => ({ status, body: { error: code, code } });
    const service = own(SERVICE_ALIASES, b.service) ? SERVICE_ALIASES[b.service] : b.service;
    const dur = own(this.config.durations, service) ? this.config.durations[service] : undefined;
    if (!dur) return bad("bad_service");
    const { date: today, minutes } = this.oslo();
    if (typeof b.date !== "string" || b.date < today || b.date > addDays(today, this.config.maxDays)) return bad("bad_date");
    const h = this.config.hours[dow(b.date)];
    if (!h) return bad("closed");
    const start = b.start;
    if (!Number.isInteger(start) || start % this.config.slotMin || start < h[0] || start + dur > h[1]) return bad("bad_time");
    if (b.date === today && start < minutes + this.config.leadMin) return bad("too_early");
    if (String(b.name || "").trim().length < 2) return bad("bad_name");
    const phone = String(b.phone || "").trim();
    const digits = phone.replace(/\D/g, "").length;
    if (phone.length > 30 || digits < 8 || digits > 15) return bad("bad_phone");
    const requestId = typeof b.requestId === "string" && REQUEST_ID.test(b.requestId) ? b.requestId : undefined;
    const same = requestId && this.active().find((i) => i.requestId === requestId);
    if (same) return this.created(same);
    if (this.active().some((i) => i.date === b.date && start < i.start + i.dur && i.start < start + dur)) return bad("taken", 409);
    const it = this.add({ date: b.date, start, dur, service, name: String(b.name).trim(), phone, addons: b.addons, requestId });
    return this.created(it);
  }
  created(it) { return { status: 201, body: { ok: true, booking: { id: it.id, date: it.date, start: it.start, dur: it.dur, service: it.service } } }; }
  /** GET /api/bookings/<id>.ics: the customer's own appointment as a calendar file. */
  ics(id) {
    const it = this.bookings().find((i) => i.id === id);
    if (!it) return { status: 404, body: "Fant ikke timen." };
    return { status: 200, body: `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${it.id}\r\nSUMMARY:${it.service}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n` };
  }
  handle(req) {
    for (const o of this.overrides) { const r = o(req, this); if (r !== undefined) return r; }
    if (req.url === "/api/availability" && req.method === "GET") return { status: 200, body: this.availability() };
    if (req.url === "/api/bookings" && req.method === "POST") return this.book(req);
    const ics = /^\/api\/bookings\/([^/]+)\.ics$/.exec(req.url);
    if (ics && req.method === "GET") return this.ics(decodeURIComponent(ics[1]));
    return { status: 404, body: "<!doctype html><title>Not found</title>" };
  }
}

/** A promise you can settle from the test: a request that answers later. */
export function later() {
  let resolve;
  const p = new Promise((r) => { resolve = r; });
  p.resolve = resolve;
  return p;
}

const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

/**
 * Boot the booking page.
 * now: the device clock (ISO string). serverAheadMs: how far the server's clock is ahead of the device's.
 * lang: "en" switches the page to English after boot. setup(server): fill the server before the page loads.
 */
export async function boot(opts = {}) {
  const o = Object.assign({ now: "2026-11-12T10:00:00+01:00", serverAheadMs: 0, lang: null, setup: null }, opts);
  const clock = { ms: Date.parse(o.now) };
  const server = new FakeServer(() => clock.ms + o.serverAheadMs);
  if (o.setup) o.setup(server);

  const timers = [];
  let timerSeq = 0;
  const addTimer = (fn, ms, every) => { const id = ++timerSeq; timers.push({ id, at: clock.ms + Math.max(0, ms || 0), fn, every }); return id; };
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
  const scrolls = [];
  const fetch = (url, init = {}) => {
    let json;
    try { json = typeof init.body === "string" ? JSON.parse(init.body) : undefined; } catch (e) { json = undefined; }
    const req = { url: String(url), method: String(init.method || "GET").toUpperCase(), headers: init.headers || {}, body: init.body, json, at: clock.ms };
    server.requests.push(req);
    return Promise.resolve().then(() => server.handle(req)).then((ans) => {
      if (ans && ans.network) throw new TypeError("Failed to fetch");
      if (ans && ans.hang) return new Promise(() => {});
      const status = ans.status;
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
    navigator: { languages: ["nb-NO", "nb", "no"], language: "nb-NO", userAgent: "mini-dom" },
    location: { search: "", pathname: "/", hash: "", href: "https://example.test/" },
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
    // Records each scroll with what had focus and the scroll behaviour at that moment
    scrollBy(x, y) { scrolls.push({ y, focused: doc.activeElement, behavior: (doc.documentElement.style || {}).scrollBehavior }); },
    scrollTo() {},
    HOURS: clone(HOURS),
    // script.js: Oslo time from the device clock
    osloNow() { const p = osloParts(clock.ms); return { y: p.y, m: p.m, d: p.d, day: new RealDate(p.y, p.m - 1, p.d).getDay(), minutes: p.minutes }; },
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(readSite("i18n.js"), ctx, { filename: "i18n.js" });
  vm.runInContext(readSite("booking.js"), ctx, { filename: "booking.js" });
  await flush();
  if (o.lang) { ctx.I18N.set(o.lang); await flush(); }

  const $ = (id) => doc.getElementById(id);
  const form = $("booking-form");
  const site = {
    doc, ctx, server, clock, advance, flush, $, form, scrolls,
    I18N: ctx.I18N,
    s: () => ctx.I18N.s(),
    qs: (sel) => doc.querySelector(sel),
    qsa: (sel) => doc.querySelectorAll(sel),
    click, choose, type, submit,
    get select() { return $("f-service"); },
    get submitButton() { return form.querySelector("button[type=submit]"); },
    get focused() { return doc.activeElement; },
    monthShown() { return $("cal-month").textContent; },
    /** The calendar button for a date (navigates to its month). */
    async day(ymd) {
      const target = ymd.slice(0, 7);
      for (let i = 0; i < 6; i++) {
        const b = $("cal-grid").querySelector(`[data-date="${ymd}"]`);
        if (b) return b;
        const shown = ($("cal-grid").querySelector("[data-date]") || { getAttribute: () => "" }).getAttribute("data-date").slice(0, 7);
        click(shown < target ? $("cal-next") : $("cal-prev"));
        await flush();
      }
      return null;
    },
    slot(min) { return $("slots").querySelector(`[data-time="${min}"]`); },
    /** Every slot button with its time (minutes), status class and visible text. */
    slots() {
      return $("slots").querySelectorAll("button").map((b) => ({
        t: b.getAttribute("data-time") !== null ? +b.getAttribute("data-time") : null,
        cls: b.className, disabled: b.disabled, text: b.textContent.replace(/\s+/g, " ").trim(), label: b.getAttribute("aria-label"), el: b,
      }));
    },
    async pick({ service, date, time, name, phone } = {}) {
      if (service !== undefined) { choose($("f-service"), service); await flush(); }
      if (date) { const b = await site.day(date); if (!b) throw new Error("no day " + date); click(b); await flush(); }
      if (time !== undefined) { const b = site.slot(time); if (!b) throw new Error("no free slot " + time + " on " + date); click(b); await flush(); }
      if (name !== undefined) type($("f-name"), name);
      if (phone !== undefined) type($("f-phone"), phone);
    },
    async book() { click(site.submitButton); await flush(); },
    bookingPosts() { return server.requests.filter((r) => r.url === "/api/bookings"); },
    otherRequests() {
      return server.requests.filter((r) => !((r.url === "/api/availability" && r.method === "GET") || (r.url === "/api/bookings" && r.method === "POST")));
    },
    /** Message elements a sighted customer can see right now (non-empty, not visually hidden). */
    visibleMessages() {
      return doc.querySelectorAll(".form-msg, .step-msg")
        .filter((el) => el.textContent.trim() && !el.classList.contains("sr-only") && !el.closest("[hidden]") && !el.closest(".hidden"));
    },
    /** All the text the customer can see in the booking messages, joined. */
    message() { return site.visibleMessages().map((el) => el.textContent.trim()).join(" | "); },
    /** Texts screen readers get announced: live regions that are not aria-hidden. */
    announced() {
      return doc.querySelectorAll("[role=status], [role=alert], [aria-live]")
        .filter((el) => el.getAttribute("aria-live") !== "off" && !el.closest("[aria-hidden=true]"))
        .map((el) => el.textContent.trim()).filter(Boolean);
    },
    summary() { const el = $("booking-summary"); return el.hidden ? "" : el.textContent; },
    async hide() { doc.hidden = true; doc.dispatchEvent(new Event("visibilitychange")); await flush(); },
    async show() { doc.hidden = false; doc.dispatchEvent(new Event("visibilitychange")); await flush(); },
    /** Run the 30-second refresh. */
    async poll() { await advance(30000); },
  };
  return site;
}

/** A complete, valid booking for Friday 13 November 2026 at 14:00 (today is Thursday 12 November). */
export const FRIDAY = { service: "Herreklipp", date: "2026-11-13", time: 840, name: "Kari Nordmann", phone: "409 63 955" };
