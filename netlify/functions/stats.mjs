// Besøksstatistikk uten informasjonskapsler.
// POST /api/hit  – nettsiden melder én sidevisning: bare dato (norsk tid), side og hvor besøket kom fra
//                  (instagram, facebook, google, tiktok, direkte, annet). Ingen IP-adresse, ingen ID, ingen
//                  nettleserinfo, ingen henvisningsadresse, ingenting lagres på besøkerens enhet. Roboter,
//                  forhåndsvisninger, grener, gamle permalenker og kall fra andre nettsteder telles ikke.
//                  Ett dokument per dag (d/ÅÅÅÅ-MM-DD), konfliktsikkert; slettes etter STATS_KEEP_DAYS (retention.mjs).
// GET  /api/stats – siste 30 dager, bare for innlogget barber (samme billett som /admin, også auth/epoch).
import { liveDeps, bookingStore, isProduction, isRetiredDeploy, retiredResponse, jsonObject } from "../lib/runtime.mjs";
import { osloNow, addDays, mutateJSON, readSession } from "../lib/booking-core.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const noContent = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|facebookexternalhit|whatsapp|telegram|discord|curl|wget|python|node-fetch|axios|go-http/i;
export const SOURCES = ["instagram", "facebook", "google", "tiktok", "direkte", "annet"];
const PAGES = ["forside", "personvern"];
export const MAX_HIT_BYTES = 1024;

function sourceOf(host) {
  const h = String(host || "").toLowerCase();
  if (!h || /(^|\.)viggosbarbershop\.no$|netlify\.app$/.test(h)) return "direkte";
  if (/instagram/.test(h)) return "instagram";
  if (/facebook|(^|\.)fb\.com$|(^|\.)fb\.me$/.test(h)) return "facebook";
  if (/(^|\.)google\./.test(h)) return "google";
  if (/tiktok/.test(h)) return "tiktok";
  return "annet";
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

// Dagens dokument i fast form: bare kjente sider og kilder med heltall, uansett hva som lå der
function dayDoc(data) {
  const src = data && typeof data === "object" ? data : {};
  const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  const pick = (obj, names) => {
    const out = {};
    for (const n of names) if (obj && typeof obj === "object" && count(obj[n])) out[n] = count(obj[n]);
    return out;
  };
  return { views: count(src.views), pages: pick(src.pages, PAGES), sources: pick(src.sources, SOURCES) };
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
    const source = sourceOf(body.r);
    try {
      const r = await mutateJSON(statsStore(deps, context), `d/${osloNow(deps.now()).date}`, dayDoc, (doc) => {
        doc.views += 1;
        doc.pages[page] = (doc.pages[page] || 0) + 1;
        doc.sources[source] = (doc.sources[source] || 0) + 1;
        return { ok: true };
      }, { attempts: 20 }); // mange kan komme samtidig; hver kollisjon betyr at en annen ble telt
      if (r.error) console.error("Statistikk: for mange samtidige treff, ett ble ikke telt");
    } catch (err) {
      console.error("Statistikk: lagringen svarte ikke:", err && err.name);
    }
    return noContent();
  }

  // GET /api/stats
  if (req.method !== "GET") return json({ error: "Bruk GET." }, 405);
  if (isRetiredDeploy(context)) return retiredResponse();
  const password = deps.env.ADMIN_PASSWORD;
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  try {
    const nowMs = deps.now().getTime();
    if (!password || !(await readSession(bookingStore(deps, context), token, password, nowMs))) return json({ error: "Logg inn på nytt." }, 401);
    const store = statsStore(deps, context);
    const today = osloNow(deps.now()).date;
    const dates = Array.from({ length: 30 }, (_, i) => addDays(today, -i));
    // En dag som ikke kan leses, er ikke «0 besøk»: feilen går til catch nedenfor (503), aldri et sikkert tall (SPEC R18)
    const docs = await Promise.all(dates.map((d) => store.get(`d/${d}`, { type: "json" })));
    const days = dates.map((date, i) => { const doc = dayDoc(docs[i]); return { date, views: doc.views, sources: doc.sources }; });
    const sum = (n) => days.slice(0, n).reduce((a, d) => a + d.views, 0);
    const sources = {};
    for (const s of SOURCES) sources[s] = days.reduce((a, d) => a + (d.sources[s] || 0), 0);
    return json({ today, totals: { today: sum(1), week: sum(7), month: sum(30) }, sources, days });
  } catch (err) {
    console.error("Statistikk: kunne ikke lese:", err && err.name);
    return json({ error: "Kunne ikke hente statistikken." }, 503);
  }
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { path: ["/api/hit", "/api/stats"] };
