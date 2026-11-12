// POST /api/bookings – kunden bestiller en time. Tiden låses med en gang,
// og to kunder kan aldri få samme tid (konfliktsikker skriving i Netlify Blobs).
import { liveDeps } from "../lib/runtime.mjs";
import { validateCustomer, createItem, osloNow, readMonths, addDays, CONFIG } from "../lib/booking-core.mjs";
import { smsConfigured, sendSms, confirmText, confirmationAllowed } from "../lib/sms.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring, miljø, klokke og fetch)
export async function handle(req, context, deps) {
  const { env } = deps;
  if (req.method !== "POST") return json({ error: "Bruk POST." }, 405);
  const raw = await req.text();
  if (raw.length > 4000) return json({ error: "For stor forespørsel." }, 413);
  let input;
  try { input = JSON.parse(raw); } catch { return json({ error: "Ugyldig JSON." }, 400); }
  if (input.botField) return json({ ok: true }); // honningkrukke mot spam-roboter (samme felt som Netlify Forms)

  const v = validateCustomer(input, deps.now());
  if (v.error) return json({ error: v.error, code: v.code }, v.status);
  try {
    const store = deps.getStore({ name: "bookings", consistency: "strong" });
    const r = await createItem(store, { ...v.value, type: "booking" }, { source: "nettside", now: deps.now() });
    if (r.error) return json({ error: r.error, code: r.code }, r.status);
    const { id, date, start, dur, service } = r.item;
    // SMS-bekreftelse (Sveve). Timen er allerede lagret, så en SMS-feil skal aldri stoppe bestillingen.
    let sms = "off";
    if (smsConfigured(env)) {
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
