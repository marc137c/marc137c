// Kjernen i bookingsystemet: regler, lagring og konfliktsikre skrivinger.
// Alle klokkeslett er minutter etter midnatt, norsk tid (Europe/Oslo). Datoer er "ÅÅÅÅ-MM-DD".
// Lagring: Netlify Blobs, ett dokument per måned (nøkkel "m/ÅÅÅÅ-MM") med alle avtaler og blokkeringer.
import { randomBytes, createHmac, createHash, timingSafeEqual, scryptSync } from "node:crypto";

// ---------- Konfigurasjon (hold i sync med HOURS i viggos-barbershop/script.js) ----------
export const CONFIG = {
  timeZone: "Europe/Oslo",
  // [åpner, stenger] i minutter. 0 = søndag.
  hours: { 0: null, 1: [600, 1080], 2: [600, 1080], 3: [600, 1080], 4: [600, 1080], 5: [600, 1080], 6: [600, 1020] },
  slotMin: 30,   // kundene kan velge starttid hvert 30. minutt
  leadMin: 60,   // i dag: tidligst én time frem i tid
  maxDays: 60,   // hvor langt frem kundene kan bestille
  // Varighet per tjeneste i minutter (navnene må være like som i bestillingsskjemaet)
  durations: {
    "Full service": 60,
    "Herreklipp": 30,
    "Herreklipp + skjeggtrim": 30,
    "Knivbarbering": 30,
    "Skjegg & line-up": 30,
    "Barneklipp": 30,
  },
  addons: ["Vask kort hår", "Vask langt hår", "Styling"],
};

// ---------- Tid og dato ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// En ekte kalenderdato: «2026-11-31» og «2027-02-29» finnes ikke (Date ruller dem over til neste måned, så de
// må gi den samme datoen tilbake for å godtas). Ellers ble de «spøkelsestimer» som dobbeltbooket 1. desember i
// kalenderen på telefonen og i varslene, men aldri viste seg i /admin.
export function isDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export const dayOfWeek = (date) => new Date(date + "T00:00:00Z").getUTCDay();
export function addDays(date, n) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const monthOf = (date) => date.slice(0, 7);

// Dato og klokkeslett akkurat nå i Norge
export function osloNow(now = new Date(), timeZone = CONFIG.timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const overlaps = (aStart, aDur, bStart, bDur) => aStart < bStart + bDur && bStart < aStart + aDur;
const active = (item) => item.status !== "cancelled";

// ---------- Lagring med optimistisk låsing ----------
const monthKey = (ym) => `m/${ym}`;

// Leser en måned, lar fn endre den, og skriver bare hvis ingen andre har skrevet i mellomtiden.
// Ved kollisjon prøves det på nytt. fn kan returnere { error, status } for å avbryte uten å skrive,
// eller et svar med noWrite: true når ingenting er endret.
export const mutateMonth = (store, ym, fn) =>
  mutateJSON(store, monthKey(ym), (data) => (data && Array.isArray(data.items) ? data : { items: [] }), fn);

// Ventetiden før neste forsøk etter en kollisjon (ekte tid). Et objekt, så testene kan sette den til 0.
export const retryDelay = { ms: (attempt) => 20 * 2 ** Math.min(attempt, 5) + Math.random() * 20 };

// Det samme for et vilkårlig JSON-dokument: init(data) gir dokumentet fn får (data = det lagrede, eller null).
// attempts: hvor mange ganger det prøves ved kollisjon (8; tellere med mange samtidige skrivere bruker flere).
export async function mutateJSON(store, key, init, fn, { attempts = 8 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const doc = init(cur ? cur.data : null);
    const result = await fn(doc);
    if (result && (result.error || result.noWrite)) return result;
    const write = await store.setJSON(key, doc, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    // Bare en skriving med ETag er bekreftet lagret. Uten ETag har lagringen feilet (5xx/401/403),
    // og da skal kunden ikke få beskjed om at timen er booket.
    if (write.modified && write.etag) return result || { ok: true };
    if (write.modified) throw new Error("Netlify Blobs bekreftet ikke lagringen (mangler ETag)");
    await new Promise((r) => setTimeout(r, retryDelay.ms(attempt)));
  }
  return { error: "Mange endringer samtidig. Prøv igjen.", status: 503 };
}

export async function readMonths(store, fromDate, toDate) {
  const months = new Set();
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) months.add(monthOf(d));
  const docs = await Promise.all([...months].map((ym) => store.get(monthKey(ym), { type: "json" })));
  return docs.flatMap((doc) => (doc && Array.isArray(doc.items) ? doc.items : []))
    .filter((i) => i.date >= fromDate && i.date <= toDate)
    .sort((a, b) => (a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1));
}

// ---------- Offentlig: ledighet ----------
// Stengte dager (eierens beslutning D4, F7/F56): ingen automatiske helligdager, men en dag Viggo har blokkert helt
// er stengt overalt. En dato er stengt når de aktive blokkeringene (type «block», ikke avlyst) til sammen dekker
// åpningstiden den ukedagen. Bestillinger stenger aldri en dag, og søndag (ingen åpningstid) står aldri på lista.
// Svarer datoene sortert. Tilfellene: test/fixtures/closed-days.mjs.
export function closedDays(items) {
  const blocks = new Map();
  for (const i of items) {
    if (!i || i.type !== "block" || !active(i) || !isDate(i.date) || !Number.isFinite(i.start) || !Number.isFinite(i.dur)) continue;
    if (!blocks.has(i.date)) blocks.set(i.date, []);
    blocks.get(i.date).push([i.start, i.start + i.dur]);
  }
  const out = [];
  for (const [date, spans] of blocks) {
    const hours = CONFIG.hours[dayOfWeek(date)];
    if (!hours) continue;
    let reached = hours[0]; // dekket fra åpning til hit
    for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
      if (a > reached) break;
      reached = Math.max(reached, b);
    }
    if (reached >= hours[1]) out.push(date);
  }
  return out.sort();
}

// Kundene ser bare opptatte tidsrom – aldri navn eller telefonnummer.
export async function getAvailability(store, now = new Date()) {
  const { date: today, minutes } = osloNow(now);
  const last = addDays(today, CONFIG.maxDays);
  const items = await readMonths(store, today, last);
  const busy = {};
  for (const i of items.filter(active)) (busy[i.date] ||= []).push([i.start, i.start + i.dur]);
  // De gamle navnene også, med den nye tjenestens varighet (F24)
  const durations = { ...CONFIG.durations };
  for (const [old, target] of Object.entries(SERVICE_ALIASES)) durations[old] = CONFIG.durations[target];
  return {
    today, nowMinutes: minutes, lastDate: last,
    hours: CONFIG.hours, slotMin: CONFIG.slotMin, leadMin: CONFIG.leadMin, maxDays: CONFIG.maxDays,
    durations, busy, closed: closedDays(items),
  };
}

// ---------- Validering ----------
// Tekst slik den lagres: kontrolltegn blir mellomrom, et ensomt surrogat blir U+FFFD, og kuttet etter max
// UTF-16-enheter deler aldri et tegn utenfor BMP (en emoji) i to.
// (Uten String.prototype.toWellFormed, som først kom i Node 20: funksjonene skal virke på alle Node-versjoner Netlify kjører.)
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
function clean(s, max) {
  let t = String(s ?? "").replace(LONE_SURROGATE, "�").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  if (/[\ud800-\udbff]$/.test(t)) t = t.slice(0, -1);
  return t.trim();
}
// Telefon: 8–15 sifre, uansett skrivemåte («409 63 911», «+47 409-63-911», «409.63.911»)
const phoneOk = (p) => { const n = String(p ?? "").replace(/\D/g, "").length; return n >= 8 && n <= 15; };
const fail = (code, error, status = 400) => ({ error, code, status });
// Tilleggene som er valgt, hvert høyst én gang og i samme rekkefølge som i CONFIG (en bestilling med 150 kopier av
// samme tillegg ble lagret slik, og varselet ble lengre enn alle andre)
const pickAddons = (list) => (Array.isArray(list) ? CONFIG.addons.filter((a) => list.includes(a)) : []);

// Gamle tjenestenavn → nye (godtas fortsatt, i tilfelle noen har den gamle siden åpen). /api/availability
// publiserer dem med den nye tjenestens varighet, så en gammel side regner med samme lengde som serveren (F24).
export const SERVICE_ALIASES = Object.freeze({ "Herreklipp + skjeggtrim (maskin)": "Herreklipp + skjeggtrim" });
const alias = (s) => (Object.prototype.hasOwnProperty.call(SERVICE_ALIASES, s) ? SERVICE_ALIASES[s] : s);

// Regler for kundebestillinger
export function validateCustomer(input, now = new Date()) {
  const { date: today, minutes: nowMin } = osloNow(now);
  const service = alias(clean(input.service, 80));
  // Bare egne nøkler: «constructor», «__proto__» o.l. skal ikke gi en «varighet»
  const dur = Object.prototype.hasOwnProperty.call(CONFIG.durations, service) ? CONFIG.durations[service] : undefined;
  if (!Number.isInteger(dur)) return fail("bad_service", "Ukjent tjeneste.");
  if (!isDate(input.date)) return fail("bad_date", "Ugyldig dato.");
  if (input.date < today || input.date > addDays(today, CONFIG.maxDays)) return fail("bad_date", "Datoen kan ikke bestilles.");
  const hours = CONFIG.hours[dayOfWeek(input.date)];
  if (!hours) return fail("closed", "Vi har stengt denne dagen.");
  const start = Number(input.start);
  if (!Number.isInteger(start) || start % CONFIG.slotMin !== 0 || start < hours[0] || start + dur > hours[1]) {
    return fail("bad_time", "Ugyldig tidspunkt.");
  }
  if (input.date === today && start < nowMin + CONFIG.leadMin) return fail("too_early", "Tidspunktet er for tidlig.");
  const name = clean(input.name, 80);
  const phone = clean(input.phone, 30);
  if (name.length < 2) return fail("bad_name", "Skriv inn navnet ditt.");
  // Sjekk det som lagres: et nummer over 30 tegn ble kuttet i stillhet, og sifrene etter tegn 30 forsvant (F25)
  if (String(input.phone ?? "").trim().length > 30 || !phoneOk(phone)) return fail("bad_phone", "Ugyldig telefonnummer.");
  const addons = pickAddons(input.addons);
  const value = { date: input.date, start, dur, service, addons, name, phone };
  // Idempotens-nøkkel fra siden (SPEC R1): samme requestId igjen er et nytt forsøk på den samme bestillingen.
  // Bare når siden sender en gyldig en, så en vanlig bestilling lagrer nøyaktig de samme feltene som før.
  if (typeof input.requestId === "string" && REQUEST_ID_RE.test(input.requestId)) value.requestId = input.requestId;
  return { value };
}
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Regler for admin: kan legge inn hva som helst på 5-minutters rutenett, også utenom åpningstid
export function validateAdmin(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.date !== undefined) {
    if (!isDate(input.date)) return { error: "Ugyldig dato.", status: 400 };
    out.date = input.date;
  }
  if (!partial || input.start !== undefined) {
    const start = Number(input.start);
    if (!Number.isInteger(start) || start < 0 || start >= 1440 || start % 5) return { error: "Ugyldig starttid.", status: 400 };
    out.start = start;
  }
  if (!partial || input.dur !== undefined) {
    const dur = Number(input.dur);
    if (!Number.isInteger(dur) || dur < 5 || dur > 1440 || dur % 5) return { error: "Ugyldig varighet.", status: 400 };
    out.dur = dur;
  }
  if (out.start !== undefined && out.dur !== undefined && out.start + out.dur > 1440) return { error: "Avtalen går over midnatt.", status: 400 };
  if (!partial || input.type !== undefined) {
    if (!["booking", "block"].includes(input.type ?? "booking")) return { error: "Ugyldig type.", status: 400 };
    out.type = input.type ?? "booking";
  }
  for (const [k, max] of [["service", 80], ["name", 80], ["phone", 30], ["note", 300]]) {
    if (input[k] !== undefined) out[k] = clean(input[k], max);
  }
  if (input.addons !== undefined) out.addons = pickAddons(input.addons);
  if (input.status !== undefined) {
    if (!["confirmed", "cancelled"].includes(input.status)) return { error: "Ugyldig status.", status: 400 };
    out.status = input.status;
  }
  // Idempotens-nøkkel for en ny avtale fra /admin, som for nettbestillinger (SPEC R1)
  if (!partial && typeof input.requestId === "string" && REQUEST_ID_RE.test(input.requestId)) out.requestId = input.requestId;
  // expect: avtalens updatedAt slik /admin så den. Er den endret et annet sted siden, svarer endringen 412 (SPEC R3).
  // Den hører ikke til avtalen og lagres aldri.
  if (input.expect !== undefined && (typeof input.expect !== "string" || input.expect.length > 40)) return { error: "Ugyldig versjon.", status: 400 };
  return input.expect === undefined ? { value: out } : { value: out, expect: input.expect };
}

const newId = (date) => `${date}_${randomBytes(5).toString("hex")}`;

// ---------- Opprett / endre / slett ----------
export async function createItem(store, value, { source, force = false, now = new Date() } = {}) {
  const item = {
    // status: det validerte (/admin kan legge inn en avlyst time); ellers «confirmed»
    id: newId(value.date), type: value.type || "booking", status: value.status === "cancelled" ? "cancelled" : "confirmed", source,
    date: value.date, start: value.start, dur: value.dur,
    service: value.service || "", addons: value.addons || [], name: value.name || "", phone: value.phone || "", note: value.note || "",
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  if (value.requestId) item.requestId = value.requestId;
  return mutateMonth(store, monthOf(item.date), (doc) => {
    // Ble første forsøk lagret selv om svaret gikk tapt, er jobben allerede gjort
    if (doc.items.some((o) => o.id === item.id)) return { ok: true, item };
    // … også når forsøket kom i et nytt kall (siden prøvde igjen med samme requestId, F1): svar med den lagrede
    // bestillingen i stedet for «tatt». Bare for den samme tiden, og bare mens den ikke er avlyst.
    // Samme requestId på en aktiv avtale med en annen tid er aldri et nytt forsøk (siden lager en ny requestId for hver
    // endring), men gjenbruk: avvis det i stedet for å lagre en avtale til (runde 2, SPEC R5).
    if (item.requestId) {
      const same = doc.items.find((o) => o.requestId === item.requestId && active(o) && o.date === item.date && o.start === item.start);
      if (same) return { ok: true, item: same, replay: true, noWrite: true };
      if (doc.items.some((o) => o.requestId === item.requestId && active(o))) {
        return { error: "Denne forespørselen er allerede brukt. Last siden på nytt.", code: "request_reused", status: 409 };
      }
    }
    const clash = active(item) && doc.items.find((o) => active(o) && o.date === item.date && overlaps(item.start, item.dur, o.start, o.dur));
    if (clash && !force) return { error: "Tidspunktet er allerede booket.", code: "taken", status: 409 };
    doc.items.push(item);
    return { ok: true, item };
  });
}

export async function findItem(store, id) {
  const date = String(id).split("_")[0];
  if (!isDate(date)) return null;
  const doc = await store.get(monthKey(monthOf(date)), { type: "json" });
  return doc?.items?.find((i) => i.id === id) || null;
}

const idSuffix = (id) => { const s = String(id); return s.slice(s.indexOf("_") + 1); };
// Hver endring står allerede i avtalen (et nytt forsøk etter et svar som gikk tapt)
const hasChanges = (item, changes) => Object.keys(changes).every((k) => JSON.stringify(item[k]) === JSON.stringify(changes[k]));
const STALE = { error: "Avtalen er endret på en annen enhet. Lukk og åpne den på nytt.", code: "stale", status: 412 };
const MOVE_HALF_DONE = "Avtalen er lagt inn på den nye datoen, men den gamle tiden ble ikke fjernet. Trykk Lagre én gang til.";
const MOVE_RACE_HALF = "Avtalen ble endret på en annen enhet mens du flyttet den. Oppdater siden og sjekk avtalen.";

// Endrer en avtale. changes: feltene fra validateAdmin (partial). expect: updatedAt slik /admin så avtalen; er den
// lagrede endret siden og endringen ikke allerede gjort, svarer det 412 «stale» (X1.1/X1.2). Uten expect (en gammel
// fane) som før. Kollisjon sjekkes bare når tiden endres (dato, start, varighet, eller en avlyst time blir aktiv
// igjen), så et nytt telefonnummer på en time under en blokkering ikke gir 409 (F32).
// Flytting til en annen måned beholder id-ens tilfeldige del (`${dato}_${suffix}`): avtalen legges inn i den nye
// måneden (og erstatter en med samme id, så et nytt forsøk aldri gir to), og fjernes så fra den gamle. Feiler
// fjerningen, svarer det 503 MOVE_HALF_DONE, og «Lagre» én gang til gjør jobben ferdig (F17).
export async function updateItem(store, id, changes, { force = false, now = new Date(), expect } = {}) {
  let current = await findItem(store, id);
  // Ble flyttingen lagret i et tidligere forsøk (svaret gikk tapt), ligger avtalen allerede på den nye datoen
  if (!current && changes.date !== undefined && isDate(changes.date)) current = await findItem(store, `${changes.date}_${idSuffix(id)}`);
  if (!current) return { error: "Fant ikke avtalen.", status: 404 };
  const currentId = current.id;
  const fromMonth = monthOf(current.date);
  const toMonth = monthOf(changes.date ?? current.date);
  const build = (base) => {
    const next = { ...base, ...changes, updatedAt: now.toISOString() };
    if (next.start + next.dur > 1440) return { error: "Avtalen går over midnatt.", status: 400 };
    return { next };
  };
  const timeChanged = (base, next) => next.date !== base.date || next.start !== base.start || next.dur !== base.dur || (active(next) && !active(base));
  const clashIn = (doc, next, selfId) => active(next) && doc.items.find((o) =>
    o.id !== selfId && active(o) && o.date === next.date && overlaps(next.start, next.dur, o.start, o.dur));
  const CLASH = { error: "Det nye tidspunktet kolliderer med en annen avtale.", status: 409 };
  // null: gå videre; ellers svaret (en gjentakelse som allerede er gjort, eller 412)
  const versionCheck = (base) => {
    if (expect === undefined || base.updatedAt === expect) return null;
    return hasChanges(base, changes) ? { ok: true, item: base, noWrite: true } : STALE;
  };

  if (fromMonth === toMonth) {
    return mutateMonth(store, fromMonth, (doc) => {
      const idx = doc.items.findIndex((i) => i.id === currentId);
      if (idx < 0) return { error: "Fant ikke avtalen.", status: 404 };
      const base = doc.items[idx];
      const seen = versionCheck(base);
      if (seen) return seen;
      const { next, error, status } = build(base);
      if (error) return { error, status };
      if (timeChanged(base, next) && clashIn(doc, next, currentId) && !force) return CLASH;
      doc.items[idx] = next;
      return { ok: true, item: next };
    });
  }
  const seen = versionCheck(current);
  if (seen) return seen;
  const { next, error, status } = build(current);
  if (error) return { error, status };
  next.id = `${next.date}_${idSuffix(currentId)}`;
  const suffix = idSuffix(currentId);
  // Hver forutsetning sjekkes inne i skrivingen som bygger på den (vakt-regel SPEC R16): en annen enhets endring
  // mellom lesingen over og de to skrivingene under, skal gi 412, aldri bli borte eller gi to kopier (runde 2).
  // adopted: den nye måneden har allerede nøyaktig denne flyttingen (et tidligere forsøk fra oss, eller den samme
  // flyttingen fra en annen enhet). Da står den, og bare den gamle tiden skal fjernes.
  let adopted = null;
  const addToNewMonth = () => mutateMonth(store, toMonth, (doc) => {
    adopted = null;
    const twin = doc.items.find((o) => o && idSuffix(o.id) === suffix);
    if (twin && twin.updatedAt !== next.updatedAt) {
      if (!sameExceptVersion(twin, next)) return STALE; // en annen enhet har flyttet eller endret den hit
      adopted = twin;
      return { ok: true, item: twin, noWrite: true };
    }
    if (clashIn(doc, next, next.id) && !force) return CLASH;
    const same = doc.items.findIndex((o) => o.id === next.id);
    if (same >= 0) doc.items[same] = next; else doc.items.push(next);
    return { ok: true, item: next };
  });
  let added;
  try {
    added = await addToNewMonth();
  } catch (err) {
    // Usikkert om skrivingen ble lagret (svaret kom aldri): se etter. Ligger den der, fullfør flyttingen.
    const there = await findItem(store, next.id).catch(() => null);
    if (!there || there.updatedAt !== next.updatedAt) throw err;
    added = { ok: true, item: there };
  }
  if (added.error) return added;
  // Fjern den gamle tiden, men bare den versjonen flyttingen bygde på. Er den endret (avlyst, nytt nummer …) eller
  // borte (slettet eller flyttet et annet sted) siden, tas vår kopi i den nye måneden bort igjen, og svaret er 412.
  // movedOut: en kort logg i den gamle måneden over flyttinger ut av den (id, ny id, et tilfeldig merke, tid; ingen
  // kundedata, høyst et døgn og 20 stykker). Går svaret på vår egen fjerning tapt, prøver klienten skrivingen igjen og
  // finner avtalen borte; bare merket skiller det fra at en annen enhet slettet eller flyttet den i mellomtiden.
  const moveMark = randomBytes(6).toString("hex");
  let removed;
  try {
    removed = await mutateMonth(store, fromMonth, (doc) => {
      const log = Array.isArray(doc.movedOut) ? doc.movedOut : [];
      const old = doc.items.find((i) => i.id === currentId);
      if (!old) {
        // vår egen fjerning, eller en annen enhet har gjort nøyaktig samme flytting (den tok vår kopi som sin)
        if (adopted || log.some((m) => m && m.id === currentId && (m.m === moveMark || m.to === next.id))) return { ok: true, noWrite: true };
        return { conflict: true, noWrite: true };
      }
      if (old.updatedAt !== current.updatedAt) return { conflict: true, noWrite: true };
      doc.items = doc.items.filter((i) => i.id !== currentId);
      doc.movedOut = log.filter((m) => m && Date.parse(m.at) > now.getTime() - 864e5)
        .concat({ id: currentId, to: next.id, m: moveMark, at: now.toISOString() }).slice(-20);
      return { ok: true };
    });
  } catch (err) {
    console.error("Flytting: kunne ikke fjerne den gamle tiden:", err && err.name);
    removed = { error: true };
  }
  if (removed.conflict) {
    if (adopted) return STALE; // kopien er ikke vår: la den stå
    try {
      const undone = await mutateMonth(store, toMonth, (doc) => {
        const before = doc.items.length;
        doc.items = doc.items.filter((o) => !(o.id === next.id && o.updatedAt === next.updatedAt));
        return doc.items.length === before ? { ok: true, noWrite: true } : { ok: true };
      });
      if (undone.error) throw new Error(undone.error);
    } catch (err) {
      console.error("Flytting: kunne ikke ta tilbake kopien etter en samtidig endring:", err && err.name);
      return { error: MOVE_RACE_HALF, code: "move_conflict", status: 503 };
    }
    return STALE;
  }
  if (removed.error) return { error: MOVE_HALF_DONE, code: "move_half_done", status: 503 };
  return { ok: true, item: added.item };
}
// To avtaler er like bortsett fra versjonen (updatedAt) og varselmerket
function sameExceptVersion(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete("updatedAt");
  keys.delete("notifiedAt");
  for (const k of keys) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  return true;
}

// Sletter en avtale for godt. expect: updatedAt slik /admin så den; er den endret et annet sted siden (flyttet,
// avlyst, nytt nummer), svarer det 412 «stale» og ingenting slettes (SPEC R3, som for PATCH). Uten expect (en
// gammel fane) som før.
// deletedOut: en kort logg i månedsdokumentet over slettinger (id, et tilfeldig merke for kallet, tid; ingen
// kundedata, høyst et døgn og 50 stykker), som movedOut for flyttinger. Går svaret på vår egen skriving tapt, kjøres
// endringen på nytt og finner avtalen borte; bare merket skiller det fra at en annen enhet flyttet den ut (412) eller
// slettet den (404) i mellomtiden. Vakt-regel (runde 2): et nytt forsøk kjenner igjen sitt eget tidligere forsøk bare
// på et merke i dokumentet, aldri på et flagg i minnet, for et forsøk som satte flagget, kan ha mistet skrivingen.
export async function deleteItem(store, id, { expect, now = new Date() } = {}) {
  const date = String(id).split("_")[0];
  if (!isDate(date)) return { error: "Fant ikke avtalen.", status: 404 };
  const mark = randomBytes(6).toString("hex");
  return mutateMonth(store, monthOf(date), (doc) => {
    const log = Array.isArray(doc.deletedOut) ? doc.deletedOut : [];
    const it = doc.items.find((i) => i.id === id);
    if (!it) {
      if (log.some((g) => g && g.id === id && g.m === mark)) return { ok: true, noWrite: true }; // vår egen sletting
      if (Array.isArray(doc.movedOut) && doc.movedOut.some((m) => m && m.id === id)) return STALE; // flyttet ut: åpne på nytt
      return { error: "Fant ikke avtalen.", status: 404 };
    }
    if (expect !== undefined && it.updatedAt !== expect) return STALE;
    doc.items = doc.items.filter((i) => i.id !== id);
    doc.deletedOut = log.filter((g) => g && Date.parse(g.at) > now.getTime() - 864e5)
      .concat({ id, m: mark, at: now.toISOString() }).slice(-50);
    return { ok: true };
  });
}

// Månedene («ÅÅÅÅ-MM») fra og med fromDate til og med toDate
export function monthsBetween(fromDate, toDate) {
  const out = [];
  for (let ym = monthOf(fromDate); ym <= monthOf(toDate);) {
    out.push(ym);
    const [y, m] = ym.split("-").map(Number);
    ym = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  }
  return out;
}

// Avlyser (status «cancelled», ny updatedAt; aldri slettet) alle aktive avtaler match(item) godtar i disse
// månedene. Teller bare det dette kallet avlyste, også når et svar gikk tapt og skrivingen ble prøvd igjen.
// Svarer { ok, cancelled } eller { error, status: 503, cancelled } (det som rakk å bli avlyst; kall igjen).
export async function cancelMatching(store, months, match, now = new Date()) {
  const stamp = now.toISOString();
  let total = 0;
  for (const ym of months) {
    const attempted = new Set();
    let r;
    try {
      r = await mutateMonth(store, ym, (doc) => {
        let changed = false;
        for (const i of doc.items) {
          if (!active(i) || !match(i)) continue;
          i.status = "cancelled";
          i.updatedAt = stamp;
          attempted.add(i.id);
          changed = true;
        }
        const cancelled = doc.items.filter((i) => attempted.has(i.id) && i.status === "cancelled" && i.updatedAt === stamp).length;
        return changed ? { ok: true, cancelled } : { ok: true, noWrite: true, cancelled };
      });
    } catch (err) {
      console.error("Avlysning: lagringen svarte ikke:", err && err.name);
      r = { error: true };
    }
    if (r.error) return { error: "Fikk ikke avlyst alle. Prøv igjen om litt.", status: 503, cancelled: total };
    total += r.cancelled;
  }
  return { ok: true, cancelled: total };
}

// ---------- Admin-innlogging ----------
// Passordet settes i Netlify som ADMIN_PASSWORD. Et nytt passord gjelder først etter en ny utrulling (Netlify bruker
// miljøverdiene fra da utrullingen ble laget, docs/contracts/netlify.md); da blir alle gamle billetter, varsler på
// enhetene og kalenderlenken ugyldige. Innloggingen gir en signert billett (12 timer, eller 60 dager med «Hold meg innlogget»).
//
// Nøkler (F34): ingenting serveren gir ut eller lagrer, er en rask hash av passordet. Alt kommer fra én langsom
// hovednøkkel, scrypt(passord, «viggos-admin-token-v1», N=16384, r=8, p=1), regnet ut én gang per passord per
// instans, med en egen HMAC-undernøkkel per formål: «token» (billetter), «device» (enhetsmerket) og «gen:<formål>».
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const MASTER_SALT = "viggos-admin-token-v1";
const masterCache = new Map();
export function masterKey(password) {
  const pw = String(password);
  let key = masterCache.get(pw);
  if (!key) {
    key = scryptSync(pw, MASTER_SALT, 32, { N: 16384, r: 8, p: 1 });
    if (masterCache.size >= 4) masterCache.clear(); // et passordbytte gir en ny instans uansett; dette er bare et tak
    masterCache.set(pw, key);
  }
  return key;
}
export const subkey = (password, purpose) => createHmac("sha256", masterKey(password)).update(purpose).digest();

// Et kort merke for «dette passordet» til ting som skal slutte å virke når passordet byttes, slik billettene gjør:
// varsler på enhetene (purpose «push») og kalenderlenken («calendar»). De første 16 tegnene av
// HMAC(hovednøkkelen, «gen:<purpose>») i base64url. Uten passord null.
export function passwordGen(password, purpose) {
  if (!password || !/^[a-z]+$/.test(String(purpose))) return null;
  return createHmac("sha256", masterKey(password)).update("gen:" + purpose).digest("base64url").slice(0, 16);
}

export function checkPassword(given, password) {
  if (!password || typeof given !== "string") return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(password).digest();
  return timingSafeEqual(a, b);
}
// Billetten: { exp, iat } (utløper, laget; millisekunder), signert med undernøkkelen «token»
const signWith = (password, purpose, payload) => b64url(createHmac("sha256", subkey(password, purpose)).update(payload).digest());
function makeSigned(password, purpose, now, ttlMs) {
  const payload = b64url(JSON.stringify({ exp: now + ttlMs, iat: now }));
  return `${payload}.${signWith(password, purpose, payload)}`;
}
function readSigned(token, password, purpose, now, { anyTime = false } = {}) {
  if (!password || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const a = Buffer.from(sig || ""), b = Buffer.from(signWith(password, purpose, payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString()); } catch { return null; }
  if (!data || !Number.isFinite(data.exp) || !Number.isFinite(data.iat) || !(anyTime || data.exp > now)) return null;
  return { exp: data.exp, iat: data.iat };
}
export const makeToken = (password, now = Date.now(), ttlMs = 12 * 60 * 60 * 1000) => makeSigned(password, "token", now, ttlMs);
// Innholdet { exp, iat } i en gyldig, ikke utløpt billett for dette passordet, ellers null. Sjekker ikke auth/epoch:
// det gjør readSession, som handlerne bruker.
export const readToken = (token, password, now = Date.now()) => readSigned(token, password, "token", now);
export const verifyToken = (token, password, now = Date.now()) => readToken(token, password, now) !== null;

// «Logg ut alle» (F34): doc auth/epoch { t } i timebokens lagring. En billett laget før t godtas ikke. POST
// /api/admin/push/reset flytter t til nå (og gir den som trykket en ny billett).
export const EPOCH_KEY = "auth/epoch";
export async function readEpoch(store) {
  const doc = await store.get(EPOCH_KEY, { type: "json" });
  return doc && Number.isFinite(doc.t) ? doc.t : 0;
}
export const bumpEpoch = (store, nowMs) => mutateJSON(store, EPOCH_KEY, (d) => (d && typeof d === "object" && !Array.isArray(d) ? d : {}), (doc) => {
  doc.t = Math.max(Number.isFinite(doc.t) ? doc.t : 0, nowMs);
  return { ok: true, t: doc.t };
});
// Innloggingen bak billetten: { session: { exp, iat } } når billetten er gyldig og ikke laget før auth/epoch, ellers
// { code } som sier hvorfor (runde 2: /admin kan da si sannheten om varslene på enheten):
//   expired  billetten er dette passordets, men tiden dens er ute
//   revoked  laget før auth/epoch («Slå av varsler på alle andre enheter» på en annen enhet)
//   invalid  ikke en billett for dette passordet (et nytt ADMIN_PASSWORD, eller noe som ikke er en billett)
export async function checkSession(store, token, password, nowMs) {
  const claims = readSigned(token, password, "token", nowMs, { anyTime: true });
  if (!claims) return { code: "invalid" };
  if (!(claims.exp > nowMs)) return { code: "expired" };
  if (claims.iat < await readEpoch(store)) return { code: "revoked" };
  return { session: claims };
}
// Det samme, bare innloggingen eller null
export async function readSession(store, token, password, nowMs) {
  return (await checkSession(store, token, password, nowMs)).session || null;
}

// Enhetsmerket (F5): en innlogging med riktig passord gir enheten et merke som varer i et år. Med det slipper
// innloggingen det felles taket mot gjetting (rl/login/all), så en som gjetter fra mange adresser ikke stenger
// Viggo ute. Taket per klient gjelder fortsatt, og passordet må fortsatt være riktig. Egen undernøkkel («device»),
// så et merke aldri er en billett eller omvendt.
export const DEVICE_MARK_MS = 365 * 24 * 60 * 60 * 1000;
export const makeDeviceMark = (password, now = Date.now()) => makeSigned(password, "device", now, DEVICE_MARK_MS);
export const verifyDeviceMark = (mark, password, now = Date.now()) => readSigned(mark, password, "device", now) !== null;
