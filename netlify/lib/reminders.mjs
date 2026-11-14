// SMS-utboksen: bekreftelser til kunden og varsel til frisøren (sendes med en gang fra bookings.mjs, ellers av
// neste kjøring) og påminnelser før timen (planlagt kjøring hvert 15. minutt, sms-reminders.mjs).
// Hver SMS går i konfliktsikre steg (ETag), så den aldri sendes to ganger og aldri vises som «sendt» uten at Sveve
// har bekreftet den:
//   1. krav: avtalen merkes f.claim + f.run (denne kjøringens id) + f.error «sending». To kjøringer samtidig kan
//      ikke begge få kravet. Gikk svaret på skrivingen tapt, kjenner kjøringen igjen sin egen id (F38).
//   2. tak: en plass i nummerets SMS-logg (limits.mjs: høyst 3 per kundenummer per døgn til sammen, F3/F16;
//      høyst 40 varsler per døgn til frisøren).
//   3. send: bare før fristen og aldri 21–08; ellers gis kravet og plassen tilbake og neste kjøring tar den (F39).
//   4. utfall: sendt → f.sent, feilen fjernes (/admin viser «sendt» først nå).
//      Sikkert ikke sendt (avvist, feil passord, HTTP-feil, ingen forbindelse) → kravet og plassen gis tilbake, så
//      neste kjøring prøver igjen, høyst MAX_FAILS ganger (F37). Ukjent (tidsavbrudd, tapt svar) → kravet beholdes
//      og feilen lagres: heller én tapt SMS enn to. Testmodus → ingen SMS, kravet gis tilbake og f.test settes, så
//      en påminnelse fortsatt sendes ekte når testmodus slås av (F42); en bekreftelse sendes ikke i ettertid.
import { randomBytes } from "node:crypto";
import { osloNow, addDays, readMonths, mutateMonth, monthOf, findItem, CONFIG } from "./booking-core.mjs";
import {
  reminderDue, reminderText, confirmText, shopText, shopNumber, sendSms, smsConfigured, smsTestMode, quietHours, minutesUntil, norwegianMobile,
} from "./sms.mjs";
import { reserveSms, releaseSms } from "./limits.mjs";

export const MAX_FAILS = 8; // påminnelse: 4 kjøringer i døgnvinduet + 4 i 2-timersvinduet
const DAY = 24 * 60 * 60 * 1000;

// Feltene på avtalen for hver type SMS. pending = «skal sendes» (settes når nettbestillingen lagres).
export const REMINDER = { claim: "remindedAt", run: "reminderRun", sent: "reminderSentAt", error: "reminderError", fails: "reminderFails", test: "reminderTestAt" };
export const SHOP = { pending: "shopPending", claim: "shopSmsAt", run: "shopRun", sent: "shopSentAt", error: "shopError", fails: "shopFails", test: "shopTestAt" };
export const CONFIRM = { pending: "confirmPending", claim: "confirmAt", run: "confirmRun", sent: "confirmSentAt", error: "confirmError", fails: "confirmFails", test: "confirmTestAt" };
export const SENDING = "sending"; // f.error mens SMS-en er krevd, men ikke bekreftet sendt

// Tidsfrister, regnet fra kjøringen startet (Netlify stopper planlagte funksjoner etter 30 s):
// ingen ny avtale etter budgetMs, og aldri et kall til Sveve etter sendDeadlineMs (Sveve venter høyst 8 s).
export const BUDGET_MS = 10000;
export const SEND_DEADLINE_MS = 20000;
// Mens kunden venter på svar (bookings.mjs, Netlify gir 10 s): send bare innen 3 s, og vent høyst 5 s på Sveve
export const INLINE = { sendDeadlineMs: 3000, timeoutMs: 5000 };

// Typene SMS utboksen sender, med regelen for når hver er klar
function jobsFor(env, oslo, nowMs, due = reminderDue) {
  const test = smsTestMode(env);
  const open = (f, it) => !it[f.claim] && (it[f.fails] || 0) < MAX_FAILS && !(test && it[f.test]);
  return {
    confirm: {
      kind: "confirm", f: CONFIRM,
      due: (it) => it.type === "booking" && it.status !== "cancelled" && it[CONFIRM.pending] === true && open(CONFIRM, it) &&
        Boolean(norwegianMobile(it.phone)) && nowMs - Date.parse(it.createdAt || 0) < DAY && minutesUntil(it, oslo) > 0 && !quietHours(oslo),
      to: (it) => it.phone,
      text: (it) => confirmText(it, oslo.date),
    },
    // Varsel til frisøren om en ny nettbestilling (eier: én SMS per bestilling, til SHOP_SMS_TO)
    shop: {
      kind: "shop", f: SHOP,
      due: (it) => it.type === "booking" && it.status !== "cancelled" && it[SHOP.pending] === true && open(SHOP, it) &&
        Boolean(shopNumber(env)) && nowMs - Date.parse(it.createdAt || 0) < DAY && minutesUntil(it, oslo) > 0 && !quietHours(oslo),
      to: () => shopNumber(env),
      text: (it) => shopText(it),
    },
    reminder: {
      kind: "reminder", f: REMINDER,
      due: (it) => due(it, oslo, nowMs) && open(REMINDER, it),
      to: (it) => it.phone,
      text: (it) => reminderText(it, oslo.date),
    },
  };
}

const findIn = (doc, id) => doc.items.find((i) => i.id === id);
const unclaim = (cur, f) => { delete cur[f.claim]; delete cur[f.run]; if (cur[f.error] === SENDING) delete cur[f.error]; };

// Steg 1. Svarer { ok, item } når denne kjøringen har kravet, ellers { error }.
async function claim(store, it, job, run) {
  const { f } = job;
  const take = (doc) => {
    const cur = findIn(doc, it.id);
    if (cur && cur[f.run] === run.id) return { ok: true, item: { ...cur }, noWrite: true }; // vår egen skriving ble lagret
    if (!cur || !job.due(cur)) return { error: "skip", status: 409 }; // endret, flyttet eller sendt i mellomtiden
    cur[f.claim] = run.stamp;
    cur[f.run] = run.id;
    cur[f.error] = SENDING;
    return { ok: true, item: { ...cur } };
  };
  try {
    return await mutateMonth(store, monthOf(it.date), take);
  } catch (err) {
    // Lagringen ga opp, men skrivingen kan likevel ha landet: se etter vår egen id før vi gir opp
    const cur = await findItem(store, it.id).catch(() => null);
    if (cur && cur[f.run] === run.id) return { ok: true, item: cur };
    throw err;
  }
}

// Steg 4. Lagrer utfallet på avtalen, men bare hvis kravet fortsatt er vårt.
function record(store, it, f, run, outcome) {
  return mutateMonth(store, monthOf(it.date), (doc) => {
    const cur = findIn(doc, it.id);
    if (!cur || cur[f.run] !== run.id) return { error: "gone", status: 409 };
    const at = new Date(run.clock()).toISOString();
    if (outcome.kind === "sent") { cur[f.sent] = at; delete cur[f.error]; }
    else if (outcome.kind === "test") { unclaim(cur, f); cur[f.test] = at; if (f.pending) delete cur[f.pending]; }
    else if (outcome.kind === "deferred") unclaim(cur, f);
    else if (outcome.kind === "unknown" || outcome.kind === "limit") cur[f.error] = outcome.error; // beholdes: aldri igjen
    else { // sikkert ikke sendt: prøv igjen ved neste kjøring, høyst MAX_FAILS ganger
      cur[f.error] = outcome.error;
      cur[f.fails] = (cur[f.fails] || 0) + 1;
      if (cur[f.fails] < MAX_FAILS) { delete cur[f.claim]; delete cur[f.run]; }
    }
    return { ok: true };
  });
}

const outcomeOf = (r) => (r.ok ? { kind: r.test ? "test" : "sent" } : { kind: r.maybeSent ? "unknown" : "failed", error: r.error });
// For sent å sende nå: fristen er ute, eller SMS-en kan komme frem etter 21:00 (Sveve kan bruke opptil timeoutMs)
const tooLate = (run) => {
  const now = run.clock();
  return now - run.startedAt > run.sendDeadlineMs || quietHours(osloNow(new Date(now))) || quietHours(osloNow(new Date(now + run.timeoutMs)));
};

// Krav → tak → send → utfall for én avtale. Svarer: sent | test | failed | unknown | deferred | limit | skip.
async function deliver(store, env, it, job, run) {
  const c = await claim(store, it, job, run);
  if (c.error) return "skip";
  const { f } = job;
  const number = norwegianMobile(job.to(c.item));
  const token = `${run.id}:${job.kind}:${it.id}`;
  let seat;
  try {
    seat = await reserveSms(store, number, job.kind, run.clock(), token);
  } catch (err) {
    await record(store, it, f, run, { kind: "deferred" }).catch(() => {});
    throw err;
  }
  if (seat.error) { await record(store, it, f, run, { kind: "deferred" }); return "deferred"; }
  if (!seat.ok) {
    console.warn("SMS-tak nådd, sendes ikke:", it.id, job.kind);
    await record(store, it, f, run, { kind: "limit", error: "limit" });
    return "limit";
  }
  let outcome;
  if (tooLate(run)) outcome = { kind: "deferred" };
  else {
    const r = await sendSms(env, job.to(c.item), job.text(c.item), run.fetchFn, { timeoutMs: run.timeoutMs });
    if (!r.ok) console.error(`SMS (${job.kind}) feilet:`, it.id, r.error);
    outcome = outcomeOf(r);
  }
  await record(store, it, f, run, outcome);
  if (outcome.kind !== "sent" && outcome.kind !== "unknown") {
    await releaseSms(store, number, token).catch((err) => console.error("SMS-logg:", err && err.message));
  }
  return outcome.kind;
}

function newRun(now, { clock = Date.now, fetchFn = fetch, sendDeadlineMs = SEND_DEADLINE_MS, timeoutMs = 8000 } = {}) {
  return { id: randomBytes(6).toString("hex"), stamp: now.toISOString(), startedAt: clock(), clock, fetchFn, sendDeadlineMs, timeoutMs };
}

// Bekreftelsen til kunden og varselet til frisøren rett etter at nettbestillingen er lagret (bookings.mjs), begge
// samtidig så kunden ikke venter på to SMS etter hverandre. Klarer en av dem det ikke innen fristen, eller er det
// natt, blir den liggende og sendes av neste planlagte kjøring (fra kl. 08). Svarer { confirm, shop } med utfallene.
export async function sendBookingSms(store, env, item, { now = new Date(), clock = Date.now, fetchFn = fetch } = {}) {
  const oslo = osloNow(now);
  const jobs = jobsFor(env, oslo, now.getTime());
  const one = (job) => (job.due(item) ? deliver(store, env, item, job, newRun(now, { clock, fetchFn, ...INLINE }))
    : Promise.resolve(item[job.f.pending] && quietHours(oslo) ? "deferred" : "skip"));
  const [confirm, shop] = await Promise.all([one(jobs.confirm), one(jobs.shop)].map((p) => p.catch((err) => {
    console.error("SMS:", item.id, err && err.message);
    return "failed";
  })));
  return { confirm, shop };
}

export async function runReminders(store, env, {
  now = new Date(), due = reminderDue, fetchFn = fetch, budgetMs = BUDGET_MS, sendDeadlineMs = SEND_DEADLINE_MS, clock = Date.now,
} = {}) {
  if (!smsConfigured(env)) return { sent: 0, failed: 0, skipped: "not_configured" };
  const run = newRun(now, { clock, fetchFn, sendDeadlineMs });
  const oslo = osloNow(now);
  const jobs = jobsFor(env, oslo, now.getTime(), due);
  const count = { sent: 0, failed: 0, unknown: 0, test: 0, deferred: 0, limit: 0 };
  // Bekreftelser som venter (nattbestillinger, feil) først, så påminnelser for i dag og de neste to dagene
  const items = await readMonths(store, oslo.date, addDays(oslo.date, CONFIG.maxDays));
  const work = [
    ...items.filter((it) => jobs.shop.due(it)).map((it) => [it, jobs.shop]),
    ...items.filter((it) => jobs.confirm.due(it)).map((it) => [it, jobs.confirm]),
    ...items.filter((it) => it.date >= oslo.date && it.date <= addDays(oslo.date, 2) && jobs.reminder.due(it)).map((it) => [it, jobs.reminder]),
  ];
  for (const [it, job] of work) {
    if (clock() - run.startedAt > budgetMs) { count.deferred++; continue; }
    const kind = await deliver(store, env, it, job, run);
    if (kind in count) count[kind]++;
  }
  const out = { sent: count.sent, failed: count.failed };
  for (const k of ["unknown", "test", "deferred", "limit"]) if (count[k]) out[k] = count[k];
  return out;
}
