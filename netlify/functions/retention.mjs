// Daglig opprydding (planlagt funksjon, F36): sletter det reglene i netlify/lib/store-keys.mjs sier skal bort.
//  - timebøkene («bookings» og «bookings-preview»): hver avtale RETENTION_DAYS dager etter datoen (også avlyste, og
//    datoer som ikke finnes); et månedsdokument som blir tomt, slettes når hele måneden er eldre enn grensen;
//  - tellerne rl/* når nyeste treff (og et eventuelt pausevarsel) er over et døgn gammelt; rl/secret blir;
//  - de gamle innloggingstellerne auth/ip/* og auth/all (auth/epoch blir);
//  - besøksstatistikk (d/ÅÅÅÅ-MM-DD) eldre enn STATS_KEEP_DAYS;
//  - en Instagram-tilkobling som aldri ble fullført (oauth-state-*), etter et døgn.
// På en gammel permalenke (isRetiredDeploy) gjør den ingenting. Utenfor produksjon rydder den bare
// forhåndsvisningenes lagring. Feil i ett dokument stopper ikke resten; neste kjøring gjør det ferdig.
// Planen står i denne fila (Netlify: planlagte funksjoner kjører bare på den publiserte utrullingen).
import { liveDeps, isProduction, isRetiredDeploy, retiredResponse } from "../lib/runtime.mjs";
import { addDays, isDate, osloNow, mutateJSON, EPOCH_KEY } from "../lib/booking-core.mjs";
import { SECRET_KEY } from "../lib/limits.mjs";
import { RETENTION_DAYS, COUNTER_MAX_AGE_MS, STATS_KEEP_DAYS, OAUTH_STATE_MAX_AGE_MS } from "../lib/store-keys.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const MONTH_RE = /^m\/(\d{4})-(\d{2})$/;
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // m: 1–12

async function listKeys(store) {
  const keys = [];
  for await (const page of store.list({ paginate: true })) for (const b of page.blobs) keys.push(b.key);
  return keys;
}

// Sletter key bare hvis den fortsatt har samme ETag som da vi bestemte oss (noen kan ha skrevet i mellomtiden)
async function deleteIfUnchanged(store, key, etag) {
  const meta = await store.getMetadata(key);
  if (!meta) return false;
  if (etag !== undefined && meta.etag !== etag) return false;
  await store.delete(key);
  return true;
}

async function cleanBookings(store, { today, nowMs }, tally) {
  const cutoff = addDays(today, -RETENTION_DAYS);
  for (const key of await listKeys(store)) {
    try {
      const month = MONTH_RE.exec(key);
      if (month) {
        let removed = 0;
        const r = await mutateJSON(store, key, (d) => (d && Array.isArray(d.items) ? d : { items: [] }), (doc) => {
          const keep = doc.items.filter((i) => i && isDate(i.date) && i.date >= cutoff);
          removed = doc.items.length - keep.length;
          if (!removed) return { ok: true, noWrite: true };
          doc.items = keep;
          return { ok: true };
        });
        if (r.error) throw new Error(r.error);
        if (removed) tally.changed++;
        tally.deleted += removed;
        // Et tomt dokument for en måned som er helt eldre enn grensen: ingen kunde kan bestille der lenger
        if (lastDayOf(Number(month[1]), Number(month[2])) < cutoff) {
          const cur = await store.getWithMetadata(key, { type: "json" });
          if (cur && cur.data && Array.isArray(cur.data.items) && cur.data.items.length === 0 && await deleteIfUnchanged(store, key, cur.etag)) tally.deleted++;
        }
        continue;
      }
      if (key === SECRET_KEY || key === EPOCH_KEY) continue;
      if (key.startsWith("rl/")) {
        const cur = await store.getWithMetadata(key, { type: "json" });
        if (!cur) continue;
        const doc = cur.data && typeof cur.data === "object" ? cur.data : {};
        const times = (Array.isArray(doc.hits) ? doc.hits : []).map((h) => (h && Number.isFinite(h.t) ? h.t : -Infinity));
        if (Number.isFinite(doc.alertedAt)) times.push(doc.alertedAt);
        const newest = times.length ? Math.max(...times) : -Infinity;
        if (nowMs - newest > COUNTER_MAX_AGE_MS && await deleteIfUnchanged(store, key, cur.etag)) tally.deleted++;
        continue;
      }
      if (key.startsWith("auth/")) { // de gamle innloggingstellerne (før 2c): auth/ip/<adresse>, auth/all
        await store.delete(key);
        tally.deleted++;
      }
    } catch (err) {
      tally.errors++;
      console.error("Opprydding: kunne ikke rydde et dokument:", err && err.name); // aldri nøkkelen (kan være en gammel adresse)
    }
  }
}

async function cleanStats(store, { today }, tally) {
  const cutoff = addDays(today, -STATS_KEEP_DAYS);
  for (const key of await listKeys(store)) {
    const m = /^d\/(\d{4}-\d{2}-\d{2})$/.exec(key);
    if (!m || m[1] >= cutoff) continue;
    try { await store.delete(key); tally.deleted++; } catch (err) { tally.errors++; console.error("Opprydding: statistikk:", err && err.name); }
  }
}

async function cleanSocial(store, { nowMs }, tally) {
  for (const key of await listKeys(store)) {
    if (!key.startsWith("oauth-state-")) continue;
    try {
      const cur = await store.getWithMetadata(key, { type: "json" });
      const at = cur && cur.data && Number.isFinite(cur.data.created_at) ? cur.data.created_at : -Infinity;
      if (nowMs - at > OAUTH_STATE_MAX_AGE_MS && await deleteIfUnchanged(store, key, cur && cur.etag)) tally.deleted++;
    } catch (err) {
      tally.errors++;
      console.error("Opprydding: Instagram-tilkobling:", err && err.name);
    }
  }
}

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring og klokke)
export async function handle(req, context, deps) {
  if (isRetiredDeploy(context)) return retiredResponse();
  const now = deps.now();
  const at = { today: osloNow(now).date, nowMs: now.getTime() };
  const live = isProduction(context);
  const tally = { deleted: 0, changed: 0, errors: 0 };
  const steps = [
    ...(live ? ["bookings"] : []).map((name) => () => cleanBookings(deps.getStore({ name, consistency: "strong" }), at, tally)),
    () => cleanBookings(deps.getStore({ name: "bookings-preview", consistency: "strong" }), at, tally),
    ...(live ? ["stats"] : []).map((name) => () => cleanStats(deps.getStore({ name, consistency: "strong" }), at, tally)),
    () => cleanStats(deps.getStore({ name: "stats-preview", consistency: "strong" }), at, tally),
    ...(live ? [() => cleanSocial(deps.getStore({ name: "social", consistency: "strong" }), at, tally)] : []),
  ];
  for (const step of steps) {
    try { await step(); } catch (err) { tally.errors++; console.error("Opprydding: kunne ikke lese en lagring:", err && err.name); }
  }
  console.log(`Opprydding: ${tally.deleted} slettet, ${tally.changed} dokumenter endret, ${tally.errors} feil`);
  return json(tally, tally.errors ? 500 : 200);
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { schedule: "@daily" };
