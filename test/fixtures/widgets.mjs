// Edge-case and hostile data for the Google reviews and Instagram widgets (RC8: until now only friendly data, 12 or
// 41 reviews, was ever rendered). Each REVIEWS entry is a whole /api/reviews answer and each feed() a whole
// /api/social answer, in the shape netlify/lib/reviews.mjs and netlify/lib/social.mjs send. All names and texts are
// made up. test/page/site-widgets.test.mjs runs them through the real reviews.js, social-feed.js and i18n.js.

export const ALL_REVIEWS_URL = "https://www.google.com/maps/place//data=fixture-reviews";
export const UNCONFIGURED_URL = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent("Viggos Barbershop Kurti, Violgata 22, 1776 Halden");

export function review(n, over = {}) {
  return Object.assign({
    author: `Fixture Kunde ${n}`,
    authorUrl: `https://www.google.com/maps/contrib/1000000000000000000${n}/reviews`,
    photo: null,
    rating: 5,
    text: `Fixture-anmeldelse nummer ${n}.`,
    when: "for 2 uker siden",
    date: "2026-11-02T10:15:00.000Z",
    mapsUri: `https://www.google.com/maps/reviews/data=fixture-review-${n}`,
  }, over);
}

const configured = (rating, count, reviews) => ({
  configured: true, rating, count, url: ALL_REVIEWS_URL, mapsUrl: "https://maps.google.com/?cid=1000000000000000001", reviews,
});

// 43 characters with no space or hyphen to break at
export const LONG_NAME = "Kristofferhaugenbjornstadjohansenmikkelsens";
export const ARABIC_TEXT = "حلاقة ممتازة وخدمة رائعة، أنصح به بشدة.";

export const REVIEWS = {
  one: configured(5, 1, [review(1)]),                                                          // 1 review
  oneStar: configured(1, 1, [review(1, { rating: 1, text: "Ikke fornøyd denne gangen." })]),  // a 1.0 average
  few: configured(4.7, 3, [review(1), review(2), review(3, { rating: 4 })]),                    // 3 reviews
  many: configured(4.7, 41, [review(1), review(2, { text: "" }), review(3, { rating: 4 }), review(4), review(5)]), // 41 at 4.7
  low: configured(2.1, 7, [review(1, { rating: 2 }), review(2, { rating: 1 })]),               // a low score, 7 reviews
  two: configured(4.5, 2, [review(1), review(2)]),
  noText: configured(4.8, 12, [review(1, { text: "" }), review(2, { text: "" })]),              // ratings only
  names: configured(4.6, 9, [
    review(1, { author: LONG_NAME }),
    review(2, { author: "🔥Ali" }),
    review(3, { author: "𝓜𝓪𝓻𝓲𝓪" }),
    review(4, { author: "Øyvind" }),
  ]),
  rtl: configured(4.9, 15, [
    review(1, { author: "عمر", text: ARABIC_TEXT }),
    review(2, { text: "Raskt & bra <b>ikke fet</b> \"sitat\" 'enkelt'", authorUrl: "javascript:alert(1)", photo: "http://insecure.test/a.jpg", mapsUri: "javascript:alert(2)" }),
  ]),
  unconfigured: { configured: false, rating: null, count: 0, reviews: [], url: UNCONFIGURED_URL },
};

// Captions with something that breaks when cut at 80 UTF-16 units: an entity, a quote or an emoji right there
const PREFIX = "Fade og skjeggtrim i dag. ".repeat(4).slice(0, 76);
export const CAPTIONS = {
  amp: PREFIX + " & ring oss",
  quote: PREFIX + " \"Viggo\" er best",
  emoji: PREFIX + " 💈🔥 Book",
  arabic: "قصة شعر جديدة اليوم",
};

export function post(n, over = {}) {
  return Object.assign({
    platform: "instagram",
    id: String(18000000000000000 + n),
    url: `https://www.instagram.com/p/Fixture${n}/`,
    image: `https://scontent.cdninstagram.com/v/fixture/${n}.jpg?oh=fixture&oe=69300000`,
    video: false,
    caption: `Fixture-post ${n}`,
    date: "2026-11-15T14:02:11.000Z",
  }, over);
}

export function feed(n, overs = []) {
  return {
    updated_at: "2026-11-16T10:00:00.000Z",
    fetched_at: "2026-11-16T10:00:00.000Z",
    profiles: { instagram: "https://www.instagram.com/viggos.barbershop/" },
    instagram: Array.from({ length: n }, (_, i) => post(i + 1, overs[i] || {})),
  };
}

// The owner's three real Google reviews (FEATURED in viggos-barbershop/reviews.js, owner decision D10), as the
// page must show them while /api/reviews is not configured
export const FEATURED = [
  { author: "Leon S. W.", initial: "L", link: "https://maps.app.goo.gl/QREBo7cj1MRCwQgD7", starts: "Klart den beste opplevelsen" },
  { author: "Edvard M. M.", initial: "E", link: "https://maps.app.goo.gl/XYkd2LQnLUvtRBva6", starts: "Viggos barbershop kan anbefales" },
  { author: "Gilbert L.", initial: "G", link: "https://maps.app.goo.gl/dqCgHtyePRZ4ZbaT8", starts: "Kjempeservice og en meget bra klipp" },
];
export const FEATURED_URL = "https://www.google.com/maps?cid=11492333145250102936";
