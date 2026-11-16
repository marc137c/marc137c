// Runs the real viggos-barbershop/admin.js (and, for old browsers, compat.js first) in node:vm against a small
// fake DOM built from the real admin.html: every element with an id exists with its tag, hidden flag and href,
// and $("x") for an id that is not in admin.html gives null, as in a browser. No browser is started.
//
//   const page = await loadAdmin({ routes, token: "t", navigator: {}, confirm: () => true, oldBrowser: false,
//                                  globals: { Notification, PushManager }, search: "?dag=2026-11-20" });
//   page.$("settings-open").click(); await page.flush();
//   page.calls        → [{ method, path, headers, body }] every fetch the page made
//   page.confirms     → texts passed to confirm()
//   page.missing      → ids admin.js asked for that admin.html does not have
//   await page.advance(ms) moves the page's fake clock: setTimeout callbacks that are due run (nothing waits in real
//   time); page.timers() → how many timeouts are pending
// routes: { "GET /api/admin/calendar": (call) => ({ status, body }) | body | Promise, … } (query ignored).
// An unknown route answers 404. A route may throw to simulate a network failure (netFail), never answer (hang),
// or be answered later by the test (held). itemsRoute(list) answers GET /api/admin/items like the server.
// globals: extra window properties (e.g. Notification and PushManager from fakePushBrowser below).
// now: "2026-11-11T23:50" gives the page a fake Date (local time) that page.setNow(t) moves; storage: extra
// localStorage entries at load.
//   page.alerts → texts passed to alert(); page.wake() fires visibilitychange; page.tick() runs the setInterval
//   callbacks; page.rendered(id) parses what admin.js wrote into #id; page.tap(id, selector) clicks an element in
//   it (the event reaches #id's delegated listener); page.text(id) its visible text; page.submit("edit-form")
//   submits a form; page.field(name) is an editor field (the same object admin.js reads).
//
//   const browser = fakePushBrowser({ permission: "default", answer: "granted", device: makeDevice("apple") });
//   loadAdmin({ navigator: browser.navigator, globals: browser.globals })
//   browser.log  → { registered, subscribes, permissionAsks, unsubscribed, getRegistration }
//   browser.emit(data) sends a message from the service worker to the page; browser.current() the subscription.
//   fakePushBrowser({ subscribeHangs: true }): subscribe() never settles (push service unreachable) until the test
//   calls browser.settleSubscribe() (it then resolves with the subscription, as a late answer would).
//   fakePushBrowser({ permissionsApi: true }) adds navigator.permissions; browser.setPermission(p) changes the
//   permission as the settings app would (and fires the status's onchange).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { parseDocument } from "./mini-dom.mjs";

const SITE_DIR = fileURLToPath(new URL("../../viggos-barbershop/", import.meta.url));
const HTML = readFileSync(SITE_DIR + "admin.html", "utf8");
const ADMIN_JS = readFileSync(SITE_DIR + "admin.js", "utf8");
const COMPAT_JS = readFileSync(SITE_DIR + "compat.js", "utf8");

class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  toggle(c, force) { const on = force === undefined ? !this.set.has(c) : !!force; if (on) this.set.add(c); else this.set.delete(c); return on; }
  contains(c) { return this.set.has(c); }
  toString() { return [...this.set].join(" "); }
}

class FakeElement {
  constructor(doc, tag, id = "", attrs = "") {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.attrs = {};
    this.listeners = {};
    this.classList = new ClassList();
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.parentNode = null;
    this.textContent = "";
    this.innerHTML = "";
    this.value = (/\svalue="([^"]*)"/.exec(attrs) || [])[1] || "";
    this.hidden = /(^|\s)hidden(\s|=|$)/.test(attrs);
    this.disabled = /(^|\s)disabled(\s|=|$)/.test(attrs);
    this.checked = /(^|\s)checked(\s|=|$)/.test(attrs);
    this.href = (/\shref="([^"]*)"/.exec(attrs) || [])[1];
    this.type = (/\stype="([^"]*)"/.exec(attrs) || [])[1] || "";
    this.open = false;
    this.selectedText = null;
    const cls = (/\sclass="([^"]*)"/.exec(attrs) || [])[1];
    if (cls) cls.split(/\s+/).forEach((c) => this.classList.add(c));
  }
  get className() { return this.classList.toString(); }
  set className(v) { this.classList = new ClassList(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
  get offsetParent() { return this.hidden ? null : this.ownerDocument.body; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatch(type, extra = {}) {
    const e = { type, target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    for (const fn of this.listeners[type] || []) fn.call(this, e);
    return e;
  }
  click() { if (!this.disabled) this.dispatch("click"); }
  dispatchEvent(ev) { for (const fn of this.listeners[ev.type] || []) fn.call(this, ev); return true; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() {}
  select() { this.selectedText = this.value; }
  setSelectionRange(a, b) { this.selectedText = String(this.value).slice(a, b); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "hidden") this.hidden = true; if (k === "open") this.open = true; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; if (k === "hidden") this.hidden = false; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  matches() { return false; }
  insertAdjacentHTML() {}
  // <dialog> as in a browser that has it (compat.js replaces these with its shim in old browsers)
  showModal() { this.open = true; this.attrs.open = ""; }
  close() { if (!this.open) return; this.open = false; delete this.attrs.open; this.dispatch("close"); }
  // form.elements: fields by name (only used when the editor opens). The same object every time, so a test can
  // type into page.$("edit-form").elements.note and admin.js reads it.
  get elements() {
    const doc = this.ownerDocument;
    if (!this._elements) this._elements = new Proxy({}, { get: (o, name) => (typeof name === "string" ? (o[name] = o[name] || new FakeElement(doc, "input", "", "")) : undefined) });
    return this._elements;
  }
}

function makeDocument() {
  const doc = {
    byId: new Map(),
    asked: new Set(),
    missing: [],
    listeners: {},
    hidden: false,
    activeElement: null,
    execCommandCalls: [],
    getElementById(id) {
      this.asked.add(id);
      const el = this.byId.get(id) || null;
      if (!el) this.missing.push(id);
      return el;
    },
    querySelectorAll(sel) { return /^[a-z]+$/.test(sel) ? [...this.byId.values()].filter((e) => e.tagName === sel.toUpperCase()) : []; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    createElement(tag) { return new FakeElement(doc, tag); },
    // Old-style events (document.createEvent + initEvent), for browsers without the Event constructor
    createEvent() { return { type: "", initEvent(type) { this.type = type; } }; },
    // Sends a key press to every keydown listener on the document (compat.js's Esc and Tab handling)
    key(key) { const e = { key, keyCode: { Escape: 27, Tab: 9 }[key], shiftKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; (this.listeners.keydown || []).forEach((fn) => fn(e)); return e; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
  };
  doc.body = new FakeElement(doc, "body");
  for (const m of HTML.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)\sid="([^"]+)"([^>]*)>/g)) {
    doc.byId.set(m[3], new FakeElement(doc, m[1], m[3], m[2] + " " + m[4]));
  }
  return doc;
}

const storage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _map: m };
};

// A Date whose «now» the test sets: new Date() and Date.now() give it; new Date(y, m, d, …) and new Date(string)
// work as usual. Times without a zone ("2026-11-11T23:50") are local time, like admin.js's own dates.
export function fakeDate(start) {
  const Real = Date;
  const clock = { ms: typeof start === "number" ? start : Real.parse(start) };
  if (Number.isNaN(clock.ms)) throw new Error("fakeDate: bad start " + start);
  class FakeDate extends Real {
    constructor(...a) { if (a.length === 0) super(clock.ms); else super(...a); }
    static now() { return clock.ms; }
  }
  return { Date: FakeDate, set: (t) => { clock.ms = typeof t === "number" ? t : Real.parse(t); }, now: () => clock.ms };
}

// Routes for the network cases (RC2): a route that never answers, one that fails the way browsers do when the
// connection drops (Safari: «Load failed», Chrome: «Failed to fetch»), and one the test answers later:
//   const h = held(); routes: { "POST /api/admin/items": h.route } … h.release({ status: 409, body }) / h.fail()
export const hang = () => () => new Promise(() => {});
export const netFail = (message = "Failed to fetch") => () => { throw new TypeError(message); };
export function held() {
  const waiting = [];
  return {
    route: (call) => new Promise((resolve, reject) => { waiting.push({ call, resolve, reject }); }),
    get calls() { return waiting.map((w) => w.call); },
    pending: () => waiting.length,
    release(answer) { const w = waiting.shift(); if (!w) throw new Error("held: nothing is waiting"); w.resolve(answer); },
    fail(message = "Load failed") { const w = waiting.shift(); if (!w) throw new Error("held: nothing is waiting"); w.reject(new TypeError(message)); },
  };
}

// GET /api/admin/items as the server answers it: the items between ?from and ?to, sorted by date and start, with
// the config. list may be an array the test changes later, or a function returning one.
export const ADMIN_CONFIG = { hours: { 0: null, 1: [600, 1080], 2: [600, 1080], 3: [600, 1080], 4: [600, 1080], 5: [600, 1080], 6: [600, 1020] }, durations: { Herreklipp: 30, "Full service": 60 }, addons: ["Vask langt hår"] };
export function itemsRoute(list, config = ADMIN_CONFIG) {
  return (call) => {
    const q = new URL(call.url, "https://viggos.test").searchParams;
    const from = q.get("from"), to = q.get("to") || from;
    const all = typeof list === "function" ? list() : list;
    const items = all.filter((i) => i.date >= from && i.date <= to).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start));
    return { from, to, items: JSON.parse(JSON.stringify(items)), config };
  };
}

export async function loadAdmin({ routes = {}, token = "test-admin-token", navigator = {}, confirm = () => true, oldBrowser = false, execCommand, queryCommandSupported, globals = {}, search = "", now, storage: stored = {} } = {}) {
  const doc = makeDocument();
  const calls = [];
  const confirms = [];
  const alerts = [];
  const intervals = [];
  const clockDate = now === undefined ? null : fakeDate(now);
  if (execCommand) doc.execCommand = (cmd) => { doc.execCommandCalls.push(cmd); return execCommand(cmd, doc); };
  if (queryCommandSupported) doc.queryCommandSupported = queryCommandSupported;
  const all = {
    "GET /api/admin/items": () => ({ items: [], today: "2026-11-16", config: { hours: { 0: null, 1: [600, 1080], 2: [600, 1080], 3: [600, 1080], 4: [600, 1080], 5: [600, 1080], 6: [600, 1020] }, durations: { Herreklipp: 30 }, addons: [] } }),
    ...routes,
  };
  const fetch = (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    const path = String(url).split("?")[0];
    const call = { method, path, url: String(url), headers: opts.headers || {}, body: opts.body === undefined ? undefined : JSON.parse(opts.body) };
    calls.push(call);
    const route = all[`${method} ${path}`];
    return Promise.resolve().then(() => (route ? route(call) : { status: 404, body: { error: "Ukjent forespørsel." } })).then((r) => {
      const res = r && typeof r === "object" && "status" in r && "body" in r ? r : { status: 200, body: r };
      // A string body is a page that is not JSON (e.g. the platform's HTML error page): json() rejects, as in a browser
      const json = typeof res.body === "string" ? () => Promise.reject(new SyntaxError("Unexpected token '<'")) : () => Promise.resolve(JSON.parse(JSON.stringify(res.body)));
      return { ok: res.status >= 200 && res.status < 300, status: res.status, json };
    });
  };
  const local = storage(Object.assign({}, stored, token ? { "viggo-admin-token": token } : {}));
  // A fake clock for setTimeout/clearTimeout: callbacks run only when the test calls advance(ms)
  const clock = { now: 0, seq: 0, pending: [] };
  const setTimeoutFake = (fn, ms) => { const id = ++clock.seq; clock.pending.push({ id, at: clock.now + Math.max(0, Number(ms) || 0), fn }); return id; };
  const clearTimeoutFake = (id) => { clock.pending = clock.pending.filter((t) => t.id !== id); };
  const context = {
    document: doc, navigator, fetch, localStorage: local, sessionStorage: storage(),
    setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake,
    confirm: (text) => { confirms.push(text); return confirm(text); },
    alert: (text) => { alerts.push(String(text)); },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval: () => {}, console,
    ...(clockDate ? { Date: clockDate.Date } : {}),
    atob: (s) => Buffer.from(String(s), "base64").toString("latin1"),
    Event: class Event { constructor(type) { this.type = type; } },
    location: { pathname: "/admin", search, href: "https://viggos.test/admin" + search },
    ...globals,
  };
  context.window = context;
  vm.createContext(context);
  if (oldBrowser) vm.runInContext(COMPAT_JS, context, { filename: "compat.js" });
  vm.runInContext(ADMIN_JS, context, { filename: "admin.js" });
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const advance = async (ms) => {
    const until = clock.now + ms;
    for (;;) {
      const due = clock.pending.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      clock.pending = clock.pending.filter((t) => t !== due);
      clock.now = due.at;
      due.fn();
      await flush();
    }
    clock.now = until;
    await flush();
  };
  await flush();
  // The HTML admin.js wrote into an element, parsed (mini-dom), so a test can query it like a page
  const rendered = (id) => parseDocument(`<div id="__root">${doc.byId.get(id).innerHTML}</div>`).getElementById("__root");
  // A click on something admin.js drew inside #id (e.g. a card in #timeline): the event reaches #id's listener
  // with that element as target, as event delegation in a browser would
  const tap = (id, selector) => {
    const el = rendered(id).querySelector(selector);
    if (!el) throw new Error(`tap: nothing matches ${selector} in #${id}`);
    doc.byId.get(id).dispatch("click", { target: el });
    return el;
  };
  // The tab comes back to the front (visibilitychange), and the 30-s timer fires
  const wake = () => { doc.hidden = false; (doc.listeners.visibilitychange || []).forEach((fn) => fn({ type: "visibilitychange" })); };
  const tick = () => intervals.forEach((t) => t.fn());
  // The visible text of what admin.js drew into #id, whitespace collapsed
  const text = (id) => rendered(id).textContent.replace(/\s+/g, " ").trim();
  return {
    doc, $: (id) => doc.byId.get(id), calls, confirms, alerts, missing: doc.missing, local, flush, advance, timers: () => clock.pending.length, context,
    rendered, tap, wake, tick, text, setNow: (t) => { if (!clockDate) throw new Error("loadAdmin: pass now to set the clock"); clockDate.set(t); },
    submit: (id = "edit-form") => doc.byId.get(id).dispatch("submit", { submitter: doc.byId.get(id === "login-form" ? "pw" : "save") }),
    field: (name) => doc.byId.get("edit-form").elements[name],
  };
}

// A browser with service worker and Web Push (Chrome, Firefox, Safari 16+, iPhone Home Screen app on iOS 16.4+), or,
// with ios: true and push: false, iPhone Safari outside the Home Screen (service worker, but no PushManager and no
// Notification). device: a fake-push.mjs makeDevice() whose endpoint and keys the subscription gets.
// subscribed: the browser already has a subscription made with this applicationServerKey (bytes) at load.
// As in Chrome, Firefox and Safari, pushManager.subscribe() asks for permission itself when it is «default» (the
// barber answers `answer`), and rejects with NotAllowedError unless it ends up «granted».
export function fakePushBrowser({ permission = "default", answer = "granted", device, subscribed, push = true, ios = false, standalone = false, unsubscribeOk = true, registered = Boolean(subscribed), subscribeHangs = false, permissionsApi = false } = {}) {
  const log = { registered: [], subscribes: [], permissionAsks: 0, unsubscribed: [], getRegistration: [] };
  const listeners = {};
  const makeSub = (appKey) => ({
    endpoint: device.endpoint,
    options: { userVisibleOnly: true, applicationServerKey: appKey },
    toJSON: () => ({ endpoint: device.endpoint, expirationTime: null, keys: device.subscription.keys }),
    unsubscribe() {
      log.unsubscribed.push(device.endpoint);
      if (unsubscribeOk && current === this) current = null;
      return Promise.resolve(unsubscribeOk);
    },
  });
  let current = subscribed ? makeSub(new Uint8Array(subscribed).buffer) : null;
  const hanging = [];
  const reg = {
    scope: "https://viggos.test/admin",
    pushManager: {
      getSubscription: () => Promise.resolve(current),
      subscribe: (opts) => {
        log.subscribes.push(opts);
        if (Notification.permission === "default") { log.permissionAsks++; Notification.permission = answer; }
        if (Notification.permission !== "granted") return Promise.reject(Object.assign(new Error("Registration failed - permission denied"), { name: "NotAllowedError" }));
        const make = () => { current = makeSub(new Uint8Array(opts.applicationServerKey).buffer); return current; };
        if (subscribeHangs) return new Promise((resolve) => { hanging.push(() => resolve(make())); });
        return Promise.resolve(make());
      },
    },
  };
  const serviceWorker = {
    register: (url, opts) => { log.registered.push({ url, scope: opts && opts.scope }); registered = true; return Promise.resolve(reg); },
    get ready() { return registered ? Promise.resolve(reg) : new Promise(() => {}); },
    getRegistration: (scope) => { log.getRegistration.push(scope); return Promise.resolve(registered ? reg : undefined); },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const Notification = {
    permission,
    requestPermission() {
      log.permissionAsks++;
      Notification.permission = answer;
      return Promise.resolve(answer);
    },
  };
  const navigator = {
    serviceWorker,
    userAgent: ios ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    platform: ios ? "iPhone" : "Win32",
    maxTouchPoints: ios ? 5 : 0,
  };
  if (ios) navigator.standalone = standalone;
  // navigator.permissions (Chrome, Firefox, Safari 16+): its «notifications» status says when the barber changes it
  const status = { state: permission === "default" ? "prompt" : permission, onchange: null };
  if (permissionsApi) navigator.permissions = { query: (d) => (d && d.name === "notifications" ? Promise.resolve(status) : Promise.reject(new TypeError("unknown"))) };
  const globals = push ? { Notification, PushManager: function PushManager() {} } : {};
  return {
    navigator, globals, log, current: () => current, emit: (data) => (listeners.message || []).forEach((fn) => fn({ data })),
    // The barber changes the permission in the browser's or the phone's settings
    setPermission: (p) => { Notification.permission = p; status.state = p === "default" ? "prompt" : p; if (typeof status.onchange === "function") status.onchange({ target: status }); },
    settleSubscribe: () => { const f = hanging.shift(); if (!f) throw new Error("no subscribe() is waiting"); f(); },
  };
}
