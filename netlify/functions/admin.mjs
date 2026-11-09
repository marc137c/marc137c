// Admin-API for timebestillinger. Alt krever innlogging med ADMIN_PASSWORD (settes i Netlify).
//   POST   /api/admin/login            { password, remember } → { token }
//   GET    /api/admin/items?from&to    alle avtaler og blokkeringer i perioden
//   POST   /api/admin/items            ny avtale/blokkering   (?force=1 = lagre selv om det kolliderer)
//   PATCH  /api/admin/items/:id        endre (flytte, ny tjeneste, avlyse …)
//   DELETE /api/admin/items/:id        slette for godt
import { getStore } from "@netlify/blobs";
import {
  CONFIG, addDays, isDate, osloNow, readMonths, validateAdmin,
  createItem, updateItem, deleteItem, checkPassword, makeToken, verifyToken,
} from "../lib/booking-core.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const DAY = 24 * 60 * 60 * 1000;

export default async (req, context) => {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return json({ error: "Admin er ikke satt opp ennå: legg inn ADMIN_PASSWORD i Netlify." }, 503);
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/api/admin/login") {
    if (req.method !== "POST") return json({ error: "Bruk POST." }, 405);
    let body = {};
    try { body = await req.json(); } catch {}
    // Sperre mot gjetting: maks 10 feil per IP og 100 totalt per 15 minutter
    const authStore = getStore({ name: "bookings", consistency: "strong" });
    const ip = (context?.ip || req.headers.get("x-nf-client-connection-ip") || "ukjent").replace(/[^\w.:-]/g, "");
    const limits = [[`auth/ip/${ip}`, 10], ["auth/all", 100]];
    const WINDOW = 15 * 60 * 1000, now = Date.now();
    const counts = await Promise.all(limits.map(([k]) => authStore.get(k, { type: "json" }).catch(() => null)));
    if (limits.some(([, max], i) => counts[i] && now - counts[i].start < WINDOW && counts[i].n >= max)) {
      return json({ error: "For mange feil forsøk. Vent et kvarter og prøv igjen." }, 429);
    }
    if (!checkPassword(String(body.password ?? ""), password)) {
      await Promise.all(limits.map(([k], i) => {
        const c = counts[i] && now - counts[i].start < WINDOW ? counts[i] : { start: now, n: 0 };
        return authStore.setJSON(k, { start: c.start, n: c.n + 1 }).catch(() => {});
      }));
      await new Promise((r) => setTimeout(r, 500));
      return json({ error: "Feil passord." }, 401);
    }
    const ttl = body.remember === false ? DAY / 2 : 60 * DAY;
    return json({ token: makeToken(password, Date.now(), ttl), expiresIn: ttl });
  }

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!verifyToken(token, password)) return json({ error: "Logg inn på nytt." }, 401);

  const store = getStore({ name: "bookings", consistency: "strong" });
  const id = context?.params?.id || path.match(/^\/api\/admin\/items\/([^/]+)$/)?.[1];
  const force = url.searchParams.get("force") === "1";

  try {
    if (path === "/api/admin/items" && req.method === "GET") {
      const today = osloNow().date;
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
      const r = await createItem(store, v.value, { source: "admin", force });
      return r.error ? json(r, r.status) : json(r, 201);
    }
    if (id && req.method === "PATCH") {
      const v = validateAdmin(await req.json(), { partial: true });
      if (v.error) return json({ error: v.error }, v.status);
      const r = await updateItem(store, decodeURIComponent(id), v.value, { force });
      return r.error ? json(r, r.status) : json(r);
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
};

export const config = { path: ["/api/admin/login", "/api/admin/items", "/api/admin/items/:id"] };
