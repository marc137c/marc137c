// Kjøres av Netlify før hver publisering (etter check-es2015.mjs). Stopper bygget hvis CSS eller bilder
// ville se ødelagt ut i eldre nettlesere (Safari/iOS 10+, Chrome 60+, Firefox 55+, Samsung 8+):
//  CSS  – min()/max()/clamp() og dvh/svh uten en vanlig verdi først i samme regel
//       – logiske egenskaper (margin-inline, inset …), place-*, translate/scale/rotate som egne egenskaper
//       – :focus-visible i en selektorliste (gamle nettlesere dropper da HELE regelen), :is/:where/:has, nesting (&)
//       – grid med gap uten grid-gap, sticky uten -webkit-sticky, backdrop-filter uten -webkit-
//       – aspect-ratio uten en «@supports not (aspect-ratio …)»-reserve, @container/@layer/@property, color-mix/oklch
//       – dialog-stil «.x[open]» inni @supports uten tilsvarende «.x.dialog-shim[open]» utenfor (Safari < 15.4, Firefox < 98)
//  Filer – WebP i <source> uten JPG/PNG-<img> i samme <picture>, data-full .webp uten .jpg ved siden av
//          (lysboksen bytter til .jpg i nettlesere uten WebP), og lenker til filer som ikke finnes.
// Med vilje unntatt? Skriv /* compat-ok */ inni regelen.
// Bruk: node scripts/check-css-assets.mjs [mappe]   (standard: viggos-barbershop)
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] || "viggos-barbershop";
const files = readdirSync(dir);
let failed = false;
const report = (where, msg) => { failed = true; console.error(`${where}: ${msg}`); };

// ---------- En liten CSS-leser: regler med selektor, deklarasjoner, linjenummer og @-kontekst ----------
function parseCss(src) {
  const rules = [];
  const atRules = [];
  const lineAt = (i) => { while (/\s/.test(src[i] || "")) i++; return src.slice(0, i).split("\n").length; }; // første tegn, ikke linjeskiftet før
  function block(start, end, ctx) {
    let i = start, preludeStart = start;
    while (i < end) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2) + 2; if (i < 2) i = end; continue; }
      if (c === '"' || c === "'") { const q = src.indexOf(c, i + 1); i = q < 0 ? end : q + 1; continue; }
      if (c === ";" && src.slice(preludeStart, i).trim().startsWith("@")) { atRules.push({ text: src.slice(preludeStart, i).trim(), line: lineAt(preludeStart) }); preludeStart = i + 1; i++; continue; }
      if (c === "{") {
        let depth = 1, j = i + 1;
        while (j < end && depth) {
          if (src[j] === "/" && src[j + 1] === "*") { j = src.indexOf("*/", j + 2) + 2; continue; }
          if (src[j] === '"' || src[j] === "'") { j = src.indexOf(src[j], j + 1) + 1; continue; }
          if (src[j] === "{") depth++; else if (src[j] === "}") depth--;
          j++;
        }
        const prelude = src.slice(preludeStart, i).replace(/\/\*[\s\S]*?\*\//g, "").trim();
        if (prelude.startsWith("@")) {
          atRules.push({ text: prelude, line: lineAt(preludeStart) });
          if (/^@(media|supports)/.test(prelude)) block(i + 1, j - 1, ctx.concat(prelude));
        } else {
          rules.push({ selector: prelude, body: src.slice(i + 1, j - 1), ctx, line: lineAt(i) });
        }
        i = j; preludeStart = i; continue;
      }
      i++;
    }
  }
  block(0, src.length, []);
  for (const r of rules) {
    r.allowed = /compat-ok/.test(r.body);
    r.decls = [];
    let depth = 0, q = null, cur = "";
    const body = r.body.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const ch of body + ";") {
      if (q) { if (ch === q) q = null; cur += ch; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === "(") depth++; else if (ch === ")") depth--;
      if (ch === ";" && depth === 0) {
        const k = cur.indexOf(":");
        if (k > 0) r.decls.push([cur.slice(0, k).trim().toLowerCase(), cur.slice(k + 1).trim()]);
        cur = "";
      } else cur += ch;
    }
  }
  return { rules, atRules };
}

const MODERN_VALUE = /(^|[^\w-])(min|max|clamp)\(|\d(dvh|svh|lvh|dvw|svw|lvw)\b/;
const BAD_PROP = /^(margin|padding|border)-(inline|block)|^inset\b|^(inline|block)-size$|^place-(items|content|self)$|^(translate|scale|rotate)$/;

function checkCss(name, src) {
  const { rules, atRules } = parseCss(src);
  const hasAspectFallback = atRules.some((a) => /^@supports\s+not\s*\(\s*aspect-ratio/.test(a.text));
  for (const a of atRules) {
    if (/^@(container|layer|property|scope)\b/.test(a.text)) report(`${name}:${a.line}`, `${a.text.split(/\s/)[0]} støttes ikke i eldre nettlesere.`);
    if (/^@media[^{]*\([^)]*(<=|>=|<|>)/.test(a.text)) report(`${name}:${a.line}`, `media-spørring med område-syntaks («${a.text}»): bruk min-width/max-width.`);
  }
  const shimSelectors = rules.filter((r) => !r.ctx.some((c) => c.startsWith("@supports"))).map((r) => r.selector).join(",");
  for (const r of rules) {
    if (r.allowed || /^(from|to|\d+%)/.test(r.selector)) continue; // nøkkelbilder i @keyframes
    const where = `${name}:${r.line} (${r.selector.slice(0, 50)})`;
    const list = r.selector.split(",").map((s) => s.trim());
    if (list.length > 1 && list.some((s) => s.includes(":focus-visible"))) report(where, ":focus-visible i en selektorliste: gamle nettlesere dropper hele regelen. Legg den i en egen regel.");
    if (/:(is|where|has)\(/.test(r.selector)) report(where, ":is()/:where()/:has() støttes ikke i eldre nettlesere.");
    if (/:not\([^)]*,/.test(r.selector)) report(where, ":not() med liste støttes ikke i eldre nettlesere: skriv :not(a):not(b).");
    if (/(^|[\s,])&/.test(r.selector) || /[{;]\s*&/.test(r.body)) report(where, "CSS-nesting (&) støttes ikke i eldre nettlesere.");
    const props = new Map();
    for (const [p, v] of r.decls) { if (!props.has(p)) props.set(p, []); props.get(p).push(v); }
    r.decls.forEach(([p, v], idx) => {
      if (p.startsWith("--")) return; // egendefinerte variabler leses ikke direkte av nettleseren
      if (BAD_PROP.test(p)) report(where, `«${p}» støttes ikke i eldre nettlesere.`);
      if (/\b(color-mix|oklch|oklab|lab|lch)\(/.test(v)) report(where, `«${p}: ${v.slice(0, 40)}»: fargefunksjonen støttes ikke i eldre nettlesere.`);
      if (MODERN_VALUE.test(v) && !r.ctx.some((c) => /^@supports[^{]*(min|max|clamp)\(/.test(c))) { // inni @supports (width: min(…)) er greit
        // også en kortform tidligere i regelen teller: «font: 400 4.6rem …» før «font-size: clamp(…)», «margin» før «margin-top»
        const covers = (p2) => p2 === p || p.startsWith(p2 + "-") || (p === "font-size" && p2 === "font");
        const earlier = r.decls.slice(0, idx).some(([p2, v2]) => covers(p2) && !MODERN_VALUE.test(v2));
        if (!earlier) report(where, `«${p}: ${v.slice(0, 50)}» trenger en vanlig verdi først (f.eks. ${p}: 300px;), ellers mangler den i eldre nettlesere (min/max/clamp: Safari < 11.1, Chrome < 79; dvh/svh: alle før 2022).`);
      }
      if (p === "position" && v === "sticky" && !(props.get("position") || []).includes("-webkit-sticky")) report(where, "position: sticky trenger position: -webkit-sticky først (Safari < 13).");
      if (p === "backdrop-filter" && !props.has("-webkit-backdrop-filter")) report(where, "backdrop-filter trenger -webkit-backdrop-filter (Safari).");
      if (p === "aspect-ratio" && !hasAspectFallback) report(where, "aspect-ratio uten «@supports not (aspect-ratio: 1)»-reserve (Safari < 15, Chrome < 88).");
      if ((p === "gap" || p === "row-gap" || p === "column-gap") && (props.get("display") || []).some((d) => /grid/.test(d)) && !props.has("grid-" + p))
        report(where, `${p} i grid trenger grid-${p} også (Safari < 12, Chrome < 66).`);
    });
    // Dialog-stil som bare gjelder ekte <dialog>: shimmen (compat.js) trenger sin egen regel utenfor @supports
    if (r.ctx.some((c) => c.startsWith("@supports"))) {
      for (const m of r.selector.matchAll(/(\.[\w-]+)\[open\]/g)) {
        if (!shimSelectors.includes(`${m[1]}.dialog-shim[open]`)) report(where, `${m[0]} inni @supports, men ingen «${m[1]}.dialog-shim[open]»-regel utenfor: dialogen havner feil i Safari < 15.4 / Firefox < 98.`);
      }
    }
  }
}

// ---------- Bilder og filer ----------
const isLocal = (u) => u && !/^(https?:|data:|mailto:|tel:|#|\/\/|javascript:)/i.test(u) && !u.startsWith("/api/");
const fileFor = (u) => { const p = u.split(/[?#]/)[0].replace(/^\//, ""); return p === "" ? "index.html" : p === "admin" ? "admin.html" : p; };
const exists = (u) => existsSync(join(dir, fileFor(u)));

function checkHtml(name, src) {
  const lineAt = (i) => src.slice(0, i).split("\n").length;
  for (const m of src.matchAll(/<picture\b[\s\S]*?<\/picture>/gi)) {
    const pic = m[0];
    const webp = /<source[^>]*type="image\/webp"/i.test(pic);
    const img = (pic.match(/<img[^>]*\ssrc="([^"]+)"/i) || [])[1] || "";
    if (webp && !/\.(jpe?g|png)$/i.test(img)) report(`${name}:${lineAt(m.index)}`, `<picture> med WebP trenger en JPG/PNG i <img src> (Safari < 14), fant «${img || "ingen"}».`);
  }
  for (const m of src.matchAll(/\s(src|href|data-full|srcset|poster)="([^"]+)"/gi)) {
    const urls = m[1].toLowerCase() === "srcset" ? m[2].split(",").map((s) => s.trim().split(/\s+/)[0]) : [m[2]];
    for (const u of urls) {
      if (!isLocal(u) || /^\/?(admin)?$/.test(u.split(/[?#]/)[0])) continue;
      if (!exists(u)) report(`${name}:${lineAt(m.index)}`, `${m[1]}="${u}" finnes ikke.`);
      if (m[1] === "data-full" && /\.webp$/i.test(u) && !exists(u.replace(/\.webp$/i, ".jpg"))) report(`${name}:${lineAt(m.index)}`, `data-full="${u}" trenger ${u.replace(/\.webp$/i, ".jpg")} for nettlesere uten WebP.`);
    }
  }
}

for (const f of files.filter((x) => /\.(css|html)$/.test(x))) {
  const src = readFileSync(join(dir, f), "utf8");
  if (f.endsWith(".css")) {
    checkCss(f, src);
    for (const m of src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) if (isLocal(m[1]) && !exists(m[1])) report(f, `url(${m[1]}) finnes ikke.`);
  }
  if (f.endsWith(".html")) checkHtml(f, src);
}

if (failed) {
  console.error("Rett linjene over, så ser siden riktig ut også i eldre nettlesere.");
  process.exit(1);
}
console.log("CSS- og fil-sjekk OK");
