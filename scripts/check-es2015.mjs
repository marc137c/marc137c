// Kjøres av Netlify før hver publisering. Stopper bygget hvis nettsidens JavaScript (filer og inline <script>)
// 1) bruker syntaks nyere enn ES2015 (async/await, ?., ??, 1_000 …),
// 2) har en global const/let/class med samme navn som en id, et name="" eller en kjent window-egenskap.
//    Safari 10.0 / iOS 10.0–10.2 avviser da hele skriptfilen (SyntaxError), og kalenderen blir tom,
// 3) sprer (...) eller går gjennom (for-of) en DOM-samling, f.eks. [...select.options]: iOS 10.0–10.2 kan ikke
//    iterere HTMLCollection, så koden kaster midt i en bestilling. Bruk Array.prototype.map.call(...) o.l.,
// 4) bruker et nyere nettleser-API uten å sjekke at det finnes først (if ("X" in window), typeof …, try).
//    Også navigator.clipboard, navigator.serviceWorker, Notification og PushManager: de mangler i mange av
//    målnettleserne, og iPhone har varsler bare i iOS 16.4+ fra Hjem-skjermen. Selve sjekken
//    («if (navigator.clipboard && …)», «typeof Notification», «"serviceWorker" in navigator») er lov.
// Med vilje unntatt? Skriv «compat-ok» i en kommentar på samme linje eller linjen over.
// Mål: Safari/iOS 10+, Chrome 60+, Firefox 55+, Samsung 8+ (se «browserslist» i package.json).
// Bruk: node scripts/check-es2015.mjs [mappe]   (standard: viggos-barbershop)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "acorn";

const dir = process.argv[2] || "viggos-barbershop";
const files = readdirSync(dir);
const htmlFiles = files.filter((f) => f.endsWith(".html"));

// Navn som allerede finnes på window: id-er, name="" på form/img/iframe/embed/object, og vanlige window-egenskaper
const reserved = new Map();
for (const html of htmlFiles) {
  const src = readFileSync(join(dir, html), "utf8");
  for (const m of src.matchAll(/\sid="([^"]+)"/g)) reserved.set(m[1], `id="${m[1]}" i ${html}`);
  for (const m of src.matchAll(/<(?:form|img|iframe|embed|object)\b[^>]*\sname="([^"]+)"/gi)) reserved.set(m[1], `name="${m[1]}" i ${html}`);
}
for (const n of ["name", "status", "history", "location", "top", "parent", "self", "length", "event", "origin", "external",
  "screen", "close", "open", "print", "stop", "find", "scroll", "frames", "opener", "closed", "navigator", "document",
  "performance", "crypto", "localStorage", "sessionStorage", "focus", "blur", "alert", "confirm", "prompt", "fetch"]) {
  if (!reserved.has(n)) reserved.set(n, "window." + n);
}

// Nyere API-er: navn → hvilke av målnettleserne som mangler det
const RISKY_NEW = {
  IntersectionObserver: "Safari < 12.1", ResizeObserver: "Safari < 13.1, Chrome < 64", URLSearchParams: "Safari < 10.1",
  AbortController: "Safari < 12.1, Chrome < 66", "Intl.RelativeTimeFormat": "Safari < 14, Chrome < 71",
  "Intl.ListFormat": "Safari < 14.1, Chrome < 72", "Intl.PluralRules": "Safari < 13, Chrome < 63",
};
const RISKY_CALL = {
  "Object.entries": "Safari 10.0", "Object.values": "Safari 10.0", "Object.fromEntries": "Safari < 12.1, Chrome < 73",
  structuredClone: "Safari < 15.4", requestIdleCallback: "Safari", queueMicrotask: "Safari < 12.1, Chrome < 71",
};
const RISKY_METHOD = {
  flat: "Safari < 12, Chrome < 69", flatMap: "Safari < 12, Chrome < 69", finally: "Safari < 11.1, Chrome < 63",
  replaceAll: "Safari < 13.1, Chrome < 85", matchAll: "Safari < 13, Chrome < 73", at: "Safari < 15.4, Chrome < 92",
  allSettled: "Safari < 13, Chrome < 76", formatToParts: "Safari < 11", toggleAttribute: "Safari < 12, Chrome < 69",
  trimStart: "Safari < 12", trimEnd: "Safari < 12", scrollIntoViewIfNeeded: "Firefox",
};
// Objekter/globale navn som må sjekkes før bruk (også som window.X): navn → hvem som mangler det
const RISKY_GLOBAL = {
  "navigator.clipboard": "Safari < 13.1, Chrome < 66, Firefox < 63",
  "navigator.serviceWorker": "Safari < 11.1, Chrome < 40, Firefox < 44, og i privat modus i Firefox",
  Notification: "iOS Safari < 16.4, og iPhone utenfor Hjem-skjermen",
  PushManager: "Safari < 16, iOS < 16.4, Chrome < 42, Firefox < 44",
};
// Kall som alltid gir en ekte Array (trygt å spre)
const ARRAY_CALLS = new Set(["map", "filter", "slice", "concat", "split", "from", "keys", "sort", "reverse", "fill", "of"]);

const dotted = (n) => n.type === "Identifier" ? n.name
  : n.type === "MemberExpression" && !n.computed && n.property.type === "Identifier" ? (n.object.type === "Identifier" || n.object.type === "MemberExpression" ? dotted(n.object) + "." + n.property.name : "?." + n.property.name)
  : "?";

function walk(node, anc, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node, anc);
  anc.push(node);
  for (const k of Object.keys(node)) {
    if (k === "loc") continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") walk(c, anc, visit); }
    else if (v && typeof v.type === "string") walk(v, anc, visit);
  }
  anc.pop();
}

let failed = false;
const report = (where, line, msg) => { failed = true; console.error(`${where}:${line}: ${msg}`); };

function check(where, code, lineOffset = 0) {
  let ast;
  try {
    ast = parse(code, { ecmaVersion: 2015, sourceType: "script", locations: true });
  } catch (err) {
    report(where, (err.loc ? err.loc.line : 0) + lineOffset, `${err.message} (nyere syntaks enn ES2015)`);
    return;
  }
  const lines = code.split("\n");
  const allowed = (line) => /compat-ok/.test(lines[line - 1] || "") || /compat-ok/.test(lines[line - 2] || "");
  const L = (node) => node.loc.start.line + lineOffset;

  // 2) Globale navn
  for (const node of ast.body) {
    const names = node.type === "VariableDeclaration" && node.kind !== "var"
      ? node.declarations.filter((d) => d.id.type === "Identifier").map((d) => d.id.name)
      : node.type === "ClassDeclaration" ? [node.id.name] : [];
    for (const n of names) {
      if (reserved.has(n) && !allowed(node.loc.start.line)) report(where, L(node), `global «${n}» krasjer med ${reserved.get(n)}. Gi den et annet navn.`);
    }
  }

  // Er noden beskyttet av en sjekk på at API-et finnes?
  const guarded = (node, anc, key) => {
    if (allowed(node.loc.start.line)) return true;
    const has = (n) => n && code.slice(n.start, n.end).includes(key);
    for (let i = anc.length - 1; i >= 0; i--) {
      const a = anc[i], child = anc[i + 1] || node;
      if ((a.type === "IfStatement" || a.type === "ConditionalExpression") && child !== a.test && has(a.test)) return true;
      if (a.type === "LogicalExpression" && child === a.right && has(a.left)) return true;
      if (a.type === "TryStatement" && child === a.block) return true;
      if (/Function/.test(a.type) || a.type === "Program") {
        // tidlig retur før bruken: «if (typeof Intl.RelativeTimeFormat !== "function") return»
        const before = code.slice(a.start, node.start);
        if (new RegExp(`typeof\\s+[\\w.]*\\b${key}\\b|["']${key}["']\\s+in\\b`).test(before)) return true;
      }
    }
    return false;
  };

  // Er bruken selve sjekken? typeof X, if (X …), X && …, X ? … : …
  const isCheck = (node, anc) => {
    for (let i = anc.length - 1; i >= 0; i--) {
      const a = anc[i], child = anc[i + 1] || node;
      if (a.type === "UnaryExpression" && a.operator === "typeof") return true;
      if ((a.type === "IfStatement" || a.type === "ConditionalExpression" || a.type === "WhileStatement") && child === a.test) return true;
      if (a.type === "LogicalExpression" && child === a.left) return true;
      if (/Statement|Declaration|Function/.test(a.type)) return false;
    }
    return false;
  };
  const globalName = (node, parent) => {
    if (node.type === "MemberExpression") return dotted(node).replace(/^window\./, "");
    if (node.type !== "Identifier") return null;
    if (parent && parent.type === "MemberExpression" && parent.property === node && !parent.computed) return null; // x.Notification
    if (parent && parent.type === "Property" && parent.key === node && !parent.computed) return null;           // { Notification: … }
    return node.name;
  };

  walk(ast, [], (node, anc) => {
    // 4b) Objekter som må sjekkes før bruk
    const gname = (node.type === "MemberExpression" || node.type === "Identifier") ? globalName(node, anc[anc.length - 1]) : null;
    if (gname && RISKY_GLOBAL[gname] && !isCheck(node, anc) && !guarded(node, anc, gname.split(".").pop())) {
      report(where, L(node), `${gname} uten sjekk (mangler i ${RISKY_GLOBAL[gname]}). Sjekk først, f.eks. if (${gname.includes(".") ? gname + " && …" : `"${gname}" in window`}).`);
    }
    // 3) Spredning / for-of over noe som kan være en DOM-samling
    const iterated = node.type === "SpreadElement" ? node.argument : node.type === "ForOfStatement" ? node.right : null;
    if (iterated && (iterated.type === "MemberExpression" || iterated.type === "CallExpression") && !allowed(node.loc.start.line)) {
      const callee = iterated.type === "CallExpression" && iterated.callee.type === "MemberExpression" && !iterated.callee.computed ? iterated.callee.property.name : null;
      if (!(callee && ARRAY_CALLS.has(callee))) {
        report(where, L(node), `«${code.slice(iterated.start, iterated.end).slice(0, 60)}» spres/itereres. iOS 10 kan ikke iterere DOM-samlinger: bruk Array.prototype.map.call(…) / .filter.call(…)[0].`);
      }
    }
    // 4) Nyere API-er uten sjekk
    if (node.type === "NewExpression") {
      const name = dotted(node.callee);
      if (RISKY_NEW[name] && !guarded(node, anc, name.split(".").pop())) report(where, L(node), `new ${name} uten sjekk (mangler i ${RISKY_NEW[name]}).`);
    }
    if (node.type === "CallExpression") {
      const name = dotted(node.callee);
      const method = node.callee.type === "MemberExpression" && !node.callee.computed ? node.callee.property.name : null;
      if (RISKY_CALL[name] && !guarded(node, anc, name.split(".").pop())) report(where, L(node), `${name}() uten sjekk (mangler i ${RISKY_CALL[name]}).`);
      else if (method && RISKY_METHOD[method] && !RISKY_CALL[name] && !guarded(node, anc, method)) report(where, L(node), `.${method}() uten sjekk (mangler i ${RISKY_METHOD[method]}).`);
    }
  });
}

for (const name of files.filter((f) => f.endsWith(".js"))) check(name, readFileSync(join(dir, name), "utf8"));
// Inline <script> i HTML (ikke JSON-LD og andre datatyper)
for (const html of htmlFiles) {
  const src = readFileSync(join(dir, html), "utf8");
  for (const m of src.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] || "";
    if (/\ssrc=/.test(attrs) || (/\stype=/.test(attrs) && !/type="(text\/javascript|module)"/.test(attrs))) continue;
    check(html, m[2], src.slice(0, m.index).split("\n").length - 1);
  }
}

if (failed) {
  console.error("Rett linjene over, så virker siden også på eldre telefoner.");
  process.exit(1);
}
console.log("ES2015-sjekk OK (syntaks, globale navn, DOM-samlinger, nyere API-er, utklippstavle/varsler/service worker)");
