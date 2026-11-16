// Daglig opprydding (planlagt funksjon, F36): sletter det reglene i netlify/lib/store-keys.mjs sier skal bort.
//  - timebøkene («bookings» og «bookings-preview»): hver avtale RETENTION_DAYS dager etter datoen (også avlyste, og
//    datoer som ikke finnes); et månedsdokument som blir tomt, slettes når hele måneden er eldre enn grensen;
//  - tellerne rl/* når nyeste treff (og et eventuelt pausevarsel) er over et døgn gammelt; rl/secret blir;
//  - de gamle innloggingstellerne auth/ip/* og auth/all (auth/epoch blir);
//  - besøksstatistikk (d/ÅÅÅÅ-MM-DD) eldre enn STATS_KEEP_DAYS;
//  - en Instagram-tilkobling som aldri ble fullført (oauth-state-*), etter et døgn.
// På en gammel permalenke (isRetiredDeploy) gjør den ingenting. Med en annen utrulling enn produksjon (f.eks.
// netlify dev) rydder den bare forhåndsvisningenes lagring. Feil i ett dokument stopper ikke resten; neste kjøring gjør det ferdig.
// Tidsbudsjett (runde 2): Netlify stopper en planlagt funksjon etter 30 s (docs/contracts/netlify.md). Ny jobb startes
// bare de første BUDGET_MS, høyst PARALLEL kall om gangen; det som ikke ble gjort, står i loggen og tas neste natt.
// Rekkefølgen: timebøkenes måneder (personopplysninger), så det som er lite og begrenset (statistikk, Instagram), og
// til slutt tellerne, den eneste mengden en fremmed kan blåse opp, så den aldri sulter ut de andre.
// Planen står i denne fila (Netlify: planlagte funksjoner kjører bare på den publiserte utrullingen).
import { liveDeps, isProduction, isRetiredDeploy, retiredResponse } from "../lib/runtime.mjs";
import { addDays, isDate, osloNow, mutateJSON, EPOCH_KEY } from "../lib/booking-core.mjs";
import { SECRET_KEY } from "../lib/limits.mjs";
import { RETENTION_DAYS, COUNTER_MAX_AGE_MS, STATS_KEEP_DAYS, OAUTH_STATE_MAX_AGE_MS } from "../lib/store-keys.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const MONTH_RE = /^m\/(\d{4})-(\d{2})$/;
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // m: 1–12
export const BUDGET_MS = 20 * 1000; // ny jobb startes bare så lenge; Netlify stopper funksjonen ved 30 s
export const PARALLEL = 10;

async function listKeys(store) {
  const keys = [];
  for await (const page of store.list({ paginate: true })) for (const b of page.blobs) keys.push(b.key);
  return keys;
}

// Kjører jobbene med høyst PARALLEL om gangen, og starter ingen ny etter fristen. Svarer hvor mange som ikke ble startet.
async function pool(jobs, run) {
  let next = 0, skipped = 0;
  const worker = async () => {
    while (next < jobs.length) {
      if (run.now() >= run.deadline) { skipped += jobs.length - next; next = jobs.length; return; }
      await jobs[next++]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
  return skipped;
}
// Én jobb: en feil telles og stopper ingenting annet
const job = (tally, what, fn) => async () => {
  try { await fn(); } catch (err) {
    tally.errors++;
    console.error(`Opprydding: ${what}:`, err && err.name); // aldri nøkkelen (kan være en gammel adresse)
  }
};

// En måned i en timebok: avtaler eldre enn grensen går; en måned som er helt eldre enn grensen og blir tom, slettes
// i sin helhet (uten å skrives tom først)
async function cleanMonth(store, key, month, cutoff, tally) {
  const whole = lastDayOf(Number(month[1]), Number(month[2])) < cutoff;
  let removed = 0, empty = false;
  const r = await mutateJSON(store, key, (d) => (d && Array.isArray(d.items) ? d : { items: [] }), (doc) => {
    const keep = doc.items.filter((i) => i && isDate(i.date) && i.date >= cutoff);
    removed = doc.items.length - keep.length;
    empty = keep.length === 0;
    if (whole && empty) return { ok: true, noWrite: true }; // hele dokumentet slettes under
    if (!removed) return { ok: true, noWrite: true };
    doc.items = keep;
    return { ok: true };
  });
  if (r.error) throw new Error(r.error);
  if (whole && empty) {
    await store.delete(key);
    if (removed) tally.changed++;
    tally.deleted += removed + 1;
    return;
  }
  if (removed) tally.changed++;
  tally.deleted += removed;
}

// En teller: slettes når nyeste treff (og et eventuelt pausevarsel) er over COUNTER_MAX_AGE_MS gammelt. To kall,
// lesing og sletting (sletting kan ikke være betinget i Netlify Blobs; et treff skrevet etter lesingen er nytt, og
// slik en teller er uansett ikke gammel ved neste kjøring).
async function cleanCounter(store, key, nowMs, tally) {
  const data = await store.get(key, { type: "json" });
  if (data === null || data === undefined) return;
  const doc = typeof data === "object" ? data : {};
  const times = (Array.isArray(doc.hits) ? doc.hits : []).map((h) => (h && Number.isFinite(h.t) ? h.t : -Infinity));
  if (Number.isFinite(doc.alertedAt)) times.push(doc.alertedAt);
  const newest = times.length ? Math.max(...times) : -Infinity;
  if (nowMs - newest <= COUNTER_MAX_AGE_MS) return;
  await store.delete(key);
  tally.deleted++;
}

async function statsJobs(store, { today }, tally) {
  const cutoff = addDays(today, -STATS_KEEP_DAYS);
  return (await listKeys(store)).filter((key) => {
    const m = /^d\/(\d{4}-\d{2}-\d{2})$/.exec(key);
    return m && m[1] < cutoff;
  }).map((key) => job(tally, "statistikk", async () => { await store.delete(key); tally.deleted++; }));
}

async function socialJobs(store, { nowMs }, tally) {
  return (await listKeys(store)).filter((key) => key.startsWith("oauth-state-")).map((key) => job(tally, "Instagram-tilkobling", async () => {
    const data = await store.get(key, { type: "json" });
    const at = data && Number.isFinite(data.created_at) ? data.created_at : -Infinity;
    if (data !== null && data !== undefined && nowMs - at > OAUTH_STATE_MAX_AGE_MS) { await store.delete(key); tally.deleted++; }
  }));
}

// Jobbene i en timebok, delt i månedene (først) og tellerne (sist)
async function bookingJobs(store, { today, nowMs }, tally) {
  const cutoff = addDays(today, -RETENTION_DAYS);
  const months = [], counters = [];
  for (const key of await listKeys(store)) {
    const month = MONTH_RE.exec(key);
    if (month) months.push(job(tally, "en måned", () => cleanMonth(store, key, month, cutoff, tally)));
    else if (key === SECRET_KEY || key === EPOCH_KEY) continue;
    else if (key.startsWith("rl/")) counters.push(job(tally, "en teller", () => cleanCounter(store, key, nowMs, tally)));
    // de gamle innloggingstellerne (før 2c): auth/ip/<adresse>, auth/all
    else if (key.startsWith("auth/")) counters.push(job(tally, "en gammel teller", async () => { await store.delete(key); tally.deleted++; }));
  }
  return { months, counters };
}

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring og klokke)
export async function handle(req, context, deps) {
  if (isRetiredDeploy(context)) return retiredResponse();
  const now = deps.now();
  const at = { today: osloNow(now).date, nowMs: now.getTime() };
  const run = { now: () => deps.now().getTime(), deadline: now.getTime() + BUDGET_MS };
  // Netlify kjører planlagte funksjoner bare på den publiserte utrullingen, så et kall uten utrullingsinfo regnes som
  // det. Reglene er de samme for alle lagringer, så det sletter uansett bare det som skal bort.
  const live = isProduction(context) || !(context && context.deploy && context.deploy.context);
  const tally = { deleted: 0, changed: 0, errors: 0, unfinished: 0 };
  const store = (name) => deps.getStore({ name, consistency: "strong" });
  const listed = async (fn) => {
    try { return await fn(); } catch (err) {
      tally.errors++;
      console.error("Opprydding: kunne ikke lese en lagring:", err && err.name);
      return null;
    }
  };
  // 1. timebøkene: månedene (personopplysninger) først
  const books = [];
  for (const name of [...(live ? ["bookings"] : []), "bookings-preview"]) {
    const b = await listed(() => bookingJobs(store(name), at, tally));
    if (b) books.push(b);
  }
  tally.unfinished += await pool([].concat(...books.map((b) => b.months)), run);
  // 2. det som er lite og begrenset: statistikk og Instagram-tilkoblinger
  const small = [];
  for (const name of [...(live ? ["stats"] : []), "stats-preview"]) small.push(...((await listed(() => statsJobs(store(name), at, tally))) || []));
  if (live) small.push(...((await listed(() => socialJobs(store("social"), at, tally))) || []));
  tally.unfinished += await pool(small, run);
  // 3. tellerne, den eneste mengden en fremmed kan blåse opp
  tally.unfinished += await pool([].concat(...books.map((b) => b.counters)), run);
  if (tally.unfinished) console.log(`Opprydding: stoppet etter ${BUDGET_MS / 1000} s med ${tally.unfinished} dokumenter igjen; neste kjøring fortsetter`);
  console.log(`Opprydding: ${tally.deleted} slettet, ${tally.changed} dokumenter endret, ${tally.errors} feil`);
  return json(tally, tally.errors ? 500 : 200);
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { schedule: "@daily" };
