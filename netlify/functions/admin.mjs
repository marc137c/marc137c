// Admin-API for timebestillinger. Alt krever innlogging med ADMIN_PASSWORD (settes i Netlify).
//   POST   /api/admin/login            { password, remember, device? } → { token, expiresIn, device } (60 dager bare
//                                      med remember: true, ellers 12 timer; device: enhetsmerket, gyldig et år)
//   GET    /api/admin/items?from&to    alle avtaler og blokkeringer i perioden
//   POST   /api/admin/items            ny avtale/blokkering   (?force=1 = lagre selv om det kolliderer)
//   PATCH  /api/admin/items/:id        endre (flytte, ny tjeneste, avlyse …)
//   DELETE /api/admin/items/:id        slette for godt
//   POST   /api/admin/cancel-phone     { phone } avlys alle kommende nettbestillinger fra dette nummeret, uansett
//                                      skrivemåte (etter en flom av falske bestillinger, X2.4) → { ok, cancelled }
//   GET    /api/admin/calendar         lenken til kalenderen på telefonen: { enabled, createdAt, links }, eller
//                                      { enabled: false, expired: true } når passordet er byttet siden den ble laget
//   POST   /api/admin/calendar         lag lenken { replace: false } (beholder en som finnes) eller lag en ny
//                                      { replace: true } (den gamle slutter å virke med en gang)
//   GET    /api/admin/push             varsler på enhetene: { publicKey, devices } (nøkkelparet lages første gang);
//                                      med ?endpoint=<adresse> også thisDevice: er den adressen en enhet her
//   POST   /api/admin/push/subscribe   { subscription } denne enheten får varsel om nye bestillinger (410 «gone»
//                                      hvis push-tjenesten har sagt at abonnementet er borte: lag et nytt). Bare til
//                                      innloggingen går ut: svaret har { until }

//   POST   /api/admin/push/unsubscribe { endpoint }     denne enheten får ikke flere varsler
//   POST   /api/admin/push/test        { endpoint }     send et testvarsel til denne enheten (bare en lagret enhet)
//   POST   /api/admin/push/reset                        ingen enhet får varsler før de slås på igjen, og alle andre
//                                                       innlogginger slutter å virke ({ ok, devices: 0, token }: ny billett)
// Enhetene er knyttet til ADMIN_PASSWORD: bytter Viggo passordet, får ingen av de gamle enhetene flere varsler.
// En enhet får varsler bare til innloggingen den ble slått på med, går ut (12 timer, eller 60 dager med «Hold meg
// innlogget»); da får den ett siste varsel uten kundedata.
import { liveDeps, bookingStore, isRetiredDeploy, retiredResponse } from "../lib/runtime.mjs";
import {
  CONFIG, addDays, isDate, osloNow, readMonths, validateAdmin,
  createItem, updateItem, deleteItem, cancelMatching, monthsBetween, checkPassword, makeToken, readSession, bumpEpoch, makeDeviceMark, verifyDeviceMark,
} from "../lib/booking-core.mjs";
import { take, release, newToken, counterKey, limiterSecret, clientKey, phoneKey, LOGIN_LIMITS, LOGIN_ALL_KEY } from "../lib/limits.mjs";
import { readFeedState, createFeed, feedLinks, feedGen } from "../lib/calendar.mjs";
import {
  vapidKeys, readSubscriptions, parseSubscription, saveSubscription, removeSubscriptions, normalizeEndpoint,
  pushToDevices, testMessage, clearSubscriptions, pushGen,
} from "../lib/push.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const DAY = 24 * 60 * 60 * 1000;
const SHORT_LOGIN = DAY / 2; // «Hold meg innlogget» av
// En enhet får varsler med kundenavn bare så lenge innloggingen den ble slått på med varer, kort (12 timer) eller
// lang (60 dager): en lånt eller videregitt enhet der innloggingen har gått ut, skal ikke vise kundenavn. Hver ny
// innlogging der fornyer det (siden sender abonnementet på nytt), og når det går ut, får enheten ett siste varsel
// uten kundedata (loginExpiredMessage i netlify/lib/push.mjs).
const pushUntil = (session) => new Date(session.exp);
// Det /admin får vite om kalenderlenken. Hemmeligheten står bare inne i lenkene.
const calendarInfo = (origin, feed, stale) => (feed
  ? { enabled: true, createdAt: feed.createdAt, links: feedLinks(origin, feed.token) }
  : stale ? { enabled: false, expired: true } : { enabled: false });
// Brødteksten som et JSON-objekt (høyst 20 000 tegn), eller null
async function readBody(req) {
  const raw = await req.text();
  if (raw.length > 20000) return null;
  try {
    const body = JSON.parse(raw);
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch { return null; }
}
const PUSH_POSTS = new Set(["/api/admin/push/subscribe", "/api/admin/push/unsubscribe", "/api/admin/push/test", "/api/admin/push/reset"]);

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring, miljø og klokke)
export async function handle(req, context, deps) {
  // En gammel permalenke har det gamle passordet og den gamle koden: ingen sti der, heller ikke innloggingen (F10)
  if (isRetiredDeploy(context)) return retiredResponse();
  const password = deps.env.ADMIN_PASSWORD;
  if (!password) return json({ error: "Admin er ikke satt opp ennå: legg inn ADMIN_PASSWORD i Netlify." }, 503);
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const nowMs = deps.now().getTime();

  if (path === "/api/admin/login") {
    if (req.method !== "POST") return json({ error: "Bruk POST." }, 405);
    let body = {};
    try { body = (await req.json()) || {}; } catch {}
    // Sperre mot gjetting (F4, F5): hvert forsøk tar en plass i telleren FØR passordet sjekkes, konfliktsikkert,
    // så parallelle forsøk aldri får sjekket flere enn taket: høyst 10 per klient (IPv6 per /64) og 100 totalt per
    // 15 minutter. En enhet med et gyldig enhetsmerke (fra en tidligere innlogging her) slipper det felles taket.
    // En riktig innlogging gir plassene tilbake.
    const authStore = bookingStore(deps, context); // forhåndsvisninger har sin egen lagring (F10)
    const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "ukjent";
    const attempt = newToken();
    const taken = [];
    try {
      const ipKey = counterKey(await limiterSecret(authStore), "login/ip", clientKey(ip));
      const checks = [[ipKey, LOGIN_LIMITS.ip]];
      if (!verifyDeviceMark(body.device, password, nowMs)) checks.push([LOGIN_ALL_KEY, LOGIN_LIMITS.all]);
      for (const [key, rules] of checks) {
        const r = await take(authStore, key, rules, { nowMs, token: attempt });
        if (r.error || !r.ok) {
          for (const k of taken) await release(authStore, k, attempt).catch(() => {});
          if (r.error) return json({ error: "Innloggingen er ikke tilgjengelig akkurat nå. Prøv igjen om litt." }, 503);
          return json({ error: "For mange feil forsøk. Vent et kvarter og prøv igjen." }, 429);
        }
        taken.push(key);
      }
    } catch (err) {
      console.error("Admin: innloggingstelleren svarte ikke:", err && err.name);
      return json({ error: "Innloggingen er ikke tilgjengelig akkurat nå. Prøv igjen om litt." }, 503);
    }
    if (!checkPassword(String(body.password ?? ""), password)) {
      await deps.sleep(500);
      return json({ error: "Feil passord." }, 401);
    }
    for (const k of taken) await release(authStore, k, attempt).catch(() => {});
    // 60 dager bare når «Hold meg innlogget» er krysset av (remember: true), ellers 12 timer (F34)
    const ttl = body.remember === true ? 60 * DAY : SHORT_LOGIN;
    return json({ token: makeToken(password, nowMs, ttl), expiresIn: ttl, device: makeDeviceMark(password, nowMs) });
  }

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const store = bookingStore(deps, context);
  let session;
  try {
    session = await readSession(store, token, password, nowMs); // også: ikke laget før auth/epoch (F34)
  } catch (err) {
    console.error("Admin: kunne ikke lese innloggingen:", err && err.name);
    return json({ error: "Noe gikk galt på serveren." }, 503);
  }
  if (!session) return json({ error: "Logg inn på nytt." }, 401);

  const id = context?.params?.id || path.match(/^\/api\/admin\/items\/([^/]+)$/)?.[1];
  const force = url.searchParams.get("force") === "1";

  try {
    if (path === "/api/admin/items" && req.method === "GET") {
      const today = osloNow(deps.now()).date;
      const from = isDate(url.searchParams.get("from")) ? url.searchParams.get("from") : today;
      let to = isDate(url.searchParams.get("to")) ? url.searchParams.get("to") : addDays(from, 6);
      if (to < from) to = from;
      if (to > addDays(from, 92)) to = addDays(from, 92);
      const items = await readMonths(store, from, to);
      return json({ from, to, today, items, config: { hours: CONFIG.hours, durations: CONFIG.durations, addons: CONFIG.addons } });
    }
    if (path === "/api/admin/items" && req.method === "POST") {
      const body = await readBody(req);
      if (!body) return json({ error: "Ugyldig forespørsel." }, 400);
      const v = validateAdmin(body);
      if (v.error) return json({ error: v.error }, v.status);
      // Med requestId er et nytt forsøk (svaret gikk tapt) den samme avtalen, aldri en kopi (SPEC R1)
      const r = await createItem(store, v.value, { source: "admin", force, now: deps.now() });
      return r.error ? json(r, r.status) : json({ ok: true, item: r.item }, 201);
    }
    if (id && req.method === "PATCH") {
      const body = await readBody(req);
      if (!body) return json({ error: "Ugyldig forespørsel." }, 400);
      const v = validateAdmin(body, { partial: true });
      if (v.error) return json({ error: v.error }, v.status);
      // expect: updatedAt slik denne enheten så avtalen; 412 «stale» hvis den er endret et annet sted siden (X1.1)
      const r = await updateItem(store, decodeURIComponent(id), v.value, { force, now: deps.now(), expect: v.expect });
      return r.error ? json(r, r.status) : json({ ok: true, item: r.item });
    }
    if (path === "/api/admin/cancel-phone" && req.method === "POST") {
      const body = await readBody(req);
      const raw = body && typeof body.phone === "string" ? body.phone.trim() : "";
      const key = phoneKey(raw);
      if (raw.length > 30 || key.length < 8 || key.length > 15) return json({ error: "Ugyldig telefonnummer.", code: "bad_phone" }, 400);
      const today = osloNow(deps.now()).date;
      const r = await cancelMatching(store, monthsBetween(today, addDays(today, 92)), (i) =>
        i.source === "nettside" && (i.type ?? "booking") === "booking" && isDate(i.date) && i.date >= today && phoneKey(i.phone) === key, deps.now());
      if (r.error) return json({ error: r.error, cancelled: r.cancelled }, r.status);
      return json({ ok: true, cancelled: r.cancelled });
    }
    if (path === "/api/admin/calendar" && req.method === "GET") {
      const { feed, stale } = await readFeedState(store, feedGen(password));
      return json(calendarInfo(url.origin, feed, stale));
    }
    if (path === "/api/admin/calendar" && req.method === "POST") {
      let body = {};
      try { body = await req.json(); } catch {}
      const r = await createFeed(store, { replace: body && body.replace === true, now: deps.now(), gen: feedGen(password) });
      if (r.error) return json({ error: r.error }, r.status);
      return json(calendarInfo(url.origin, r.feed), r.created ? 201 : 200);
    }
    if (path === "/api/admin/push" && req.method === "GET") {
      // Bare den offentlige nøkkelen går til nettleseren; den private blir på serveren
      const keys = await vapidKeys(store, { now: deps.now() });
      if (keys.error) return json({ error: keys.error }, keys.status);
      const subs = await readSubscriptions(store, { gen: pushGen(password), now: deps.now() });
      const out = { publicKey: keys.publicKey, devices: subs.length };
      // ?endpoint=<adressen denne enheten husker>: er den fortsatt en enhet her? Så kan /admin telle bare de andre,
      // og fjerne sin egen døde adresse når nettleseren har mistet abonnementet. Aldri andre enheters adresser.
      const asked = url.searchParams.get("endpoint");
      if (asked !== null) {
        const mine = normalizeEndpoint(asked);
        out.thisDevice = !!mine && subs.some((s) => s.endpoint === mine);
      }
      return json(out);
    }
    if (PUSH_POSTS.has(path) && req.method === "POST") {
      const raw = await req.text();
      if (raw.length > 4000) return json({ error: "For stor forespørsel." }, 413);
      let body = {};
      try { body = JSON.parse(raw) || {}; } catch {}
      const gen = pushGen(password);
      if (path === "/api/admin/push/reset") {
        // Ingen enhet får varsler, og alle innlogginger laget før nå slutter å virke (auth/epoch). Den som trykket,
        // får en ny billett som varer like lenge som den gamle ville gjort.
        const r = await clearSubscriptions(store);
        if (r.error) return json({ error: r.error }, r.status);
        const e = await bumpEpoch(store, nowMs);
        if (e.error) return json({ error: e.error }, e.status);
        return json({ ok: true, devices: 0, token: makeToken(password, nowMs, session.exp - nowMs) });
      }
      if (path === "/api/admin/push/subscribe") {
        const v = parseSubscription(body.subscription);
        if (v.error) return json({ error: v.error, code: v.code }, 400);
        const r = await saveSubscription(store, v.value, { now: deps.now(), gen, until: pushUntil(session) });
        // 410 «gone»: push-tjenesten har sagt at dette abonnementet er borte, så nettleseren må lage et nytt
        if (r.error) return json(r.code ? { error: r.error, code: r.code } : { error: r.error }, r.status);
        return json(r.until ? { ok: true, devices: r.devices, until: r.until } : { ok: true, devices: r.devices }, r.created ? 201 : 200);
      }
      const endpoint = normalizeEndpoint(body.endpoint);
      if (path === "/api/admin/push/unsubscribe") {
        if (!endpoint) return json({ error: "Ukjent enhet.", code: "unknown_push_service" }, 400);
        const r = await removeSubscriptions(store, [endpoint], { gen, now: deps.now() });
        if (r.error) return json({ error: r.error }, r.status);
        return json({ ok: true, devices: r.devices });
      }
      // Testvarsel: bare til en enhet som allerede er lagret, aldri til en adresse nettleseren bare oppgir
      const r = endpoint ? await pushToDevices(store, testMessage(), { fetch: deps.fetch, now: deps.now(), origin: url.origin, endpoint, gen }) : { targets: 0 };
      if (!r.targets) return json({ error: "Denne enheten får ikke varsler. Trykk «Slå på varsler».", code: "not_subscribed" }, 404);
      if (r.sent) return json({ ok: true, devices: r.devices });
      if (r.gone) return json({ error: "Denne enheten kan ikke lenger få varsler. Trykk «Slå på varsler» igjen.", code: "gone", devices: r.devices }, 410);
      return json({ error: "Testvarselet kom ikke fram. Prøv igjen om litt.", code: "push_failed" }, 502);
    }
    if (id && req.method === "DELETE") {
      const r = await deleteItem(store, decodeURIComponent(id));
      return r.error ? json(r, r.status) : json(r);
    }
    return json({ error: "Ukjent forespørsel." }, 404);
  } catch (err) {
    console.error("Admin:", err);
    return json({ error: "Noe gikk galt på serveren." }, 500);
  }
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { path: [
  "/api/admin/login", "/api/admin/items", "/api/admin/items/:id", "/api/admin/cancel-phone", "/api/admin/calendar",
  "/api/admin/push", "/api/admin/push/subscribe", "/api/admin/push/unsubscribe", "/api/admin/push/test", "/api/admin/push/reset",
] };
