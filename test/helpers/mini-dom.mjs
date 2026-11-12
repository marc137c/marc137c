// A small DOM for running the site's browser scripts in node:vm, without npm packages.
// It covers what the page scripts use: parsing HTML, getElementById, querySelector(All) with simple
// selectors (tag, #id, .class, [attr], [attr=value], :not(...), :checked, :disabled, descendant and >),
// closest/contains, innerHTML/textContent, attributes, dataset, classList, form controls (value,
// checked, disabled, readOnly, select options, form.elements, form.reset), focus with the HTML
// "focus fixup" (a removed element loses focus to <body>) and bubbling events.
// Interaction helpers (click, choose, type, submit) refuse what a real user could not do:
// clicking a disabled button, typing into a read-only field, changing a disabled select.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul"]);
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", ndash: "–", mdash: "—", middot: "·",
  rarr: "→", larr: "←", hellip: "…", rsaquo: "›", lsaquo: "‹", times: "×", uarr: "↑", darr: "↓" };
export const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === "#"
  ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  : ENT[e] !== undefined ? ENT[e] : m));
const escText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const kebab = (k) => k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

export class Event {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this._stop = false;
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
}

class Node {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = {};
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get children() { return this.childNodes.filter((n) => n instanceof Element); }
  get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== "" && v !== null && v !== undefined) this.appendChild(new Text(this.ownerDocument, String(v)));
  }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument;
  }
  addEventListener(type, fn) { (this._listeners[type] || (this._listeners[type] = [])).push(fn); }
  removeEventListener(type, fn) {
    const l = this._listeners[type];
    if (l && l.indexOf(fn) >= 0) l.splice(l.indexOf(fn), 1);
  }
  dispatchEvent(ev) {
    ev.target = this;
    const path = [];
    for (let n = this; n; n = n.parentNode) path.push(n);
    for (const n of path) {
      if (n !== this && !ev.bubbles) break;
      ev.currentTarget = n;
      for (const fn of (n._listeners[ev.type] || []).slice()) fn.call(n, ev);
      if (ev._stop) break;
    }
    return !ev.defaultPrevented;
  }
  querySelectorAll(sel) {
    const list = parseSelectorList(sel);
    const out = [];
    const visit = (node) => {
      for (const c of node.childNodes) {
        if (!(c instanceof Element)) continue;
        if (list.some((cx) => matchComplex(c, cx, cx.length - 1))) out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

class Text extends Node {
  constructor(doc, data) { super(doc); this.data = data; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

const BOOL_ATTRS = { hidden: "hidden", disabled: "disabled", readOnly: "readonly", required: "required", multiple: "multiple" };
const STR_ATTRS = { id: "id", className: "class", title: "title", lang: "lang", name: "name", href: "href", htmlFor: "for", placeholder: "placeholder", src: "src" };

export class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.localName = tag.toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this._attrs = new Map();
    this.style = {};
  }
  getAttribute(n) { n = n.toLowerCase(); return this._attrs.has(n) ? this._attrs.get(n) : null; }
  setAttribute(n, v) { this._attrs.set(n.toLowerCase(), String(v)); }
  removeAttribute(n) { this._attrs.delete(n.toLowerCase()); }
  hasAttribute(n) { return this._attrs.has(n.toLowerCase()); }
  get attributes() { return Array.from(this._attrs, ([name, value]) => ({ name, value })); }
  get classList() {
    const el = this;
    const get = () => el.className.split(/\s+/).filter(Boolean);
    const put = (a) => { el.className = a.join(" "); };
    return {
      contains: (c) => get().includes(c),
      add: (...cs) => { const a = get(); for (const c of cs) if (!a.includes(c)) a.push(c); put(a); },
      remove: (...cs) => put(get().filter((c) => !cs.includes(c))),
      toggle: (c, force) => {
        const on = force === undefined ? !get().includes(c) : !!force;
        if (on) { const a = get(); if (!a.includes(c)) a.push(c); put(a); } else put(get().filter((x) => x !== c));
        return on;
      },
    };
  }
  get dataset() {
    const el = this;
    return new Proxy({}, {
      get: (_, k) => (typeof k === "string" && el.hasAttribute("data-" + kebab(k)) ? el.getAttribute("data-" + kebab(k)) : undefined),
      set: (_, k, v) => { el.setAttribute("data-" + kebab(String(k)), v); return true; },
      has: (_, k) => typeof k === "string" && el.hasAttribute("data-" + kebab(k)),
    });
  }
  get type() {
    const t = (this.getAttribute("type") || "").toLowerCase();
    if (this.localName === "input") return t || "text";
    if (this.localName === "button") return t || "submit";
    if (this.localName === "select") return this.hasAttribute("multiple") ? "select-multiple" : "select-one";
    return t;
  }
  set type(v) { this.setAttribute("type", v); }
  get value() {
    if (this.localName === "select") { const o = this.options[this.selectedIndex]; return o ? o.value : ""; }
    if (this.localName === "option") { const v = this.getAttribute("value"); return v !== null ? v : this.textContent.replace(/\s+/g, " ").trim(); }
    if ("_value" in this) return this._value;
    const v = this.getAttribute("value");
    if (v !== null) return v;
    return this.localName === "input" && /^(checkbox|radio)$/.test(this.type) ? "on" : this.localName === "textarea" ? this.textContent : "";
  }
  set value(v) {
    if (this.localName === "select") { this._selIdx = this.options.findIndex((o) => o.value === String(v)); return; }
    this._value = String(v);
  }
  get checked() { return "_checked" in this ? this._checked : this.hasAttribute("checked"); }
  set checked(v) { this._checked = !!v; }
  get options() { return this.localName === "select" ? this.querySelectorAll("option") : undefined; }
  get selectedIndex() {
    if (this._selIdx !== undefined) return this._selIdx;
    const opts = this.options;
    const i = opts.findIndex((o) => o.hasAttribute("selected"));
    return opts.length ? (i < 0 ? 0 : i) : -1;
  }
  set selectedIndex(i) { this._selIdx = i; }
  get form() { return this.closest("form"); }
  get elements() { return this.querySelectorAll("input, select, button, textarea"); }
  reset() { for (const el of this.elements) { delete el._value; delete el._checked; delete el._selIdx; } }
  get innerHTML() { return this.childNodes.map(serialize).join(""); }
  set innerHTML(html) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    parseInto(this, String(html), this.ownerDocument);
  }
  get outerHTML() { return serialize(this); }
  matches(sel) { return parseSelectorList(sel).some((cx) => matchComplex(this, cx, cx.length - 1)); }
  closest(sel) {
    const list = parseSelectorList(sel);
    for (let n = this; n instanceof Element; n = n.parentNode) if (list.some((cx) => matchComplex(n, cx, cx.length - 1))) return n;
    return null;
  }
  focus() {
    if (!this.isConnected || this.disabled || this.closest("[hidden]")) return;
    this.ownerDocument._active = this;
  }
  blur() { if (this.ownerDocument._active === this) this.ownerDocument._active = null; }
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
  get offsetWidth() { return 0; }
  get offsetHeight() { return 0; }
  scrollIntoView() {}
}
for (const [prop, attr] of Object.entries(BOOL_ATTRS)) {
  Object.defineProperty(Element.prototype, prop, {
    get() { return this.hasAttribute(attr); },
    set(v) { if (v) this.setAttribute(attr, ""); else this.removeAttribute(attr); },
  });
}
for (const [prop, attr] of Object.entries(STR_ATTRS)) {
  Object.defineProperty(Element.prototype, prop, {
    get() { const v = this.getAttribute(attr); return v === null ? "" : v; },
    set(v) { this.setAttribute(attr, v); },
  });
}

export class Document extends Node {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this._active = null;
    this.hidden = false;
  }
  createElement(tag) { return new Element(this, tag); }
  createTextNode(s) { return new Text(this, String(s)); }
  get documentElement() { return this.childNodes.find((n) => n.localName === "html") || null; }
  get body() { const h = this.documentElement; return h ? h.children.find((n) => n.localName === "body") || null : null; }
  get head() { const h = this.documentElement; return h ? h.children.find((n) => n.localName === "head") || null : null; }
  get visibilityState() { return this.hidden ? "hidden" : "visible"; }
  getElementById(id) {
    let found = null;
    const visit = (node) => {
      for (const c of node.childNodes) {
        if (found) return;
        if (!(c instanceof Element)) continue;
        if (c.getAttribute("id") === id) { found = c; return; }
        visit(c);
      }
    };
    visit(this);
    return found;
  }
  get activeElement() { const a = this._active; return a && a.isConnected ? a : this.body; }
}

// ---------- HTML parser (tag soup good enough for the site's own, well-formed pages) ----------
function parseInto(parent, html, doc) {
  const stack = [parent];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < html.length) {
    if (html.startsWith("<!--", i)) { const j = html.indexOf("-->", i + 4); i = j < 0 ? html.length : j + 3; continue; }
    if (html.startsWith("<!", i) || html.startsWith("<?", i)) { const j = html.indexOf(">", i); i = j < 0 ? html.length : j + 1; continue; }
    if (html[i] === "<" && html[i + 1] === "/") {
      const m = /^<\/([a-zA-Z][\w-]*)\s*>/.exec(html.slice(i, i + 100));
      if (m) {
        const tag = m[1].toLowerCase();
        for (let k = stack.length - 1; k > 0; k--) if (stack[k].localName === tag) { stack.length = k; break; }
        i += m[0].length;
        continue;
      }
    }
    if (html[i] === "<" && /[a-zA-Z]/.test(html[i + 1] || "")) {
      const m = /^<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/.exec(html.slice(i));
      if (m) {
        const el = doc.createElement(m[1]);
        const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
        let a;
        while ((a = re.exec(m[2]))) {
          const v = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : "";
          el.setAttribute(a[1], decode(v));
        }
        if (top().localName === "p" && CLOSES_P.has(el.localName)) stack.pop();
        if (el.localName === "li" && top().localName === "li") stack.pop();
        if (el.localName === "option" && top().localName === "option") stack.pop();
        top().appendChild(el);
        i += m[0].length;
        if (VOID.has(el.localName) || m[3]) continue;
        if (RAW.has(el.localName)) {
          const end = html.toLowerCase().indexOf("</" + el.localName, i);
          const text = html.slice(i, end < 0 ? html.length : end);
          if (text) el.appendChild(doc.createTextNode(el.localName === "script" || el.localName === "style" ? text : decode(text)));
          i = end < 0 ? html.length : html.indexOf(">", end) + 1;
          continue;
        }
        stack.push(el);
        continue;
      }
    }
    let j = html.indexOf("<", i + 1);
    if (j < 0) j = html.length;
    top().appendChild(doc.createTextNode(decode(html.slice(i, j))));
    i = j;
  }
}

function serialize(n) {
  if (n instanceof Text) {
    const p = n.parentNode;
    return p && (p.localName === "script" || p.localName === "style") ? n.data : escText(n.data);
  }
  const attrs = Array.from(n._attrs, ([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${escAttr(v)}"`)).join("");
  if (VOID.has(n.localName)) return `<${n.localName}${attrs}>`;
  return `<${n.localName}${attrs}>${n.childNodes.map(serialize).join("")}</${n.localName}>`;
}

export function parseDocument(html) {
  const doc = new Document();
  parseInto(doc, html, doc);
  if (!doc.documentElement) {
    const h = doc.createElement("html");
    for (const c of doc.childNodes.slice()) h.appendChild(c);
    doc.appendChild(h);
  }
  return doc;
}

// ---------- Selectors ----------
const selCache = new Map();
function parseSelectorList(sel) {
  if (selCache.has(sel)) return selCache.get(sel);
  let i = 0;
  const s = sel.trim();
  const ws = () => { while (/\s/.test(s[i] || "")) i++; };
  const ident = () => { const m = /^[\w-]+/.exec(s.slice(i)); if (!m) throw new SyntaxError(`mini-dom: cannot parse selector "${sel}"`); i += m[0].length; return m[0]; };
  function compound() {
    const c = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
    let any = false;
    for (;;) {
      const ch = s[i];
      if (ch === "*") { i++; any = true; continue; }
      if (ch && /[a-zA-Z]/.test(ch) && !any && c.tag === null && !c.id && !c.classes.length && !c.attrs.length && !c.pseudos.length) { c.tag = ident().toLowerCase(); any = true; continue; }
      if (ch === "#") { i++; c.id = ident(); any = true; continue; }
      if (ch === ".") { i++; c.classes.push(ident()); any = true; continue; }
      if (ch === "[") {
        i++; ws();
        const name = ident().toLowerCase(); ws();
        let val = null;
        if (s[i] === "=") {
          i++; ws();
          if (s[i] === '"' || s[i] === "'") { const q = s[i]; const j = s.indexOf(q, i + 1); val = s.slice(i + 1, j); i = j + 1; } else val = ident();
          ws();
        }
        if (s[i] !== "]") throw new SyntaxError(`mini-dom: cannot parse selector "${sel}"`);
        i++;
        c.attrs.push({ name, val });
        any = true;
        continue;
      }
      if (ch === ":") {
        i++;
        const name = ident();
        if (name === "not") {
          if (s[i] !== "(") throw new SyntaxError(`mini-dom: cannot parse selector "${sel}"`);
          let depth = 1, j = i + 1;
          while (j < s.length && depth) { if (s[j] === "(") depth++; else if (s[j] === ")") depth--; j++; }
          c.pseudos.push({ not: parseSelectorList(s.slice(i + 1, j - 1)) });
          i = j;
        } else if (["checked", "disabled", "enabled", "empty"].includes(name)) c.pseudos.push({ is: name });
        else throw new SyntaxError(`mini-dom: unsupported pseudo-class :${name} in "${sel}"`);
        any = true;
        continue;
      }
      break;
    }
    if (!any) throw new SyntaxError(`mini-dom: cannot parse selector "${sel}"`);
    return c;
  }
  const list = [];
  let cur = [];
  let comb = null;
  ws();
  while (i < s.length) {
    cur.push({ comb, c: compound() });
    const before = i;
    ws();
    if (i >= s.length) break;
    if (s[i] === ",") { i++; ws(); list.push(cur); cur = []; comb = null; continue; }
    if (s[i] === ">") { i++; ws(); comb = ">"; continue; }
    if (i > before) { comb = " "; continue; }
    throw new SyntaxError(`mini-dom: cannot parse selector "${sel}"`);
  }
  list.push(cur);
  selCache.set(sel, list);
  return list;
}

function matchCompound(el, c) {
  if (c.tag && el.localName !== c.tag) return false;
  if (c.id && el.getAttribute("id") !== c.id) return false;
  if (c.classes.length) { const cl = el.className.split(/\s+/); if (!c.classes.every((x) => cl.includes(x))) return false; }
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    if (a.val !== null && el.getAttribute(a.name) !== a.val) return false;
  }
  for (const p of c.pseudos) {
    if (p.not) { if (p.not.some((cx) => matchComplex(el, cx, cx.length - 1))) return false; continue; }
    if (p.is === "checked" && !(el.localName === "input" && el.checked) && !(el.localName === "option" && el.parentNode && el.parentNode.value === el.value)) return false;
    if (p.is === "disabled" && !el.disabled) return false;
    if (p.is === "enabled" && el.disabled) return false;
    if (p.is === "empty" && el.childNodes.length) return false;
  }
  return true;
}

function matchComplex(el, parts, idx) {
  if (!matchCompound(el, parts[idx].c)) return false;
  if (idx === 0) return true;
  if (parts[idx].comb === ">") { const p = el.parentNode; return p instanceof Element && matchComplex(p, parts, idx - 1); }
  for (let p = el.parentNode; p instanceof Element; p = p.parentNode) if (matchComplex(p, parts, idx - 1)) return true;
  return false;
}

// ---------- What a user can do ----------
const control = (el) => (el.closest ? el.closest("button, input, select, textarea") : null);

/** Click like a user: nothing happens on a disabled control. Returns false when the click was impossible. */
export function click(el) {
  if (!el) throw new Error("click: no element");
  const ctl = control(el);
  if (ctl && (ctl.disabled || ctl.closest("fieldset[disabled]"))) return false;
  if (ctl) ctl.focus(); // a press focuses the control before the click event (Chrome/Firefox)
  if (ctl && ctl.localName === "input" && /^(checkbox|radio)$/.test(ctl.type)) ctl.checked = ctl.type === "radio" ? true : !ctl.checked;
  const ev = new Event("click", { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  if (!ev.defaultPrevented && ctl) {
    if (ctl.localName === "button" && ctl.type === "submit" && ctl.form) submit(ctl.form);
    if (ctl.localName === "input" && /^(checkbox|radio)$/.test(ctl.type)) ctl.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return true;
}

/** Pick an option in a select like a user. Returns false when the select is disabled. */
export function choose(select, value) {
  if (select.disabled) return false;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** Type into a text field like a user. Returns false when the field is disabled or read-only. */
export function type(input, value) {
  if (input.disabled || input.readOnly) return false;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

/** Submit a form. A submit that the page does not cancel would make the browser post the form natively. */
export function submit(form) {
  const ev = new Event("submit", { bubbles: true, cancelable: true });
  form.dispatchEvent(ev);
  if (!ev.defaultPrevented) form._nativeSubmits = (form._nativeSubmits || 0) + 1;
  return ev;
}
