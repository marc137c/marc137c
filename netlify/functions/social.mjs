// GET /api/social – de nyeste postene fra Instagram.
// Leser ferdig feed fra Netlify Blobs (oppdateres hver time av social-refresh).
import { liveDeps } from "../lib/runtime.mjs";
import { buildFeed, isStale, PROFILES } from "../lib/social.mjs";

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring, miljø, klokke og fetch)
export async function handle(req, context, deps) {
  const clock = () => deps.now().getTime();
  const store = deps.getStore("social");
  let feed = await store.get("feed", { type: "json" });
  if (isStale(feed, undefined, clock)) {
    try {
      feed = await buildFeed(store, deps.env, deps.fetch, clock);
    } catch (err) {
      console.error("social:", err);
    }
  }
  return new Response(JSON.stringify(feed || { profiles: PROFILES, instagram: [] }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      "Netlify-CDN-Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600",
    },
  });
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { path: "/api/social" };
