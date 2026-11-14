// netlify/lib/calendar.mjs: the iCalendar text the barber's phone subscribes to (owner decision 2a).
// Invariants, checked with the independent RFC 5545 reader in test/helpers/ical.mjs:
//   1. the stream obeys RFC 5545: CRLF, 75-octet folding that never splits a character, TEXT escaping,
//      DTSTAMP in UTC, a unique UID per event, every TZID backed by a VTIMEZONE, valid alarms;
//   2. every active booking appears exactly once, with the right Oslo wall-clock times, also across the
//      summer/winter time changes (the VTIMEZONE is resolved by its own rules and compared with Intl);
//   3. cancelled bookings and blocks never appear; the text carries service (+ add-ons), name and phone, and never
//      the barber's private note;
//   4. the link token is 256 random bits and only an exact match passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { oslo } from "../helpers/clock.mjs";
import { item } from "../helpers/bookings.mjs";
import { rfc5545Problems, parseCalendar, components, prop, text, toUtcMs, unfold } from "../helpers/ical.mjs";
import {
  buildCalendar, escapeText, foldLine, localDateTime, utcDateTime, feedRange, feedLinks, feedPath,
  newFeedToken, isTokenShaped, tokenMatches, createFeed, readFeed, calendarFor, FEED_KEY, ALARM_MIN,
} from "../../netlify/lib/calendar.mjs";
import { FakeBlobs } from "../helpers/fake-blobs.mjs";
import { FakeClock } from "../helpers/clock.mjs";
import { seedItems } from "../helpers/bookings.mjs";
import { addDays } from "../../netlify/lib/booking-core.mjs";

const NOW = new Date("2026-11-14T09:00:00Z");
const events = (ics) => components(parseCalendar(ics), "VEVENT");
const byUid = (ics) => new Map(events(ics).map((e) => [prop(e, "UID").value, e]));
const uidOf = (i) => `${i.id}@viggos-timebok`;
const hm = (min) => [Math.floor(min / 60), min % 60];

// A small deterministic random generator, so the property test is the same on every run
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test("calendar: an empty timebook is still a valid calendar (VTIMEZONE counts as a component)", () => {
  const ics = buildCalendar([], { now: NOW });
  assert.deepEqual(rfc5545Problems(ics), []);
  const cal = parseCalendar(ics);
  assert.equal(prop(cal, "VERSION").value, "2.0");
  assert.match(prop(cal, "PRODID").value, /^-\/\/Viggo's Barbershop\/\/Timebok\/\/NO$/);
  assert.equal(events(ics).length, 0);
  assert.equal(components(cal, "VTIMEZONE").length, 1);
  assert.equal(prop(cal, "METHOD"), undefined, "no METHOD: DTSTAMP then means «last revised», RFC 5545 3.8.7.2");
});

test("calendar: one booking becomes one event with service, add-ons, name, phone, Oslo times, an alarm and a stable UID", () => {
  const b = item({ date: "2026-11-19", start: 600, dur: 60, service: "Full service", addons: ["Vask kort hår", "Styling"], name: "Ola Nordmann", phone: "912 34 567", note: "Kommer litt sent", updatedAt: "2026-11-02T08:30:15.123Z", createdAt: "2026-11-01T10:00:00.000Z" });
  const ics = buildCalendar([b], { now: NOW });
  assert.deepEqual(rfc5545Problems(ics), []);
  const [ev] = events(ics);
  assert.equal(prop(ev, "UID").value, uidOf(b));
  assert.equal(text(ev, "SUMMARY"), "Full service + Vask kort hår, Styling – Ola Nordmann");
  assert.equal(text(ev, "DESCRIPTION"), "Kunde: Ola Nordmann\nTelefon: 912 34 567\nTjeneste: Full service\nTillegg: Vask kort hår, Styling\nBestilt på nettsiden");
  assert.doesNotMatch(ics, /Kommer litt sent|Notat/, "the barber's note stays in /admin");
  assert.deepEqual([prop(ev, "DTSTART").params.TZID, prop(ev, "DTSTART").value], ["Europe/Oslo", "20261119T100000"]);
  assert.equal(prop(ev, "DTEND").value, "20261119T110000");
  assert.equal(prop(ev, "DTSTAMP").value, "20261102T083015Z", "DTSTAMP = when the booking was last changed, in UTC");
  assert.equal(prop(ev, "CREATED").value, "20261101T100000Z");
  assert.equal(prop(ev, "STATUS").value, "CONFIRMED");
  const [alarm] = components(ev, "VALARM");
  assert.equal(prop(alarm, "TRIGGER").value, `-PT${ALARM_MIN}M`);
  assert.equal(prop(alarm, "ACTION").value, "DISPLAY");
  assert.equal(toUtcMs(prop(ev, "DTSTART"), parseCalendar(ics)), oslo("2026-11-19", 10, 0).getTime());
  // Same input, same text: the phone sees no change when nothing changed
  assert.equal(buildCalendar([b], { now: new Date("2027-01-01T00:00:00Z") }), ics);
});

test("calendar: cancelled bookings, blocks and broken records never appear; duplicates appear once", () => {
  const keep = item({ date: "2026-11-20", start: 660 });
  const ics = buildCalendar([
    keep, { ...keep },
    item({ date: "2026-11-20", start: 600, status: "cancelled" }),
    item({ date: "2026-11-20", start: 720, type: "block", note: "lunsj" }),
    item({ date: "2026-11-20", start: "x" }), item({ date: "2026-11-20", dur: 0 }), null,
  ], { now: NOW });
  assert.deepEqual(rfc5545Problems(ics), []);
  assert.deepEqual([...byUid(ics).keys()], [uidOf(keep)]);
  assert.doesNotMatch(ics, /lunsj/);
});

test("calendar: TEXT escaping of \\ ; , and newlines, control characters dropped (RFC 5545 3.3.11)", () => {
  assert.equal(escapeText("a\\b;c,d\ne\r\nf\rg"), "a\\\\b\\;c\\,d\\ne\\nf\\ng");
  assert.equal(escapeText("x\u0000y\u0007z\u001b\u007f\tok"), "x y z  \tok");
  const nasty = item({ date: "2026-11-21", name: "Ola; Nordmann, jr. \\ «Øks»", service: "linje1\nlinje2\r\nEND:VEVENT\r\nBEGIN:VEVENT", phone: "+47 912,34;567" });
  const ics = buildCalendar([nasty], { now: NOW });
  assert.deepEqual(rfc5545Problems(ics), []);
  const [ev] = events(ics);
  assert.equal(text(ev, "SUMMARY"), "linje1\nlinje2\nEND:VEVENT\nBEGIN:VEVENT – Ola; Nordmann, jr. \\ «Øks»");
  assert.match(text(ev, "DESCRIPTION"), /Tjeneste: linje1\nlinje2\nEND:VEVENT\nBEGIN:VEVENT\n/);
  assert.match(text(ev, "DESCRIPTION"), /Telefon: \+47 912,34;567\n/);
  assert.equal(events(ics).length, 1, "stored text can never inject a second event");
});

test("calendar: lines are folded at 75 octets with CRLF + space, never inside a character (RFC 5545 3.1)", () => {
  assert.equal(foldLine("A".repeat(75)), "A".repeat(75));
  assert.equal(foldLine("A".repeat(76)), "A".repeat(75) + "\r\n A");
  assert.equal(foldLine("B".repeat(75 + 74 + 1)), "B".repeat(75) + "\r\n " + "B".repeat(74) + "\r\n B");
  // «ø» is 2 octets, «😀» 4: none may be split
  for (const unit of ["ø", "😀", "aø", "a😀b"]) {
    for (let n = 30; n < 90; n++) {
      const line = "SUMMARY:" + unit.repeat(n);
      const folded = foldLine(line);
      for (const phys of folded.split("\r\n")) {
        assert.ok(Buffer.byteLength(phys) <= 75, `${unit} × ${n}: ${Buffer.byteLength(phys)} octets`);
        assert.equal(Buffer.from(phys).toString(), phys, "every physical line is whole UTF-8");
      }
      assert.equal(folded.replace(/\r\n /g, ""), line, "unfolding gives the line back");
    }
  }
  const long = item({ date: "2026-11-21", name: "Øyvind Ærlige Åsmund-Østergård 😀 ".repeat(6).trim(), service: "Æ".repeat(300) });
  assert.deepEqual(rfc5545Problems(buildCalendar([long], { now: NOW })), []);
});

test("calendar: DATE-TIME helpers", () => {
  assert.equal(localDateTime("2026-11-19", 0), "20261119T000000");
  assert.equal(localDateTime("2026-11-19", 9 * 60 + 5), "20261119T090500");
  assert.equal(localDateTime("2026-12-31", 1440), "20270101T000000", "an end at midnight is the next day 00:00");
  assert.equal(utcDateTime("2026-11-02T08:30:15.123Z"), "20261102T083015Z");
  assert.equal(utcDateTime("not a date"), null);
});

test("calendar: an appointment ending at midnight ends at 00:00 the next day", () => {
  const late = item({ date: "2026-12-31", start: 1410, dur: 30 });
  const ics = buildCalendar([late], { now: NOW });
  assert.deepEqual(rfc5545Problems(ics), []);
  assert.equal(prop(events(ics)[0], "DTEND").value, "20270101T000000");
});

test("calendar: Oslo times are right on both sides of the summer and winter time changes", () => {
  // 2027: summer time starts Sun 28 March 02:00, ends Sun 31 October 03:00. 2026: ends Sun 25 October.
  const days = ["2026-10-24", "2026-10-25", "2026-10-26", "2027-03-27", "2027-03-28", "2027-03-29", "2027-10-30", "2027-10-31", "2027-11-01"];
  const items = [];
  for (const date of days) for (const start of [0, 60, 180, 600, 1020, 1410]) items.push(item({ date, start, dur: 30 }));
  const ics = buildCalendar(items, { now: NOW });
  assert.deepEqual(rfc5545Problems(ics), []);
  const cal = parseCalendar(ics);
  const evs = byUid(ics);
  for (const i of items) {
    const ev = evs.get(uidOf(i));
    assert.equal(toUtcMs(prop(ev, "DTSTART"), cal), oslo(i.date, ...hm(i.start)).getTime(), `${i.date} ${i.start}`);
  }
  // The same wall-clock 10:00 is 09:00Z in winter and 08:00Z in summer
  const ten = (date) => toUtcMs(prop(evs.get(uidOf(items.find((i) => i.date === date && i.start === 600))), "DTSTART"), cal);
  assert.equal(new Date(ten("2027-03-27")).toISOString(), "2027-03-27T09:00:00.000Z");
  assert.equal(new Date(ten("2027-03-29")).toISOString(), "2027-03-29T08:00:00.000Z");
  assert.equal(new Date(ten("2027-10-30")).toISOString(), "2027-10-30T08:00:00.000Z");
  assert.equal(new Date(ten("2027-11-01")).toISOString(), "2027-11-01T09:00:00.000Z");
});

test("calendar (property): every active booking appears exactly once with the right Oslo times; nothing else appears", () => {
  const rand = rng(20261114);
  const services = ["Herreklipp", "Full service", "Barneklipp", "Knivbarbering", ""];
  for (let round = 0; round < 25; round++) {
    const items = [];
    const n = Math.floor(rand() * 40);
    for (let k = 0; k < n; k++) {
      const date = addDays("2026-10-01", Math.floor(rand() * 500)); // across two DST changes each way
      const start = 360 + 5 * Math.floor(rand() * 200);            // 06:00–22:35, never in the 02:00 gap
      const r = rand();
      items.push(item({
        date, start, dur: 5 * (1 + Math.floor(rand() * 24)),
        type: r < 0.15 ? "block" : "booking", status: r > 0.8 ? "cancelled" : "confirmed",
        service: services[Math.floor(rand() * services.length)], name: rand() < 0.1 ? "" : `Kunde ${k}, «${round}»`,
        addons: rand() < 0.3 ? ["Styling"] : [], note: rand() < 0.5 ? `Privat notat ${k}` : "",
      }));
    }
    const ics = buildCalendar(items, { now: NOW });
    assert.deepEqual(rfc5545Problems(ics), [], `round ${round}`);
    assert.doesNotMatch(ics, /Privat notat|Notat/, `round ${round}: no private note in the feed`);
    const cal = parseCalendar(ics);
    const evs = events(ics);
    const want = items.filter((i) => i.type === "booking" && i.status !== "cancelled");
    assert.deepEqual(evs.map((e) => prop(e, "UID").value).sort(), want.map(uidOf).sort(), `round ${round}: exactly the active bookings`);
    const map = byUid(ics);
    for (const i of want) {
      const ev = map.get(uidOf(i));
      assert.equal(toUtcMs(prop(ev, "DTSTART"), cal), oslo(i.date, ...hm(i.start)).getTime());
      assert.equal(prop(ev, "DTSTART").value.slice(0, 8), i.date.replace(/-/g, ""), "the event starts on its stored date");
      const end = i.start + i.dur;
      assert.equal(toUtcMs(prop(ev, "DTEND"), cal), end >= 1440 ? oslo(addDays(i.date, 1), ...hm(end - 1440)).getTime() : oslo(i.date, ...hm(end)).getTime());
      assert.ok(text(ev, "SUMMARY").startsWith(i.service || "Avtale"));
      if (i.name) assert.ok(text(ev, "SUMMARY").endsWith(" – " + i.name));
      assert.ok(text(ev, "DESCRIPTION").includes(`Telefon: ${i.phone}`));
    }
    // In time order
    const starts = evs.map((e) => toUtcMs(prop(e, "DTSTART"), cal));
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  }
});

test("calendar: the feed covers 31 days back to 366 days ahead (Oslo date) and reads from the store", async () => {
  assert.deepEqual(feedRange(new Date("2026-11-14T23:30:00Z")), { from: "2026-10-15", to: "2027-11-16" }, "00:30 on the 15th in Oslo");
  const clock = new FakeClock("2026-11-14T23:30:00Z");
  const blobs = new FakeBlobs({ clock });
  const edges = [item({ date: "2026-10-14" }), item({ date: "2026-10-15" }), item({ date: "2027-11-16" }), item({ date: "2027-11-17" })];
  seedItems(blobs, edges);
  const ics = await calendarFor(blobs.getStore({ name: "bookings", consistency: "strong" }), clock.date());
  assert.deepEqual([...byUid(ics).keys()], [edges[1], edges[2]].map(uidOf));
});

test("calendar link: 256-bit base64url tokens, exact match only, links for iPhone, Google and copying", () => {
  const tokens = new Set(Array.from({ length: 200 }, newFeedToken));
  assert.equal(tokens.size, 200);
  for (const t of tokens) assert.ok(isTokenShaped(t) && Buffer.from(t, "base64url").length === 32, t);
  const [a, b] = [...tokens];
  assert.equal(tokenMatches(a, a), true);
  assert.equal(tokenMatches(a, b), false);
  assert.equal(tokenMatches(a.slice(0, -1) + (a.endsWith("A") ? "B" : "A"), a), false);
  for (const bad of ["", null, undefined, a + "x", a.slice(1), a.toUpperCase() === a ? a.toLowerCase() : a.toUpperCase()]) assert.equal(tokenMatches(bad, a), false, String(bad));
  assert.equal(tokenMatches(a, undefined), false);
  const links = feedLinks("https://viggos.test", a);
  assert.equal(links.https, `https://viggos.test/api/calendar/${a}.ics`);
  assert.equal(links.webcal, `webcal://viggos.test/api/calendar/${a}.ics`);
  assert.equal(links.google, "https://calendar.google.com/calendar/r?cid=" + encodeURIComponent(links.webcal));
  assert.equal(feedPath(a), `/api/calendar/${a}.ics`);
});

test("calendar link: created once, kept unless replaced, replaced atomically", async () => {
  const blobs = new FakeBlobs();
  const store = blobs.getStore({ name: "bookings", consistency: "strong" });
  assert.equal(await readFeed(store), null);
  const first = await createFeed(store, { now: NOW });
  assert.equal(first.created, true);
  assert.deepEqual(blobs.json("bookings", FEED_KEY), { token: first.feed.token, createdAt: NOW.toISOString() });
  const again = await createFeed(store, { now: NOW });
  assert.deepEqual([again.created, again.feed.token], [false, first.feed.token], "creating again keeps the link");
  const renewed = await createFeed(store, { replace: true, now: NOW });
  assert.equal(renewed.created, true);
  assert.notEqual(renewed.feed.token, first.feed.token);
  assert.equal((await readFeed(store)).token, renewed.feed.token);
  // Two re-creations at the same moment: both succeed, and the stored token is the one the later write returned
  const [x, y] = await Promise.all([createFeed(store, { replace: true }), createFeed(store, { replace: true })]);
  const stored = (await readFeed(store)).token;
  assert.ok([x.feed.token, y.feed.token].includes(stored));
  assert.ok(![first.feed.token, renewed.feed.token].includes(stored));
});

test("calendar: no line of a real-sized feed is over 75 octets and every line ends in CRLF", () => {
  const items = Array.from({ length: 300 }, (_, k) => item({ date: addDays("2026-11-16", k % 60), start: 600 + 30 * (k % 16), name: `Kunde nummer ${k} med et ganske langt navn, Æsøy-Ålesund`, note: "x".repeat(k % 120) }));
  const ics = buildCalendar(items, { now: NOW });
  assert.deepEqual(rfc5545Problems(ics), []);
  assert.equal(unfold(ics).length > 300 * 15, true);
  assert.equal(events(ics).length, 300);
});
