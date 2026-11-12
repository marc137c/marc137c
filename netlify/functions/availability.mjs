// GET /api/availability – hvilke tider som er opptatt de neste 60 dagene.
// Viser bare tidsrom (start/slutt), aldri hvem som har bestilt.
import { liveDeps } from "../lib/runtime.mjs";
import { getAvailability } from "../lib/booking-core.mjs";
import { smsConfigured } from "../lib/sms.mjs";

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring, miljø og klokke)
export async function handle(req, context, deps) {
  try {
    const data = await getAvailability(deps.getStore({ name: "bookings", consistency: "strong" }), deps.now());
    data.sms = smsConfigured(deps.env); // skjemaet viser «Du får bekreftelse på SMS» bare når det er sant
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("Ledighet:", err);
    return Response.json({ error: "Kunne ikke hente ledige tider." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { path: "/api/availability" };
