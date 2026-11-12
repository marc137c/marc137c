// Det funksjonene trenger fra omgivelsene: lagring, miljøvariabler, klokke, nettverk og venting.
// Hver funksjon eksporterer handle(req, context, deps). Netlify kaller standardeksporten, som sender inn
// liveDeps(); testene (test/helpers/deps.mjs) sender inn falske utgaver i stedet.
//   getStore  samme signatur som getStore fra @netlify/blobs
//   env       miljøvariablene (process.env)
//   now()     tidspunktet akkurat nå som Date
//   fetch     samme som den globale fetch
//   sleep(ms) vent så mange millisekunder
import { getStore } from "@netlify/blobs";

export const liveDeps = () => ({
  getStore,
  env: process.env,
  now: () => new Date(),
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
