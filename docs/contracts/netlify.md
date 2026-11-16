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
- **What the code does:** `isRetiredDeploy(context)` in `netlify/lib/runtime.mjs` is `production && published === false`. Bookings, every `/api/admin/*` path (the login included), the calendar feed, the customer's `/api/bookings/<id>.ics`, `/api/push/renew` and the daily clean-up refuse there with 410 `{ error: "Bruk hovedsiden." }` before they open a store.
- **Operations:** after each publish, delete the older deploys (Deploys → deploy → Options → Delete deploy).
- **Test:** `test/functions/deploy-context.test.mjs` (410 and an empty Blobs log for each handler, while `published: true` or no `published` field behaves as before).

## 4. Scheduled functions run only on the published deploy

- **Docs:** https://docs.netlify.com/build/functions/scheduled-functions/
- **Quote:** "Scheduled functions only run on their schedule for published deploys — Deploy Previews and branch deploys won't trigger them automatically."
- **What the code does:** the schedule is declared in each function file (`export const config = { schedule: ... }`), never in `netlify.toml`. The only scheduled functions are `social-refresh.mjs` (hourly) and `retention.mjs` (the daily clean-up). `retention.mjs` still checks the context itself: it does nothing on a retired deploy, and outside production it cleans only the preview stores.
- **Test:** `test/no-sms.test.mjs` (the list of scheduled functions, and no `schedule` in `netlify.toml`), `test/functions/retention.test.mjs`.
