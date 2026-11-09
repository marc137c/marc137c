// POST /api/bookings – kunden bestiller en time. Tiden låses med en gang,
// og to kunder kan aldri få samme tid (konfliktsikker skriving i Netlify Blobs).
import { getStore } from "@netlify/blobs";
import { validateCustomer, createItem } from "../lib/booking-core.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Bruk POST." }, 405);
  const raw = await req.text();
  if (raw.length > 4000) return json({ error: "For stor forespørsel." }, 413);
  let input;
  try { input = JSON.parse(raw); } catch { return json({ error: "Ugyldig JSON." }, 400); }
  if (input.website) return json({ ok: true }); // honningkrukke mot spam-roboter

  const v = validateCustomer(input);
  if (v.error) return json({ error: v.error }, v.status);
  try {
    const store = getStore({ name: "bookings", consistency: "strong" });
    const r = await createItem(store, { ...v.value, type: "booking" }, { source: "nettside" });
    if (r.error) return json({ error: r.error, code: r.status === 409 ? "taken" : undefined }, r.status);
    const { id, date, start, dur, service } = r.item;
    return json({ ok: true, booking: { id, date, start, dur, service } }, 201);
  } catch (err) {
    console.error("Bestilling:", err);
    return json({ error: "Noe gikk galt. Ring oss gjerne." }, 500);
  }
};

export const config = { path: "/api/bookings" };
