// Eierens oversikt over alle bedriftene.
// POST /api/login     {password} → {token}. Passordet ligger i Netlify som OVERVIEW_PASSWORD (settes i et skjult vindu).
//                     Brems: 8 forsøk per 15 min fra samme avsender, 40 totalt per 15 min. Hvert forsøk tar plassen sin
//                     med en betinget skriving FØR passordet sammenlignes, så parallelle gjetninger aldri får sjekket
//                     flere enn taket; får forsøket ikke skrevet plassen, svarer det 503 uten å sammenligne (runde 3).
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
const BUSY = "Innloggingen er ikke tilgjengelig akkurat nå. Prøv igjen om litt.";

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

// Telleren: et fast sett på to dokumenter, fail/0 og fail/1 (vinduets nummer modulo 2). Et dokument fra et eldre vindu
// (w ulik dagens) teller som tomt og skrives over, så lagringen er alltid høyst to små filer, uansett hvor mange som
// prøver eller hvor sjeldent (avsenderne hashet inn i 256 bøtter). Hver endring er en betinget skriving (ETag), med
// ventetid og tilfeldig spredning mellom forsøkene; vinner den ikke innen ATTEMPTS, svarer den { busy: true }.
const ATTEMPTS = 16;
export const retryDelay = { ms: (a) => 10 * 2 ** Math.min(a, 4) + Math.random() * 30 };
const windowOf = (now) => Math.floor(now / WINDOW);
async function mutateWindow(store, w, fn, sleep) {
  const key = "fail/" + (w % 2);
  for (let a = 0; a < ATTEMPTS; a++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const old = cur && cur.data;
    const doc = old && old.w === w && old.b && typeof old.b === "object" ? { w, all: Number(old.all) || 0, b: old.b } : { w, all: 0, b: {} };
    const res = fn(doc);
    if (res.noWrite) return res;
    const write = await store.setJSON(key, doc, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    // Bare en skriving med ETag er lagret: uten ETag svarte lagringen med en feil (5xx/401/403 etter alle forsøkene)
    if (write && write.modified && write.etag) return res;
    if (write && write.modified) return { busy: true };
    await sleep(retryDelay.ms(a));
  }
  return { busy: true };
}
// Tar én plass for dette forsøket, eller svarer full uten å skrive noe
const reserve = (store, w, bucket, sleep) => mutateWindow(store, w, (doc) => {
  if ((doc.b[bucket] || 0) >= LIMITS.one || doc.all >= LIMITS.all) return { full: true, noWrite: true };
  doc.all += 1; doc.b[bucket] = (doc.b[bucket] || 0) + 1;
  return { ok: true };
}, sleep);
// Et riktig passord gir plassen tilbake (bare i vinduet den ble tatt i)
const giveBack = (store, w, bucket, sleep) => mutateWindow(store, w, (doc) => {
  if (!(doc.b[bucket] > 0) || !(doc.all > 0)) return { noWrite: true };
  doc.all -= 1; doc.b[bucket] -= 1;
  return { ok: true };
}, sleep);

// Bare det oversikten trenger, for den valgte perioden
export function slim(d, n) {
  const days = (d.days || []).slice(0, n).map((x) => ({
    date: x.date, visits: x.visits || 0, views: x.views || 0,
    booked: x.bookings ? (x.bookings.web || 0) + (x.bookings.admin || 0) : null,
    web: x.bookings ? x.bookings.web || 0 : null, cancelled: x.bookings ? x.bookings.cancelled || 0 : null,
  }));
  return { today: d.today, range: n, visits: d.totals ? d.totals.visits || 0 : 0, views: d.totals ? d.totals.views || 0 : 0, sources: d.sources || {}, bookings: d.bookings || null, days };
}

async function fetchSite(site, n, env, fetchImpl) {
  const base = { id: site.id, name: site.name, url: site.url };
  const key = env[site.keyEnv];
  if (!key) return { ...base, ok: false, error: "Mangler lesenøkkel (" + site.keyEnv + ")" };
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
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const url = new URL(req.url);
  if (url.pathname === "/api/login") {
    if (req.method !== "POST") return json({ error: "Bruk POST." }, 405);
    if (!env.OVERVIEW_PASSWORD) return json({ error: "Passordet er ikke satt ennå." }, 503);
    let body = {};
    try { body = JSON.parse((await req.text()).slice(0, 2000)) || {}; } catch { /* tomt */ }
    // Uten passord prøves ingen gjetning, så forsøket tar ingen plass
    if (typeof body.password !== "string" || !body.password) return json({ error: "Skriv passordet." }, 400);
    const ip = (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "ukjent";
    const bucket = sha("o:" + ip)[0];
    const w = windowOf(now());
    let slot;
    try { slot = await reserve(store, w, bucket, sleep); } catch { slot = { busy: true }; }
    if (slot.full) return json({ error: "For mange feil forsøk. Vent 15 minutter." }, 429);
    if (!slot.ok) return json({ error: BUSY }, 503);
    if (!passwordOk(body.password, env.OVERVIEW_PASSWORD)) return json({ error: "Feil passord." }, 401);
    await giveBack(store, w, bucket, sleep).catch(() => {});
    return json({ token: makeToken(env.OVERVIEW_PASSWORD, now()) });
  }
  if (url.pathname === "/api/overview") {
    if (req.method !== "GET") return json({ error: "Bruk GET." }, 405);
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!verifyToken(token, env.OVERVIEW_PASSWORD, now())) return json({ error: "Logg inn på nytt." }, 401);
    const n = RANGES.includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
    const results = await Promise.all(sites.map((s) => fetchSite(s, n, env, fetchImpl)));
    return json({ range: n, sites: results });
  }
  return json({ error: "Finnes ikke." }, 404);
}

export default (req, context) => handle(req, context, {
  env: process.env, store: getStore({ name: "oversikt-auth", consistency: "strong" }), fetchImpl: fetch, now: () => Date.now(), sites: SITES,
});

export const config = { path: ["/api/login", "/api/overview"] };
