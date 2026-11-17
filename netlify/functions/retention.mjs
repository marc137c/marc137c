// Daglig opprydding (planlagt funksjon, F36): sletter det reglene i netlify/lib/store-keys.mjs sier skal bort.
//  - timebøkene («bookings» og «bookings-preview»): hver avtale RETENTION_DAYS dager etter datoen (også avlyste, og
//    datoer som ikke finnes); et månedsdokument som blir tomt, slettes når hele måneden er eldre enn grensen;
//  - i tellerne (rl/*, et fast sett dokumenter): hvert treff og pausevarsel som er over et døgn gammelt; rl/secret
//    blir; tellerdokumenter fra eldre utgaver (ett per klient eller nummer) og de gamle innloggingstellerne auth/ip/*
//    og auth/all slettes uten å leses (auth/epoch blir);
//  - besøksstatistikk (d/ÅÅÅÅ-MM-DD) eldre enn STATS_KEEP_DAYS;
//  - en Instagram-tilkobling som aldri ble fullført (oauth-state-*), etter et døgn.
// På en gammel permalenke (isRetiredDeploy) gjør den ingenting. Med en annen utrulling enn produksjon (f.eks.
// netlify dev) rydder den bare forhåndsvisningenes lagring. Feil i ett dokument stopper ikke resten; neste kjøring gjør det ferdig.
// Tidsbudsjett (runde 2): Netlify stopper en planlagt funksjon etter 30 s (docs/contracts/netlify.md). Ny jobb startes
// bare de første BUDGET_MS, høyst PARALLEL kall om gangen; det som ikke ble gjort, står i loggen og tas neste natt.
// Runde 3: hvert steg lister bare sitt eget prefiks, side for side, og leser ingen ny side etter fristen, så en lang
// liste aldri sulter ut et steg før seg. Rekkefølgen: timebøkenes måneder (personopplysninger), det som er lite og
// begrenset (statistikk, Instagram), tellerne (et fast sett, uansett trafikk: limits.mjs) og til slutt rester fra
// eldre utgaver, den eneste mengden som kan være stor, og som ikke lenger vokser.
// Planen står i denne fila (Netlify: planlagte funksjoner kjører bare på den publiserte utrullingen).
import { liveDeps, isProduction, isRetiredDeploy, retiredResponse } from "../lib/runtime.mjs";
import { addDays, isDate, osloNow, mutateJSON, EPOCH_KEY } from "../lib/booking-core.mjs";
import { SECRET_KEY, ALL_KEY, LOGIN_ALL_KEY, BUCKET_RE } from "../lib/limits.mjs";
import { RETENTION_DAYS, COUNTER_MAX_AGE_MS, STATS_KEEP_DAYS, OAUTH_STATE_MAX_AGE_MS } from "../lib/store-keys.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const MONTH_RE = /^m\/(\d{4})-(\d{2})$/;
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // m: 1–12
export const BUDGET_MS = 20 * 1000; // ny jobb startes bare så lenge; Netlify stopper funksjonen ved 30 s
export const PARALLEL = 10;

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

// En teller (en bøtte eller en felles teller): skrives på nytt uten treffene og pausevarselet som er over
// COUNTER_MAX_AGE_MS gamle. Én lesing, og en betinget skriving bare når noe gikk ut: et treff skrevet samtidig går
// aldri tapt, og dokumentet slettes aldri (settet er fast, en tom bøtte holder ingenting).
const counterDoc = (d) => (d === null || d === undefined ? { missing: true }
  : d && typeof d === "object" && !Array.isArray(d) ? d : { broken: true });
async function cleanCounter(store, key, nowMs, tally) {
  let dropped = 0;
  const r = await mutateJSON(store, key, counterDoc, (doc) => {
    dropped = 0;
    if (doc.missing) return { ok: true, noWrite: true };
    const fresh = (t) => Number.isFinite(t) && nowMs - t <= COUNTER_MAX_AGE_MS;
    const hits = Array.isArray(doc.hits) ? doc.hits : [];
    const keep = hits.filter((h) => h && typeof h === "object" && fresh(h.t));
    const oldAlert = "alertedAt" in doc && !fresh(doc.alertedAt);
    dropped = hits.length - keep.length + (oldAlert ? 1 : 0);
    if (!dropped && Array.isArray(doc.hits) && !doc.broken) return { ok: true, noWrite: true };
    delete doc.broken;
    doc.hits = keep;
    if (oldAlert) delete doc.alertedAt;
    return { ok: true };
  });
  if (r.error) throw new Error(r.error);
  if (dropped) { tally.changed++; tally.deleted += dropped; }
}

// Jobben for en nøkkel under hvert prefiks (null: ingenting å gjøre). Hvert steg lister bare sitt eget prefiks.
const deleteJob = (store, tally, what, key) => job(tally, what, async () => { await store.delete(key); tally.deleted++; });
const statsJob = (store, { today }, tally) => (key) => {
  const m = /^d\/(\d{4}-\d{2}-\d{2})$/.exec(key);
  return m && m[1] < addDays(today, -STATS_KEEP_DAYS) ? deleteJob(store, tally, "statistikk", key) : null;
};
const socialJob = (store, { nowMs }, tally) => (key) => job(tally, "Instagram-tilkobling", async () => {
  const data = await store.get(key, { type: "json" });
  const at = data && Number.isFinite(data.created_at) ? data.created_at : -Infinity;
  if (data !== null && data !== undefined && nowMs - at > OAUTH_STATE_MAX_AGE_MS) { await store.delete(key); tally.deleted++; }
});
const monthJob = (store, { today }, tally) => (key) => {
  const month = MONTH_RE.exec(key);
  return month ? job(tally, "en måned", () => cleanMonth(store, key, month, addDays(today, -RETENTION_DAYS), tally)) : null;
};
const counterJob = (store, { nowMs }, tally) => (key) => job(tally, "en teller", () => cleanCounter(store, key, nowMs, tally));
// Rester fra eldre utgaver, som ingen kode skriver lenger: et tellerdokument per klient eller nummer
// (rl/ip/<hash>, rl/phone/<hash>, rl/login/ip/<hash>) og de gamle innloggingstellerne auth/ip/<adresse> og auth/all.
// Slettes uten å leses (ett kall).
const isCurrent = (key) => key === SECRET_KEY || key === EPOCH_KEY || key === ALL_KEY || key === LOGIN_ALL_KEY || BUCKET_RE.test(key);
const leftoverJob = (store, tally) => (key) => (isCurrent(key) ? null : deleteJob(store, tally, "en gammel teller", key));

// Lister nøklene under prefix side for side, men leser ingen ny side etter until (høyst fristen), og kjører så
// jobbene. Listingen teller med i budsjettet; er den ikke ferdig, telles det som arbeid igjen. Ingenting slettes mens
// listen leses (hvordan en markør oppfører seg da, sier ikke Netlify), og en lang liste får bare halve tiden som er
// igjen, så hver natt også sletter noe av den.
async function sweep(store, prefix, toJob, run, tally, { half = false } = {}) {
  const until = half ? run.now() + (run.deadline - run.now()) / 2 : run.deadline;
  const keys = [];
  const pages = store.list({ prefix, paginate: true })[Symbol.asyncIterator]();
  for (;;) {
    if (run.now() >= until) { tally.unfinished++; break; }
    const page = await pages.next();
    if (page.done) break;
    for (const b of page.value.blobs) keys.push(b.key);
  }
  tally.unfinished += await pool(keys.map(toJob).filter(Boolean), run);
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
  // En lagring som ikke kan listes, stopper ikke resten
  const swept = async (name, prefix, toJob, opts) => {
    const s = store(name);
    try { await sweep(s, prefix, toJob(s), run, tally, opts); } catch (err) {
      tally.errors++;
      console.error("Opprydding: kunne ikke lese en lagring:", err && err.name);
    }
  };
  const books = [...(live ? ["bookings"] : []), "bookings-preview"];
  // 1. timebøkene: månedene (personopplysninger) først
  for (const name of books) await swept(name, "m/", (s) => monthJob(s, at, tally));
  // 2. det som er lite og begrenset: statistikk og Instagram-tilkoblinger
  for (const name of [...(live ? ["stats"] : []), "stats-preview"]) await swept(name, "d/", (s) => statsJob(s, at, tally));
  if (live) await swept("social", "oauth-state-", (s) => socialJob(s, at, tally));
  // 3. tellerne: et fast sett dokumenter (limits.mjs), så dette steget er like stort uansett trafikk: bøttene (høyst
  // 3 x BUCKETS, én listeside) og de to felles tellerne
  for (const name of books) {
    await swept(name, "rl/b/", (s) => (key) => (BUCKET_RE.test(key) ? counterJob(s, at, tally)(key) : null));
    tally.unfinished += await pool([ALL_KEY, LOGIN_ALL_KEY].map(counterJob(store(name), at, tally)), run);
  }
  // 4. rester fra eldre utgaver (vokser ikke lenger)
  for (const name of books) for (const prefix of ["rl/", "auth/"]) await swept(name, prefix, (s) => leftoverJob(s, tally), { half: true });
  if (tally.unfinished) console.log(`Opprydding: stoppet etter ${BUDGET_MS / 1000} s med minst ${tally.unfinished} dokumenter igjen; neste kjøring fortsetter`);
  console.log(`Opprydding: ${tally.deleted} slettet, ${tally.changed} dokumenter endret, ${tally.errors} feil`);
  return json(tally, tally.errors ? 500 : 200);
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { schedule: "@daily" };
