// GET /api/availability – hvilke tider som er opptatt de neste 60 dagene.
// Viser bare tidsrom (start/slutt), aldri hvem som har bestilt.
import { getStore } from "@netlify/blobs";
import { getAvailability } from "../lib/booking-core.mjs";

export default async () => {
  try {
    const data = await getAvailability(getStore({ name: "bookings", consistency: "strong" }));
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("Ledighet:", err);
    return Response.json({ error: "Kunne ikke hente ledige tider." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
};

export const config = { path: "/api/availability" };
