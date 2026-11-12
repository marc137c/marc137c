// GET /api/reviews – Google-anmeldelser (snitt, antall og de nyeste/mest relevante).
import { liveDeps } from "../lib/runtime.mjs";
import { getReviews } from "../lib/reviews.mjs";

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring, miljø, klokke og fetch)
export async function handle(req, context, deps) {
  const data = await getReviews(deps.env, deps.getStore("reviews"), deps.fetch, () => deps.now().getTime());
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=600",
      "Netlify-CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { path: "/api/reviews" };
