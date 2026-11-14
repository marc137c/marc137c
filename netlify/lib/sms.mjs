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
const DAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const smsConfigured = (env) => Boolean(env.SVEVE_USER && env.SVEVE_PASSWD);

// «409 63 911», «+47 409 63 911», «0047 40963911» → «40963911». Alt annet → null.
export function norwegianMobile(phone) {
  let d = String(phone ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("0047")) d = d.slice(4);
  else if (d.length === 10 && d.startsWith("47")) d = d.slice(2);
  return /^[49]\d{7}$/.test(d) ? d : null;
}

// Taket på hvor mange SMS ett nummer kan få per døgn (bekreftelser og påminnelser til sammen) ligger i
// limits.mjs (SMS_LIMITS) og telles konfliktsikkert i Netlify Blobs før hver SMS (reminders.mjs).

const senderName = (env) => (String(env.SVEVE_FROM || "").replace(/[^A-Za-z0-9 ]/g, "").trim().slice(0, 11)) || "Viggos";
const pad2 = (n) => String(n).padStart(2, "0");
const hhmm = (min) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
const hhmm12 = (min) => { const h = Math.floor(min / 60); return `${((h + 11) % 12) + 1}:${pad2(min % 60)} ${h < 12 ? "AM" : "PM"}`; }; // som den engelske siden
const dayMonth = (date) => `${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}.`;
const weekday = (date) => DAYS[new Date(date + "T00:00:00Z").getUTCDay()];
const tomorrowOf = (today) => new Date(Date.parse(today + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);

// «tirsdag 12.11. kl. 14:30», eller «i dag kl. …» / «i morgen kl. …» sett fra datoen today
export function whenText(item, today) {
  const t = `kl. ${hhmm(item.start)}`;
  if (item.date === today) return `i dag ${t}`;
  if (item.date === tomorrowOf(today)) return `i morgen ${t}`;
  return `${weekday(item.date)} ${dayMonth(item.date)} ${t}`;
}
// Engelsk: «Thursday 12 Nov at 2:30 PM», «today at …», «tomorrow at …»
export function whenTextEn(item, today) {
  const t = `at ${hhmm12(item.start)}`;
  if (item.date === today) return `today ${t}`;
  if (item.date === tomorrowOf(today)) return `tomorrow ${t}`;
  const d = new Date(item.date + "T00:00:00Z");
  return `${DAYS_EN[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_EN[d.getUTCMonth()]} ${t}`;
}

// Tjenestenavnene slik den engelske siden viser dem (i18n.js). Andre navn (skrevet inn i /admin) vises som de er.
const SERVICES_EN = {
  "Full service": "Full service",
  "Herreklipp": "Men's haircut",
  "Herreklipp + skjeggtrim": "Men's haircut + beard trim",
  "Herreklipp + skjeggtrim (maskin)": "Men's haircut + beard trim", // gammelt navn på eldre bestillinger
  "Knivbarbering": "Straight razor shave",
  "Skjegg & line-up": "Beard & line-up",
  "Barneklipp": "Kids' haircut",
};
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// GSM 03.38: grunntegn koster 1 septett, utvidelsestegn 2. Alt annet gjør hele SMS-en til UCS-2 (70 tegn per SMS).
const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€\f";
// Antall septetter, eller null hvis teksten ikke kan sendes som GSM-7
export function gsmLength(text) {
  let n = 0;
  for (const ch of String(text)) {
    if (GSM_BASIC.includes(ch)) n += 1;
    else if (GSM_EXT.includes(ch)) n += 2;
    else return null;
  }
  return n;
}
// Én SMS = høyst 160 GSM-7-septetter
export const oneSms = (text) => { const n = gsmLength(text); return n !== null && n <= 160; };

// Kundens SMS: på språket kunden bestilte på (item.lang «en» = engelsk, alt annet norsk), alltid én SMS,
// aldri navnet kunden skrev inn. Tjenesten står i parentes bare når den finnes og får plass; ellers droppes den
// (en tom tjeneste fra /admin skal ikke gi «()», og en lang eller rar tjeneste skal ikke gi to SMS).
const TEMPLATES = {
  no: {
    when: whenText,
    service: (s) => s,
    confirm: (when, svc) => `Timen din hos Viggo's Barbershop er booket: ${when}${svc}. Violgata 22. Endre/avlyse? Ring 409 63 911`,
    reminder: (when, svc) => `Påminnelse: Du har time hos Viggo's Barbershop ${when}${svc}. Violgata 22. Kan du ikke komme? Ring 409 63 911`,
  },
  en: {
    when: whenTextEn,
    service: (s) => (own(SERVICES_EN, s) ? SERVICES_EN[s] : s),
    confirm: (when, svc) => `Your appointment at Viggo's Barbershop is booked: ${when}${svc}. Violgata 22. To change or cancel, call 409 63 911`,
    reminder: (when, svc) => `Reminder: Your appointment at Viggo's Barbershop is ${when}${svc}. Violgata 22. Can't make it? Call 409 63 911`,
  },
};
export const langOf = (item) => (item && item.lang === "en" ? "en" : "no");

function customerText(kind, item, today) {
  const t = TEMPLATES[langOf(item)];
  const when = t.when(item, today);
  const service = String(item.service || "").trim();
  if (service) {
    const text = t[kind](when, ` (${t.service(service)})`);
    if (oneSms(text)) return text;
  }
  return t[kind](when, "");
}

// Holdt til én SMS for alle tjenester, datoer, klokkeslett og begge språk; testes i test/sms-texts.test.mjs
export const confirmText = (item, today) => customerText("confirm", item, today);
export const reminderText = (item, today) => customerText("reminder", item, today);

// ---------- Varsel til frisøren ----------
// Én SMS per ny nettbestilling til SHOP_SMS_TO (standard butikkens mobil 409 63 911), alltid på norsk.
// Den er den eneste SMS-en som har med navnet kunden skrev, og den går bare til butikkens eget nummer.
export const SHOP_SMS_DEFAULT = "40963911";
export const shopNumber = (env) => norwegianMobile(env.SHOP_SMS_TO || SHOP_SMS_DEFAULT);

// Navnet slik kunden skrev det: uten kontroll- og formateringstegn (linjeskift, retningsmarkører, nullbredde),
// mellomrom slått sammen, trimmet, høyst 40 tegn (uten å dele et tegn som trenger to UTF-16-enheter)
export function shopName(name) {
  const s = String(name ?? "").replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "").replace(/\s+/g, " ").trim();
  let out = "";
  for (const ch of s) { if (out.length + ch.length > 40) break; out += ch; }
  return out.trim();
}
const shopPhone = (phone) => {
  const m = norwegianMobile(phone);
  return m ? `${m.slice(0, 3)} ${m.slice(3, 5)} ${m.slice(5)}` : String(phone ?? "").replace(/[^\d+]/g, "").slice(0, 16);
};
// «Ny time fra nettsiden: fredag 20.11. kl. 14:00, Herreklipp. Kunde: Ola Nordmann, tlf 912 34 567».
// Får det ikke plass i én SMS (lang tjeneste, navn med tegn utenfor GSM-7), brukes en kortere form (høyst 2 SMS).
export function shopText(item) {
  const when = `${weekday(item.date)} ${dayMonth(item.date)} kl. ${hhmm(item.start)}`;
  const service = String(item.service || "").trim();
  const name = shopName(item.name);
  const tel = shopPhone(item.phone);
  const full = `Ny time fra nettsiden: ${when}${service ? `, ${service}` : ""}. Kunde: ${name}, tlf ${tel}`;
  return oneSms(full) ? full : `Ny time ${when}${service ? `, ${service}` : ""}. ${name}, ${tel}`;
}

// Minutter fra nå til timen starter, regnet i norsk tid. Negativt tall = timen har begynt.
// now = { date: "ÅÅÅÅ-MM-DD", minutes } fra osloNow()
export function minutesUntil(item, now) {
  const days = Math.round((Date.parse(item.date + "T00:00:00Z") - Date.parse(now.date + "T00:00:00Z")) / 86400000);
  return days * 1440 + item.start - now.minutes;
}

// Aldri SMS om natten: 21:00–08:00 norsk tid. now = { date, minutes } fra osloNow()
export const quietHours = (now) => now.minutes < 8 * 60 || now.minutes >= 21 * 60;

// Skal denne avtalen få påminnelse nå? Kjøres hvert 15. minutt av sms-reminders.
// now = { date, minutes } (norsk tid) og nowMs = Date.now() da kjøringen startet.
export function reminderDue(item, now, nowMs) {
  if (item.type !== "booking" || item.status === "cancelled" || item.remindedAt) return false;
  if (!norwegianMobile(item.phone)) return false;
  const left = minutesUntil(item, now);                                  // minutter til timen
  // Minutter siden bestillingen, eller siden bekreftelsen hvis den kom senere (en nattbestilling får
  // bekreftelsen kl. 08), så kunden ikke får påminnelse rett etter bekreftelsen
  const bookedAgo = (nowMs - Date.parse(item.confirmSentAt || item.createdAt || 0)) / 60000;
  // Aldri om natten
  if (quietHours(now)) return false;
  // Vanlig: ett døgn før (vinduet er 60 min, så én kjøring som faller ut gjør ingenting).
  // Ikke rett etter bestillingen: da har kunden nettopp fått bekreftelsen.
  if (left <= 24 * 60 && left > 23 * 60 && bookedAgo > 3 * 60) return true;
  // Bestilt mindre enn et døgn før: to timer før i stedet, hvis bestillingen ikke er helt fersk
  return left <= 2 * 60 && left > 60 && bookedAgo > 6 * 60;
}

// SVEVE_TEST=true: Sveve tar imot kallet (sjekker brukernavn/passord), men sender ingen SMS
export const smsTestMode = (env) => String(env.SVEVE_TEST).toLowerCase() === "true";

// Feil der kallet aldri nådde Sveve (ingen forbindelse), så ingen SMS kan ha gått
const NOT_CONNECTED = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"];

// Sender én SMS. Kaster aldri. Svarer
//   { ok: true, id }                     Sveve bekreftet at SMS-en er sendt
//   { ok: true, test: true }             testmodus: Sveve godtok kallet, men ingen SMS ble sendt
//   { ok: false, error, skipped: true }  ikke forsøkt (ikke satt opp / ikke norsk mobil)
//   { ok: false, error }                 Sveve sendte den sikkert ikke (avvist, feil passord, HTTP-feil, ingen forbindelse)
//   { ok: false, error, maybeSent: true } ukjent (tidsavbrudd eller svaret gikk tapt): kan ha blitt sendt
export async function sendSms(env, phone, msg, fetchFn = fetch, { timeoutMs = 8000 } = {}) {
  if (!smsConfigured(env)) return { ok: false, skipped: true, error: "not_configured" };
  const to = norwegianMobile(phone);
  if (!to) return { ok: false, skipped: true, error: "not_norwegian_mobile" };
  const test = smsTestMode(env);
  const body = { user: env.SVEVE_USER, passwd: env.SVEVE_PASSWD, to, msg, from: senderName(env), f: "json" };
  if (test) body.test = true;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    let data = null;
    try { data = JSON.parse(await res.text()); } catch { /* ikke JSON, eller svaret ble brutt */ }
    const r = data && data.response;
    if (!r) return { ok: false, error: "bad_response", maybeSent: true }; // 200 uten lesbart svar: vet ikke
    if (r.fatalError) return { ok: false, error: String(r.fatalError).slice(0, 200) };
    if (test) return { ok: true, test: true }; // F42: aldri «sendt» i testmodus, uansett hva Sveve teller
    if (!(r.msgOkCount > 0)) return { ok: false, error: String((r.errors && r.errors[0] && r.errors[0].message) || "not_sent").slice(0, 200) };
    return { ok: true, id: Array.isArray(r.ids) ? r.ids[0] : undefined };
  } catch (err) {
    if (err && err.name === "AbortError") return { ok: false, error: "timeout", maybeSent: true };
    const code = err && err.cause && err.cause.code;
    if (NOT_CONNECTED.includes(code)) return { ok: false, error: "network" };
    return { ok: false, error: "network", maybeSent: true };
  } finally {
    clearTimeout(timer);
  }
}
