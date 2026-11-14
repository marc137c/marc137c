// SMS-påminnelser: går gjennom avtalene i dag og de neste to dagene og sender påminnelse til dem reminderDue()
// sier ja til. Hver SMS går i tre konfliktsikre steg (ETag), så den aldri sendes to ganger og aldri vises som
// «sendt» uten at Sveve har bekreftet den:
//   1. krav: avtalen merkes remindedAt + reminderRun (denne kjøringens id) + reminderError «sending». To kjøringer
//      samtidig kan ikke begge få kravet. Gikk svaret på skrivingen tapt, kjenner kjøringen igjen sin egen id (F38).
//   2. send: bare før fristen og aldri om natten; ellers gis kravet tilbake og neste kjøring tar den (F39).
//   3. utfall: sendt → reminderSentAt, feilen fjernes (/admin viser «sendt» først nå).
//      Sikkert ikke sendt (avvist, feil passord, HTTP-feil, ingen forbindelse) → kravet gis tilbake, så neste
//      kjøring prøver igjen, høyst MAX_FAILS ganger (F37). Ukjent (tidsavbrudd, tapt svar) → kravet beholdes og
//      feilen lagres: heller én tapt påminnelse enn to SMS. Testmodus → kravet gis tilbake og reminderTestAt
//      settes, så den ekte påminnelsen fortsatt sendes når testmodus slås av (F42).
import { randomBytes } from "node:crypto";
import { osloNow, addDays, readMonths, mutateMonth, monthOf, findItem } from "./booking-core.mjs";
import { reminderDue, reminderText, sendSms, smsConfigured, smsTestMode, quietHours } from "./sms.mjs";

export const MAX_FAILS = 8; // 4 kjøringer i døgnvinduet + 4 i 2-timersvinduet

// Feltene på avtalen for én type SMS
export const REMINDER = { claim: "remindedAt", run: "reminderRun", sent: "reminderSentAt", error: "reminderError", fails: "reminderFails", test: "reminderTestAt" };
export const SENDING = "sending"; // reminderError mens SMS-en er krevd, men ikke bekreftet sendt

// Tidsfrister, regnet fra kjøringen startet (Netlify stopper planlagte funksjoner etter 30 s):
// ingen ny avtale etter budgetMs, og aldri et kall til Sveve etter sendDeadlineMs (Sveve venter høyst 8 s).
export const BUDGET_MS = 10000;
export const SEND_DEADLINE_MS = 20000;

const findIn = (doc, id) => doc.items.find((i) => i.id === id);
const unclaim = (cur, f) => { delete cur[f.claim]; delete cur[f.run]; if (cur[f.error] === SENDING) delete cur[f.error]; };

// Steg 1. Svarer { ok, item } når denne kjøringen har kravet, ellers { error }.
async function claim(store, it, f, due, run) {
  const take = (doc) => {
    const cur = findIn(doc, it.id);
    if (cur && cur[f.run] === run.id) return { ok: true, item: { ...cur }, noWrite: true }; // vår egen skriving ble lagret
    if (!cur || !due(cur)) return { error: "skip", status: 409 }; // endret, flyttet eller sendt i mellomtiden
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

// Steg 3. Lagrer utfallet på avtalen, men bare hvis kravet fortsatt er vårt.
function record(store, it, f, run, outcome) {
  return mutateMonth(store, monthOf(it.date), (doc) => {
    const cur = findIn(doc, it.id);
    if (!cur || cur[f.run] !== run.id) return { error: "gone", status: 409 };
    const at = new Date(run.clock()).toISOString();
    if (outcome.kind === "sent") { cur[f.sent] = at; delete cur[f.error]; }
    else if (outcome.kind === "test") { unclaim(cur, f); cur[f.test] = at; }
    else if (outcome.kind === "deferred") unclaim(cur, f);
    else if (outcome.kind === "unknown") cur[f.error] = outcome.error;
    else { // sikkert ikke sendt: prøv igjen ved neste kjøring, høyst MAX_FAILS ganger
      cur[f.error] = outcome.error;
      cur[f.fails] = (cur[f.fails] || 0) + 1;
      if (cur[f.fails] < MAX_FAILS) { delete cur[f.claim]; delete cur[f.run]; }
    }
    return { ok: true };
  });
}

const outcomeOf = (r) => (r.ok ? { kind: r.test ? "test" : "sent" } : { kind: r.maybeSent ? "unknown" : "failed", error: r.error });

// Krav → send → utfall for én avtale. Svarer utfallet: sent | test | failed | unknown | deferred | skip.
async function deliver(store, env, it, { f, due, to, text }, run) {
  const c = await claim(store, it, f, due, run);
  if (c.error) return "skip";
  const now = run.clock();
  if (now - run.startedAt > run.sendDeadlineMs || quietHours(osloNow(new Date(now)))) {
    await record(store, it, f, run, { kind: "deferred" }); // for sent: neste kjøring tar den
    return "deferred";
  }
  const r = await sendSms(env, to(c.item), text(c.item), run.fetchFn);
  const outcome = outcomeOf(r);
  if (!r.ok) console.error("SMS feilet:", it.id, r.error);
  await record(store, it, f, run, outcome);
  return outcome.kind;
}

export async function runReminders(store, env, {
  now = new Date(), due = reminderDue, fetchFn = fetch, budgetMs = BUDGET_MS, sendDeadlineMs = SEND_DEADLINE_MS, clock = Date.now,
} = {}) {
  if (!smsConfigured(env)) return { sent: 0, failed: 0, skipped: "not_configured" };
  const run = { id: randomBytes(6).toString("hex"), stamp: now.toISOString(), startedAt: clock(), clock, fetchFn, sendDeadlineMs };
  const oslo = osloNow(now);
  const nowMs = now.getTime();
  const test = smsTestMode(env);
  const reminder = {
    f: REMINDER,
    due: (it) => due(it, oslo, nowMs) && (it[REMINDER.fails] || 0) < MAX_FAILS && !(test && it[REMINDER.test]),
    to: (it) => it.phone,
    text: (it) => reminderText(it, oslo.date),
  };
  const items = await readMonths(store, oslo.date, addDays(oslo.date, 2));
  const count = { sent: 0, failed: 0, unknown: 0, test: 0, deferred: 0 };
  for (const it of items) {
    if (!reminder.due(it)) continue;
    if (clock() - run.startedAt > budgetMs) { count.deferred++; continue; }
    const kind = await deliver(store, env, it, reminder, run);
    if (kind in count) count[kind]++;
  }
  const out = { sent: count.sent, failed: count.failed };
  for (const k of ["unknown", "test", "deferred"]) if (count[k]) out[k] = count[k];
  return out;
}
