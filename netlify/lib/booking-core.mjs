// Kjernen i bookingsystemet: regler, lagring og konfliktsikre skrivinger.
// Alle klokkeslett er minutter etter midnatt, norsk tid (Europe/Oslo). Datoer er "ÅÅÅÅ-MM-DD".
// Lagring: Netlify Blobs, ett dokument per måned (nøkkel "m/ÅÅÅÅ-MM") med alle avtaler og blokkeringer.
import { randomBytes, createHmac, createHash, timingSafeEqual } from "node:crypto";

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
    "Herreklipp + skjeggtrim (maskin)": 60,
    "Knivbarbering": 30,
    "Skjegg & line-up": 30,
    "Barneklipp": 30,
  },
  addons: ["Vask kort hår", "Vask langt hår", "Styling"],
};

// ---------- Tid og dato ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (s) => typeof s === "string" && DATE_RE.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
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
// Ved kollisjon prøves det på nytt. fn kan returnere { error, status } for å avbryte uten å skrive.
export async function mutateMonth(store, ym, fn) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await store.getWithMetadata(monthKey(ym), { type: "json" });
    const doc = cur?.data && Array.isArray(cur.data.items) ? cur.data : { items: [] };
    const result = await fn(doc);
    if (result && result.error) return result;
    const write = await store.setJSON(monthKey(ym), doc, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (write.modified) return result || { ok: true };
    await new Promise((r) => setTimeout(r, 20 * 2 ** attempt + Math.random() * 20));
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
// Kundene ser bare opptatte tidsrom – aldri navn eller telefonnummer.
export async function getAvailability(store, now = new Date()) {
  const { date: today, minutes } = osloNow(now);
  const last = addDays(today, CONFIG.maxDays);
  const items = await readMonths(store, today, last);
  const busy = {};
  for (const i of items.filter(active)) (busy[i.date] ||= []).push([i.start, i.start + i.dur]);
  return {
    today, nowMinutes: minutes, lastDate: last,
    hours: CONFIG.hours, slotMin: CONFIG.slotMin, leadMin: CONFIG.leadMin, maxDays: CONFIG.maxDays,
    durations: CONFIG.durations, busy,
  };
}

// ---------- Validering ----------
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const phoneOk = (p) => String(p).replace(/\D/g, "").length >= 8 && /^[+\d\s()-]{8,20}$/.test(String(p).trim());

// Regler for kundebestillinger
export function validateCustomer(input, now = new Date()) {
  const { date: today, minutes: nowMin } = osloNow(now);
  const service = clean(input.service, 80);
  const dur = CONFIG.durations[service];
  if (!dur) return { error: "Ukjent tjeneste.", status: 400 };
  if (!isDate(input.date)) return { error: "Ugyldig dato.", status: 400 };
  if (input.date < today || input.date > addDays(today, CONFIG.maxDays)) return { error: "Datoen kan ikke bestilles.", status: 400 };
  const hours = CONFIG.hours[dayOfWeek(input.date)];
  if (!hours) return { error: "Vi har stengt denne dagen.", status: 400 };
  const start = Number(input.start);
  if (!Number.isInteger(start) || start % CONFIG.slotMin !== 0 || start < hours[0] || start + dur > hours[1]) {
    return { error: "Ugyldig tidspunkt.", status: 400 };
  }
  if (input.date === today && start < nowMin + CONFIG.leadMin) return { error: "Tidspunktet er for tidlig.", status: 400 };
  const name = clean(input.name, 80);
  const phone = clean(input.phone, 20);
  if (name.length < 2) return { error: "Skriv inn navnet ditt.", status: 400 };
  if (!phoneOk(phone)) return { error: "Ugyldig telefonnummer.", status: 400 };
  const addons = (Array.isArray(input.addons) ? input.addons : []).filter((a) => CONFIG.addons.includes(a));
  return { value: { date: input.date, start, dur, service, addons, name, phone } };
}

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
  for (const [k, max] of [["service", 80], ["name", 80], ["phone", 20], ["note", 300]]) {
    if (input[k] !== undefined) out[k] = clean(input[k], max);
  }
  if (input.addons !== undefined) out.addons = (Array.isArray(input.addons) ? input.addons : []).filter((a) => CONFIG.addons.includes(a));
  if (input.status !== undefined) {
    if (!["confirmed", "cancelled"].includes(input.status)) return { error: "Ugyldig status.", status: 400 };
    out.status = input.status;
  }
  return { value: out };
}

const newId = (date) => `${date}_${randomBytes(5).toString("hex")}`;

// ---------- Opprett / endre / slett ----------
export async function createItem(store, value, { source, force = false, now = new Date() } = {}) {
  const item = {
    id: newId(value.date), type: value.type || "booking", status: "confirmed", source,
    date: value.date, start: value.start, dur: value.dur,
    service: value.service || "", addons: value.addons || [], name: value.name || "", phone: value.phone || "", note: value.note || "",
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  return mutateMonth(store, monthOf(item.date), (doc) => {
    const clash = doc.items.find((o) => active(o) && o.date === item.date && overlaps(item.start, item.dur, o.start, o.dur));
    if (clash && !force) return { error: "Tidspunktet er allerede booket.", status: 409, clash: { start: clash.start, dur: clash.dur } };
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

export async function updateItem(store, id, changes, { force = false, now = new Date() } = {}) {
  const current = await findItem(store, id);
  if (!current) return { error: "Fant ikke avtalen.", status: 404 };
  const fromMonth = monthOf(current.date);
  const toMonth = monthOf(changes.date ?? current.date);
  const build = (base) => {
    const next = { ...base, ...changes, updatedAt: now.toISOString() };
    if (next.start + next.dur > 1440) return { error: "Avtalen går over midnatt.", status: 400 };
    return { next };
  };
  const clashIn = (doc, next, selfId) => active(next) && doc.items.find((o) =>
    o.id !== selfId && active(o) && o.date === next.date && overlaps(next.start, next.dur, o.start, o.dur));
  const CLASH = { error: "Det nye tidspunktet kolliderer med en annen avtale.", status: 409 };

  if (fromMonth === toMonth) {
    return mutateMonth(store, fromMonth, (doc) => {
      const idx = doc.items.findIndex((i) => i.id === id);
      if (idx < 0) return { error: "Fant ikke avtalen.", status: 404 };
      const { next, error, status } = build(doc.items[idx]);
      if (error) return { error, status };
      if (clashIn(doc, next, id) && !force) return CLASH;
      doc.items[idx] = next;
      return { ok: true, item: next };
    });
  }
  // Flytting til en annen måned: ny ID (ID-en viser hvilken måned avtalen ligger i).
  // Legg inn i ny måned først, fjern så fra den gamle – da forsvinner avtalen aldri.
  const { next, error, status } = build(current);
  if (error) return { error, status };
  next.id = newId(next.date);
  const added = await mutateMonth(store, toMonth, (doc) => {
    if (clashIn(doc, next, next.id) && !force) return CLASH;
    doc.items.push(next);
    return { ok: true, item: next };
  });
  if (added.error) return added;
  await mutateMonth(store, fromMonth, (doc) => { doc.items = doc.items.filter((i) => i.id !== id); });
  return added;
}

export async function deleteItem(store, id) {
  const date = String(id).split("_")[0];
  if (!isDate(date)) return { error: "Fant ikke avtalen.", status: 404 };
  return mutateMonth(store, monthOf(date), (doc) => {
    const before = doc.items.length;
    doc.items = doc.items.filter((i) => i.id !== id);
    if (doc.items.length === before) return { error: "Fant ikke avtalen.", status: 404 };
    return { ok: true };
  });
}

// ---------- Admin-innlogging ----------
// Passordet settes i Netlify som ADMIN_PASSWORD. Innloggingen gir en signert billett (12 timer, eller 60 dager med «Hold meg innlogget»);
// bytter du passord, blir alle gamle billetter ugyldige.
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const signingKey = (password) => createHash("sha256").update("viggos-admin:" + password).digest();

export function checkPassword(given, password) {
  if (!password || typeof given !== "string") return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(password).digest();
  return timingSafeEqual(a, b);
}
export function makeToken(password, now = Date.now(), ttlMs = 12 * 60 * 60 * 1000) {
  const payload = b64url(JSON.stringify({ exp: now + ttlMs }));
  const sig = b64url(createHmac("sha256", signingKey(password)).update(payload).digest());
  return `${payload}.${sig}`;
}
export function verifyToken(token, password, now = Date.now()) {
  if (!password || typeof token !== "string" || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  const expected = b64url(createHmac("sha256", signingKey(password)).update(payload).digest());
  const a = Buffer.from(sig || ""), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > now; } catch { return false; }
}
