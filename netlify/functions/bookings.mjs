// POST /api/bookings – kunden bestiller en time. Tiden låses med en gang,
// og to kunder kan aldri få samme tid (konfliktsikker skriving i Netlify Blobs).
// Hver ny bestilling gir et varsel på Viggos telefon/PC (Web Push, netlify/lib/push.mjs). Varselet sendes etter at
// timen er lagret, og får aldri felle bestillingen eller holde igjen svaret mer enn BOOKING_PUSH_WAIT_MS.
import { liveDeps, bookingStore, afterResponse, isRetiredDeploy, retiredResponse } from "../lib/runtime.mjs";
import { validateCustomer, createItem } from "../lib/booking-core.mjs";
import { takeBookingSlot, releaseBookingSlot } from "../lib/limits.mjs";
import { notifyNewBooking, pushToDevices, bookingsPausedMessage, pushGen, BOOKING_PUSH_WAIT_MS } from "../lib/push.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring, miljø, klokke og fetch)
export async function handle(req, context, deps) {
  if (isRetiredDeploy(context)) return retiredResponse(); // en gammel permalenke skriver aldri i timeboken (F10)
  if (req.method !== "POST") return json({ error: "Bruk POST." }, 405);
  // Bare JSON fra vår egen side. En annen nettside kan ikke sende JSON hit uten CORS-forhåndssjekk (som vi ikke
  // svarer på), så skjemaer og no-cors-kall fra fremmede sider kan ikke bestille i besøkendes navn (F2).
  if (!/^application\/json\b/i.test(req.headers.get("content-type") || "")) return json({ error: "Bruk JSON.", code: "bad_content_type" }, 415);
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return json({ error: "Ikke tillatt.", code: "cross_site" }, 403);
  const raw = await req.text();
  if (raw.length > 4000) return json({ error: "For stor forespørsel." }, 413);
  let input;
  try { input = JSON.parse(raw); } catch { return json({ error: "Ugyldig JSON." }, 400); }
  if (input.botField) return json({ ok: true }); // honningkrukke mot spam-roboter (samme felt som Netlify Forms)

  const v = validateCustomer(input, deps.now());
  if (v.error) return json({ error: v.error, code: v.code }, v.status);
  try {
    const store = bookingStore(deps, context); // forhåndsvisninger har sin egen timebok (F10)
    // Tak mot flom (F2): per klient (IP eller IPv6 /64), per telefonnummer og totalt, telt konfliktsikkert før timen lagres
    const ip = (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "ukjent";
    // Med requestId er tokenet det samme i et nytt forsøk, så forsøket ikke telles to ganger (F1)
    const slot = await takeBookingSlot(store, { ip, phone: v.value.phone, ...(v.value.requestId ? { token: v.value.requestId } : {}) }, deps.now().getTime());
    if (!slot.ok) {
      // Første gang det felles taket avviser i døgnet: ett varsel til Viggo (uten kundedata), så han vet hvorfor
      if (slot.tripped) {
        const paused = pushToDevices(store, bookingsPausedMessage(), { fetch: deps.fetch, now: deps.now(), origin: new URL(req.url).origin, gen: pushGen(deps.env.ADMIN_PASSWORD) });
        await afterResponse(context, paused, BOOKING_PUSH_WAIT_MS);
      }
      if (slot.error) return json({ error: slot.error }, slot.status || 503);
      return json({ error: "For mange bestillinger akkurat nå. Ring oss på 409 63 911.", code: "rate_limited" }, 429);
    }
    const r = await createItem(store, { ...v.value, type: "booking" }, { source: "nettside", now: deps.now() });
    if (r.error) {
      // Ble ingenting lagret (tiden var tatt), koster forsøket verken nummeret eller det felles taket noe.
      // Klientens treff blir stående, så én klient fortsatt ikke kan prøve uten grense.
      await releaseBookingSlot(store, slot, ["phone", "all"]);
      return json({ error: r.error, code: r.code }, r.status);
    }
    // Bare enheter slått på med dagens admin-passord får varselet (bytter Viggo passordet, stopper alle gamle).
    // Et nytt forsøk på en bestilling som allerede er lagret (replay), varsler ikke igjen.
    if (!r.replay) {
      const pushing = notifyNewBooking(store, r.item, { fetch: deps.fetch, now: deps.now(), origin: new URL(req.url).origin, gen: pushGen(deps.env.ADMIN_PASSWORD) });
      await afterResponse(context, pushing, BOOKING_PUSH_WAIT_MS);
    }
    const { id, date, start, dur, service } = r.item;
    return json({ ok: true, booking: { id, date, start, dur, service } }, 201);
  } catch (err) {
    console.error("Bestilling:", err);
    return json({ error: "Noe gikk galt. Ring oss gjerne." }, 500);
  }
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { path: "/api/bookings" };
