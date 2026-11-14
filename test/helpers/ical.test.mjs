// The RFC 5545 reader in ical.mjs must catch each broken rule on its own, or a passing calendar test proves
// nothing. Each case below breaks one rule in an otherwise valid stream.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rfc5545Problems, parseCalendar, components, prop, toUtcMs, parseDuration, eventEndMs } from "./ical.mjs";

const VTZ = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Oslo",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
  "END:VTIMEZONE",
];
const EVENT = ["BEGIN:VEVENT", "UID:a@x", "DTSTAMP:20261101T100000Z", "DTSTART;TZID=Europe/Oslo:20261119T100000", "DTEND;TZID=Europe/Oslo:20261119T103000", "SUMMARY:Herreklipp – Ola", "END:VEVENT"];
const cal = (lines) => lines.join("\r\n") + "\r\n";
const good = (over = {}) => {
  const ev = EVENT.map((l) => { const k = l.split(/[;:]/)[0]; return k in over ? over[k] : l; }).filter((l) => l !== null);
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//t//t//NO", ...VTZ, ...ev, "END:VCALENDAR"];
};
const fails = (ics, re) => {
  const p = rfc5545Problems(ics);
  assert.ok(p.some((m) => re.test(m)), `expected a problem matching ${re}, got ${JSON.stringify(p)}`);
};

test("ical reader: a valid stream has no problems", () => {
  assert.deepEqual(rfc5545Problems(cal(good())), []);
});

test("ical reader: catches line-ending, length and folding mistakes", () => {
  fails(good().join("\n") + "\n", /bare LF/);
  fails(good().join("\r\n"), /does not end in CRLF/);
  fails(cal(good({ SUMMARY: "SUMMARY:" + "x".repeat(80) })), /octets \(> 75\)/);
  const long = "SUMMARY:" + "x".repeat(66) + "😀";
  fails(cal(good({ SUMMARY: long.slice(0, 75) + "\r\n " + long.slice(75) })), /splits a character/);
  fails(cal(good({ SUMMARY: "SUMMARY:x\r\n\r\n y" })), /empty/);
});

test("ical reader: catches unescaped TEXT and control characters", () => {
  fails(cal(good({ SUMMARY: "SUMMARY:Ola, Nordmann" })), /unescaped/);
  fails(cal(good({ SUMMARY: "SUMMARY:Ola; Nordmann" })), /unescaped/);
  fails(cal(good({ SUMMARY: "SUMMARY:C:\\temp" })), /unescaped/);
  fails(cal(good({ SUMMARY: "SUMMARY:Ola\u0007" })), /control character/);
  assert.deepEqual(rfc5545Problems(cal(good({ SUMMARY: "SUMMARY:Ola\\, Nordmann\\; \\\\ \\n" }))), []);
});

test("ical reader: catches missing or bad required properties", () => {
  fails(cal(good({ UID: null })), /exactly one UID/);
  fails(cal(good({ DTSTAMP: null })), /exactly one DTSTAMP/);
  fails(cal(good({ DTSTAMP: "DTSTAMP:20261101T100000" })), /DTSTAMP must be UTC/);
  fails(cal(good({ DTEND: "DTEND;TZID=Europe/Oslo:20261119T090000" })), /DTEND is not after DTSTART/);
  fails(cal(good({ DTEND: "DTEND;TZID=Europe/Oslo:20261119T100000" })), /DTEND is not after DTSTART/);
  // The spring-forward night: 02:00–03:00 does not exist, so 02:00 → 03:00 is zero minutes of real time (3.3.5)
  fails(cal(good({ DTSTART: "DTSTART;TZID=Europe/Oslo:20270328T020000", DTEND: "DTEND;TZID=Europe/Oslo:20270328T030000" })), /DTEND is not after DTSTART/);
  fails(cal(good({ DTEND: "DURATION:PT0M" })), /DURATION must be positive/);
  fails(cal(good({ DTEND: "DURATION:-PT30M" })), /DURATION must be positive/);
  fails(cal(good({ DTEND: "DURATION:30M" })), /not a DURATION/);
  assert.deepEqual(rfc5545Problems(cal(good({ DTEND: "DURATION:PT30M" }))), []);
  assert.deepEqual(rfc5545Problems(cal(good({ DTSTART: "DTSTART;TZID=Europe/Oslo:20270328T020000", DTEND: "DURATION:PT60M" }))), []);
  const both = good();
  both.splice(both.indexOf("END:VEVENT"), 0, "DURATION:PT30M");
  fails(cal(both), /both DTEND and DURATION/);
  fails(cal(good({ DTSTART: "DTSTART;TZID=Europe/Paris:20261119T100000" })), /without a VTIMEZONE/);
  fails(cal(good().filter((l) => !l.startsWith("VERSION"))), /VERSION/);
  fails(cal(good().filter((l) => !l.startsWith("PRODID"))), /PRODID/);
  const twice = good();
  twice.splice(twice.length - 1, 0, ...EVENT);
  fails(cal(twice), /UID a@x twice/);
  fails(cal(good().filter((l) => l !== "END:VEVENT")), /closes|unclosed/);
  fails(cal(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:x", "END:VCALENDAR"]), /at least one component/);
  const alarm = good();
  alarm.splice(alarm.indexOf("END:VEVENT"), 0, "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "END:VALARM");
  fails(cal(alarm), /DISPLAY needs DESCRIPTION/);
});

test("ical reader: resolves TZID by the stream's own VTIMEZONE, so a wrong VTIMEZONE gives wrong instants", () => {
  const parsed = parseCalendar(cal(good()));
  const start = prop(components(parsed, "VEVENT")[0], "DTSTART");
  assert.equal(new Date(toUtcMs(start, parsed)).toISOString(), "2026-11-19T09:00:00.000Z");
  const summer = { ...start, value: "20270615T100000" };
  assert.equal(new Date(toUtcMs(summer, parsed)).toISOString(), "2027-06-15T08:00:00.000Z");
  assert.throws(() => toUtcMs({ ...start, value: "20270328T023000" }, parsed), /does not exist/);
  // RFC 5545 3.3.5: a skipped local time uses the offset before the change (+01:00), so 02:30 is 01:30Z (03:30 CEST)
  assert.equal(new Date(toUtcMs({ ...start, value: "20270328T023000" }, parsed, { resolve: true })).toISOString(), "2027-03-28T01:30:00.000Z");
  assert.equal(new Date(toUtcMs({ ...start, value: "20270328T020000" }, parsed, { resolve: true })).toISOString(), "2027-03-28T01:00:00.000Z");
  assert.equal(new Date(toUtcMs({ ...start, value: "20270328T030000" }, parsed, { resolve: true })).toISOString(), "2027-03-28T01:00:00.000Z", "03:00 CEST is the same instant");
  assert.equal(new Date(toUtcMs({ ...start, value: "20270328T015500" }, parsed, { resolve: true })).toISOString(), "2027-03-28T00:55:00.000Z");
  assert.equal(new Date(toUtcMs({ ...start, value: "20271031T023000" }, parsed)).toISOString(), "2027-10-31T00:30:00.000Z", "an ambiguous time is its first occurrence");
  // Offsets swapped: the reader now gives 10:00 in November as 08:00Z, which the calendar tests would catch
  const swapped = parseCalendar(cal(good().map((l) => l.replace("TZOFFSETTO:+0100", "TZOFFSETTO:+0X").replace("TZOFFSETTO:+0200", "TZOFFSETTO:+0100").replace("TZOFFSETTO:+0X", "TZOFFSETTO:+0200"))));
  assert.notEqual(toUtcMs(prop(components(swapped, "VEVENT")[0], "DTSTART"), swapped), toUtcMs(start, parsed));
});

test("ical reader: DURATION (RFC 5545 3.3.6): hours, minutes and seconds are exact, days and weeks nominal", () => {
  assert.deepEqual(parseDuration("PT90M"), { sign: 1, days: 0, exactMs: 90 * 60e3 });
  assert.deepEqual(parseDuration("PT1H30M"), { sign: 1, days: 0, exactMs: 90 * 60e3 });
  assert.deepEqual(parseDuration("-PT15M"), { sign: -1, days: 0, exactMs: 15 * 60e3 });
  assert.deepEqual(parseDuration("P1DT2H"), { sign: 1, days: 1, exactMs: 2 * 3600e3 });
  assert.deepEqual(parseDuration("P2W"), { sign: 1, days: 14, exactMs: 0 });
  for (const bad of ["P", "PT", "P1DT", "30M", "PT1.5H", "P1H", "pt30m"]) assert.throws(() => parseDuration(bad), /not a DURATION/, bad);
  const at = (lines) => { const c = parseCalendar(cal(good(lines))); return [c, components(c, "VEVENT")[0]]; };
  // Over the spring-forward night: 01:30 CET (00:30Z) + PT60M ends 01:30Z = 03:30 CEST, exactly 60 minutes later
  let [c, ev] = at({ DTSTART: "DTSTART;TZID=Europe/Oslo:20270328T013000", DTEND: "DURATION:PT60M" });
  assert.equal(eventEndMs(ev, c) - toUtcMs(prop(ev, "DTSTART"), c), 60 * 60e3);
  // A nominal day keeps the wall-clock time: 10:00 Saturday + P1D = 10:00 Sunday, 23 hours later in real time
  [c, ev] = at({ DTSTART: "DTSTART;TZID=Europe/Oslo:20270327T100000", DTEND: "DURATION:P1D" });
  assert.equal(eventEndMs(ev, c) - toUtcMs(prop(ev, "DTSTART"), c), 23 * 3600e3);
  // No DTEND and no DURATION: a DATE-TIME event ends when it starts (3.6.1)
  [c, ev] = at({ DTEND: null });
  assert.equal(eventEndMs(ev, c), toUtcMs(prop(ev, "DTSTART"), c));
});
