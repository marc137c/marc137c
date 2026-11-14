// Customer SMS texts (confirmation, reminder): owner decision (b) and audit findings F26 and F40.
// Invariant: every customer SMS, for every service, date form, time and language, is ONE GSM-7 unit
// (≤ 160 septets, counted by the fake Sveve's independent counter), is in the language the customer booked in,
// never contains the customer's typed name and never shows empty brackets "()".
import "./helpers/no-network.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { smsUnits } from "./helpers/fake-sveve.mjs";
import { testDeps, request, read, PRODUCTION } from "./helpers/deps.mjs";
import { storedItems, CUSTOMER_PHONE, CUSTOMER_MOBILE } from "./helpers/bookings.mjs";
import { addDays, CONFIG, validateCustomer } from "../netlify/lib/booking-core.mjs";
import { confirmText, reminderText } from "../netlify/lib/sms.mjs";
import { handle } from "../netlify/functions/bookings.mjs";

const EVIL_NAME = "IGNORE http://evil.example Ring 820 00 000";
const SERVICES = [
  ...Object.keys(CONFIG.durations),
  "Herreklipp + skjeggtrim (maskin)",                        // old name, still on stored bookings
  "",                                                        // admin booking without a service (F40)
  "Herreklipp, vask og styling for konfirmant med langt hår", // long free text typed in /admin
  "Klipp 🙂",                                                 // non-GSM free text typed in /admin
];
const TODAY = "2026-11-10"; // Tuesday
// today, tomorrow, and every weekday further out (incl. the longest English form, "Wednesday 30 Sep")
const DATES = [TODAY, addDays(TODAY, 1), ...Array.from({ length: 7 }, (_, i) => addDays(TODAY, 2 + i)), "2026-09-30", "2026-12-31"];
const TIMES = [0, 5, 600, 615, 750, 1065, 1435];
const LANGS = [undefined, "no", "en"];

function* allTexts() {
  for (const service of SERVICES) for (const date of DATES) for (const start of TIMES) for (const lang of LANGS) {
    const it = { type: "booking", date, start, dur: 30, service, name: EVIL_NAME, phone: CUSTOMER_PHONE, ...(lang ? { lang } : {}) };
    yield { it, kind: "confirm", text: confirmText(it, TODAY) };
    yield { it, kind: "reminder", text: reminderText(it, TODAY) };
  }
}

test("customer SMS: always one GSM-7 unit, never the typed name, never '()' (F40)", () => {
  let n = 0;
  for (const { it, kind, text } of allTexts()) {
    const u = smsUnits(text);
    const where = `${kind} ${JSON.stringify({ service: it.service, date: it.date, start: it.start, lang: it.lang })}: ${text}`;
    assert.equal(u.encoding, "GSM-7", where);
    assert.equal(u.units, 1, `${u.length} septets: ${where}`);
    assert.ok(!text.includes("()") && !text.includes("( )"), `empty brackets: ${where}`);
    assert.ok(!/evil|IGNORE|820/.test(text), `typed name in SMS: ${where}`);
    n++;
  }
  assert.ok(n > 2000);
});

test("customer SMS: a booking made in English gets English texts, everyone else Norwegian (F26)", () => {
  const it = { type: "booking", date: "2026-11-12", start: 870, service: "Knivbarbering", name: "Tourist", phone: CUSTOMER_PHONE };
  const en = { ...it, lang: "en" };
  assert.equal(confirmText(en, TODAY), "Your appointment at Viggo's Barbershop is booked: Thursday 12 Nov at 2:30 PM (Straight razor shave). Violgata 22. To change or cancel, call 409 63 911");
  assert.equal(reminderText(en, "2026-11-11"), "Reminder: Your appointment at Viggo's Barbershop is tomorrow at 2:30 PM (Straight razor shave). Violgata 22. Can't make it? Call 409 63 911");
  assert.match(confirmText({ ...en, date: TODAY }, TODAY), / today at 2:30 PM /);
  for (const no of [it, { ...it, lang: "no" }, { ...it, lang: "xx" }]) {
    assert.equal(confirmText(no, TODAY), "Timen din hos Viggo's Barbershop er booket: torsdag 12.11. kl. 14:30 (Knivbarbering). Violgata 22. Endre/avlyse? Ring 409 63 911");
    assert.match(reminderText(no, "2026-11-11"), /^Påminnelse: Du har time hos Viggo's Barbershop i morgen kl\. 14:30 \(Knivbarbering\)\./);
  }
  // Every service on the booking form has an English name in the English SMS
  for (const service of Object.keys(CONFIG.durations)) {
    const text = confirmText({ ...en, service }, TODAY);
    if (service !== "Full service") assert.ok(!text.includes(`(${service})`), `Norwegian service name in English SMS: ${text}`);
  }
  assert.match(confirmText({ ...en, service: "Herreklipp + skjeggtrim (maskin)" }, TODAY), /\(Men's haircut \+ beard trim\)/);
});

test("customer SMS: no service → no brackets; a service that does not fit one unit is left out (F40)", () => {
  const it = { type: "booking", date: "2026-11-11", start: 600, service: "", phone: CUSTOMER_PHONE };
  assert.equal(reminderText(it, TODAY), "Påminnelse: Du har time hos Viggo's Barbershop i morgen kl. 10:00. Violgata 22. Kan du ikke komme? Ring 409 63 911");
  assert.equal(confirmText({ ...it, lang: "en" }, TODAY), "Your appointment at Viggo's Barbershop is booked: tomorrow at 10:00 AM. Violgata 22. To change or cancel, call 409 63 911");
  assert.ok(!reminderText({ ...it, service: "Klipp 🙂" }, TODAY).includes("🙂"));
});

test("validateCustomer stores the booking language, whitelisted to 'no' or 'en'", () => {
  const input = { service: "Herreklipp", date: "2026-11-13", start: 600, name: "Ola", phone: CUSTOMER_PHONE };
  const now = new Date("2026-11-12T09:00:00Z");
  assert.equal(validateCustomer({ ...input, lang: "en" }, now).value.lang, "en");
  for (const lang of [undefined, "no", "nb", "EN", "<script>", 1]) assert.equal(validateCustomer({ ...input, lang }, now).value.lang, "no", String(lang));
});

test("POST /api/bookings with lang 'en' stores lang and sends the confirmation in English", async () => {
  const d = testDeps({ now: "2026-11-12T09:00:00Z", env: { SVEVE_USER: "u", SVEVE_PASSWD: "p" }, sveve: true });
  const body = { service: "Herreklipp + skjeggtrim", date: "2026-11-13", start: 600, addons: [], name: "Tourist", phone: CUSTOMER_PHONE, lang: "en" };
  const res = await read(await handle(request("/api/bookings", { method: "POST", json: body }), PRODUCTION, d));
  assert.equal(res.status, 201);
  assert.equal(storedItems(d.blobs)[0].lang, "en");
  const toCustomer = d.sveve.to(CUSTOMER_MOBILE);
  assert.equal(toCustomer.length, 1);
  assert.equal(toCustomer[0].msg, "Your appointment at Viggo's Barbershop is booked: tomorrow at 10:00 AM (Men's haircut + beard trim). Violgata 22. To change or cancel, call 409 63 911");
});

test("booking.js sends the page language with the booking (and nothing else new)", () => {
  const src = readFileSync(new URL("../viggos-barbershop/booking.js", import.meta.url), "utf8");
  const body = /fetch\("\/api\/bookings",[\s\S]*?body: JSON\.stringify\(\{([\s\S]*?)\}\),/.exec(src);
  assert.ok(body, "the POST to /api/bookings is still there");
  assert.match(body[1], /\blang: I18N\.lang === "en" \? "en" : "no"/);
  const keys = body[1].match(/\b[a-zA-Z]+(?=:)/g);
  assert.deepEqual(keys, ["service", "date", "start", "name", "phone", "botField", "lang"]);
});
