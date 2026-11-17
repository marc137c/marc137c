# Google Places API (New): the rules this code relies on

Each rule below is something `netlify/lib/reviews.mjs` and `viggos-barbershop/reviews.js` assume about Google's reviews data. Each one names the test that holds the code to it. Quotes are copied from the audit's notes of Google's Places policy page (audit round 4, November 2026). They were not fetched again for this page. A rule marked **unquoted** has no recorded doc wording yet, so check it against the docs before relying on it further.

The recorded responses in `test/fixtures/places/*.json` follow the documented response format. They were not captured from Google, because no key is set yet. When `GOOGLE_PLACES_API_KEY` is first set, compare one real answer (Netlify → Logs → Functions → reviews) with them.

None of this applies to the owner's three `FEATURED` reviews in `reviews.js` (owner decision D10). Those are not Places data: the owner chose them from Google Maps, each links to its original, and they show only while `/api/reviews` is not configured or fails.

## 1. Places data shown without a Google map is attributed "Google Maps"

- **Docs:** https://developers.google.com/maps/documentation/places/web-service/policies
- **Quotes:** "Attribution should take the form of the Google Maps logo whenever possible ... the text Google Maps is acceptable" and "For new implementations, use "Google Maps"". Only existing implementations "may continue using "Google"". The audit's notes add that the text label must not be translated.
- **What the code does:** the summary, every Google card and the hero badge carry the text 'Google Maps' in `<span class="gm-attr" translate="no">` (no hand-drawn logo). The i18n strings say 'på Google Maps' / 'on Google Maps', and `reviews.js` wraps that name in `translate="no"`.
- **Test:** `test/page/site-widgets.test.mjs` (F84: in Norwegian and English, one 'Google Maps' label with `translate="no"` in the summary, on every card and in the badge, and no `.g-logo` next to Places data).

## 2. Every review links to its source on Google Maps

- **Docs:** https://developers.google.com/maps/documentation/places/web-service/policies and https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places (`Review.googleMapsUri`)
- **Quote:** "end-users must always have access to view the individual source ... review on Google Maps using the provided googleMapsUri".
- **What the code does:** the server keeps each review's `googleMapsUri` as `mapsUri`. Each Google card links to it ('Les hele på Google' / 'Read on Google', https only, new tab). This also lets a visitor read a text the 7-line clamp cuts off.
- **Test:** `test/lib/reviews.test.mjs` (F76: `mapsUri` passed through, `null` when missing), `test/page/site-widgets.test.mjs` (F76: one link per card with the review's own address; a non-https link is left out).

## 3. A notice says how the reviews shown are ordered and filtered

- **Docs:** https://developers.google.com/maps/documentation/places/web-service/policies
- **Quote:** "a clear notice that describes how reviews are being ordered and filtered".
- **What the code does:** below the Google cards, one line reads «Et utvalg av anmeldelsene med tekst, i den rekkefølgen Google Maps viser dem (mest relevante først).» ('A selection of the reviews with text, in the order Google Maps shows them (most relevant first).'). That matches the code: reviews without text are left out, at most 4 are shown, in Google's order (rule 4).
- **Test:** `test/page/site-widgets.test.mjs` (F76: the line in both languages, only with Google cards, never with `FEATURED`).

## 4. A place answer holds at most 5 reviews, sorted by relevance

- **Docs:** https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places (`Place.reviews`)
- **Rule (unquoted):** `reviews` is a list of at most 5 reviews, sorted by relevance. A review may have a rating and no text. `originalText` is the reviewer's own words, and `text` may be a machine translation.
- **What the code does:** keeps Google's order, prefers `originalText`, drops reviews without text from the cards (they still count in `userRatingCount`), and shows at most 4 cards.
- **Test:** `test/lib/reviews.test.mjs` (the mapping of `test/fixtures/places/details.json`: order, `originalText` trimmed, a rating-only review), `test/page/site-widgets.test.mjs` (four cards out of five, the rating-only one left out).

## 5. Google content may not be stored, except as the terms allow

- **Docs:** https://developers.google.com/maps/documentation/places/web-service/policies ("Data storage, caching, and scraping") and the Google Maps Platform Service Specific Terms
- **Quote:** do not "copy and save business names, addresses, or user reviews". Caching is allowed only as the Service Specific Terms permit, which cover place IDs (rule 7) and, for 30 days, coordinates.
- **What the code does:** keeps the last answer in Blobs (`reviews` store, key `reviews`) for 12 hours, so Google is called only a few times a day. When Google fails, the last good answer is served for at most 3 days after it was fetched (`STALE_LIMIT_MS`). After that the stored blob is replaced by an empty answer, so no reviewer name or text stays in storage. The CDN may keep `/api/reviews` for 1 hour, plus up to 1 day while it revalidates (`netlify/functions/reviews.mjs`).
- **Open point for the owner:** a strict reading of the terms allows no cache of reviews at all. The 12-hour cache and the 3-day limit are the plan's compromise to stay within the free quota. Without them, every CDN miss would call Google.
- **Test:** `test/lib/reviews.test.mjs` (F77: served at +2 days, empty at +4 days with no review text left, the limit counted from the last good fetch, an old blob without `okAt` dropped), `test/functions/store-keys.test.mjs` (the `reviews` row names the 3-day limit).

## 6. The Google Cloud project needs a billing account

- **Docs:** https://developers.google.com/maps/documentation/places/web-service/cloud-setup and https://developers.google.com/maps/billing-and-pricing/pricing
- **Quotes (fetched 17 November 2026, round 3):** "Verify that you have a Google Cloud project with billing enabled." (cloud-setup, prerequisites). The pricing page lists free usage caps per month: Places API Place Details Enterprise + Atmosphere 1,000 (the SKU a request for `reviews` falls under) and Text Search Pro 5,000 (`displayName` and `formattedAddress`).
- **Rule (unquoted):** the refusal from a project without billing is HTTP 403 with `reason: "BILLING_DISABLED"` (body as in `test/fixtures/places/billing-disabled.json`), also within the free monthly usage.
- **What the code does:** logs «Places 403: Google Cloud-prosjektet har ingen betalingskonto (BILLING_DISABLED). Koble en betalingskonto til prosjektet i console.cloud.google.com (Billing → Link a billing account) …». Until then the page shows the owner's `FEATURED` reviews. With the 12-hour cache a working setup makes about two place lookups a day, far below the free 1,000 a month. The README's setup step 1 links a billing account, and its troubleshooting line names this log line (F83).
- **Test:** `test/lib/reviews.test.mjs` (F83: the log line for the search and for the place lookup), `test/docs/docs.test.mjs` (F83: the README's billing step and BILLING_DISABLED).

## 7. Finding the place: Text Search, and place IDs

- **Docs:** https://developers.google.com/maps/documentation/places/web-service/text-search and https://developers.google.com/maps/documentation/places/web-service/place-id
- **Rule (unquoted):** a Text Search returns places in its own ranking and can include other businesses. A place ID may be stored, but Google can change it, and a lookup then fails.
- **What the code does:** with no `GOOGLE_PLACE_ID`, it accepts only a hit called «Viggo…» whose address is Violgata 22. Any other hit throws, and nothing is stored. A remembered `place-id` that fails the same check is looked up again. The cache records which place it belongs to, and a changed `GOOGLE_PLACE_ID` never gets the old place's reviews, not even as a stale fallback.
- **Test:** `test/lib/reviews.test.mjs` (F78: 'Viggo Bil AS' at another address throws and stores nothing, a remembered wrong place is replaced, a changed `GOOGLE_PLACE_ID` bypasses the cache).

## 8. The "see all reviews" link uses Google's own link

- **Docs:** https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places (`Place.googleMapsLinks.reviewsUri`, `Place.googleMapsUri`)
- **Rule (unquoted):** `googleMapsLinks.reviewsUri` opens the place's reviews on Google Maps. It is requested in the field mask together with `rating`, `userRatingCount`, `reviews` and `googleMapsUri`.
- **What the code does:** «Se alle anmeldelser på Google» links to `reviewsUri`, then `googleMapsUri`, then a Maps search. The undocumented `search.google.com/local/reviews?placeid=` link is no longer used.
- **Test:** `test/lib/reviews.test.mjs` (F76: the field mask, the url and its fallback).
