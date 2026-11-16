// GET /api/bookings/<id>.ics – kundens egen time som kalenderfil, så den kan legges i telefonens kalender etter
// bestillingen (siden lager adressen fra booking.id i svaret på bestillingen). Bare en nettbestilling som ikke er
// avlyst. Filen har tjeneste, tid, adresse og telefonnummeret til butikken, aldri kundens navn eller telefon.
// Alt annet (avlyst, blokkering, lagt inn av Viggo, ukjent eller feil form) gir det samme 404-svaret.
import { liveDeps, bookingStore, isRetiredDeploy, retiredResponse } from "../lib/runtime.mjs";
import { findItem, isDate } from "../lib/booking-core.mjs";
import { customerCalendar, isCustomerVisible } from "../lib/calendar.mjs";

const HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Netlify-CDN-Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};
const text = (body, status, extra = {}) => new Response(body, { status, headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8", ...extra } });
const notFound = () => text("Fant ikke timen. Ring oss på 409 63 911.\n", 404);
const ID_RE = /^(\d{4}-\d{2}-\d{2})_[A-Za-z0-9]{1,32}$/;

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring og klokke)
export async function handle(req, context, deps) {
  if (isRetiredDeploy(context)) return retiredResponse(); // en gammel permalenke viser aldri timeboken (F10)
  if (req.method !== "GET" && req.method !== "HEAD") return text("Bruk GET.\n", 405, { Allow: "GET, HEAD" });
  const m = /^\/api\/bookings\/([^/]+)\.ics$/.exec(new URL(req.url).pathname);
  const id = m ? m[1] : "";
  const idm = ID_RE.exec(id);
  if (!idm || !isDate(idm[1])) return notFound();
  try {
    const item = await findItem(bookingStore(deps, context), id);
    if (!isCustomerVisible(item)) return notFound();
    return new Response(req.method === "HEAD" ? null : customerCalendar(item, { now: deps.now() }), {
      status: 200,
      headers: { ...HEADERS, "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="viggos-time.ics"' },
    });
  } catch (err) {
    console.error("Kalenderfil: kunne ikke lese timen:", err && err.name); // aldri id-en
    return text("Prøv igjen senere, eller ring oss på 409 63 911.\n", 503, { "Retry-After": "60" });
  }
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { path: "/api/bookings/:file" };
