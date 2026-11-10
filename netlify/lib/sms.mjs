// SMS via Sveve (sveve.no): bekreftelse når kunden bestiller, og påminnelse før timen.
// Sett i Netlify (Site configuration → Environment variables):
//   SVEVE_USER    brukernavnet på Sveve
//   SVEVE_PASSWD  API-passordet (sveve.no → API → API-nøkkel), ikke innloggingspassordet
//   SVEVE_FROM    valgfritt avsendernavn, maks 11 tegn uten æøå (standard «Viggos»)
//   SVEVE_TEST    «true» = Sveve tar imot kallet, men sender ingen SMS (til testing)
// Uten SVEVE_USER/SVEVE_PASSWD sendes ingenting, og bestillingen virker akkurat som før.
//
// Sikkerhet: meldingen inneholder bare vår egen tekst + dato/tid/tjeneste som serveren har sjekket,
// aldri navnet kunden skrev inn. Ellers kunne hvem som helst sende en egen tekst («navnet») fra
// «Viggos» til et fremmed nummer. Vi sender også bare til norske mobilnummer (stopper SMS-svindel
// mot dyre utenlandske nummer).

const ENDPOINT = "https://sveve.no/SMS/SendMessage";
const DAYS = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];

export const smsConfigured = (env) => Boolean(env.SVEVE_USER && env.SVEVE_PASSWD);

// «409 63 911», «+47 409 63 911», «0047 40963911» → «40963911». Alt annet → null.
export function norwegianMobile(phone) {
  let d = String(phone ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("0047")) d = d.slice(4);
  else if (d.length === 10 && d.startsWith("47")) d = d.slice(2);
  return /^[49]\d{7}$/.test(d) ? d : null;
}

// Høyst så mange SMS-bekreftelser til samme nummer per døgn. Stopper misbruk der noen booker
// mange timer med et fremmed nummer (det koster penger og plager eieren av nummeret).
export const MAX_CONFIRMATIONS_PER_DAY = 3;
export function confirmationAllowed(items, phone, nowMs = Date.now()) {
  const n = norwegianMobile(phone);
  if (!n) return false;
  const since = nowMs - 24 * 60 * 60 * 1000;
  const recent = items.filter((i) => i.type === "booking" && Date.parse(i.createdAt || 0) > since && norwegianMobile(i.phone) === n);
  return recent.length <= MAX_CONFIRMATIONS_PER_DAY; // inkludert bestillingen som nettopp ble lagret
}

const senderName = (env) => (String(env.SVEVE_FROM || "").replace(/[^A-Za-z0-9 ]/g, "").trim().slice(0, 11)) || "Viggos";
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const dayMonth = (date) => `${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}.`;
const weekday = (date) => DAYS[new Date(date + "T00:00:00Z").getUTCDay()];

// «tirsdag 12.11. kl. 14:30», eller «i dag kl. …» / «i morgen kl. …» sett fra datoen today
export function whenText(item, today) {
  const t = `kl. ${hhmm(item.start)}`;
  if (item.date === today) return `i dag ${t}`;
  const tomorrow = new Date(Date.parse(today + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  if (item.date === tomorrow) return `i morgen ${t}`;
  return `${weekday(item.date)} ${dayMonth(item.date)} ${t}`;
}

// Holdt under 160 tegn (én SMS) også med lengste tjeneste og ukedag-dato; testes i tools/test-sms.mjs
export const confirmText = (item, today) =>
  `Timen din hos Viggo's Barbershop er booket: ${whenText(item, today)} (${item.service}). ` +
  `Violgata 22. Endre/avlyse? Ring 409 63 911`;

export const reminderText = (item, today) =>
  `Påminnelse: Du har time hos Viggo's Barbershop ${whenText(item, today)} (${item.service}). ` +
  `Violgata 22. Kan du ikke komme? Ring 409 63 911`;

// Minutter fra nå til timen starter, regnet i norsk tid. Negativt tall = timen har begynt.
// now = { date: "ÅÅÅÅ-MM-DD", minutes } fra osloNow()
export function minutesUntil(item, now) {
  const days = Math.round((Date.parse(item.date + "T00:00:00Z") - Date.parse(now.date + "T00:00:00Z")) / 86400000);
  return days * 1440 + item.start - now.minutes;
}

// Skal denne avtalen få påminnelse nå? Kjøres hvert 15. minutt av sms-reminders.
// now = { date, minutes } (norsk tid) og nowMs = Date.now() da kjøringen startet.
export function reminderDue(item, now, nowMs) {
  if (item.type !== "booking" || item.status === "cancelled" || item.remindedAt) return false;
  if (!norwegianMobile(item.phone)) return false;
  const left = minutesUntil(item, now);                                  // minutter til timen
  const bookedAgo = (nowMs - Date.parse(item.createdAt || 0)) / 60000;   // minutter siden bestillingen
  // TODO(human): bestem når påminnelsen sendes. Returner true når det er riktig tidspunkt.
  return false;
}

// Sender én SMS. Svarer { ok: true } eller { ok: false, error, skipped? }. Kaster aldri.
export async function sendSms(env, phone, msg, fetchFn = fetch) {
  if (!smsConfigured(env)) return { ok: false, skipped: true, error: "not_configured" };
  const to = norwegianMobile(phone);
  if (!to) return { ok: false, skipped: true, error: "not_norwegian_mobile" };
  const body = { user: env.SVEVE_USER, passwd: env.SVEVE_PASSWD, to, msg, from: senderName(env), f: "json" };
  if (String(env.SVEVE_TEST).toLowerCase() === "true") body.test = true;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchFn(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let data = null;
    try { data = JSON.parse(await res.text()); } catch { /* ikke JSON */ }
    const r = data && data.response;
    if (!res.ok || !r) return { ok: false, error: `http_${res.status}` };
    if (r.fatalError) return { ok: false, error: String(r.fatalError).slice(0, 200) };
    if (!(r.msgOkCount > 0)) return { ok: false, error: String((r.errors && r.errors[0] && r.errors[0].message) || "not_sent").slice(0, 200) };
    return { ok: true, id: Array.isArray(r.ids) ? r.ids[0] : undefined };
  } catch (err) {
    return { ok: false, error: err && err.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}
