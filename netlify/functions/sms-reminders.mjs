// Planlagt funksjon: sender SMS-påminnelser hvert 15. minutt.
// Netlify kjører planlagte funksjoner bare på den publiserte nettsiden (ikke på forhåndsvisninger).
import { getStore } from "@netlify/blobs";
import { runReminders } from "../lib/reminders.mjs";

export default async () => {
  try {
    const r = await runReminders(getStore({ name: "bookings", consistency: "strong" }), process.env);
    if (r.sent || r.failed) console.log("SMS-påminnelser:", r);
  } catch (err) {
    console.error("SMS-påminnelser:", err);
  }
};

export const config = { schedule: "*/15 * * * *" };
