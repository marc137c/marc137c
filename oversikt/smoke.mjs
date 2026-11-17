// Etter hver publisering av oversikten, kjøres for hånd (ikke av Netlify, ikke i npm test). Sjekker det som skiller en
// publisering som virker fra en som ikke gjør det (runde 3: oversikten svarte «Passordet er ikke satt ennå.» fordi
// OVERVIEW_PASSWORD ble lagt inn etter siste publisering, og den gamle sjekken – /api/overview uten innlogging gir
// 401 – ga samme svar med og uten passordet):
//   GET  /               200, siden «Oversikt»
//   GET  /api/overview   uten innlogging: 401 (502 = @netlify/blobs mangler i pakken)
//   POST /api/login      med et tilfeldig, påfunnet passord: 401 «Feil passord.» betyr at passordet ER med i denne
//                        publiseringen. 503 «Passordet er ikke satt ennå.» betyr at det ikke er det: publiser på nytt.
//                        429 = bremsen er på (vent 15 min). Forsøket tar én av de 8 plassene i bremsen, ellers ingenting.
// Etterpå, for hånd: logg inn, og Viggo's rad skal vise tall, ikke «Mangler lesenøkkel» eller «Lesenøkkelen ble ikke
// godtatt» (README «Publisere oversikten»). Skriptet kjenner aldri det ekte passordet.
// Bruk: node smoke.mjs https://<oversiktens adresse>
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const REDEPLOY = "OVERVIEW_PASSWORD er ikke med i denne publiseringen (den ble laget før passordet ble lagt inn): publiser oversikten på nytt";
const BUNDLE = "502: funksjonen kjører ikke, trolig mangler @netlify/blobs i pakken (npm install i oversikt/ før publisering)";

// fetchFn(url, init) som global fetch; svarene trenger status og text()
export async function smoke({ origin, fetchFn = fetch, timeoutMs = 15000 }) {
  origin = String(origin).replace(/\/+$/, "");
  const results = [];
  const call = (path, init = {}) => {
    const opts = Object.assign({ method: "GET", redirect: "follow" }, init);
    opts.headers = Object.assign({ "User-Agent": "oversikt-smoke-check", Accept: "application/json" }, init.headers || {});
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opts.signal = AbortSignal.timeout(timeoutMs);
    return fetchFn(origin + path, opts);
  };
  const errorOf = async (r) => { try { return (JSON.parse(await r.text()) || {}).error || ""; } catch { return ""; } };
  async function check(name, fn) {
    try {
      results.push({ name, ok: true, detail: (await fn()) || "" });
    } catch (e) {
      results.push({ name, ok: false, detail: e && e.message ? e.message : String(e) });
    }
  }
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

  await check("GET / (siden)", async () => {
    const r = await call("/", { headers: { Accept: "text/html" } });
    expect(r.status === 200, "svarte " + r.status);
    expect(/<title>Oversikt/.test(await r.text()), "ikke oversiktens side");
  });
  await check("GET /api/overview uten innlogging", async () => {
    const r = await call("/api/overview?days=7");
    if (r.status === 502) throw new Error(BUNDLE);
    expect(r.status === 401, "svarte " + r.status + " (skal være 401)");
  });
  await check("POST /api/login med et påfunnet passord: passordet er med i publiseringen", async () => {
    const made = "smoke-" + randomBytes(18).toString("hex"); // aldri det ekte passordet
    const r = await call("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: made }) });
    const error = await errorOf(r);
    if (r.status === 401) return "«" + (error || "Feil passord.") + "» – passordet er med";
    if (r.status === 503 && /ikke satt/.test(error)) throw new Error("503 «" + error + "»: " + REDEPLOY);
    if (r.status === 502) throw new Error(BUNDLE);
    if (r.status === 429) throw new Error("429: bremsen er på etter feil forsøk; kjør sjekken igjen om 15 minutter");
    throw new Error("svarte " + r.status + (error ? " «" + error + "»" : "") + " (skal være 401 «Feil passord.»)");
  });
  return { ok: results.every((r) => r.ok), results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.argv[2];
  if (!origin || !/^https:\/\//.test(origin)) {
    console.error("Bruk: node smoke.mjs https://<oversiktens adresse>");
    process.exit(2);
  }
  const { results } = await smoke({ origin });
  for (const r of results) console.log(`${r.ok ? "OK  " : "FEIL"} ${r.name}${r.detail ? ": " + r.detail : ""}`);
  const bad = results.filter((r) => !r.ok).length;
  console.log(bad ? `${bad} av ${results.length} sjekker feilet.` : `Alle ${results.length} sjekker OK. Logg inn og se at Viggo's rad viser tall.`);
  process.exit(bad ? 1 : 0);
}
