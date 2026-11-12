// Google-anmeldelser via Places API (New).
// Krever GOOGLE_PLACES_API_KEY. GOOGLE_PLACE_ID er valgfri: mangler den, finnes stedet
// automatisk med et tekstsøk etter «Viggos Barbershop» i Violgata 22, og ID-en lagres.
// Resultatet mellomlagres i Netlify Blobs, så Google kalles bare et par ganger i døgnet.

const SEARCH_QUERY = "Viggos Barbershop Kurti, Violgata 22, 1776 Halden";
const FALLBACK_URL = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(SEARCH_QUERY);
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

export const emptyReviews = () => ({ configured: false, rating: null, count: 0, reviews: [], url: FALLBACK_URL });

async function findPlaceId(env, store, fetchFn) {
  if (env.GOOGLE_PLACE_ID) return env.GOOGLE_PLACE_ID;
  const saved = await store.get("place-id", { type: "json" });
  if (saved?.id) return saved.id;

  const res = await fetchFn("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress",
    },
    body: JSON.stringify({ textQuery: SEARCH_QUERY, languageCode: "no", regionCode: "NO" }),
  });
  if (!res.ok) throw new Error(`Places-søk ${res.status}: ${await res.text()}`);
  const { places = [] } = await res.json();
  // Bare godta et treff som faktisk heter noe med «Viggo» (det finnes andre salonger i samme gate)
  const hit = places.find((p) => /viggo/i.test(p.displayName?.text || ""));
  if (!hit) throw new Error("Fant ikke Viggo's Barbershop på Google. Sett GOOGLE_PLACE_ID.");
  await store.setJSON("place-id", { id: hit.id, name: hit.displayName?.text, address: hit.formattedAddress });
  return hit.id;
}

export async function fetchReviews(env, store, fetchFn = fetch) {
  const placeId = await findPlaceId(env, store, fetchFn);
  const res = await fetchFn(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=no`, {
    headers: {
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask": "rating,userRatingCount,reviews,googleMapsUri",
    },
  });
  if (!res.ok) throw new Error(`Places ${res.status}: ${await res.text()}`);
  const p = await res.json();
  return {
    configured: true,
    rating: typeof p.rating === "number" ? p.rating : null,
    count: p.userRatingCount || 0,
    url: `https://search.google.com/local/reviews?placeid=${encodeURIComponent(placeId)}`,
    mapsUrl: p.googleMapsUri || FALLBACK_URL,
    reviews: (p.reviews || []).map((r) => ({
      author: r.authorAttribution?.displayName || "Google-bruker",
      authorUrl: r.authorAttribution?.uri || null,
      photo: r.authorAttribution?.photoUri || null,
      rating: r.rating || 0,
      // Kundens egne ord (originalText), ikke Googles maskinoversettelse
      text: (r.originalText?.text || r.text?.text || "").trim(),
      when: r.relativePublishTimeDescription || "",
      date: r.publishTime || null,
    })),
  };
}

// Henter fra mellomlageret, og fra Google når lageret er eldre enn 12 timer.
// Feiler Google, vises forrige vellykkede resultat.
export async function getReviews(env, store, fetchFn = fetch) {
  if (!env.GOOGLE_PLACES_API_KEY) return emptyReviews();
  const cached = await store.get("reviews", { type: "json" });
  if (cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) return cached.data;
  try {
    const data = await fetchReviews(env, store, fetchFn);
    await store.setJSON("reviews", { fetchedAt: Date.now(), data });
    return data;
  } catch (err) {
    console.error("Anmeldelser:", err.message);
    // Prøv Google igjen tidligst om 30 minutter (ikke ved hvert besøk mens Google feiler)
    const data = cached?.data || emptyReviews();
    await store.setJSON("reviews", { fetchedAt: Date.now() - MAX_AGE_MS + 30 * 60 * 1000, data }).catch(() => {});
    return data;
  }
}
