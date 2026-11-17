// Eierens oversikt over alle bedriftene.
// POST /api/login     {password} → {token}. Passordet ligger i Netlify som OVERVIEW_PASSWORD (settes i et skjult vindu).
//                     Brems: 8 feil per 15 min fra samme avsender, 40 feil totalt per 15 min.
// GET  /api/overview?days=7|30|90 (Bearer token) → tallene fra hver bedrift, hentet samtidig fra bedriftens /api/stats
//                     med lesenøkkelen (bare tall, aldri navn eller telefon). En bedrift som ikke svarer stopper ikke resten.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { SITES } from "../../sites.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
const RANGES = [7, 30, 90];
const TTL = 12 * 60 * 60 * 1000;
const WINDOW = 15 * 60 * 1000;
const LIMITS = { one: 8, all: 40 };
const TIMEOUT_MS = 9000;

const b64 = (b) => Buffer.from(b).toString("base64url");
const sha = (s) => createHash("sha256").update(String(s)).digest();
const signKey = (pw) => sha("oversikt:" + pw);
export function makeToken(pw, now = Date.now()) {
  const payload = b64(JSON.stringify({ exp: now + TTL }));
  return payload + "." + b64(createHmac("sha256", signKey(pw)).update(payload).digest());
}
export function verifyToken(token, pw, now = Date.now()) {
  if (!pw || typeof token !== "string") return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const want = createHmac("sha256", signKey(pw)).update(payload).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > now; } catch { return false; }
}
export const passwordOk = (given, pw) => !!pw && typeof given === "string" && timingSafeEqual(sha(given), sha(pw));

// Én liten teller-fil per 15-minutters vindu (avsenderne hashet inn i 256 bøtter), og vinduet før forrige slettes.
// Lagringen er dermed alltid begrenset, uansett hvor mange som prøver.
async function failures(store, now) {
  const w = Math.floor(now / WINDOW);
  store.delete(`fail/${w - 2}`).catch(() => {});
  return { key: `fail/${w}`, doc: (await store.get(`fail/${w}`, { type: "json" })) || { all: 0, b: {} } };
}
async function addFailure(store, key, bucket) {
  for (let i = 0; i < 6; i++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const doc = cur && cur.data ? cur.data : { all: 0, b: {} };
    doc.all += 1; doc.b[bucket] = (doc.b[bucket] || 0) + 1;
    const r = await store.setJSON(key, doc, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (r && r.modified) return;
  }
}

// Bare det oversikten trenger, for den valgte perioden
export function slim(d, n) {
  const days = (d.days || []).slice(0, n).map((x) => ({
    date: x.date, visits: x.visits || 0, views: x.views || 0,
    booked: x.bookings ? (x.bookings.web || 0) + (x.bookings.admin || 0) : null,
    web: x.bookings ? x.bookings.web || 0 : null, cancelled: x.bookings ? x.bookings.cancelled || 0 : null,
  }));
  return { today: d.today, range: n, visits: d.totals ? d.totals.visits || 0 : 0, views: d.totals ? d.totals.views || 0 : 0, sources: d.sources || {}, bookings: d.bookings || null, days };
}

// Bedriftslisten = den faste listen i sites.mjs + bedrifter lagt til med tools/add-site.sh (lagret i oversiktens
// Blobs-lager «oversikt-sites» som site/<id> = {id, name, url, key}). Da trengs verken kodeendring eller ny
// publisering når en ny bedrift kommer til. Ugyldige oppføringer hoppes over; en fast oppføring vinner ved lik id.
export function validEntry(e) {
  if (!e || typeof e !== "object") return false;
  if (typeof e.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(e.id)) return false;
  if (typeof e.name !== "string" || !e.name.trim() || e.name.length > 80) return false;
  if (typeof e.key !== "string" || e.key.length < 20) return false;
  try { const u = new URL(e.url); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; }
}
export function mergeSites(fixed, registry) {
  const ids = new Set(fixed.map((s) => s.id));
  const extra = (registry || []).filter((e) => validEntry(e) && !ids.has(e.id))
    .map((e) => ({ id: e.id, name: e.name.trim(), url: e.url, key: e.key }))
    .sort((a, b) => a.name.localeCompare(b.name, "nb"));
  return [...fixed, ...extra];
}
async function loadRegistry(store) {
  try {
    const { blobs } = await store.list({ prefix: "site/" });
    return (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean);
  } catch (err) { console.error("Bedriftslisten kunne ikke leses:", err && err.message); return []; }
}

async function fetchSite(site, n, env, fetchImpl) {
  const base = { id: site.id, name: site.name, url: site.url }; // nøkkelen sendes aldri videre til nettleseren
  const key = site.key || env[site.keyEnv];
  if (!key) return { ...base, ok: false, error: "Mangler lesenøkkel (" + (site.keyEnv || site.id) + ")" };
  try {
    const r = await fetchImpl(site.url.replace(/\/$/, "") + "/api/stats?days=" + n, {
      headers: { "X-Stats-Key": key, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow",
    });
    if (r.status === 401) return { ...base, ok: false, error: "Lesenøkkelen ble ikke godtatt" };
    if (!r.ok) return { ...base, ok: false, error: "Siden svarte " + r.status };
    const d = await r.json();
    if (!d || !Array.isArray(d.days)) return { ...base, ok: false, error: "Ukjent svar fra siden" };
    return { ...base, ok: true, data: slim(d, n) };
  } catch (e) {
    return { ...base, ok: false, error: e && e.name === "TimeoutError" ? "Svarte ikke innen 9 sekunder" : "Kunne ikke nås" };
  }
}

export async function handle(req, context, deps) {
  const { env, store, fetchImpl, now, sites } = deps;
  const url = new URL(req.url);
  if (url.pathname === "/api/login") {
    if (req.method !== "POST") return json({ error: "Bruk POST." }, 405);
    if (!env.OVERVIEW_PASSWORD) return json({ error: "Passordet er ikke satt ennå." }, 503);
    const ip = (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "ukjent";
    const bucket = sha("o:" + ip)[0];
    const f = await failures(store, now());
    if ((f.doc.b[bucket] || 0) >= LIMITS.one || f.doc.all >= LIMITS.all) return json({ error: "For mange feil forsøk. Vent 15 minutter." }, 429);
    let body = {};
    try { body = JSON.parse((await req.text()).slice(0, 2000)) || {}; } catch { /* tomt */ }
    if (!passwordOk(body.password, env.OVERVIEW_PASSWORD)) {
      await addFailure(store, f.key, bucket);
      return json({ error: "Feil passord." }, 401);
    }
    return json({ token: makeToken(env.OVERVIEW_PASSWORD, now()) });
  }
  if (url.pathname === "/api/overview") {
    if (req.method !== "GET") return json({ error: "Bruk GET." }, 405);
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!verifyToken(token, env.OVERVIEW_PASSWORD, now())) return json({ error: "Logg inn på nytt." }, 401);
    const n = RANGES.includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
    const all = mergeSites(sites, deps.registry ? await deps.registry() : []);
    const results = await Promise.all(all.map((s) => fetchSite(s, n, env, fetchImpl)));
    return json({ range: n, sites: results });
  }
  return json({ error: "Finnes ikke." }, 404);
}

export default (req, context) => handle(req, context, {
  env: process.env, store: getStore({ name: "oversikt-auth", consistency: "strong" }), fetchImpl: fetch, now: () => Date.now(), sites: SITES,
  registry: () => loadRegistry(getStore({ name: "oversikt-sites", consistency: "strong" })),
});

export const config = { path: ["/api/login", "/api/overview"] };
