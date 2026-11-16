# Netlify: the platform rules this code relies on

Each rule below is something the code assumes about Netlify. Each one names the test that holds the code to it. Quotes are copied from the audit's notes of the Netlify docs (audit rounds 3 and 4, November 2026). They were not fetched again for this page. A rule marked **unquoted** has no recorded doc wording yet, so check it against the docs before relying on it further.

## 1. Blobs stores from `getStore` are site-wide

- **Docs:** https://docs.netlify.com/build/data-and-storage/netlify-blobs/
- **Quote:** "The namespaces you make with `getStore` are shared across all deploys of your site ... This also means you can test your Deploy Previews with production data ... be careful to avoid scenarios such as a branch deploy deleting blobs that your published deploy depends on."
- **What the code does:** only `context.deploy.context === "production"` uses the `bookings` store. Every other context uses `bookings-preview` (`netlify/lib/runtime.mjs` `bookingStore`), and visitor statistics use `stats-preview`.
- **Test:** `test/functions/deploy-context.test.mjs` (a booking from a preview, a branch deploy, `netlify dev` or a call with no context never reaches the live store).

## 2. Environment values are fixed per deploy

- **Docs:** https://docs.netlify.com/build/functions/environment-variables/ (Limitations) and https://docs.netlify.com/build/environment-variables/get-started/
- **Quotes:** "Environment variables are applied based on the values set at the time of deployment. Each deploy ... uses the environment variable values that were set at the time of deployment. To apply updated environment variable values, create a new deploy." and "Environment variable changes require a build and deploy to take effect."
- **What this means here:** a new `ADMIN_PASSWORD` applies only after a new deploy (Deploys → Trigger deploy → Deploy site). Until then the published deploy keeps the old one. Every older deploy also keeps the password it was built with, which is why rule 3 matters.
- **Test:** `test/functions/deploy-context.test.mjs` (a retired deploy answers 410 on every admin path, the login included, so an old password there opens nothing).

## 3. Older deploys stay reachable at their permalinks

- **Docs:** https://docs.netlify.com/build/functions/api/#deploy (`context.deploy.context`, `context.deploy.published`)
- **Rule (unquoted):** each deploy keeps its own code and env values and stays reachable at `https://<deploy-id>--<site>.netlify.app` until it is deleted (the audit noted up to 30 days). Its functions see `context.deploy.context === "production"` with `context.deploy.published === false`.
- **What the code does:** `isRetiredDeploy(context)` in `netlify/lib/runtime.mjs` is `production && published === false`. Bookings, every `/api/admin/*` path (the login included), the calendar feed, the customer's `/api/bookings/<id>.ics`, `/api/push/renew`, the daily clean-up and the statistics panel refuse there with 410 `{ error: "Bruk hovedsiden." }` before they open a store, and `/api/connect/instagram` with a 410 page «Bruk hovedsiden» (fix-up round 2: its old `SOCIAL_ADMIN_KEY` could otherwise write an OAuth state the live callback accepted). The rule is checked per file: every file in `netlify/functions/` is tried, with a commented exemption list for read-only functions.
- **Operations:** after each publish, delete the older deploys (Deploys → deploy → Options → Delete deploy).
- **Test:** `test/functions/deploy-context.test.mjs` (410 and an empty Blobs log for each handler, while `published: true` or no `published` field behaves as before; «retired deploy guard» for every function file), `test/functions/social-connect.test.mjs`.

## 4. Scheduled functions run only on the published deploy

- **Docs:** https://docs.netlify.com/build/functions/scheduled-functions/
- **Quote:** "Scheduled functions only run on their schedule for published deploys — Deploy Previews and branch deploys won't trigger them automatically."
- **What the code does:** the schedule is declared in each function file (`export const config = { schedule: ... }`), never in `netlify.toml`. The only scheduled functions are `social-refresh.mjs` (hourly) and `retention.mjs` (the daily clean-up). `retention.mjs` still checks the context itself: it does nothing on a retired deploy, cleans only the preview stores under another named context (such as `dev`), and treats a call without deploy information as the published deploy, since only that one runs on a schedule.
- **Test:** `test/no-sms.test.mjs` (the list of scheduled functions, and no `schedule` in `netlify.toml`), `test/functions/retention.test.mjs`.

## 5. A scheduled function runs for at most 30 seconds

- **Docs:** https://docs.netlify.com/build/functions/scheduled-functions/ (Limitations)
- **Rule (unquoted):** a scheduled function has an execution limit of 30 seconds; Netlify stops it after that. The audit (fix-up round 2) took the number from this page and did not fetch it again, so check it before relying on it further.
- **What the code does:** `retention.mjs` starts new work only during its first `BUDGET_MS` (20 s), at most `PARALLEL` (10) Blobs calls at a time, and logs «stoppet etter 20 s med N dokumenter igjen» when it stops early; the next night continues. It works in this order: the booking months (personal data) first, then the small, bounded steps (statistics days, unfinished Instagram connections), and last the rate-limit counters, the only set a stranger can grow, so a counter flood can never starve the other steps. A stale counter costs two calls (read, delete). Refused requests (any 429) create no counter document, and a counter emptied by a give-back is deleted at once (`release` in `netlify/lib/limits.mjs`), so only counted attempts leave documents behind. `social-refresh.mjs` (hourly) makes a fixed, small number of calls (the token, the feed, one write); a hang there is stopped at 30 s and the next hour tries again.
- **Test:** `test/functions/retention.test.mjs` («retention budget»: 5 000 stale counters at 25 ms per Blobs call, with concurrent calls adding up on the fake clock, stop cleanly inside 30 s with bookings, statistics and Instagram done, and later nights finish; a stale counter costs two calls), `test/functions/admin.test.mjs` («admin login abuse»: a refused login writes nothing; 600 wrong logins from 600 /64s leave only the 100 counted documents, none empty).
