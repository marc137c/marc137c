// Besøks- og bookingstatistikk uten informasjonskapsler.
// POST /api/hit  – nettsiden melder én sidevisning: bare dato (norsk tid), side og hvilket nettsted visningen kom fra.
//                  Et «besøk» er en visning som IKKE kom fra en annen side på samme nettsted, og som ikke er en ny
//                  innlasting eller Tilbake (t = «reload»/«back_forward» fra Performance API-et: de beholder
//                  document.referrer fra første gang, så de ville ellers telt som nye besøk); bare besøk får en kilde
//                  (instagram, facebook, google, tiktok, direkte, annet). Ingen IP-adresse, ingen ID, ingen
//                  nettleserinfo, ingen henvisningsadresse, ingenting lagres på besøkerens enhet. Roboter,
//                  forhåndsvisninger, grener, gamle permalenker og kall fra andre nettsteder telles ikke.
//                  Ett dokument per dag (d/ÅÅÅÅ-MM-DD), konfliktsikkert; slettes etter STATS_KEEP_DAYS (retention.mjs).
// GET  /api/stats?days=7|30|90 – bare tall (aldri navn eller telefon), og BARE for eierens egen oversikt (oversikt/):
//                  krever lesenøkkelen STATS_READ_KEY i headeren X-Stats-Key. Barberens /admin-innlogging gir IKKE
//                  tilgang (eierens beslutning 17.11.2026). Bookingtallene regnes ut ved å lese bookingene
//                  (netlify/lib/stats-bookings.mjs); bestillingen selv skriver ingenting til statistikken.
// Nettstedets egen adresse leses fra forespørselen, så filen kan brukes uendret på nye bedrifters sider.
import { createHash, timingSafeEqual } from "node:crypto";
import { liveDeps, bookingStore, isProduction, isRetiredDeploy, retiredResponse, jsonObject } from "../lib/runtime.mjs";
import { osloNow, addDays, mutateJSON } from "../lib/booking-core.mjs";
import { statsDay, bookingStats, sumDays, SOURCES, PAGES } from "../lib/stats-bookings.mjs";

export { SOURCES, PAGES };
const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const noContent = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|facebookexternalhit|whatsapp|telegram|discord|curl|wget|python|node-fetch|axios|go-http/i;
export const RANGES = Object.freeze([7, 30, 90]);
export const MAX_HIT_BYTES = 1024;
const bare = (h) => String(h || "").toLowerCase().replace(/^www\./, "");

// Hvor et besøk utenfra kom fra (tom avsender = skrevet inn, bokmerke eller app som ikke sender avsender)
export function sourceOf(host) {
  const h = bare(host);
  if (!h) return "direkte";
  if (/instagram/.test(h)) return "instagram";
  if (/facebook|(^|\.)fb\.(com|me)$/.test(h)) return "facebook";
  if (/(^|\.)google\./.test(h)) return "google";
  if (/tiktok/.test(h)) return "tiktok";
  return "annet";
}
// Er visningen den samme siden vist på nytt (ny innlasting, Tilbake/Frem, en fane nettleseren henter fram igjen)?
// Da er document.referrer fortsatt den fra første gang, så det er en visning, ikke et nytt besøk. Uten t (en eldre
// side fra hurtigbufferen) eller med en annen verdi telles den som et besøk, som før.
export const isRedisplay = (t) => t === "reload" || t === "back_forward";
// Kom visningen fra en annen side på det samme nettstedet (med eller uten www)?
export const isInternal = (refHost, siteHost) => !!bare(refHost) && bare(refHost) === bare(siteHost);

// Lesenøkkelen, sammenlignet på konstant tid (hashene er like lange uansett hva som sendes)
const digest = (s) => createHash("sha256").update(String(s)).digest();
export function keyMatches(given, expected) {
  if (!expected || !given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

// Teksten i forespørselen, men aldri mer enn max byte (null hvis den er større)
async function readCapped(req, max) {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

// Teller én visning i dagens dokument; source = null for en visning fra en annen side her (ikke et besøk).
// Mange kan komme samtidig; hver kollisjon betyr at en annen ble telt, så det prøves opptil 20 ganger.
export function bump(store, key, page, source) {
  return mutateJSON(store, key, statsDay, (doc) => {
    doc.views += 1;
    doc.pages[page] = (doc.pages[page] || 0) + 1;
    if (source) { doc.visits += 1; doc.sources[source] = (doc.sources[source] || 0) + 1; }
    return { ok: true };
  }, { attempts: 20 });
}

const statsStore = (deps, context) => deps.getStore({ name: isProduction(context) ? "stats" : "stats-preview", consistency: "strong" });

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring, miljø og klokke)
export async function handle(req, context, deps) {
  const url = new URL(req.url);

  if (url.pathname === "/api/hit") {
    if (req.method !== "POST") return json({ error: "Bruk POST." }, 405);
    const site = req.headers.get("sec-fetch-site");
    const counted = isProduction(context) && !isRetiredDeploy(context) && !(site && site !== "same-origin");
    const ua = req.headers.get("user-agent") || "";
    if (!counted || !ua || BOT.test(ua)) return noContent();
    const raw = await readCapped(req, MAX_HIT_BYTES);
    if (raw === null) return json({ error: "For stor forespørsel." }, 413);
    const body = jsonObject(raw) || {}; // en melding vi ikke kan lese (eller som ikke er et objekt), teller som forsiden
    const page = /personvern/.test(String(body.p || "")) ? "personvern" : "forside";
    const source = isInternal(body.r, url.hostname) || isRedisplay(body.t) ? null : sourceOf(body.r);
    try {
      const r = await bump(statsStore(deps, context), `d/${osloNow(deps.now()).date}`, page, source);
      if (r.error) console.error("Statistikk: for mange samtidige treff, ett ble ikke telt");
    } catch (err) {
      console.error("Statistikk: lagringen svarte ikke:", err && err.name);
    }
    return noContent();
  }

  // GET /api/stats
  if (req.method !== "GET") return json({ error: "Bruk GET." }, 405);
  if (isRetiredDeploy(context)) return retiredResponse();
  // Bare eierens oversikt (lesenøkkelen), ikke barberens innlogging. Sjekkes før noen lagring åpnes.
  if (!keyMatches(req.headers.get("x-stats-key"), deps.env.STATS_READ_KEY)) return json({ error: "Mangler gyldig lesenøkkel." }, 401);
  const n = RANGES.includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
  const store = statsStore(deps, context);
  const today = osloNow(deps.now()).date;
  const dates = Array.from({ length: Math.max(n, 30) }, (_, i) => addDays(today, -i)); // nyeste først
  let docs;
  try {
    // En dag som ikke kan leses, er ikke «0 besøk»: svaret er 503 uten tall, aldri et sikkert tall (SPEC R18)
    docs = (await Promise.all(dates.map((d) => store.get(`d/${d}`, { type: "json" })))).map(statsDay);
  } catch (err) {
    console.error("Statistikk: kunne ikke lese:", err && err.name);
    return json({ error: "Kunne ikke hente statistikken." }, 503);
  }
  const dayDocs = {};
  dates.forEach((d, i) => { dayDocs[d] = docs[i]; });

  // Bookingene som ikke kan leses, gir null (ukjent), aldri 0 (SPEC R18)
  let b = null;
  try { b = await bookingStats(bookingStore(deps, context), store, dates, today, dayDocs); }
  catch (err) { console.error("Bookingstatistikk: kunne ikke lese bookingene:", err && err.name); }

  const days = dates.map((date, i) => {
    const d = docs[i];
    const bk = b ? b.perDay[i] : null;
    return { date, views: d.views, visits: d.visits, sources: d.sources, bookings: bk ? { web: bk.web, admin: bk.admin, cancelled: bk.cancelled } : null };
  });
  const sum = (k, len) => days.slice(0, len).reduce((a, d) => a + d[k], 0);
  const sources = {};
  for (const s of SOURCES) sources[s] = days.slice(0, n).reduce((a, d) => a + (d.sources[s] || 0), 0);
  const bt = b ? sumDays(b.perDay.slice(0, n)) : null;
  return json({
    site: bare(url.hostname), today, range: n,
    // today/week/month = sidevisninger; views/visits = valgt periode
    totals: { today: sum("views", 1), week: sum("views", 7), month: sum("views", 30), views: sum("views", n), visits: sum("visits", n) },
    sources,
    days,
    bookings: bt ? { web: bt.web, admin: bt.admin, cancelled: bt.cancelled, services: bt.services, weekdays: bt.weekdays, upcoming7: b.upcoming7 } : null,
  });
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { path: ["/api/hit", "/api/stats"] };
