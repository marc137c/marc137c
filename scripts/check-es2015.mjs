// Kjøres av Netlify før hver publisering. Stopper bygget hvis nettsidens JavaScript
// 1) bruker syntaks nyere enn ES2015 (async/await, ?., ??, 1_000 …), eller
// 2) har en global const/let/class med samme navn som en id i HTML-en. Safari 10.0 / iOS 10.0–10.2
//    avviser da hele skriptfilen (SyntaxError), og kalenderen blir tom.
// I eldre nettlesere ville hele filen feilet, uten at noen merket det. Mål: Safari/iOS 10+, Chrome 60+, Firefox 55+, Samsung 8+.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "acorn";

const dir = "viggos-barbershop";
const files = readdirSync(dir);
const ids = new Set();
for (const html of files.filter((f) => f.endsWith(".html"))) {
  for (const m of readFileSync(join(dir, html), "utf8").matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
}

let failed = false;
for (const name of files.filter((f) => f.endsWith(".js"))) {
  let ast;
  try {
    ast = parse(readFileSync(join(dir, name), "utf8"), { ecmaVersion: 2015, sourceType: "script", locations: true });
  } catch (err) {
    failed = true;
    console.error(`${name}: ${err.message}`);
    continue;
  }
  for (const node of ast.body) {
    const names = node.type === "VariableDeclaration" && node.kind !== "var"
      ? node.declarations.filter((d) => d.id.type === "Identifier").map((d) => d.id.name)
      : node.type === "ClassDeclaration" ? [node.id.name] : [];
    for (const n of names) {
      if (ids.has(n)) {
        failed = true;
        console.error(`${name}:${node.loc.start.line}: global «${n}» har samme navn som id="${n}" i HTML-en. Gi den et annet navn.`);
      }
    }
  }
}
if (failed) {
  console.error("Rett linjene over, så virker siden også på eldre telefoner.");
  process.exit(1);
}
console.log("ES2015-sjekk OK");
