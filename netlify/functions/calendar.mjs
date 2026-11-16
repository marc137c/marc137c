// GET /api/calendar/<hemmelighet>.ics – timeboken som kalenderabonnement for Viggos telefon (se netlify/lib/calendar.mjs).
// Kalenderapper kan ikke logge inn, så hemmeligheten i adressen er innloggingen:
//  - feil, gammel eller manglende hemmelighet (eller ingen kalenderlenke laget ennå, eller en lenke laget før
//    admin-passordet ble byttet) gir alltid det samme 404-svaret, uten noe innhold fra timeboken, og leser ingen avtaler;
//  - svaret mellomlagres aldri (Cache-Control: private, no-store, også for Netlifys CDN);
//  - hemmeligheten skrives aldri til loggen.
import { liveDeps, bookingStore, isRetiredDeploy, retiredResponse } from "../lib/runtime.mjs";
import { readFeed, feedGen, tokenMatches, isTokenShaped, calendarFor } from "../lib/calendar.mjs";

const PRIVATE = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Netlify-CDN-Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};
const text = (body, status, extra = {}) => new Response(body, {
  status, headers: { ...PRIVATE, "Content-Type": "text/plain; charset=utf-8", ...extra },
});
const notFound = () => text("Fant ikke kalenderen.\n", 404);

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring og klokke)
export async function handle(req, context, deps) {
  if (isRetiredDeploy(context)) return retiredResponse(); // en gammel permalenke viser aldri timeboken (F10)
  if (req.method !== "GET" && req.method !== "HEAD") return text("Bruk GET.\n", 405, { Allow: "GET, HEAD" });
  const m = /^\/api\/calendar\/([^/]+?)(?:\.ics)?\/?$/.exec(new URL(req.url).pathname);
  const given = m ? m[1] : "";
  if (!isTokenShaped(given)) return notFound();
  try {
    const store = bookingStore(deps, context); // forhåndsvisninger har sin egen timebok og sin egen lenke (F10)
    const feed = await readFeed(store, feedGen(deps.env.ADMIN_PASSWORD));
    if (!feed || !tokenMatches(given, feed.token)) return notFound();
    const body = await calendarFor(store, deps.now());
    return new Response(req.method === "HEAD" ? null : body, {
      status: 200,
      headers: {
        ...PRIVATE,
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="viggos-timebok.ics"',
      },
    });
  } catch (err) {
    console.error("Kalender: kunne ikke lage kalenderen:", err && err.name, err && err.message); // aldri adressen
    return text("Prøv igjen senere.\n", 503, { "Retry-After": "300" });
  }
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { path: "/api/calendar/:file" };
