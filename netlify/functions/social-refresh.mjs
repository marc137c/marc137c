// Planlagt funksjon: henter nye poster og fornyer tokens hver time.
import { getStore } from "@netlify/blobs";
import { buildFeed } from "../lib/social.mjs";

export default async () => {
  const feed = await buildFeed(getStore("social"), process.env);
  console.log(`Feed oppdatert: ${feed.instagram.length} Instagram-poster`);
};

export const config = { schedule: "@hourly" };
