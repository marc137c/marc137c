// GET /api/social – de nyeste postene fra Instagram.
// Leser ferdig feed fra Netlify Blobs (oppdateres hver time av social-refresh).
import { getStore } from "@netlify/blobs";
import { buildFeed, isStale, PROFILES } from "../lib/social.mjs";

export default async () => {
  const store = getStore("social");
  let feed = await store.get("feed", { type: "json" });
  if (isStale(feed)) {
    try {
      feed = await buildFeed(store, process.env);
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
};

export const config = { path: "/api/social" };
