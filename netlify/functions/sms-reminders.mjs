// Planlagt funksjon: sender SMS-påminnelser hvert 15. minutt.
// Netlify kjører planlagte funksjoner bare på den publiserte nettsiden (ikke på forhåndsvisninger).
import { liveDeps } from "../lib/runtime.mjs";
import { runReminders } from "../lib/reminders.mjs";

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring, miljø, klokke og fetch)
export async function handle(req, context, deps) {
  try {
    const store = deps.getStore({ name: "bookings", consistency: "strong" });
    const r = await runReminders(store, deps.env, { now: deps.now(), fetchFn: deps.fetch, clock: () => deps.now().getTime() });
    if (r.sent || r.failed) console.log("SMS-påminnelser:", r);
  } catch (err) {
    console.error("SMS-påminnelser:", err);
  }
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { schedule: "*/15 * * * *" };
