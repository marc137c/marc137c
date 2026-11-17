// STATISTIKK-SETT for nye nettsider (kopier mappen stats-kit inn i nettsiden – se stats-kit/README.md).
// Teller besøk uten informasjonskapsler og viser dem bare i eierens oversikt (lesenøkkel), aldri til bedriften selv.
// POST /api/hit  – én sidevisning: bare dato (norsk tid), side, og hvor besøket kom fra. Kilde = merket lenke
//                  (?fra=instagram osv.) hvis den finnes, ellers avsendernettstedet. Ingen IP, ingen ID, ingenting lagres
//                  på besøkerens enhet. Roboter og forhåndsvisninger (deploy previews) telles ikke.
// GET  /api/stats?days=7|30|90 – bare tall, og bare med X-Stats-Key = STATS_READ_KEY (eierens oversikt).
// Dagstall eldre enn KEEP_DAYS slettes (første besøk hver dag rydder), så ingenting lagres for alltid.
// Selvstendig: trenger bare @netlify/blobs (versjon 10 eller nyere). Nettstedets egen adresse leses fra forespørselen.
import { createHash, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
// «bot» men ikke «CUBOT» (en telefon-merkevare som står i nettleser-ID-en til ekte telefoner)
const BOT = /(?<!cu)bot|crawl|spider|slurp|preview|headless|lighthouse|facebookexternalhit|whatsapp|telegram|discord|curl|wget|python|node-fetch/i;
const RANGES = [7, 30, 90];
export const KEEP_DAYS = 400;
const MAX_PAGES = 30; // ulike sidenavn per dag; flere havner under «annen»
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// Merkede lenker (?fra=...) som telles som egen kilde. Alt annet blir «annet».
export const TAGS = ["instagram", "facebook", "google", "tiktok", "snapchat", "qr", "sms", "epost", "visittkort"];
export const SOURCES = [...TAGS, "direkte", "annet"];
const bare = (h) => String(h || "").toLowerCase().replace(/^www\./, "");

export function osloDate(now = new Date()) {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}
export function addDays(date, n) { const d = new Date(date + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

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
export const keyMatches = (given, expected) => !!expected && !!given && timingSafeEqual(digest(given), digest(expected));

// Teller én visning i dagens dokument. Svarer "new" når dagens dokument ble laget nå (første besøk i dag), ellers true/false.
export async function bump(store, key, page, source) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const doc = cur && cur.data ? cur.data : { views: 0, visits: 0, pages: {}, sources: {} };
    doc.views = (doc.views || 0) + 1;
    doc.visits = doc.visits || 0; doc.pages = doc.pages || {}; doc.sources = doc.sources || {};
    // Høyst MAX_PAGES ulike sidenavn per dag, og bare egne tellere (ikke arvede som «constructor»)
    if (!own(doc.pages, page) && Object.keys(doc.pages).length >= MAX_PAGES) page = "annen";
    doc.pages[page] = (own(doc.pages, page) ? doc.pages[page] : 0) + 1;
    if (source) { doc.visits += 1; doc.sources[source] = (own(doc.sources, source) ? doc.sources[source] : 0) + 1; }
    const w = await store.setJSON(key, doc, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    // @netlify/blobs før versjon 10 ignorerer onlyIfMatch og svarer undefined: da ville hvert besøk telles opptil 6 ganger
    if (!w || typeof w.modified !== "boolean") throw new Error("@netlify/blobs 10 eller nyere trengs (betinget skriving)");
    if (w.modified) return cur ? true : "new";
    await new Promise((r) => setTimeout(r, 15 * 2 ** attempt + Math.random() * 15));
  }
  return false;
}

// Sletter dagstall eldre enn keep dager. Kjøres når dagens første besøk lager dagens dokument (én gang per dag).
export async function prune(store, today, keep = KEEP_DAYS) {
  const cutoff = addDays(today, -keep);
  const { blobs } = await store.list({ prefix: "d/" });
  const old = blobs.map((b) => b.key).filter((k) => /^d\/\d{4}-\d{2}-\d{2}$/.test(k) && k.slice(2) < cutoff);
  await Promise.all(old.map((k) => store.delete(k)));
  return old.length;
}

// Sidenavn: bare enkle tegn og maks 40; antallet ulike navn per dag begrenses i bump()
export const pageName = (p) => { const s = String(p || "/").toLowerCase().replace(/\.html$/, "").replace(/^\/+|\/+$/g, ""); return /^[a-z0-9\-/]{0,40}$/.test(s) ? (s || "forside") : "annen"; };

export async function handle(req, context, deps) {
  const url = new URL(req.url);
  const production = !context || !context.deploy || !context.deploy.context || context.deploy.context === "production";
  if (url.pathname === "/api/hit") {
    if (req.method !== "POST") return json({ error: "Bruk POST." }, 405);
    if (!production || BOT.test(req.headers.get("user-agent") || "")) return new Response(null, { status: 204 });
    let body = {};
    try { body = JSON.parse((await req.text()).slice(0, 1000)) || {}; } catch { /* tom melding teller som forsiden */ }
    if (typeof body !== "object") body = {};
    const source = isInternal(body.r, url.hostname) ? null : sourceOf(body.r, body.f);
    try {
      const store = deps.store(), today = osloDate(deps.now());
      if ((await bump(store, `d/${today}`, pageName(body.p), source)) === "new") await prune(store, today);
    } catch (err) { console.error("Statistikk:", err && err.message); }
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  if (req.method !== "GET") return json({ error: "Bruk GET." }, 405);
  if (!keyMatches(req.headers.get("x-stats-key"), deps.env.STATS_READ_KEY)) return json({ error: "Mangler gyldig lesenøkkel." }, 401);
  const n = RANGES.includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
  const today = osloDate(deps.now());
  const dates = Array.from({ length: Math.max(n, 30) }, (_, i) => addDays(today, -i));
  let docs;
  try { const store = deps.store(); docs = await Promise.all(dates.map((d) => store.get(`d/${d}`, { type: "json" }))); }
  catch (err) { console.error("Statistikk:", err && err.message); return json({ error: "Statistikken kunne ikke leses akkurat nå." }, 503); }
  const days = dates.map((date, i) => { const d = docs[i] || {}; return { date, views: d.views || 0, visits: d.visits || 0, sources: d.sources || {}, bookings: null }; });
  const sum = (k, len) => days.slice(0, len).reduce((a, d) => a + d[k], 0);
  const sources = {};
  for (const s of SOURCES) sources[s] = days.slice(0, n).reduce((a, d) => a + (d.sources[s] || 0), 0);
  return json({ site: bare(url.hostname), today, range: n,
    totals: { today: sum("views", 1), week: sum("views", 7), month: sum("views", 30), views: sum("views", n), visits: sum("visits", n) },
    sources, days, bookings: null });
}

export default (req, context) => {
  const production = !context || !context.deploy || !context.deploy.context || context.deploy.context === "production";
  return handle(req, context, { env: process.env, now: () => new Date(), store: () => getStore({ name: production ? "stats" : "stats-preview", consistency: "strong" }) });
};

export const config = { path: ["/api/hit", "/api/stats"] };
