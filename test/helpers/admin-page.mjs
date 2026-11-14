// Runs the real viggos-barbershop/admin.js (and, for old browsers, compat.js first) in node:vm against a small
// fake DOM built from the real admin.html: every element with an id exists with its tag, hidden flag and href,
// and $("x") for an id that is not in admin.html gives null, as in a browser. No browser is started.
//
//   const page = await loadAdmin({ routes, token: "t", navigator: {}, confirm: () => true, oldBrowser: false });
//   page.$("settings-open").click(); await page.flush();
//   page.calls        → [{ method, path, headers, body }] every fetch the page made
//   page.confirms     → texts passed to confirm()
//   page.missing      → ids admin.js asked for that admin.html does not have
// routes: { "GET /api/admin/calendar": (call) => ({ status, body }) | body | Promise, … } (query ignored).
// An unknown route answers 404. A route may throw to simulate a network failure.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

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
  // form.elements: fields by name (only used when the editor opens)
  get elements() {
    const doc = this.ownerDocument;
    return new Proxy({}, { get: (o, name) => (typeof name === "string" ? (o[name] = o[name] || new FakeElement(doc, "input", "", "")) : undefined) });
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

export async function loadAdmin({ routes = {}, token = "test-admin-token", navigator = {}, confirm = () => true, oldBrowser = false, execCommand, queryCommandSupported } = {}) {
  const doc = makeDocument();
  const calls = [];
  const confirms = [];
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
      return { ok: res.status >= 200 && res.status < 300, status: res.status, json: () => Promise.resolve(JSON.parse(JSON.stringify(res.body))) };
    });
  };
  const local = storage(token ? { "viggo-admin-token": token } : {});
  const context = {
    document: doc, navigator, fetch, localStorage: local, sessionStorage: storage(),
    confirm: (text) => { confirms.push(text); return confirm(text); },
    setInterval: () => 0, clearInterval: () => {}, console,
  };
  context.window = context;
  vm.createContext(context);
  if (oldBrowser) vm.runInContext(COMPAT_JS, context, { filename: "compat.js" });
  vm.runInContext(ADMIN_JS, context, { filename: "admin.js" });
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  await flush();
  return { doc, $: (id) => doc.byId.get(id), calls, confirms, missing: doc.missing, local, flush, context };
}
