# Viggo's Barbershop: specification

This page holds the owner's decisions in force (D) and the rules the November 2026 fix plan adds (R). Each row names the test that enforces it. **now** means that test exists and runs in `npm test`, which the Netlify build runs before every deploy. **step N** means plan step N adds the enforcement; a planned file name may change, and the step that adds the test updates its row and sets it to **now**. A decision changes only with the owner, and the page, the test and the code change in the same commit. `test/docs/spec.test.mjs` checks this page.

## Owner decisions in force

| ID | Decision | Enforced by | Status |
|---|---|---|---|
| D1 | Nothing is ever sent to a phone number. No page or text promises it, and no provider for it is configured. There is no reminder run, and the barber's booking notifications are Web Push in /admin. The forbidden words are listed in the test, the only file allowed to name them. | `test/no-sms.test.mjs` | now |
| D2 | No Netlify Forms copy of a booking. Netlify Blobs is the only booking store: no `data-netlify`, `form-name` or `netlify-honeypot`, and no `fetch("/"`. | `test/client/booking-static.test.mjs` | now |
| D3 | If the booking API fails, times out or gives an uncertain answer, the customer is told to call: 'Ring oss på 409 63 911'. The page never says 'vi bekrefter' or promises a confirmation, and every API failure text contains 409 63 911. | `test/client/booking.test.mjs`, `test/client/booking-static.test.mjs` | now |
| D4 | No automatic holidays. A day the barber blocked completely, where the union of active blocks covers the opening hours, is closed everywhere: the customer calendar, the hero status line, and the admin week strip and day info. One shared fixture defines the rule. | `test/fixtures/closed-days.mjs` used by `test/functions/availability.test.mjs`, `test/client/booking.test.mjs`, `test/page/admin-blocked-days.test.mjs` (step 4: week strip and day info), `test/page/site-script.test.mjs` (hero, step 6) | steps 2-4, 6 |
| D5 | Norwegian is the default for every visitor, including en-US, sv-SE and no language at all. English appears only when the visitor chooses it, and that choice is remembered. | `test/page/site-i18n.test.mjs` | step 6 |
| D6 | `personvern.html` states verified facts only (see "Privacy facts" below) and is linked from the footer and under the booking button. Bookings are deleted 90 days after the appointment. | `test/page/privacy.test.mjs` (imports `RETENTION_DAYS`, names every external flow in the code), `test/functions/retention.test.mjs` | steps 2, 6 |
| D7 | Durations: Full service 60 min, every other service 30 min ('Herreklipp + skjeggtrim' = 30, live since 31719ad). Hours: Mon-Fri 10:00-18:00, Sat 10:00-17:00, Sunday closed. Every client copy equals `CONFIG` in `netlify/lib/booking-core.mjs`. | `test/config-sync.test.mjs` | now |
| D8 | Live only on the owner's domain. The primary address is https://www.viggosbarbershop.no, the apex redirects to it, and the netlify.app host answers 301. canonical, og:url and the JSON-LD url are `https://www.viggosbarbershop.no/`. A retired deploy refuses writes with 410. Nothing is published before the owner's single final yes, which comes after the domain works. | `test/page/site-head.test.mjs` (single origin), `test/functions/deploy-context.test.mjs`, `scripts/smoke-live.mjs` (run by hand after each publish) | steps 2, 6 |
| D9 | Browser targets are Safari/iOS 10+, Chrome 60+, Firefox 55+ and Samsung 8+. Code is ES2015 only, newer APIs are feature-detected, and CSS has fallbacks. | `scripts/check-es2015.mjs`, `scripts/check-css-assets.mjs` (`npm run check`), `test/scripts/check-es2015.test.mjs` | now |
| D10 | Until `/api/reviews` is configured, the reviews section shows the owner's three real Google reviews (`FEATURED` in `reviews.js`) with '5,0 ★★★★★ på Google'. | `test/page/site-widgets.test.mjs` (also when `/api/reviews` fails) | now |

**Privacy facts (D6).** These are the only facts `personvern.html` may state.

- **Controller:** Viggos Barbershop Kurti, org.nr 937 845 812, Violgata 22, 1776 Halden, phone 409 63 911, kurtivigan1@gmail.com.
- **Data:** name, phone number, and the chosen service, add-ons and time.
- **Purpose:** the booking, plus the barber's notifications and calendar.
- **Legal basis:** GDPR art. 6(1)(b).
- **Processors:** Netlify for hosting, functions and storage (USA). Google for fonts, for the map (loaded only after a click) and for reviews.
- **Retention:** bookings are deleted 90 days after the appointment.
- **Rights:** the visitor's GDPR rights, including the right to complain to Datatilsynet.

## Rules this plan adds

| ID | Rule | Enforced by | Status |
|---|---|---|---|
| R1 | Every client write carries an idempotency key. A web booking (and a new item from /admin) sends `requestId`, so a replay stores once and counts once. A cross-month move keeps its id suffix. The server side is in (step 2), the booking page sends `requestId` since step 3, and /admin since step 4 (the same id when the same sheet is saved again, a new one when it changed). | `test/functions/bookings.test.mjs`, `test/functions/fault-matrix.test.mjs`, `test/client/booking.test.mjs`, `test/page/admin-editor-pending.test.mjs` | now |
| R2 | Every `fetch(` in `viggos-barbershop/*.js` goes through `withTimeout` or `api()`. A timeout is its own 'uncertain' outcome: the customer is told to call 409 63 911, the barber sees 'Ingen forbindelse', and nobody sees raw browser text. The Google reviews and Instagram widgets give up after 15 s and show their fallback (the owner's FEATURED reviews; a hidden feed). | `test/client/booking-static.test.mjs` (no exceptions: the pending list was emptied by `booking.js` in step 3, `admin.js`, `admin-sw.js` and `admin-stats.js` in step 4, `reviews.js` and `social-feed.js` in step 5), `test/client/booking.test.mjs`, `test/page/admin-network.test.mjs`, `test/page/site-widgets.test.mjs` | now |
| R3 | Every admin edit carries `expect=updatedAt`, and a stale edit answers 412 `stale` unless the same change is already stored (a retry). The server side is in (step 2); /admin sends `expect` and only the changed fields since step 4, and on 412 closes the sheet and reloads without the 'dobbeltbooking' question. | `test/functions/admin.test.mjs`, `test/functions/fault-matrix.test.mjs`, `test/page/admin-two-device.test.mjs` | now |
| R4 | Every store key prefix has a deletion rule in `netlify/lib/store-keys.mjs` `KEY_RULES`, and no key name contains a phone number or an IP address. Bookings are kept 90 days after the appointment and rate-limit counters 24 h; legacy `auth/*` keys are removed. | `test/functions/store-keys.test.mjs`, `test/functions/retention.test.mjs` | now |
| R5 | Booking rate limits: per client 5 per hour and 10 per 24 h, with IPv6 keyed per /64 and IPv4-mapped addresses as IPv4; per phone 6 per 24 h (owner to confirm); all web bookings together 20 per hour and 40 per 24 h. All three counters are checked before any is written, a refused attempt is refunded, and an attempt on a taken slot keeps only its client hit. The barber gets one push, with no customer data, the first time the global cap refuses in 24 h. The 429 body tells the customer to call 409 63 911 (how the page shows it is D3, step 3). | `test/functions/rate-limit.test.mjs` | now |
| R6 | Every Blobs `setJSON(` under `netlify/` uses `onlyIfMatch` or `onlyIfNew`, or carries `// blind-write-ok: <reason>`. | `test/scripts/blind-writes.test.mjs` | now |
| R7 | The tests guard themselves. Every harness under `test/helpers`, `test/client` and `test/fixtures` is used by a test, and every `*.test.mjs` asserts. Every fix commit has a test that failed first and a 'Tested:' line quoting `npm test` and `npm run check`. | `test/meta.test.mjs`, `test/docs/spec.test.mjs` | now |
| R8 | The old-browser check flags only its own table names. Names inherited from Object.prototype, such as `toString`, `hasOwnProperty`, `valueOf` and `constructor`, pass. | `test/scripts/check-es2015.test.mjs` | now |
| R9 | Barber workflows in /admin. A customer who calls is found by phone (4 or more digits, any spacing or +47) or by part of the name, among bookings from today and 92 days on, and a tap opens that booking. A block over bookings names the customers and says it cancels nobody and nobody is told. A flood of web bookings from one number is cancelled in one confirmed step (only web bookings from today on). The delete question names the phone. | `test/page/admin-find.test.mjs`, `test/page/admin-block-clash.test.mjs`, `test/page/admin-cancel-phone.test.mjs`, `test/functions/admin-cancel-phone.test.mjs` | now |
| R10 | /admin is a long-lived page. 'Today' follows the clock overnight; a save keeps its own booking and body while other sheets open; an expired login brings the open sheet back after logging in; the day info and week strip only show data for the day on screen; every failure shows Norwegian text ('Ingen forbindelse'), never the browser's own. | `test/page/admin-long-lived.test.mjs`, `test/page/admin-editor-pending.test.mjs`, `test/page/admin-editor-session.test.mjs`, `test/page/admin-offline.test.mjs`, `test/page/admin-network.test.mjs` | now |

## Defaults for the open owner questions

The owner answers these once, in the final yes before going live. Until then the plan builds the default.

- **Per-phone booking cap:** 6 per 24 h.
- **Hero rating badge:** shown whenever Google reports at least 5 reviews, whatever the score. A low score is never hidden. Built in step 5 (`HERO_MIN` in `viggos-barbershop/reviews.js`, `test/page/site-widgets.test.mjs`).
- **Empty sections:** an empty Instagram or Google reviews section is hidden.
- **Map:** the attribution is plain text, 'Google Maps', and the map loads only after a click.
- **Site address:** canonical, og:url and the JSON-LD url are `https://www.viggosbarbershop.no/`.
- **Still to confirm:** the Facebook profile URL (a share link today), and the wording of the 'uncertain' and 'rateLimited' messages (drafted in step 3).
