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
const REGISTRY_WAIT_MS = 2500;
const MAX_BODY = 200000; // byte fra én bedrifts /api/stats (90 dager er ~15 kB)

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
// Hvert forsøk RESERVERES (telles atomisk med compare-and-swap) FØR passordet sjekkes. Da kan mange samtidige forsøk
// aldri få flere passordsjekker enn grensen. Kan reservasjonen ikke skrives, sjekkes ingenting (stengt, ikke åpent).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function reserveAttempt(store, now, bucket) {
  const w = Math.floor(now / WINDOW);
  store.delete(`fail/${w - 2}`).catch(() => {});
  const key = `fail/${w}`;
  for (let i = 0; i < 12; i++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const doc = cur && cur.data ? cur.data : { all: 0, b: {} };
    if ((doc.b[bucket] || 0) >= LIMITS.one || doc.all >= LIMITS.all) return { limited: true };
    doc.all += 1; doc.b[bucket] = (doc.b[bucket] || 0) + 1;
    const r = await store.setJSON(key, doc, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (r && r.modified) return { key };
    await sleep(5 + Math.random() * 20 * (i + 1));
  }
  return { limited: true };
}
// Riktig passord: forsøket gis tilbake, så eierens egne innlogginger ikke bruker opp kvoten
async function releaseAttempt(store, key, bucket) {
  for (let i = 0; i < 6; i++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    if (!cur || !cur.data) return;
    const doc = cur.data;
    doc.all = Math.max(0, (doc.all || 0) - 1); doc.b[bucket] = Math.max(0, (doc.b[bucket] || 0) - 1);
    const r = await store.setJSON(key, doc, { onlyIfMatch: cur.etag });
    if (r && r.modified) return;
    await sleep(5 + Math.random() * 20);
  }
}

// Kildene oversikten kjenner (samme liste som stats-kit og Viggo's; en test holder dem like)
export const SOURCES = ["instagram", "facebook", "google", "tiktok", "snapchat", "qr", "sms", "epost", "visittkort", "direkte", "annet"];
const MAX_EXTRA_SOURCES = 10;
const MAX_SERVICES = 20;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
// Et antall: bare endelige tall ≥ 0 (alt annet, også tekst med HTML, blir 0)
const cnt = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1e12) : 0);

// Bare det oversikten trenger, for den valgte perioden. Svaret fra bedriftens side er UTRYGT (en side kan være hacket):
// alt bygges på nytt med fast form – tall blir tall, kildene fra en fast liste, tjenestene begrenset – så ingenting fra
// siden kan bli HTML i eierens oversikt, og én rar side kan ikke ødelegge visningen av de andre.
export function slim(d, n) {
  const days = (Array.isArray(d.days) ? d.days : []).slice(0, n)
    .filter((x) => isObj(x) && typeof x.date === "string" && DATE.test(x.date))
    .map((x) => {
      const b = isObj(x.bookings) ? x.bookings : null;
      return { date: x.date, visits: cnt(x.visits), views: cnt(x.views),
        booked: b ? cnt(b.web) + cnt(b.admin) : null, web: b ? cnt(b.web) : null, cancelled: b ? cnt(b.cancelled) : null };
    });
  const src = isObj(d.sources) ? d.sources : {};
  const sources = {};
  for (const s of SOURCES) sources[s] = cnt(src[s]);
  // En nyere kopi av settet kan ha fått en ny kilde: tas med hvis navnet er kort og enkelt, men aldri mange
  let extra = 0;
  for (const k of Object.keys(src)) {
    if (extra >= MAX_EXTRA_SOURCES) break;
    if (!Object.prototype.hasOwnProperty.call(sources, k) && /^[a-z][a-z0-9-]{0,19}$/.test(k) && cnt(src[k])) { sources[k] = cnt(src[k]); extra++; }
  }
  let bookings = null;
  if (isObj(d.bookings)) {
    const b = d.bookings;
    const services = {};
    if (isObj(b.services)) {
      Object.keys(b.services).map((k) => [String(k).slice(0, 60), cnt(b.services[k])]).filter((x) => x[0] !== "__proto__")
        .sort((x, y) => y[1] - x[1]).slice(0, MAX_SERVICES).forEach((x) => { services[x[0]] = x[1]; });
    }
    const wk = Array.isArray(b.weekdays) ? b.weekdays : [];
    bookings = { web: cnt(b.web), admin: cnt(b.admin), cancelled: cnt(b.cancelled), upcoming7: cnt(b.upcoming7),
      weekdays: [0, 1, 2, 3, 4, 5, 6].map((i) => cnt(wk[i])), services };
  }
  const t = isObj(d.totals) ? d.totals : {};
  return { today: typeof d.today === "string" && DATE.test(d.today) ? d.today : null, range: n,
    visits: cnt(t.visits), views: cnt(t.views), sources, bookings, days };
}

// Bedriftslisten = den faste listen i sites.mjs + bedrifter lagt til med tools/add-site.sh (lagret i oversiktens
// Blobs-lager «oversikt-sites» som site/<id> = {id, name, url, key}). Da trengs verken kodeendring eller ny
// publisering når en ny bedrift kommer til. Ugyldige oppføringer, og oppføringer med samme id som en fast bedrift, tas
// ikke med, men meldes i svaret («skipped») så eieren ser det. tools/add-site.sh sjekker med validEntry før lagring.
export function validEntry(e) {
  if (!e || typeof e !== "object") return false;
  if (typeof e.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(e.id)) return false;
  if (typeof e.name !== "string" || !e.name.trim() || e.name.length > 80) return false;
  if (typeof e.key !== "string" || e.key.length < 20) return false;
  try { const u = new URL(e.url); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; }
}
export function mergeSites(fixed, registry, skipped) {
  const ids = new Set(fixed.map((s) => s.id));
  const extra = [];
  for (const e of registry || []) {
    if (validEntry(e) && !ids.has(e.id)) {
      ids.add(e.id);
      extra.push({ id: e.id, name: e.name.trim(), url: new URL(e.url).origin, key: e.key });
    } else {
      const id = e && typeof e.id === "string" && /^[a-z0-9-]{1,40}$/.test(e.id) ? e.id : "(ukjent)";
      console.error("Bedriftslisten: hoppet over oppføringen", id);
      if (skipped) skipped.push(id);
    }
  }
  extra.sort((a, b) => a.name.localeCompare(b.name, "nb"));
  return [...fixed, ...extra];
}
// Leser site/<id> fra lageret. En oppføring som ikke kan leses blir {id} (ugyldig → meldes som hoppet over).
// Feiler selve listingen, kastes feilen videre; handle() viser da de faste bedriftene og registryError.
export async function loadRegistry(store) {
  const { blobs } = await store.list({ prefix: "site/" });
  return Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }).catch(() => null)
    .then((e) => (e && typeof e === "object" ? e : { id: b.key.slice(5) }))));
}
// Bedriftslisten får vente kort: Blobs-klienten prøver ellers på nytt i ~25 sekunder før den gir opp
async function readRegistry(registry, waitMs) {
  if (!registry) return { entries: [], error: false };
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ entries: [], error: true }), waitMs); });
  const load = Promise.resolve().then(registry).then(
    (entries) => ({ entries: Array.isArray(entries) ? entries : [], error: false }),
    (err) => { console.error("Bedriftslisten kunne ikke leses:", err && err.message); return { entries: [], error: true }; });
  try { return await Promise.race([load, late]); } finally { clearTimeout(timer); }
}

// Leser svaret, men aldri mer enn MAX_BODY byte (en side kan sende uendelig mye)
async function readCapped(r) {
  if (Number(r.headers.get("content-length")) > MAX_BODY) return null;
  if (!r.body || typeof r.body.getReader !== "function") { const t = await r.text(); return t.length > MAX_BODY ? null : t; }
  const reader = r.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { reader.cancel().catch(() => {}); return null; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchSite(site, n, env, fetchImpl, timeoutMs = TIMEOUT_MS) {
  const base = { id: site.id, name: site.name, url: site.url }; // nøkkelen sendes aldri videre til nettleseren
  const key = site.key || env[site.keyEnv];
  if (!key) return { ...base, ok: false, error: "Mangler lesenøkkel (" + (site.keyEnv || site.id) + ")" };
  try {
    // redirect: "manual" – nøkkelen skal aldri følge en videresending til en annen adresse
    const r = await fetchImpl(site.url.replace(/\/$/, "") + "/api/stats?days=" + n, {
      headers: { "X-Stats-Key": key, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs), redirect: "manual",
    });
    if ((r.status >= 300 && r.status < 400) || r.type === "opaqueredirect") return { ...base, ok: false, error: "Siden videresender – registrer den endelige adressen" };
    if (r.status === 401) return { ...base, ok: false, error: "Lesenøkkelen ble ikke godtatt" };
    if (!r.ok) return { ...base, ok: false, error: "Siden svarte " + r.status };
    const text = await readCapped(r);
    if (text === null) return { ...base, ok: false, error: "Svaret var for stort" };
    let d = null;
    try { d = JSON.parse(text); } catch { /* ikke JSON */ }
    if (!isObj(d) || !Array.isArray(d.days)) return { ...base, ok: false, error: "Ukjent svar fra siden" };
    return { ...base, ok: true, data: slim(d, n) };
  } catch (e) {
    return { ...base, ok: false, error: e && e.name === "TimeoutError" ? "Svarte ikke i tide" : "Kunne ikke nås" };
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
    const slot = await reserveAttempt(store, now(), bucket);
    if (slot.limited) return json({ error: "For mange feil forsøk. Vent 15 minutter." }, 429);
    let body = {};
    try { body = JSON.parse((await req.text()).slice(0, 2000)) || {}; } catch { /* tomt */ }
    if (!passwordOk(body.password, env.OVERVIEW_PASSWORD)) return json({ error: "Feil passord." }, 401);
    await releaseAttempt(store, slot.key, bucket).catch(() => {});
    return json({ token: makeToken(env.OVERVIEW_PASSWORD, now()) });
  }
  if (url.pathname === "/api/overview") {
    if (req.method !== "GET") return json({ error: "Bruk GET." }, 405);
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!verifyToken(token, env.OVERVIEW_PASSWORD, now())) return json({ error: "Logg inn på nytt." }, 401);
    const n = RANGES.includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
    // De faste bedriftene hentes med en gang; bedriftslisten får vente høyst REGISTRY_WAIT_MS, og alle deler samme frist
    const started = Date.now();
    const fixedP = Promise.all(sites.map((s) => fetchSite(s, n, env, fetchImpl)));
    const reg = await readRegistry(deps.registry, deps.registryWaitMs || REGISTRY_WAIT_MS);
    const skipped = [];
    const extra = mergeSites(sites, reg.entries, skipped).slice(sites.length);
    const left = Math.max(2000, TIMEOUT_MS - (Date.now() - started));
    const results = (await fixedP).concat(await Promise.all(extra.map((s) => fetchSite(s, n, env, fetchImpl, left))));
    const out = { range: n, sites: results };
    if (reg.error) out.registryError = true;
    if (skipped.length) out.skipped = skipped;
    return json(out);
  }
  return json({ error: "Finnes ikke." }, 404);
}

export default (req, context) => handle(req, context, {
  env: process.env, store: getStore({ name: "oversikt-auth", consistency: "strong" }), fetchImpl: fetch, now: () => Date.now(), sites: SITES,
  registry: () => loadRegistry(getStore({ name: "oversikt-sites", consistency: "strong" })),
});

export const config = { path: ["/api/login", "/api/overview"] };
