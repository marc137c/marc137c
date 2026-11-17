// F58 (round 3, ledger): the light/dark toggle was removed from the page and the README, but its listeners for a
// «themechange» event and its readers of documentElement.dataset.theme stayed, with nothing that dispatches the
// event or sets the attribute. Guard for the class, over viggos-barbershop/*.js, the pages' inline scripts and
// oversikt/public/*.js:
//   1. every event name passed to addEventListener is a standard DOM or service-worker event, or is dispatched by
//      some script there (dispatchEvent with new Event / new CustomEvent, or initEvent, of that name);
//   2. every documentElement.dataset key a script reads is written by a script (dataset.<key> = …, or
//      setAttribute("data-…")) or set on <html> in a page.
// The rule is first run on made-up sources, so a rule that silently finds nothing fails here too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIRS = ["viggos-barbershop", "oversikt/public"];

// Events the platform itself fires (DOM, media queries, WebGL, service workers): these need no dispatcher
const STANDARD = new Set(("abort activate animationend appinstalled beforeinstallprompt beforeunload blur cancel change click close " +
  "contextmenu controllerchange dblclick DOMContentLoaded error fetch focus focusin focusout hashchange input install keydown keypress keyup " +
  "languagechange load loadend message mousedown mouseenter mouseleave mousemove mouseout mouseover mouseup notificationclick notificationclose " +
  "offline online orientationchange pagehide pageshow pointercancel pointerdown pointerleave pointermove pointerup popstate push " +
  "pushsubscriptionchange readystatechange reset resize scroll statechange storage submit timeout toggle touchcancel touchend touchmove " +
  "touchstart transitionend unload updatefound visibilitychange webglcontextlost webglcontextrestored wheel").split(" "));

const kebab = (k) => k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");

// sources: [{ name, js, html? }] → list of problems
export function deadHooks(sources) {
  const js = sources.map((s) => ({ name: s.name, code: stripComments(s.js || "") }));
  const all = js.map((s) => s.code).join("\n");
  const dispatched = new Set();
  for (const m of all.matchAll(/new\s+(?:Custom)?Event\(\s*["'`]([\w:.-]+)["'`]/g)) dispatched.add(m[1]);
  for (const m of all.matchAll(/initEvent\(\s*["'`]([\w:.-]+)["'`]/g)) dispatched.add(m[1]);
  const written = new Set();
  for (const m of all.matchAll(/dataset\.(\w+)\s*=(?!=)/g)) written.add(m[1]);
  for (const m of all.matchAll(/documentElement\.setAttribute\(\s*["'`]data-([\w-]+)["'`]/g)) written.add(m[1].replace(/-(\w)/g, (x, c) => c.toUpperCase()));
  for (const s of sources) {
    const html = /<html\b[^>]*>/i.exec(s.html || "");
    if (html) for (const m of html[0].matchAll(/\sdata-([\w-]+)\s*=/g)) written.add(m[1].replace(/-(\w)/g, (x, c) => c.toUpperCase()));
  }
  const problems = [];
  for (const s of js) {
    for (const m of s.code.matchAll(/addEventListener\(\s*["'`]([\w:.-]+)["'`]/g)) {
      if (!STANDARD.has(m[1]) && !dispatched.has(m[1])) problems.push(`${s.name}: listens for «${m[1]}», which nothing dispatches`);
    }
    for (const m of s.code.matchAll(/documentElement\.dataset\.(\w+)\b(?!\s*=(?!=))/g)) {
      if (!written.has(m[1])) problems.push(`${s.name}: reads <html data-${kebab(m[1])}>, which nothing sets`);
    }
  }
  return [...new Set(problems)].sort();
}

function siteSources() {
  const out = [];
  for (const dir of DIRS) {
    for (const f of readdirSync(join(ROOT, dir))) {
      if (!/\.(js|html)$/.test(f)) continue;
      const src = readFileSync(join(ROOT, dir, f), "utf8");
      if (f.endsWith(".js")) out.push({ name: dir + "/" + f, js: src });
      else {
        const inline = [...src.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*json)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n");
        out.push({ name: dir + "/" + f, js: inline, html: src });
      }
    }
  }
  return out;
}

test("hooks: on made-up sources, a listener nobody dispatches and a dataset key nobody sets are reported; the rest are not", () => {
  const found = deadHooks([
    { name: "a.js", js: 'window.addEventListener("themechange", f); window.addEventListener("resize", g);\n' +
      'const light = document.documentElement.dataset.theme === "light";\n// window.addEventListener("commented", f)' },
    { name: "b.js", js: 'el.addEventListener("cartupdate", f); el.dispatchEvent(new CustomEvent("cartupdate"));\n' +
      'document.documentElement.dataset.ready = "1"; if (document.documentElement.dataset.ready) go();\n' +
      'if (document.documentElement.dataset.lang) x();' },
    { name: "c.html", js: "", html: '<html lang="nb" data-lang="nb"><body></body></html>' },
  ]);
  assert.deepEqual(found, ["a.js: listens for «themechange», which nothing dispatches", "a.js: reads <html data-theme>, which nothing sets"]);
});

test("hooks: every custom event the site listens for is dispatched, and every <html data-…> it reads is set (F58)", () => {
  const sources = siteSources();
  assert.ok(sources.some((s) => s.name.endsWith("gold-snow.js")) && sources.some((s) => s.name.endsWith("app.js")), "the rule sees the site's scripts");
  assert.deepEqual(deadHooks(sources), [], "remove the dead listener or reader, or dispatch / set what it waits for");
});
