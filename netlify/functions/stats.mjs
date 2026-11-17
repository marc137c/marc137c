// Besøks- og bookingstatistikk uten informasjonskapsler.
// POST /api/hit  – nettsiden melder én sidevisning: bare dato (norsk tid), side og hvilket nettsted besøket kom fra.
//                  Et «besøk» er en visning som IKKE kom fra en annen side på samme nettsted. Ingen IP-adresse, ingen ID,
//                  ingenting lagres på besøkerens enhet. Roboter og forhåndsvisninger (deploy previews) telles ikke.
// GET  /api/stats?days=7|30|90 – bare tall (aldri navn eller telefon), og BARE for eierens egen oversikt: krever
//                  lesenøkkelen STATS_READ_KEY i headeren X-Stats-Key. Barberens /admin-innlogging gir IKKE tilgang.
// Nettstedets egen adresse leses fra forespørselen, så filen kan brukes uendret på nye bedrifters sider.
import { createHash, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { osloNow, addDays } from "../lib/booking-core.mjs";
import { bookingStats, sumDays } from "../lib/stats-bookings.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|facebookexternalhit|whatsapp|telegram|discord|curl|wget|python|node-fetch/i;
// Merkede lenker (?fra=instagram osv.) – samme liste som stats-kit, så oversikten viser alle bedriftene likt
export const TAGS = ["instagram", "facebook", "google", "tiktok", "snapchat", "qr", "sms", "epost", "visittkort"];
const SOURCES = [...TAGS, "direkte", "annet"];
const RANGES = [7, 30, 90];
const bare = (h) => String(h || "").toLowerCase().replace(/^www\./, "");

// Hvor et besøk utenfra kom fra: merket lenke først (apper som Instagram sender ofte ingen avsender),
// ellers avsendernettstedet (tom avsender = skrevet inn, bokmerke eller app uten avsender)
export function sourceOf(host, tag) {
  const t = String(tag || "").toLowerCase();
  if (t) return TAGS.includes(t) ? t : "annet";
  const h = bare(host);
  if (!h) return "direkte";
  if (/instagram/.test(h)) return "instagram";
  if (/facebook|(^|\.)fb\.(com|me)$/.test(h)) return "facebook";
  if (/(^|\.)google\./.test(h)) return "google";
  if (/tiktok/.test(h)) return "tiktok";
  if (/snapchat/.test(h)) return "snapchat";
  return "annet";
}
export const isInternal = (refHost, siteHost) => !!bare(refHost) && bare(refHost) === bare(siteHost);

const digest = (s) => createHash("sha256").update(String(s)).digest();
export function keyMatches(given, expected) {
  if (!expected || !given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

export async function bump(store, key, page, source) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const doc = cur && cur.data ? cur.data : { views: 0, visits: 0, pages: {}, sources: {} };
    // Dager fra før besøk ble skilt ut: alle visninger hadde en kilde, så summen av kildene er beste anslag
    if (doc.visits === undefined) doc.visits = Object.keys(doc.sources || {}).reduce((a, k) => a + (doc.sources[k] || 0), 0);
    doc.views = (doc.views || 0) + 1;
    doc.pages = doc.pages || {}; doc.sources = doc.sources || {};
    doc.pages[page] = (doc.pages[page] || 0) + 1;
    if (source) { doc.visits += 1; doc.sources[source] = (doc.sources[source] || 0) + 1; }
    const w = await store.setJSON(key, doc, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (w && w.modified) return true;
    await new Promise((r) => setTimeout(r, 15 * 2 ** attempt + Math.random() * 15));
  }
  return false;
}

export default async (req, context) => {
  const url = new URL(req.url);
  const production = !context || !context.deploy || !context.deploy.context || context.deploy.context === "production";
  const openStore = () => getStore({ name: production ? "stats" : "stats-preview", consistency: "strong" });

  if (url.pathname === "/api/hit") {
    const store = openStore();
    if (req.method !== "POST") return json({ error: "Bruk POST." }, 405);
    if (!production || BOT.test(req.headers.get("user-agent") || "")) return new Response(null, { status: 204 });
    let body = {};
    try { body = JSON.parse((await req.text()).slice(0, 500)) || {}; } catch { /* tom melding teller som forsiden */ }
    const page = /personvern/.test(String(body.p || "")) ? "personvern" : "forside";
    const source = isInternal(body.r, url.hostname) ? null : sourceOf(body.r, body.f);
    try { await bump(store, `d/${osloNow().date}`, page, source); } catch (err) { console.error("Statistikk:", err && err.message); }
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  // GET /api/stats
  if (req.method !== "GET") return json({ error: "Bruk GET." }, 405);
  // Bare eierens oversikt (lesenøkkelen) – ikke barberens innlogging
  if (!keyMatches(req.headers.get("x-stats-key"), process.env.STATS_READ_KEY)) return json({ error: "Mangler gyldig lesenøkkel." }, 401);
  const store = openStore();

  const n = RANGES.includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
  const today = osloNow().date;
  const dates = Array.from({ length: Math.max(n, 30) }, (_, i) => addDays(today, -i)); // nyeste først
  let docs;
  try { docs = await Promise.all(dates.map((d) => store.get(`d/${d}`, { type: "json" }))); }
  catch (err) { console.error("Statistikk:", err && err.message); return json({ error: "Statistikken kunne ikke leses akkurat nå." }, 503); }
  const dayDocs = {};
  dates.forEach((d, i) => { dayDocs[d] = docs[i] || null; });

  let b = null;
  try { b = await bookingStats(getStore({ name: "bookings", consistency: "strong" }), store, dates, today, dayDocs); }
  catch (err) { console.error("Bookingstatistikk:", err && err.message); }

  const days = dates.map((date, i) => {
    const d = docs[i] || {};
    const views = d.views || 0;
    const visits = d.visits !== undefined ? d.visits : views;
    const bk = b ? b.perDay[i] : null;
    return { date, views, visits, sources: d.sources || {}, bookings: bk ? { web: bk.web, admin: bk.admin, cancelled: bk.cancelled } : null };
  });
  const sum = (k, len) => days.slice(0, len).reduce((a, d) => a + d[k], 0);
  const sources = {};
  for (const s of SOURCES) sources[s] = days.slice(0, n).reduce((a, d) => a + (d.sources[s] || 0), 0);
  const bt = b ? sumDays(b.perDay.slice(0, n)) : null;
  return json({
    site: bare(url.hostname), today, range: n,
    // today/week/month = sidevisninger (som før); views/visits = valgt periode
    totals: { today: sum("views", 1), week: sum("views", 7), month: sum("views", 30), views: sum("views", n), visits: sum("visits", n) },
    sources,
    days,
    bookings: bt ? { web: bt.web, admin: bt.admin, cancelled: bt.cancelled, services: bt.services, weekdays: bt.weekdays, upcoming7: b.upcoming7 } : null,
  });
};

export const config = { path: ["/api/hit", "/api/stats"] };
