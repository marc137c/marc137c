// RC4 (validators tested only with what the UI sends): a seeded property loop over validateCustomer and
// validateAdmin with prototype keys, impossible dates, astral characters, 10 kB strings and odd phones. No deps:
// a small seeded PRNG, so every run checks the same inputs and a failure names the case that broke.
// Invariants for every input a validator accepts:
//   1. the value is in range: an own CONFIG service with its own duration, a real date, a time on the grid inside
//      the hours (customer) or the day (admin), add-ons from CONFIG once each in CONFIG order, only known keys;
//   2. every string is well-formed UTF-16 (no lone surrogate, no emoji cut in half), has no control characters and
//      is within its length limit; a customer's phone has 8-15 digits and at most 30 characters (F25);
//   3. createItem stores exactly the validated value, field for field.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBlobs } from "../helpers/fake-blobs.mjs";
import { CONFIG, isDate, dayOfWeek, validateCustomer, validateAdmin, createItem } from "../../netlify/lib/booking-core.mjs";

// mulberry32: a tiny seeded PRNG
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const NOW = new Date("2026-11-12T09:00:00Z"); // Thursday 10:00 in Oslo
const BIG = "x".repeat(10240);
const EMOJI = "\u{1F600}";
const PROTO = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "prototype"];

const SERVICES = [...Object.keys(CONFIG.durations), "Herreklipp + skjeggtrim (maskin)", ...PROTO, "", " Herreklipp ", BIG, EMOJI, "Herreklipp\u0000", undefined, null, 5, ["Herreklipp"]];
const DATES = ["2026-11-13", "2026-11-14", "2026-11-16", "2026-12-24", "2027-01-11", "2026-11-15", "2026-11-12", "2026-11-31",
  "2027-02-29", "2026-13-01", "2026-00-10", "2026-11-1", "", "i morgen", BIG, undefined, null, 20261113, "2026-11-13T10:00", ...PROTO];
const STARTS = [600, 630, 690, 1020, 1050, 1080, 615, 0, -30, 1440, 1435, "600", 600.5, null, undefined, "abc", 1e9, NaN, [600], ...PROTO];
const DURS = [5, 30, 60, 1440, 0, 7, -5, 1445, "30", null, undefined, 30.5];
const NAMES = ["Ola Nordmann", "Ø", "Åse Æbleskiver-Øverli", "Ola " + EMOJI, "x".repeat(79) + EMOJI, "x".repeat(78) + EMOJI + "y",
  "\ud800abc", "abc\udfff", "Ola\u0000\u001fNordmann", "  ", BIG, "", undefined, null, 42, { a: 1 }, ...PROTO];
const PHONES = ["409 63 911", "+47 409 63 911", "0047 409-63-911", "409.63.911", "+47 (409) 63 911", "40963911",
  "409 63 911" + " ".repeat(20) + "1", "4".repeat(31), "4".repeat(15), "4".repeat(16), "1234567", "４０９６３９１１",
  "409 63 911" + EMOJI, BIG, "", undefined, null, 40963911, ...PROTO];
const ADDONS = [[], ["Styling"], ["Styling", "Styling"], ["Vask langt hår", "Vask kort hår", "Styling"], ["__proto__"], ["constructor"],
  "Styling", null, undefined, [BIG], [EMOJI], Array(300).fill("Vask kort hår"), [["Styling"]]];
const REQUEST_IDS = [undefined, "abcdefgh", "a".repeat(64), "a".repeat(65), "short", "../../etc", "abc def gh", EMOJI.repeat(8), 12345678, ...PROTO];
const NOTES = ["", "Ring før", "x".repeat(301), BIG, EMOJI.repeat(200), "a\u0007b", undefined, ...PROTO];
const TYPES = [undefined, "booking", "block", "holiday", "", ...PROTO];
const STATUSES = [undefined, "confirmed", "cancelled", "deleted", ...PROTO];
const EXPECTS = [undefined, "2026-11-01T10:00:00.000Z", "x".repeat(40), "x".repeat(41), 5, null];

// Each list starts with values a validator should accept; pick takes one of those 70 % of the time, so enough
// inputs pass every check together to test the accepted path too
const VALID = new Map([[SERVICES, 7], [DATES, 5], [STARTS, 4], [DURS, 4], [NAMES, 6], [PHONES, 6], [ADDONS, 4], [REQUEST_IDS, 3], [NOTES, 3], [TYPES, 3], [STATUSES, 3], [EXPECTS, 3]]);
const pick = (rand, list) => {
  const n = VALID.get(list) || list.length;
  return rand() < 0.7 ? list[Math.floor(rand() * n)] : list[Math.floor(rand() * list.length)];
};
const maybe = (rand, obj, key, list, p = 0.85) => { if (rand() < p) obj[key] = pick(rand, list); };

// Some inputs arrive as JSON with a "__proto__" key (JSON.parse makes it an own property)
function customerInput(rand) {
  const o = {};
  maybe(rand, o, "service", SERVICES, 0.95);
  maybe(rand, o, "date", DATES, 0.95);
  maybe(rand, o, "start", STARTS, 0.95);
  maybe(rand, o, "name", NAMES, 0.95);
  maybe(rand, o, "phone", PHONES, 0.95);
  maybe(rand, o, "addons", ADDONS, 0.7);
  maybe(rand, o, "requestId", REQUEST_IDS, 0.5);
  if (rand() < 0.1) return JSON.parse(JSON.stringify({ ...o, __proto__x: 1 }).replace('"__proto__x"', '"__proto__"'));
  return o;
}
function adminInput(rand) {
  const o = {};
  maybe(rand, o, "date", DATES, 0.9);
  maybe(rand, o, "start", STARTS, 0.9);
  maybe(rand, o, "dur", DURS, 0.9);
  maybe(rand, o, "type", TYPES, 0.5);
  maybe(rand, o, "service", SERVICES, 0.5);
  maybe(rand, o, "name", NAMES, 0.5);
  maybe(rand, o, "phone", PHONES, 0.5);
  maybe(rand, o, "note", NOTES, 0.4);
  maybe(rand, o, "addons", ADDONS, 0.4);
  maybe(rand, o, "status", STATUSES, 0.3);
  maybe(rand, o, "requestId", REQUEST_IDS, 0.3);
  maybe(rand, o, "expect", EXPECTS, 0.3);
  return o;
}

function cleanString(label, s, max) {
  assert.equal(typeof s, "string", label);
  assert.ok(s.isWellFormed(), `${label} is well-formed UTF-16: ${JSON.stringify(s)}`);
  assert.doesNotMatch(s, /[\u0000-\u001f\u007f]/, `${label} has no control characters`);
  assert.ok(s.length <= max, `${label} is at most ${max}: ${s.length}`);
  assert.equal(s, s.trim(), `${label} is trimmed`);
}
function addonsOk(label, a) {
  assert.ok(Array.isArray(a), label);
  assert.deepEqual(a, CONFIG.addons.filter((x) => a.includes(x)), `${label}: known, once each, in CONFIG order`);
}
// A fresh store each time: two cases with the same requestId and time would rightly be one booking (a replay)
async function storedAsValidated(value, source) {
  const store = new FakeBlobs().getStore({ name: "bookings", consistency: "strong" });
  const r = await createItem(store, value, { source, force: true, now: NOW });
  assert.ok(r.ok, JSON.stringify(r));
  const doc = await store.get(`m/${value.date.slice(0, 7)}`, { type: "json" });
  const stored = doc.items.find((i) => i.id === r.item.id);
  for (const k of Object.keys(value)) assert.deepEqual(stored[k], value[k], `stored ${k} equals the validated value`);
}

const SEEDS = [1, 2, 3, 20261116];
const ROUNDS = 400;

test("validators: every customer input validateCustomer accepts is in range, clean, and stored exactly as validated", async () => {
  let accepted = 0, refused = 0;
  for (const seed of SEEDS) {
    const rand = prng(seed);
    for (let i = 0; i < ROUNDS; i++) {
      const input = customerInput(rand);
      const label = `seed ${seed} round ${i}: ${JSON.stringify(input).slice(0, 200)}`;
      const r = validateCustomer(input, NOW);
      if (r.error) {
        refused++;
        assert.match(r.code, /^(bad_service|bad_date|closed|bad_time|too_early|bad_name|bad_phone)$/, label);
        assert.equal(r.status, 400, label);
        continue;
      }
      accepted++;
      const v = r.value;
      assert.deepEqual(Object.keys(v).filter((k) => !["date", "start", "dur", "service", "addons", "name", "phone", "requestId"].includes(k)), [], label);
      assert.ok(own(CONFIG.durations, v.service), label);
      assert.equal(v.dur, CONFIG.durations[v.service], label);
      assert.ok(isDate(v.date), label);
      const hours = CONFIG.hours[dayOfWeek(v.date)];
      assert.ok(hours && Number.isInteger(v.start) && v.start % CONFIG.slotMin === 0 && v.start >= hours[0] && v.start + v.dur <= hours[1], label);
      cleanString("name " + label, v.name, 80);
      assert.ok(v.name.length >= 2, label);
      cleanString("phone " + label, v.phone, 30);
      const digits = v.phone.replace(/\D/g, "").length;
      assert.ok(digits >= 8 && digits <= 15, `phone digits ${label}`);
      addonsOk(label, v.addons);
      if ("requestId" in v) assert.match(v.requestId, /^[A-Za-z0-9_-]{8,64}$/, label);
      await storedAsValidated(v, "nettside");
    }
  }
  assert.ok(accepted > 50 && refused > 200, `accepted ${accepted}, refused ${refused}`);
});

test("validators: every admin input validateAdmin accepts (full and partial) is in range, clean, and stored exactly as validated", async () => {
  let accepted = 0, refused = 0;
  for (const seed of SEEDS) {
    const rand = prng(seed * 7919);
    for (let i = 0; i < ROUNDS; i++) {
      const input = adminInput(rand);
      const partial = rand() < 0.4;
      const label = `seed ${seed} round ${i} partial ${partial}: ${JSON.stringify(input).slice(0, 200)}`;
      const r = validateAdmin(input, { partial });
      if (r.error) {
        refused++;
        assert.equal(r.status, 400, label);
        assert.equal(typeof r.error, "string", label);
        continue;
      }
      accepted++;
      const v = r.value;
      assert.deepEqual(Object.keys(v).filter((k) => !["date", "start", "dur", "type", "service", "name", "phone", "note", "addons", "status", "requestId"].includes(k)), [], label);
      assert.ok(!("expect" in v), "expect is never part of the item");
      if ("expect" in r) assert.ok(typeof r.expect === "string" && r.expect.length <= 40, label);
      if ("date" in v) assert.ok(isDate(v.date), label);
      if ("start" in v) assert.ok(Number.isInteger(v.start) && v.start >= 0 && v.start < 1440 && v.start % 5 === 0, label);
      if ("dur" in v) assert.ok(Number.isInteger(v.dur) && v.dur >= 5 && v.dur <= 1440 && v.dur % 5 === 0, label);
      if ("start" in v && "dur" in v) assert.ok(v.start + v.dur <= 1440, label);
      if ("type" in v) assert.ok(["booking", "block"].includes(v.type), label);
      if ("status" in v) assert.ok(["confirmed", "cancelled"].includes(v.status), label);
      for (const [k, max] of [["service", 80], ["name", 80], ["phone", 30], ["note", 300]]) if (k in v) cleanString(`${k} ${label}`, v[k], max);
      if ("addons" in v) addonsOk(label, v.addons);
      if ("requestId" in v) assert.ok(!partial && /^[A-Za-z0-9_-]{8,64}$/.test(v.requestId), label);
      if (!partial) await storedAsValidated(v, "admin");
    }
  }
  assert.ok(accepted > 50 && refused > 100, `accepted ${accepted}, refused ${refused}`);
});

test("validators: a name cut at 80 never splits an emoji, and a lone surrogate becomes U+FFFD", () => {
  const base = { service: "Herreklipp", date: "2026-11-13", start: 600, phone: "409 63 911" };
  assert.equal(validateCustomer({ ...base, name: "x".repeat(79) + EMOJI }, NOW).value.name, "x".repeat(79));
  assert.equal(validateCustomer({ ...base, name: "Ola \ud800" }, NOW).value.name, "Ola �");
});

test("validators: a phone over 30 characters is refused, not cut (F25)", () => {
  const base = { service: "Herreklipp", date: "2026-11-13", start: 600, name: "Ola Nordmann" };
  const long = "409 63 911" + " ".repeat(20) + "1";
  assert.equal(long.length, 31);
  assert.equal(validateCustomer({ ...base, phone: long }, NOW).code, "bad_phone");
  assert.equal(validateCustomer({ ...base, phone: "  409 63 911  " }, NOW).value.phone, "409 63 911", "surrounding spaces do not count");
});
