// Static guards for the booking page (docs/SPEC.md D2, D3): what the files must and must not contain, checked
// without running them. The behaviour itself is tested in test/client/booking.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
