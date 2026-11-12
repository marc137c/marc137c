// Planlagt funksjon: henter nye poster og fornyer tokens hver time.
import { liveDeps } from "../lib/runtime.mjs";
import { buildFeed } from "../lib/social.mjs";

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring, miljø, klokke og fetch)
export async function handle(req, context, deps) {
  const feed = await buildFeed(deps.getStore("social"), deps.env, deps.fetch, () => deps.now().getTime());
  console.log(`Feed oppdatert: ${feed.instagram.length} Instagram-poster`);
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { schedule: "@hourly" };
