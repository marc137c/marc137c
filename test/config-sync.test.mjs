// The booking config lives in netlify/lib/booking-core.mjs (CONFIG), but the site keeps its own copies: the
// fallback DURATIONS / SLOT_MIN / LEAD_MIN / MAX_DAYS in booking.js (used until /api/availability answers, and
// by any tab opened before a deploy), HOURS in script.js (hero status line), the <option> values of the service
// <select> and the JSON-LD opening hours in index.html, the README sentence the owner reads, and the client test
// harness. Invariant: every copy equals CONFIG, and CONFIG.durations is the owner's list (only Full service is
// 60 min; 'Herreklipp + skjeggtrim' is 30 since 31719ad). A merge resolved with 'ours' or a one-file edit fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { CONFIG } from "../netlify/lib/booking-core.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SITE = join(ROOT, "viggos-barbershop");
const read = (...p) => readFileSync(join(...p), "utf8");

// Owner decision (2026-11-14, live in 31719ad). Change it only together with the owner.
const OWNER_DURATIONS = {
  "Full service": 60,
  "Herreklipp": 30,
  "Herreklipp + skjeggtrim": 30,
  "Knivbarbering": 30,
  "Skjegg & line-up": 30,
  "Barneklipp": 30,
};
// Published opening hours: Mon-Fri 10:00-18:00, Sat 10:00-17:00, closed Sunday.
const PUBLISHED_HOURS = { 0: null, 1: [600, 1080], 2: [600, 1080], 3: [600, 1080], 4: [600, 1080], 5: [600, 1080], 6: [600, 1020] };

// ---------- helpers ----------
// The value of a literal expression (numbers, strings, null, arrays, plain objects); anything else throws.
function literal(node) {
  switch (node.type) {
    case "Literal": return node.value;
    case "UnaryExpression":
      if (node.operator === "-" && node.argument.type === "Literal") return -node.argument.value;
      break;
    case "ArrayExpression": return node.elements.map(literal);
    case "ObjectExpression": {
      const o = {};
      for (const p of node.properties) {
        if (p.type !== "Property" || p.computed) throw new Error("not a plain property at " + p.start);
        o[p.key.type === "Identifier" ? p.key.name : String(p.key.value)] = literal(p.value);
      }
      return o;
    }
  }
  throw new Error(`not a literal: ${node.type} at ${node.start}`);
}

// Every `const|let|var NAME = <literal>` in the source, wherever it is declared (top level or inside the IIFE).
function declaredLiterals(src, sourceType) {
  const ast = parse(src, { ecmaVersion: "latest", sourceType });
  const out = {};
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && n.init) {
      try { out[n.id.name] = literal(n.init); } catch (e) { /* not a literal: ignore */ }
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  })(ast);
  return out;
}

// Object keys as strings, so { 0: null } and { "0": null } compare equal.
const norm = (o) => JSON.parse(JSON.stringify(o));
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const hhmm = (s) => { const m = /^(\d{2}):(\d{2})$/.exec(s); assert.ok(m, "time is HH:MM: " + s); return +m[1] * 60 + +m[2]; };
const DAY = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };

const bookingJs = declaredLiterals(read(SITE, "booking.js"), "script");
const scriptJs = declaredLiterals(read(SITE, "script.js"), "script");
const indexHtml = read(SITE, "index.html");

// ---------- tests ----------
test("config-sync: CONFIG.durations is the owner's list (only Full service is 60 min)", () => {
  assert.deepEqual(norm(CONFIG.durations), OWNER_DURATIONS);
});

test("config-sync: CONFIG.hours are the published opening hours", () => {
  assert.deepEqual(norm(CONFIG.hours), norm(PUBLISHED_HOURS));
});

test("config-sync: booking.js fallback DURATIONS equals CONFIG.durations", () => {
  assert.ok(bookingJs.DURATIONS, "booking.js declares a literal DURATIONS");
  assert.deepEqual(bookingJs.DURATIONS, norm(CONFIG.durations));
});

test("config-sync: booking.js SLOT_MIN, LEAD_MIN and MAX_DAYS equal CONFIG", () => {
  assert.equal(bookingJs.SLOT_MIN, CONFIG.slotMin, "SLOT_MIN");
  assert.equal(bookingJs.LEAD_MIN, CONFIG.leadMin, "LEAD_MIN");
  assert.equal(bookingJs.MAX_DAYS, CONFIG.maxDays, "MAX_DAYS");
});

test("config-sync: script.js HOURS equals CONFIG.hours", () => {
  assert.ok(scriptJs.HOURS, "script.js declares a literal HOURS");
  assert.deepEqual(scriptJs.HOURS, norm(CONFIG.hours));
});

test("config-sync: the index.html #f-service options are exactly the CONFIG.durations services", () => {
  const sel = /<select\b[^>]*\bid="f-service"[^>]*>([\s\S]*?)<\/select>/.exec(indexHtml);
  assert.ok(sel, "index.html has <select id=\"f-service\">");
  const values = [];
  for (const m of sel[1].matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)) if (m[1] !== "") values.push(decode(m[1]));
  assert.equal(new Set(values).size, values.length, "no service is listed twice: " + values.join(" | "));
  assert.deepEqual(values.slice().sort(), Object.keys(CONFIG.durations).sort());
});

test("config-sync: the index.html JSON-LD openingHoursSpecification matches CONFIG.hours", () => {
  const specs = [];
  for (const m of indexHtml.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    (function find(v) {
      if (Array.isArray(v)) return v.forEach(find);
      if (!v || typeof v !== "object") return;
      if (v.openingHoursSpecification) specs.push(...[].concat(v.openingHoursSpecification));
      for (const k of Object.keys(v)) if (k !== "openingHoursSpecification") find(v[k]);
    })(JSON.parse(m[1]));
  }
  assert.ok(specs.length > 0, "index.html JSON-LD has openingHoursSpecification");
  const ld = { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null };
  for (const s of specs) {
    for (const name of [].concat(s.dayOfWeek)) {
      const d = DAY[String(name).replace(/^https?:\/\/schema\.org\//, "")];
      assert.ok(d !== undefined, "known dayOfWeek: " + name);
      assert.equal(ld[d], null, "each day appears once: " + name);
      ld[d] = [hhmm(s.opens), hhmm(s.closes)];
    }
  }
  assert.deepEqual(norm(ld), norm(CONFIG.hours));
});

test("config-sync: the README durations sentence names exactly the 60-min services", () => {
  const line = read(SITE, "README.md").split("\n").find((l) => l.includes("Varighet per tjeneste"));
  assert.ok(line, "viggos-barbershop/README.md has the 'Varighet per tjeneste' line");
  const m = /\(([^()]*?)\s*=\s*60 min,\s*(?:alle andre|resten)\s+30 min\)/.exec(line);
  assert.ok(m, "the line reads '(<services> = 60 min, alle andre 30 min)': " + line);
  const named = m[1].split(/\s*,\s*|\s+og\s+/).map((s) => s.trim()).filter(Boolean).sort();
  const sixty = Object.keys(CONFIG.durations).filter((k) => CONFIG.durations[k] === 60).sort();
  assert.deepEqual(named, sixty);
  const others = Object.keys(CONFIG.durations).filter((k) => CONFIG.durations[k] !== 60);
  others.forEach((k) => assert.equal(CONFIG.durations[k], 30, `'alle andre 30 min' is true for ${k}`));
});

// The harness imports CONFIG instead of copying it (step 3a), so it cannot drift. This checks the values it
// exports and that its fake server starts from them, and still checks literals if a copy ever comes back.
const HARNESS = join(ROOT, "test", "client", "booking-harness.mjs");
test("config-sync: the client booking harness uses CONFIG's hours and durations",
  { skip: existsSync(HARNESS) ? false : "test/client/booking-harness.mjs does not exist on this branch" }, async () => {
    const h = await import(new URL("./client/booking-harness.mjs", import.meta.url).href);
    assert.deepEqual(norm(h.HOURS), norm(CONFIG.hours), "harness HOURS");
    assert.deepEqual(norm(h.DURATIONS), norm(CONFIG.durations), "harness DURATIONS");
    const server = new h.FakeServer(() => Date.parse("2026-11-12T09:00:00Z"));
    assert.deepEqual(norm(server.config.durations), norm(CONFIG.durations), "fake server durations");
    assert.deepEqual(norm(server.config.hours), norm(CONFIG.hours), "fake server hours");
    assert.equal(server.config.slotMin, CONFIG.slotMin);
    assert.equal(server.config.leadMin, CONFIG.leadMin);
    assert.equal(server.config.maxDays, CONFIG.maxDays);
    const lit = declaredLiterals(readFileSync(HARNESS, "utf8"), "module");
    if (lit.HOURS) assert.deepEqual(lit.HOURS, norm(CONFIG.hours), "a literal HOURS in the harness");
    if (lit.DURATIONS) assert.deepEqual(lit.DURATIONS, norm(CONFIG.durations), "a literal DURATIONS in the harness");
  });
