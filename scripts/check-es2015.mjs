// Kjøres av Netlify før hver publisering. Stopper bygget hvis nettsidens JavaScript bruker syntaks nyere enn
// ES2015 (async/await, ?., ??, 1_000 …). I eldre nettlesere ville hele filen feilet, uten at noen merket det.
// Mål: Safari/iOS 10+, Chrome 60+, Firefox 55+, Samsung 8+.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "acorn";

const dir = "viggos-barbershop";
let failed = false;
for (const name of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
  try {
    parse(readFileSync(join(dir, name), "utf8"), { ecmaVersion: 2015, sourceType: "script" });
  } catch (err) {
    failed = true;
    console.error(`${name}: ${err.message}`);
  }
}
if (failed) {
  console.error("Skriv om linjene over til ES2015, så virker siden også på eldre telefoner.");
  process.exit(1);
}
console.log("ES2015-sjekk OK");
