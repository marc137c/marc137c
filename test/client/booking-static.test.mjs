// Static guards for the booking page (docs/SPEC.md D2, D3): what the files must and must not contain, checked
// without running them. The behaviour itself is tested in test/client/booking.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const SITE = fileURLToPath(new URL("../../viggos-barbershop/", import.meta.url));
const read = (f) => readFileSync(join(SITE, f), "utf8");
const index = read("index.html");
const bookingJs = read("booking.js");

function walk(node, visit, parents = []) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parents);
  const next = parents.concat([node]);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit, next));
    else if (v && typeof v === "object" && typeof v.type === "string") walk(v, visit, next);
  }
}
const ast = (src) => parse(src, { ecmaVersion: "latest", sourceType: "script", locations: true });
// Every string a script can show: string literals and the fixed parts of template literals
function strings(src) {
  const out = [];
  walk(ast(src), (n) => {
    if (n.type === "Literal" && typeof n.value === "string") out.push(n.value);
    if (n.type === "TemplateElement") out.push(n.value.cooked);
  });
  return out;
}
const bestill = () => {
  const m = /<section\b[^>]*\bid="bestill"[^>]*>([\s\S]*?)<\/section>/.exec(index);
  assert.ok(m, "index.html has <section id=\"bestill\">");
  return m[1];
};
const formTag = () => {
  const m = /<form\b[^>]*\bid="booking-form"[^>]*>/.exec(index);
  assert.ok(m, "index.html has <form id=\"booking-form\">");
  return m[0];
};

test("D2: index.html has no Netlify Forms booking form (no data-netlify, form-name, netlify-honeypot or hidden copy fields)", () => {
  assert.doesNotMatch(index, /data-netlify/i);
  assert.doesNotMatch(index, /netlify-honeypot/i);
  assert.doesNotMatch(index, /name="form-name"/i);
  const tag = formTag();
  assert.doesNotMatch(tag, /\bname=/, "the form has no name for Netlify to pick up: " + tag);
  assert.doesNotMatch(tag, /\baction=/, "no action: without JavaScript the form must not post anywhere: " + tag);
  for (const id of ["f-dato", "f-tid", "f-tillegg", "f-status"]) assert.ok(!index.includes(`id="${id}"`), `no hidden ${id}`);
  assert.match(bestill(), /<input name="bot-field">/, "the bot field stays (booking.js sends it to the API)");
});

test("D3: without JavaScript, #bestill tells the visitor to call 409 63 911", () => {
  const m = /<noscript>([\s\S]*?)<\/noscript>/.exec(bestill());
  assert.ok(m, "#bestill has a <noscript>");
  const text = m[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  assert.match(text, /^Bestilling på nett krever JavaScript\. Ring oss på 409 63 911\.$/);
  assert.match(formTag(), /\bmethod="POST"/i, "a submit without JavaScript posts the body, so name and phone never land in a URL");
});

test("D2: booking.js sends nothing to the site root or anywhere but /api/ (no Netlify Forms post)", () => {
  assert.ok(!/fetch\(\s*["'`]\/["'`]/.test(bookingJs), 'no fetch("/"');
  walk(ast(bookingJs), (n) => {
    if (n.type !== "CallExpression") return;
    const c = n.callee;
    const name = c.type === "Identifier" ? c.name : c.type === "MemberExpression" && !c.computed ? c.property.name : "";
    if (name !== "fetch" && name !== "sendBeacon") return;
    const a = n.arguments[0];
    assert.ok(a && a.type === "Literal" && /^\/api\//.test(a.value), `booking.js:${n.loc.start.line} fetches a fixed /api/ path`);
  });
  assert.doesNotMatch(bookingJs, /encodeForm|f-status|f-dato|f-tid|f-tillegg/);
});

test("D3: no i18n text promises a confirmation or says a request was received", () => {
  const all = strings(read("i18n.js")).concat(strings(bookingJs));
  const bad = all.filter((s) => /bekreft|mottatt|confirm|received/i.test(s));
  assert.deepEqual(bad, []);
  assert.doesNotMatch(bestill(), /bekreft|mottatt/i);
});

// SPEC R2: every fetch( in viggos-barbershop/*.js runs inside withTimeout(…) (its first argument), so no request
// can leave the page waiting for ever. RATCHET: the files below still have a bare fetch and are fixed in steps 4-6.
// The list can only shrink: a file listed here that has no bare fetch left fails the test until it is removed.
const PENDING_TIMEOUT = ["admin-stats.js", "admin-sw.js", "admin.js", "reviews.js", "social-feed.js"];
function bareFetches(src) {
  const out = [];
  walk(ast(src), (n, parents) => {
    if (n.type !== "CallExpression") return;
    const c = n.callee;
    const isFetch = (c.type === "Identifier" && c.name === "fetch") || (c.type === "MemberExpression" && !c.computed && c.property.name === "fetch");
    if (!isFetch) return;
    const wrapped = parents.some((p) => p.type === "CallExpression" && p.callee.type === "Identifier" && p.callee.name === "withTimeout" &&
      p.arguments[0] && p.arguments[0].start <= n.start && n.end <= p.arguments[0].end);
    if (!wrapped) out.push(n.loc.start.line);
  });
  return out;
}

test("R2: the timeout guard finds a bare fetch and accepts one inside withTimeout(…)", () => {
  assert.deepEqual(bareFetches('fetch("/a").then(f);\nwithTimeout(fetch("/b").then(g), 1);\nwithTimeout(p, fetch("/c"));\nself.fetch("/d");'), [1, 3, 4]);
});

test("R2: every fetch( in viggos-barbershop/*.js is inside withTimeout(…), except the files still on the ratchet list", () => {
  const files = readdirSync(SITE).filter((f) => f.endsWith(".js")).sort();
  const bare = files.filter((f) => bareFetches(read(f)).length > 0);
  assert.deepEqual(bare, PENDING_TIMEOUT, "files with a fetch outside withTimeout: wrap it, or (only for a listed file) keep it listed");
  assert.deepEqual(bareFetches(bookingJs), [], "booking.js has no bare fetch");
  assert.ok(bookingJs.includes('withTimeout(fetch("/api/bookings"'), "the booking POST is the first argument of withTimeout");
});

test("F8: index.html has a message box at steps 1-3, and a focused day or time is visibly outlined", () => {
  const html = bestill();
  for (const id of ["msg-service", "msg-day", "msg-time"]) {
    assert.match(html, new RegExp(`<p class="step-msg" id="${id}" aria-hidden="true"></p>`), id);
  }
  assert.match(html, /<p class="form-msg" id="form-msg" role="status"><\/p>/, "#form-msg stays the announcement");
  const css = read("styles.css");
  assert.match(css, /\.cal-day:focus, \.slot:focus \{ box-shadow: 0 0 0 3px rgba\(201, 163, 92, \.55\); \}/);
  assert.match(css, /\.step-msg:empty \{ display: none; \}/);
  assert.match(css, /\.sr-only \{[^}]*clip: rect\(0, 0, 0, 0\)/);
});

// F70: a form field's border is a non-text element that must reach 3:1 against what is around it (WCAG 1.4.11).
// The fields sit on --surface (the booking card) and are filled with --bg.
const rootTokens = (css) => {
  const m = /:root\s*\{([^}]*)\}/.exec(css);
  assert.ok(m, "styles.css has a :root block");
  const out = {};
  for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
};
function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, "a 6-digit hex colour: " + hex);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("F70: the contrast helper gives the known values", () => {
  assert.equal(contrast("#000000", "#ffffff").toFixed(2), "21.00");
  assert.equal(contrast("#2a3b31", "#12211a").toFixed(2), "1.41", "the old --line against --surface (the finding)");
});

test("F70: input and select borders use --field-line, at least 3:1 against --surface and --bg", () => {
  const css = read("styles.css");
  const t = rootTokens(css);
  assert.equal(t["--field-line"], "#66796d");
  assert.ok(contrast(t["--field-line"], t["--surface"]) >= 3, "against --surface: " + contrast(t["--field-line"], t["--surface"]).toFixed(2));
  assert.ok(contrast(t["--field-line"], t["--bg"]) >= 3, "against --bg: " + contrast(t["--field-line"], t["--bg"]).toFixed(2));
  const rule = /\ninput, select \{([^}]*)\}/.exec(css);
  assert.ok(rule, "styles.css has the 'input, select' rule");
  assert.match(rule[1], /border: 1px solid var\(--field-line\);/);
});

// F71: '.booking .addon-picks label' (inline-flex: checkbox and text on one line) and '.booking label:not(.step-label)'
// (grid: label text above its field) have the same specificity (0,2,1), so the later one wins. The add-on rule must
// come after the general one, at the top level (the @supports fallbacks further down have their own copies).
test("F71: the add-on label rule comes directly after the general booking label rule", () => {
  const css = read("styles.css").replace(/\r\n/g, "\n");
  const general = css.indexOf("\n.booking label:not(.step-label) {");
  const addon = css.indexOf("\n.booking .addon-picks label {");
  assert.ok(general > 0 && addon > 0, "both top-level rules exist");
  assert.ok(addon > general, `the add-on rule (at ${addon}) comes after the general one (at ${general})`);
  const between = css.slice(css.indexOf("\n", general + 1), addon);
  assert.equal(between, "", "nothing in between");
  assert.match(css.slice(addon), /^\n\.booking \.addon-picks label \{ display: inline-flex; align-items: center; gap: 8px; font-size: \.9rem; color: var\(--text\); cursor: pointer; \}/,
    "the rule itself is unchanged");
  assert.equal(css.split("\n.booking .addon-picks label {").length, 2, "only one top-level copy");
});
