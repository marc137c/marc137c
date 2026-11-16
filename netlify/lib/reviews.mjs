// Google-anmeldelser via Places API (New).
// Krever GOOGLE_PLACES_API_KEY. GOOGLE_PLACE_ID er valgfri: mangler den, finnes stedet
// automatisk med et tekstsøk etter «Viggos Barbershop» i Violgata 22, og ID-en lagres.
// Resultatet mellomlagres i Netlify Blobs, så Google kalles bare et par ganger i døgnet.
// Googles regler vi bygger på, og testen for hver: docs/contracts/google-places.md (test/lib/reviews.test.mjs).

const SEARCH_QUERY = "Viggos Barbershop Kurti, Violgata 22, 1776 Halden";
const FALLBACK_URL = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(SEARCH_QUERY);
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
// F77: Googles innhold (tekster, navn, snitt) vises høyst så lenge etter siste vellykkede henting. Feiler Google
// lenger, byttes det lagrede ut med et tomt svar, og siden viser eierens utvalgte anmeldelser i stedet.
export const STALE_LIMIT_MS = 3 * 24 * 60 * 60 * 1000;
// F78: bare et sted som heter noe med «Viggo» OG ligger i Violgata 22 godtas (det finnes andre «Viggo» i Halden)
const PLACE_NAME = /viggo/i;
const PLACE_ADDRESS = /violgata\s*22/i;
const isShop = (name, address) => PLACE_NAME.test(name || "") && PLACE_ADDRESS.test(address || "");

export const emptyReviews = () => ({ configured: false, rating: null, count: 0, reviews: [], url: FALLBACK_URL });

// Feilteksten fra Google til loggen. Mangler prosjektet betalingskonto, står det rett ut (F83).
function placesError(what, status, body) {
  if (/BILLING_DISABLED/.test(body) || (status === 403 && /billing/i.test(body))) {
    return `${what} ${status}: Google Cloud-prosjektet har ingen betalingskonto (BILLING_DISABLED). ` +
      "Koble en betalingskonto til prosjektet i console.cloud.google.com (Billing → Link a billing account); " +
      "Places API (New) svarer ikke uten, selv innenfor gratiskvoten.";
  }
  return `${what} ${status}: ${String(body).slice(0, 500)}`;
}

async function findPlaceId(env, store, fetchFn) {
  if (env.GOOGLE_PLACE_ID) return env.GOOGLE_PLACE_ID;
  const saved = await store.getWithMetadata("place-id", { type: "json" });
  // Et lagret sted brukes bare hvis det fortsatt består sjekken (eldre kode lagret ethvert «Viggo»-treff)
  if (saved && saved.data && saved.data.id && isShop(saved.data.name, saved.data.address)) return saved.data.id;

  const res = await fetchFn("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress",
    },
    body: JSON.stringify({ textQuery: SEARCH_QUERY, languageCode: "no", regionCode: "NO" }),
  });
  if (!res.ok) throw new Error(placesError("Places-søk", res.status, await res.text()));
  const { places = [] } = await res.json();
  const hit = places.find((p) => isShop(p.displayName?.text, p.formattedAddress));
  if (!hit) throw new Error("Fant ikke Viggo's Barbershop i Violgata 22 på Google. Sett GOOGLE_PLACE_ID.");
  await store.setJSON("place-id", { id: hit.id, name: hit.displayName?.text, address: hit.formattedAddress },
    saved ? { onlyIfMatch: saved.etag } : { onlyIfNew: true });
  return hit.id;
}

async function fetchPlace(env, store, fetchFn) {
  const placeId = await findPlaceId(env, store, fetchFn);
  const res = await fetchFn(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=no`, {
    headers: {
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask": "rating,userRatingCount,reviews,googleMapsUri,googleMapsLinks",
    },
  });
  if (!res.ok) throw new Error(placesError("Places", res.status, await res.text()));
  const p = await res.json();
  const data = {
    configured: true,
    rating: typeof p.rating === "number" ? p.rating : null,
    count: p.userRatingCount || 0,
    // «Se alle anmeldelser»: Googles egen lenke til anmeldelsene (F76), ellers stedet på Google Maps
    url: p.googleMapsLinks?.reviewsUri || p.googleMapsUri || FALLBACK_URL,
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
      // Lenken til akkurat denne anmeldelsen på Google Maps (Googles krav, F76)
      mapsUri: r.googleMapsUri || null,
    })),
  };
  return { placeId, data };
}

export async function fetchReviews(env, store, fetchFn = fetch) {
  return (await fetchPlace(env, store, fetchFn)).data;
}

// Henter fra mellomlageret, og fra Google når lageret er eldre enn 12 timer.
// Feiler Google, vises forrige vellykkede resultat, men høyst STALE_LIMIT_MS etter at det ble hentet (F77).
// Lageret hører til ett sted: er GOOGLE_PLACE_ID endret, brukes aldri det gamle stedets anmeldelser (F78).
// Skrivingen er betinget (etag): to samtidige kall kan ikke overskrive hverandres nyere svar.
export async function getReviews(env, store, fetchFn = fetch, { now = new Date() } = {}) {
  if (!env.GOOGLE_PLACES_API_KEY) return emptyReviews();
  const t = now.getTime();
  const cur = await store.getWithMetadata("reviews", { type: "json" });
  const cached = cur && cur.data && typeof cur.data === "object" ? cur.data : null;
  const samePlace = Boolean(cached && cached.data && (!env.GOOGLE_PLACE_ID || cached.placeId === env.GOOGLE_PLACE_ID));
  if (samePlace && t - cached.fetchedAt < MAX_AGE_MS) return cached.data;
  const save = (doc) => store.setJSON("reviews", doc, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true })
    .catch((err) => console.error("Anmeldelser: kunne ikke lagre:", err && err.name));
  try {
    const { placeId, data } = await fetchPlace(env, store, fetchFn);
    await save({ fetchedAt: t, okAt: t, placeId, data });
    return data;
  } catch (err) {
    console.error("Anmeldelser:", err.message);
    const usable = samePlace && Number.isFinite(cached.okAt) && t - cached.okAt < STALE_LIMIT_MS;
    // Prøv Google igjen tidligst om 30 minutter (ikke ved hvert besøk mens Google feiler)
    const doc = usable
      ? { fetchedAt: t - MAX_AGE_MS + RETRY_MS, okAt: cached.okAt, placeId: cached.placeId, data: cached.data }
      : { fetchedAt: t - MAX_AGE_MS + RETRY_MS, okAt: null, placeId: null, data: emptyReviews() };
    await save(doc);
    return doc.data;
  }
}
