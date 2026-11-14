// Admin-API for timebestillinger. Alt krever innlogging med ADMIN_PASSWORD (settes i Netlify).
//   POST   /api/admin/login            { password, remember } → { token }
//   GET    /api/admin/items?from&to    alle avtaler og blokkeringer i perioden
//   POST   /api/admin/items            ny avtale/blokkering   (?force=1 = lagre selv om det kolliderer)
//   PATCH  /api/admin/items/:id        endre (flytte, ny tjeneste, avlyse …)
//   DELETE /api/admin/items/:id        slette for godt
//   GET    /api/admin/calendar         lenken til kalenderen på telefonen: { enabled, createdAt, links }
//   POST   /api/admin/calendar         lag lenken { replace: false } (beholder en som finnes) eller lag en ny
//                                      { replace: true } (den gamle slutter å virke med en gang)
//   GET    /api/admin/push             varsler på enhetene: { publicKey, devices } (nøkkelparet lages første gang)
//   POST   /api/admin/push/subscribe   { subscription } denne enheten får varsel om nye bestillinger
//   POST   /api/admin/push/unsubscribe { endpoint }     denne enheten får ikke flere varsler
//   POST   /api/admin/push/test        { endpoint }     send et testvarsel til denne enheten (bare en lagret enhet)
//   POST   /api/admin/push/reset                        ingen enhet får varsler før de slås på igjen ({ devices: 0 })
// Enhetene er knyttet til ADMIN_PASSWORD: bytter Viggo passordet, får ingen av de gamle enhetene flere varsler.
import { liveDeps, bookingStore } from "../lib/runtime.mjs";
import {
  CONFIG, addDays, isDate, osloNow, readMonths, validateAdmin,
  createItem, updateItem, deleteItem, checkPassword, makeToken, verifyToken,
} from "../lib/booking-core.mjs";
import { readFeed, createFeed, feedLinks } from "../lib/calendar.mjs";
import {
  vapidKeys, readSubscriptions, parseSubscription, saveSubscription, removeSubscriptions, normalizeEndpoint,
  pushToDevices, testMessage, clearSubscriptions, pushGen,
} from "../lib/push.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const DAY = 24 * 60 * 60 * 1000;
// Det /admin får vite om kalenderlenken. Hemmeligheten står bare inne i lenkene.
const calendarInfo = (origin, feed) => (feed
  ? { enabled: true, createdAt: feed.createdAt, links: feedLinks(origin, feed.token) }
  : { enabled: false });
const PUSH_POSTS = new Set(["/api/admin/push/subscribe", "/api/admin/push/unsubscribe", "/api/admin/push/test", "/api/admin/push/reset"]);

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring, miljø og klokke)
export async function handle(req, context, deps) {
  const password = deps.env.ADMIN_PASSWORD;
  if (!password) return json({ error: "Admin er ikke satt opp ennå: legg inn ADMIN_PASSWORD i Netlify." }, 503);
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const nowMs = deps.now().getTime();

  if (path === "/api/admin/login") {
    if (req.method !== "POST") return json({ error: "Bruk POST." }, 405);
    let body = {};
    try { body = await req.json(); } catch {}
    // Sperre mot gjetting: maks 10 feil per IP og 100 totalt per 15 minutter
    const authStore = bookingStore(deps, context); // forhåndsvisninger har sin egen lagring (F10)
    const ip = (context?.ip || req.headers.get("x-nf-client-connection-ip") || "ukjent").replace(/[^\w.:-]/g, "");
    const limits = [[`auth/ip/${ip}`, 10], ["auth/all", 100]];
    const WINDOW = 15 * 60 * 1000;
    const counts = await Promise.all(limits.map(([k]) => authStore.get(k, { type: "json" }).catch(() => null)));
    if (limits.some(([, max], i) => counts[i] && nowMs - counts[i].start < WINDOW && counts[i].n >= max)) {
      return json({ error: "For mange feil forsøk. Vent et kvarter og prøv igjen." }, 429);
    }
    if (!checkPassword(String(body.password ?? ""), password)) {
      await Promise.all(limits.map(([k], i) => {
        const c = counts[i] && nowMs - counts[i].start < WINDOW ? counts[i] : { start: nowMs, n: 0 };
        return authStore.setJSON(k, { start: c.start, n: c.n + 1 }).catch(() => {});
      }));
      await deps.sleep(500);
      return json({ error: "Feil passord." }, 401);
    }
    const ttl = body.remember === false ? DAY / 2 : 60 * DAY;
    return json({ token: makeToken(password, nowMs, ttl), expiresIn: ttl });
  }

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!verifyToken(token, password, nowMs)) return json({ error: "Logg inn på nytt." }, 401);

  const store = bookingStore(deps, context);
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
      const v = validateAdmin(await req.json());
      if (v.error) return json({ error: v.error }, v.status);
      const r = await createItem(store, v.value, { source: "admin", force, now: deps.now() });
      return r.error ? json(r, r.status) : json(r, 201);
    }
    if (id && req.method === "PATCH") {
      const v = validateAdmin(await req.json(), { partial: true });
      if (v.error) return json({ error: v.error }, v.status);
      const r = await updateItem(store, decodeURIComponent(id), v.value, { force, now: deps.now() });
      return r.error ? json(r, r.status) : json(r);
    }
    if (path === "/api/admin/calendar" && req.method === "GET") {
      return json(calendarInfo(url.origin, await readFeed(store)));
    }
    if (path === "/api/admin/calendar" && req.method === "POST") {
      let body = {};
      try { body = await req.json(); } catch {}
      const r = await createFeed(store, { replace: body && body.replace === true, now: deps.now() });
      if (r.error) return json({ error: r.error }, r.status);
      return json(calendarInfo(url.origin, r.feed), r.created ? 201 : 200);
    }
    if (path === "/api/admin/push" && req.method === "GET") {
      // Bare den offentlige nøkkelen går til nettleseren; den private blir på serveren
      const keys = await vapidKeys(store, { now: deps.now() });
      if (keys.error) return json({ error: keys.error }, keys.status);
      return json({ publicKey: keys.publicKey, devices: (await readSubscriptions(store, { gen: pushGen(password) })).length });
    }
    if (PUSH_POSTS.has(path) && req.method === "POST") {
      const raw = await req.text();
      if (raw.length > 4000) return json({ error: "For stor forespørsel." }, 413);
      let body = {};
      try { body = JSON.parse(raw) || {}; } catch {}
      const gen = pushGen(password);
      if (path === "/api/admin/push/reset") {
        const r = await clearSubscriptions(store);
        if (r.error) return json({ error: r.error }, r.status);
        return json({ ok: true, devices: 0 });
      }
      if (path === "/api/admin/push/subscribe") {
        const v = parseSubscription(body.subscription);
        if (v.error) return json({ error: v.error, code: v.code }, 400);
        const r = await saveSubscription(store, v.value, { now: deps.now(), gen });
        if (r.error) return json({ error: r.error }, r.status);
        return json({ ok: true, devices: r.devices }, r.created ? 201 : 200);
      }
      const endpoint = normalizeEndpoint(body.endpoint);
      if (path === "/api/admin/push/unsubscribe") {
        if (!endpoint) return json({ error: "Ukjent enhet.", code: "unknown_push_service" }, 400);
        const r = await removeSubscriptions(store, [endpoint], { gen });
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
  "/api/admin/login", "/api/admin/items", "/api/admin/items/:id", "/api/admin/calendar",
  "/api/admin/push", "/api/admin/push/subscribe", "/api/admin/push/unsubscribe", "/api/admin/push/test", "/api/admin/push/reset",
] };
