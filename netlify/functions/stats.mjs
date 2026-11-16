// Besøksstatistikk uten informasjonskapsler.
// POST /api/hit  – nettsiden melder én sidevisning: bare dato (norsk tid), side og hvor besøket kom fra
//                  (instagram, facebook, google, tiktok, direkte, annet). Ingen IP-adresse, ingen ID, ingenting
//                  lagres på besøkerens enhet. Roboter og forhåndsvisninger (deploy previews) telles ikke.
// GET  /api/stats – siste 30 dager, bare for innlogget barber (samme billett som /admin).
import { getStore } from "@netlify/blobs";
import { osloNow, addDays, verifyToken } from "../lib/booking-core.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|facebookexternalhit|whatsapp|telegram|discord|curl|wget|python|node-fetch/i;
const SOURCES = ["instagram", "facebook", "google", "tiktok", "direkte", "annet"];

function sourceOf(host) {
  const h = String(host || "").toLowerCase();
  if (!h || /viggosbarbershop\.no$|netlify\.app$/.test(h)) return "direkte";
  if (/instagram/.test(h)) return "instagram";
  if (/facebook|fb\.com|fb\.me/.test(h)) return "facebook";
  if (/google\./.test(h)) return "google";
  if (/tiktok/.test(h)) return "tiktok";
  return "annet";
}

async function bump(store, key, page, source) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const doc = cur && cur.data ? cur.data : { views: 0, pages: {}, sources: {} };
    doc.views = (doc.views || 0) + 1;
    doc.pages[page] = (doc.pages[page] || 0) + 1;
    doc.sources[source] = (doc.sources[source] || 0) + 1;
    const w = await store.setJSON(key, doc, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (w && w.modified) return true;
    await new Promise((r) => setTimeout(r, 15 * 2 ** attempt + Math.random() * 15));
  }
  return false;
}

export default async (req, context) => {
  const url = new URL(req.url);
  const production = !context || !context.deploy || !context.deploy.context || context.deploy.context === "production";
  const store = getStore({ name: production ? "stats" : "stats-preview", consistency: "strong" });

  if (url.pathname === "/api/hit") {
    if (req.method !== "POST") return json({ error: "Bruk POST." }, 405);
    if (!production || BOT.test(req.headers.get("user-agent") || "")) return new Response(null, { status: 204 });
    let body = {};
    try { body = JSON.parse((await req.text()).slice(0, 500)); } catch { /* tom melding teller som forsiden */ }
    const page = /personvern/.test(String(body.p || "")) ? "personvern" : "forside";
    try { await bump(store, `d/${osloNow().date}`, page, sourceOf(body.r)); } catch (err) { console.error("Statistikk:", err && err.message); }
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  // GET /api/stats
  if (req.method !== "GET") return json({ error: "Bruk GET." }, 405);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!verifyToken(token, process.env.ADMIN_PASSWORD)) return json({ error: "Logg inn på nytt." }, 401);
  const today = osloNow().date;
  const dates = Array.from({ length: 30 }, (_, i) => addDays(today, -i));
  const docs = await Promise.all(dates.map((d) => store.get(`d/${d}`, { type: "json" }).catch(() => null)));
  const days = dates.map((date, i) => ({ date, views: (docs[i] && docs[i].views) || 0, sources: (docs[i] && docs[i].sources) || {} }));
  const sum = (n) => days.slice(0, n).reduce((a, d) => a + d.views, 0);
  const sources = {};
  for (const s of SOURCES) sources[s] = days.reduce((a, d) => a + (d.sources[s] || 0), 0);
  return json({ today, totals: { today: sum(1), week: sum(7), month: sum(30) }, sources, days });
};

export const config = { path: ["/api/hit", "/api/stats"] };
