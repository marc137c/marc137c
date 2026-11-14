// Det funksjonene trenger fra omgivelsene: lagring, miljøvariabler, klokke, nettverk og venting.
// SMS-funksjonene (bookings, sms-reminders) og availability eksporterer handle(req, context, deps).
// Netlify kaller standardeksporten, som sender inn liveDeps(); testene (test/helpers/deps.mjs) sender inn
// falske utgaver i stedet, så de aldri bruker ekte lagring, ekte SMS eller nettverket.
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

// Hvilken utrulling funksjonen hører til. Netlify gir hver funksjon context.deploy.context (Functions API,
// https://docs.netlify.com/build/functions/api/#deploy): «production» for hovedsiden, ellers «deploy-preview»,
// «branch-deploy», «preview-server», «dev» (netlify dev) eller et grennavn.
// Bare produksjon bruker den ekte timeboken og sender SMS. Forhåndsvisninger og grener har sin egen lagring
// («bookings-preview»), så en testbestilling der aldri tar en ekte tid eller får en ekte påminnelse.
// Mangler context (eldre kall, tester), regnes det som ikke-produksjon: heller en tom timebok enn ekte data.
export const isProduction = (context) => Boolean(context && context.deploy && context.deploy.context === "production");
export const PRODUCTION_STORE = "bookings";
export const PREVIEW_STORE = "bookings-preview";
export const bookingStore = (deps, context) =>
  deps.getStore({ name: isProduction(context) ? PRODUCTION_STORE : PREVIEW_STORE, consistency: "strong" });
