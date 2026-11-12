// GET /api/reviews – Google-anmeldelser (snitt, antall og de nyeste/mest relevante).
import { getStore } from "@netlify/blobs";
import { getReviews } from "../lib/reviews.mjs";

export default async () => {
  const data = await getReviews(process.env, getStore("reviews"));
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=600",
      "Netlify-CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
};

export const config = { path: "/api/reviews" };
