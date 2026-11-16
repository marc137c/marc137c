# Instagram API with Instagram Login: the rules this code relies on

Each rule below is something `netlify/lib/social.mjs`, `netlify/functions/social-connect.mjs` and `viggos-barbershop/social-feed.js` assume about Instagram. Each one names the test that holds the code to it. No doc wording has been recorded for these rules, so all of them are **unquoted**: the audit (round 4, November 2026) described the behaviour, and the docs below are where to check it before relying on it further.

The recorded responses in `test/fixtures/instagram/*.json` follow the documented response format. They were not captured from Instagram, because the account is not connected yet. After the first connection, compare one real answer (Netlify → Logs → Functions → social-refresh) with them.

## 1. A long-lived token lasts 60 days and can be refreshed once it is 24 hours old

- **Docs:** https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/ and https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
- **Rule (unquoted):** a long-lived token is valid for 60 days. `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token` gives a new 60-day token (`expires_in` in seconds), but only for a token at least 24 hours old that has not expired.
- **What the code does:** refreshes once a week, so a token never reaches 60 days. A freshly seeded token whose refresh is refused is used as it is, and the refresh is tried again a day later.
- **Test:** `test/lib/social.test.mjs` (F81: a refresh after 7 days stores the new token, `refreshed_at` and `expires_at`; a refused refresh of a fresh seed is used as it is).

## 2. A token from `INSTAGRAM_ACCESS_TOKEN` follows the env var; a token from the connect link wins

- **Docs:** https://docs.netlify.com/build/environment-variables/get-started/ (the env value is fixed per deploy, see `docs/contracts/netlify.md` rule 2)
- **Rule (unquoted):** a token created in the Meta dashboard can be put in `INSTAGRAM_ACCESS_TOKEN`; the connect link (`/api/connect/instagram?key=…`) stores its own token.
- **What the code does:** a token seeded from the env var records that value as `seed`. When the env var changes (after a new deploy), the new value replaces it, and a refresh keeps `seed`. A token from the connect link has no `seed` and is never replaced by the env var. Opening the connect link again always replaces the stored token.
- **Test:** `test/lib/social.test.mjs` (F81: env A then B gives B; a refresh keeps the seed; a connected token ignores the env var).

## 3. A dead token answers with error code 190

- **Docs:** https://developers.facebook.com/docs/graph-api/guides/error-handling/
- **Rule (unquoted):** an expired or revoked token (a password change, the app removed under Apps and websites, a missed data-use checkup) makes every call answer HTTP 400 with `{"error": {"type": "OAuthException", "code": 190, …}}` (`test/fixtures/instagram/token-invalid.json`).
- **What the code does:** any failed fetch counts the same: the last good posts are kept for at most 2 days (rule 4), then the feed is empty and the page hides the grid and its lead. The error text, cut to 500 characters, goes to the function log.
- **Test:** `test/lib/social.test.mjs` (F15: with the code 190 answer, the posts stay at +1 day and are gone at +3 days).

## 4. Image links are signed CDN links that expire

- **Docs:** https://developers.facebook.com/docs/instagram-platform/reference/instagram-media
- **Rule (unquoted):** `media_url` and `thumbnail_url` are signed `cdninstagram.com` links with an expiry (`oe=`) that stop working after a few days. A post the owner deletes on Instagram disappears from `/me/media`.
- **What the code does:** keeps the previous posts only until 2 days after the last good fetch (`KEEP_POSTS_MS`, `fetched_at` in the feed), so dead images and deleted posts leave the site. The page also removes any image that fails to load.
- **Test:** `test/lib/social.test.mjs` (F15: the 2-day limit, counted from the last good fetch; an old feed without `fetched_at` is not kept), `test/functions/store-keys.test.mjs` (the `feed` row names the limit).

## 5. The media list and its fields

- **Docs:** https://developers.facebook.com/docs/instagram-platform/reference/instagram-media and https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started
- **Rule (unquoted):** `GET https://graph.instagram.com/me/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=6` lists the newest posts first. A `VIDEO` has a `thumbnail_url` for its picture. A caption may be missing.
- **What the code does:** maps each post to `{ id, url: permalink, image, video, caption, date }`, using `thumbnail_url` for a video. The page shows at most 6 posts in 2 columns and adds a «Følg oss» card only to fill an odd row. A caption's screen-reader label is cut at 80 whole characters, and a right-to-left caption gets `dir="auto"`.
- **Test:** `test/lib/social.test.mjs` (the mapping of `test/fixtures/instagram/media.json`), `test/page/site-widgets.test.mjs` (F60, X3.4, X3.5, F64).

## 6. The connect flow is a one-time OAuth login

- **Docs:** https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
- **Rule (unquoted):** the owner is sent to `https://www.instagram.com/oauth/authorize` with a `state` value, comes back to `/api/connect/instagram/callback` with a short-lived code, and the code is exchanged first for a short-lived and then for a long-lived token.
- **What the code does:** stores each `state` once under a new random key (`onlyIfNew`), accepts it for 15 minutes, and deletes it when used. The daily clean-up deletes one that was never used after 24 hours. The token from a finished connection replaces any stored token on purpose (`// blind-write-ok:`).
- **Test:** `test/functions/retention.test.mjs` (unfinished connections are cleaned up), `test/scripts/blind-writes.test.mjs` (every write is conditional or explains itself).
