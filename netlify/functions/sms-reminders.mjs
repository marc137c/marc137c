// Planlagt funksjon: sender SMS-påminnelser hvert 15. minutt.
// Netlify kjører planlagte funksjoner bare på den publiserte nettsiden (ikke på forhåndsvisninger), så den
// leser alltid den ekte timeboken. Sier context likevel at dette ikke er produksjon (f.eks. netlify dev),
// gjør den ingenting: bare produksjon sender SMS.
import { liveDeps, isProduction, PRODUCTION_STORE } from "../lib/runtime.mjs";
import { runReminders } from "../lib/reminders.mjs";

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring, miljø, klokke og fetch)
export async function handle(req, context, deps) {
  if (context && context.deploy && context.deploy.context && !isProduction(context)) return;
  try {
    const store = deps.getStore({ name: PRODUCTION_STORE, consistency: "strong" });
    const r = await runReminders(store, deps.env, { now: deps.now(), fetchFn: deps.fetch, clock: () => deps.now().getTime() });
    if (r.sent || r.failed) console.log("SMS-påminnelser:", r);
  } catch (err) {
    console.error("SMS-påminnelser:", err);
  }
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { schedule: "*/15 * * * *" };
