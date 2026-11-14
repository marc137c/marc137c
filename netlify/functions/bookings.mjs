// POST /api/bookings – kunden bestiller en time. Tiden låses med en gang,
// og to kunder kan aldri få samme tid (konfliktsikker skriving i Netlify Blobs).
import { liveDeps, bookingStore, isProduction } from "../lib/runtime.mjs";
import { validateCustomer, createItem, osloNow, readMonths, addDays, CONFIG } from "../lib/booking-core.mjs";
import { smsConfigured, sendSms, confirmText, confirmationAllowed, norwegianMobile } from "../lib/sms.mjs";
import { takeBookingSlot } from "../lib/limits.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring, miljø, klokke og fetch)
export async function handle(req, context, deps) {
  const { env } = deps;
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
    // Tak mot flom (F2): per klient (IP), per telefonnummer og totalt, telt konfliktsikkert før timen lagres
    const ip = (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "ukjent";
    const phoneKey = norwegianMobile(v.value.phone) || v.value.phone.replace(/\D/g, "");
    const slot = await takeBookingSlot(store, { ip, phone: phoneKey }, deps.now().getTime());
    if (!slot.ok) {
      if (slot.error) return json({ error: slot.error }, slot.status || 503);
      return json({ error: "For mange bestillinger akkurat nå. Ring oss på 409 63 911.", code: "rate_limited" }, 429);
    }
    const r = await createItem(store, { ...v.value, type: "booking" }, { source: "nettside", now: deps.now() });
    if (r.error) return json({ error: r.error, code: r.code }, r.status);
    const { id, date, start, dur, service } = r.item;
    // SMS-bekreftelse (Sveve). Timen er allerede lagret, så en SMS-feil skal aldri stoppe bestillingen.
    let sms = "off";
    if (isProduction(context) && smsConfigured(env)) { // SMS bare fra den ekte nettsiden
      try { // egen try: timen er lagret, så kunden skal få «booket» selv om noe her feiler
        const today = osloNow(deps.now()).date;
        const upcoming = await readMonths(store, today, addDays(today, CONFIG.maxDays));
        const s = confirmationAllowed(upcoming, r.item.phone, deps.now().getTime())
          ? await sendSms(env, r.item.phone, confirmText(r.item, today), deps.fetch)
          : { ok: false, skipped: true, error: "limit" };
        sms = s.ok ? "sent" : s.skipped ? "skipped" : "failed";
        if (!s.ok && !s.skipped) console.error("SMS-bekreftelse feilet:", id, s.error);
      } catch (err) {
        sms = "failed";
        console.error("SMS-bekreftelse feilet:", id, err && err.message);
      }
    }
    return json({ ok: true, booking: { id, date, start, dur, service }, sms }, 201);
  } catch (err) {
    console.error("Bestilling:", err);
    return json({ error: "Noe gikk galt. Ring oss gjerne." }, 500);
  }
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { path: "/api/bookings" };
