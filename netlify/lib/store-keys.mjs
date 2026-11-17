// Every key the server writes in Netlify Blobs, what it holds and when it is deleted (SPEC R4, F36, NEW-pii-keys).
// A new key prefix needs a row here with a deletion rule: test/functions/store-keys.test.mjs drives the handlers
// and fails on any stored key without one, or on a key name that contains a phone number or an IP address.
// The daily clean-up (netlify/functions/retention.mjs) carries out the rules marked «daily clean-up».
// personvern.html (step 6) imports RETENTION_DAYS, so the page and the code always say the same number of days.
import { BUCKETS, BUCKET_MAX_HITS } from "./limits.mjs";

export const RETENTION_DAYS = 90;                    // bookings: deleted this many days after the appointment
export const COUNTER_MAX_AGE_MS = 24 * 60 * 60 * 1000; // rate-limit counters: every hit deleted once it is a day old
export const STATS_KEEP_DAYS = 400;                  // visitor statistics (no personal data): about 13 months
export const OAUTH_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // an Instagram connection that was never finished

export const BOOKING_STORES = ["bookings", "bookings-preview"];
export const STATS_STORES = ["stats", "stats-preview"];

// { stores, key (exact) | prefix, holds, deletion, fields? }. The most specific row wins: an exact key, then the longest
// prefix. fields: every field path a document under the row may hold («name[].sub» inside a list); store-keys.test.mjs
// checks it against what the handlers store, and privacy.test.mjs that personvern.html describes each one.
export const KEY_RULES = Object.freeze([
  { stores: BOOKING_STORES, prefix: "m/", holds: "one month of bookings and blocks: date, time, service, add-ons, name, phone, note (and movedOut, deletedOut: logs of moves out of the month and of deletions, each entry an id, the new id for a move, a random mark and the time, no customer data; while a move to another month is unfinished, the booking carries moving and its copy mv: ids and the move's random mark, removed when the move is finished or undone)",
    deletion: `daily clean-up: every item ${RETENTION_DAYS} days after its date (cancelled ones too, and impossible dates); a month document left empty is deleted once the whole month is past that limit. A movedOut or deletedOut entry is dropped once it is more than 24 hours old, by the next write to that month or by the daily clean-up, so at the latest 48 hours after it. The barber can delete an item at any time («Slett»).` },
  { stores: BOOKING_STORES, key: "rl/secret", holds: "32 random bytes behind the counter key names; no personal data",
    deletion: "kept for the life of the store; deleting it only resets every counter" },
  { stores: BOOKING_STORES, prefix: "rl/", holds: `rate-limit counters, a fixed set of documents whatever the traffic (SPEC R44): one shared counter each for all web bookings and all logins (rl/all, rl/login/all), and ${BUCKETS} buckets per kind, at most ${BUCKET_MAX_HITS} hits each: rl/b/ip/* and rl/b/phone/* count web bookings per client (IP address or IPv6 /64) and per phone number, rl/b/login/ip/* logins per client. Each hit holds its time and an id for the attempt, and in a bucket the keyed hash of the address or number it counts (never the value itself; the bucket is 4 bits of the same hash). For a web booking the id is a keyed hash of the booking's requestId, date, time and phone, so with store access a hit can be linked to its booking while both exist. The shared booking counter also holds when the cap last alerted the barber. Any other rl/ document is a per-client counter left by a build from before round 3.`,
    fields: ["hits[].t", "hits[].id", "hits[].k", "alertedAt"],
    deletion: "daily clean-up: every hit and pause alert more than 24 hours old is removed from its document (a conditional rewrite; the documents themselves stay), so each is gone at the latest 48 hours after the attempt, whatever the number of attempts; every write also drops the hits older than the counter's longest window, and a full bucket its oldest hits. A per-client document from before round 3 is deleted without being read." },
  { stores: BOOKING_STORES, key: "auth/epoch", holds: "the time «Slå av varsler på alle andre enheter» was last pressed; no personal data",
    deletion: "kept; it only ever moves forward" },
  { stores: BOOKING_STORES, prefix: "auth/", holds: "legacy login counters from before the hashed counters (auth/ip/<address>, auth/all)",
    deletion: "daily clean-up: always deleted" },
  { stores: BOOKING_STORES, key: "push/vapid", holds: "the server's own Web Push key pair; no personal data",
    deletion: "kept; replaced only if it is missing or broken" },
  { stores: BOOKING_STORES, key: "push/subs", holds: "the barber's devices that get notifications (push service address and keys), and hashes of addresses the push service called gone",
    deletion: "a device is removed when it is turned off, on «Slå av varsler på alle andre enheter», when the login it was turned on with runs out, when the push service says it is gone, or after a password change; a gone hash is forgotten after 60 days" },
  { stores: BOOKING_STORES, key: "calendar/feed", holds: "the secret in the barber's private calendar link",
    deletion: "replaced when the barber makes a new link; stops working after a password change" },
  { stores: STATS_STORES, prefix: "d/", holds: "visitor counts for one day: page views per page and per source; no IP address, no ID, no personal data",
    fields: ["views", "pages", "sources"],
    deletion: `daily clean-up: deleted ${STATS_KEEP_DAYS} days after that day` },
  { stores: ["social"], prefix: "oauth-state-", holds: "a random value for one Instagram connection attempt; no personal data",
    deletion: "deleted when the connection finishes; daily clean-up: deleted after 24 hours if it never did" },
  { stores: ["social"], key: "instagram-token", holds: "the shop's own Instagram access token, and the INSTAGRAM_ACCESS_TOKEN value that seeded it (if any)",
    deletion: "renewed by the hourly refresh; replaced when the account is connected again, or when a seeded token's INSTAGRAM_ACCESS_TOKEN changes" },
  { stores: ["social"], key: "feed", holds: "the shop's latest public Instagram posts (links, captions, image addresses) and when they were last fetched",
    deletion: "replaced by every hourly refresh; while Instagram fails, the posts are kept at most 2 days after the last good fetch (KEEP_POSTS_MS in netlify/lib/social.mjs), then the feed is empty" },
  { stores: ["reviews"], key: "place-id", holds: "the shop's Google place id, name and address (only a place called Viggo… at Violgata 22 is stored)",
    deletion: "replaced when the place is looked up again, also when a stored place fails the Violgata 22 check" },
  { stores: ["reviews"], key: "reviews", holds: "the shop's rating and the reviews Google shows (reviewer names and texts as published on Google), which place they belong to and when they were last fetched",
    deletion: "replaced whenever the reviews are fetched again; when Google has failed for 3 days after the last good fetch (STALE_LIMIT_MS in netlify/lib/reviews.mjs), the names and texts are replaced by an empty answer" },
]);

// The row for this key in this store, or null
export function ruleFor(store, key) {
  const rows = KEY_RULES.filter((r) => r.stores.includes(store));
  const exact = rows.find((r) => r.key === key);
  if (exact) return exact;
  const prefixed = rows.filter((r) => r.prefix && key.startsWith(r.prefix)).sort((a, b) => b.prefix.length - a.prefix.length);
  return prefixed[0] || null;
}
