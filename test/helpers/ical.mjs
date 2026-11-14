// An independent RFC 5545 reader for the tests: it shares no code with netlify/lib/calendar.mjs.
//
//   rfc5545Problems(text) → [] or a list of broken rules:
//     3.1   every line ends in CRLF (no bare CR or LF), the stream ends in CRLF, no physical line is longer than
//           75 octets, a fold is CRLF + one space/tab, folds never split a UTF-8 sequence, no empty content line;
//     3.1   every unfolded content line is  name *(";" param) ":" value  with valid names and param values;
//     3.3.11 TEXT values: «\», «;», «,» and newlines are escaped, and no control characters (except HTAB);
//     3.4/3.6 one VCALENDAR with VERSION:2.0 and PRODID exactly once and at least one component; BEGIN/END nest;
//     3.6.1 every VEVENT has exactly one UID, DTSTAMP (UTC, «…Z»), DTSTART; it ends after it starts (DTEND, or
//           DTSTART + a positive DURATION, 3.3.6), judged in real time with 3.3.5 for DST nights; not both DTEND
//           and DURATION; UIDs are unique;
//     3.6.5 every TZID= used names a VTIMEZONE in the stream, each with STANDARD/DAYLIGHT parts that have
//           DTSTART, TZOFFSETFROM and TZOFFSETTO;
//     3.6.6 every VALARM has ACTION and TRIGGER, and a DISPLAY alarm has DESCRIPTION.
//   parseCalendar(text) → { name: "VCALENDAR", props: [{ name, params, value }], children: [...] }
//   prop(comp, "SUMMARY") → first property, text(comp, "SUMMARY") → its unescaped TEXT value
//   toUtcMs(prop, calendar) → the instant a DATE-TIME property means, resolving TZID with the stream's own
//     VTIMEZONE rules (RRULE FREQ=YEARLY;BYMONTH=m;BYDAY=nSU/-1SU), never with Intl. The tests compare it
//     with Intl's Europe/Oslo to prove the VTIMEZONE is right across DST changes. { resolve: true } applies
//     RFC 5545 3.3.5 to a local time skipped by summer time (otherwise it throws).
//   parseDuration(value) → { sign, days, exactMs } (3.3.6); eventEndMs(vevent, calendar) → when it ends.
const NAME = /^(?:[A-Za-z0-9-]+)$/;
const TEXT_PROPS = new Set(["SUMMARY", "DESCRIPTION", "LOCATION", "COMMENT", "NAME", "X-WR-CALNAME", "CATEGORIES", "CONTACT", "TZNAME"]);
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

function contentLine(line) {
  // name *(";" param) ":" value — param values may be quoted (and then contain ; : ,)
  let i = 0;
  const name = /^[A-Za-z0-9-]+/.exec(line);
  if (!name) return null;
  i = name[0].length;
  const params = {};
  while (line[i] === ";") {
    const pm = /^;([A-Za-z0-9-]+)=/.exec(line.slice(i));
    if (!pm) return null;
    i += pm[0].length;
    const values = [];
    for (;;) {
      if (line[i] === '"') {
        const end = line.indexOf('"', i + 1);
        if (end < 0) return null;
        values.push(line.slice(i + 1, end));
        i = end + 1;
      } else {
        const v = /^[^";:,]*/.exec(line.slice(i))[0];
        values.push(v);
        i += v.length;
      }
      if (line[i] === ",") { i++; continue; }
      break;
    }
    params[pm[1].toUpperCase()] = values.length === 1 ? values[0] : values;
  }
  if (line[i] !== ":") return null;
  return { name: name[0].toUpperCase(), params, value: line.slice(i + 1) };
}

export function unfold(text) {
  return text.replace(/\r\n[ \t]/g, "").split("\r\n").slice(0, -1);
}

export function parseCalendar(text) {
  const root = { name: null, props: [], children: [] };
  const stack = [root];
  for (const raw of unfold(text)) {
    const p = contentLine(raw);
    if (!p) throw new Error(`not a content line: ${raw}`);
    const top = stack[stack.length - 1];
    if (p.name === "BEGIN") { const c = { name: p.value.toUpperCase(), props: [], children: [] }; top.children.push(c); stack.push(c); }
    else if (p.name === "END") { if (top.name !== p.value.toUpperCase()) throw new Error(`END:${p.value} closes ${top.name}`); stack.pop(); }
    else top.props.push(p);
  }
  if (stack.length !== 1) throw new Error(`unclosed ${stack[stack.length - 1].name}`);
  if (root.children.length !== 1 || root.props.length) throw new Error("the stream must be exactly one VCALENDAR");
  return root.children[0];
}

export const props = (comp, name) => comp.props.filter((p) => p.name === name);
export const prop = (comp, name) => props(comp, name)[0];
export const unescapeText = (v) => v.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
export const text = (comp, name) => { const p = prop(comp, name); return p ? unescapeText(p.value) : undefined; };
export const components = (comp, name) => comp.children.filter((c) => c.name === name);

// ---------- time ----------
const DT = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;
const fieldsMs = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s);
const offsetMin = (v) => { const m = /^([+-])(\d{2})(\d{2})$/.exec(v); if (!m) throw new Error(`bad UTC offset ${v}`); return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])); };

// Wall-clock onsets (as "local ms", i.e. UTC fields holding local time) of an observance in a year
function onsetLocal(obs, year) {
  const start = DT.exec(prop(obs, "DTSTART").value);
  const [hh, mm, ss] = [Number(start[4]), Number(start[5]), Number(start[6])];
  const rrule = prop(obs, "RRULE");
  if (!rrule) return year === Number(start[1]) ? [fieldsMs(Number(start[1]), Number(start[2]), Number(start[3]), hh, mm, ss)] : [];
  const r = Object.fromEntries(rrule.value.split(";").map((kv) => kv.split("=")));
  if (r.FREQ !== "YEARLY" || !r.BYMONTH || !/^-?\d?SU$/.test(r.BYDAY || "")) throw new Error(`RRULE not understood by the test reader: ${rrule.value}`);
  if (year < Number(start[1])) return [];
  const month = Number(r.BYMONTH);
  const n = Number(r.BYDAY.slice(0, -2) || 1);
  const sundays = [];
  for (let d = 1; d <= 31; d++) {
    const t = new Date(Date.UTC(year, month - 1, d));
    if (t.getUTCMonth() !== month - 1) break;
    if (t.getUTCDay() === 0) sundays.push(d);
  }
  const day = n < 0 ? sundays[sundays.length + n] : sundays[n - 1];
  return [fieldsMs(year, month, day, hh, mm, ss)];
}

// Observances of a VTIMEZONE as UTC onsets around a year: [{ utc, offsetFrom, offsetTo }], sorted
function transitions(vtz, year) {
  const out = [];
  for (const obs of vtz.children.filter((c) => c.name === "STANDARD" || c.name === "DAYLIGHT")) {
    const from = offsetMin(prop(obs, "TZOFFSETFROM").value), to = offsetMin(prop(obs, "TZOFFSETTO").value);
    for (const y of [year - 1, year, year + 1]) for (const local of onsetLocal(obs, y)) out.push({ utc: local - from * 60e3, offsetFrom: from, offsetTo: to, kind: obs.name });
  }
  return out.sort((a, b) => a.utc - b.utc);
}

// { resolve: true } applies RFC 5545 3.3.5 to a local time that does not exist (the hour skipped when summer time
// starts): it «is interpreted using the UTC offset before the transition». Without it such a time throws, so a test
// that never expects one notices at once. An ambiguous time (the hour repeated in October) is always its first
// occurrence, as 3.3.5 says.
export function toUtcMs(p, calendar, { resolve = false } = {}) {
  const m = DT.exec(p.value);
  if (!m) throw new Error(`not a DATE-TIME: ${p.value}`);
  const local = fieldsMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  if (m[7] === "Z") return local;
  const tzid = p.params.TZID;
  if (!tzid) throw new Error(`floating time ${p.value}: the tests require a TZID or UTC`);
  const vtz = components(calendar, "VTIMEZONE").find((z) => prop(z, "TZID").value === tzid);
  if (!vtz) throw new Error(`no VTIMEZONE for ${tzid}`);
  const ts = transitions(vtz, Number(m[1]));
  const inEffect = (utc) => { let cur = null; for (const t of ts) if (t.utc <= utc) cur = t; return cur; };
  // Try each offset: the right one is the offset in effect at the instant it gives
  const fits = [...new Set(ts.map((t) => t.offsetTo))].map((off) => local - off * 60e3).filter((utc) => {
    const cur = inEffect(utc);
    return cur && local - cur.offsetTo * 60e3 === utc;
  }).sort((a, b) => a - b);
  if (fits.length) return fits[0];
  if (resolve) {
    const gap = ts.find((t) => t.offsetTo > t.offsetFrom && local >= t.utc + t.offsetFrom * 60e3 && local < t.utc + t.offsetTo * 60e3);
    if (gap) return local - gap.offsetFrom * 60e3;
  }
  throw new Error(`${p.value} does not exist in ${tzid}`);
}

// RFC 5545 3.3.6 DURATION: «PT90M», «P1DT2H», «P2W», «-PT15M». Weeks and days are nominal (calendar days in local
// time); hours, minutes and seconds are exact. → { sign, days, exactMs }
export function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W|(\d+)D(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?|T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)$/.exec(String(v));
  if (!m || /T$/.test(v)) throw new Error(`not a DURATION: ${v}`);
  const n = (i) => Number(m[i] || 0);
  const days = m[2] !== undefined ? 7 * n(2) : n(3);
  const exactMs = ((n(4) + n(7)) * 3600 + (n(5) + n(8)) * 60 + n(6) + n(9)) * 1000;
  return { sign: m[1] === "-" ? -1 : 1, days, exactMs };
}

// When a VEVENT ends (RFC 5545 3.6.1 and 3.8.5): DTEND if it has one; else DTSTART + DURATION (days added on the
// local calendar, then the exact part); else, for a DATE-TIME start, the same instant as DTSTART.
export function eventEndMs(ev, calendar) {
  const start = prop(ev, "DTSTART");
  if (prop(ev, "DTEND")) return toUtcMs(prop(ev, "DTEND"), calendar, { resolve: true });
  const dur = prop(ev, "DURATION");
  if (!dur) return toUtcMs(start, calendar, { resolve: true });
  const { sign, days, exactMs } = parseDuration(dur.value);
  let base = start;
  if (days) {
    const m = DT.exec(start.value);
    const shifted = new Date(fieldsMs(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0) + sign * days * 864e5).toISOString().slice(0, 10).replace(/-/g, "");
    base = { ...start, value: `${shifted}T${m[4]}${m[5]}${m[6]}${m[7]}` };
  }
  return toUtcMs(base, calendar, { resolve: true }) + sign * exactMs;
}

// ---------- the rules ----------
export function rfc5545Problems(text) {
  const problems = [];
  const bad = (msg) => { if (problems.length < 50) problems.push(msg); };
  if (!text.endsWith("\r\n")) bad("the stream does not end in CRLF");
  if (/\r(?!\n)/.test(text)) bad("a bare CR");
  if (/(^|[^\r])\n/.test(text)) bad("a bare LF (lines must end in CRLF)");
  const physical = text.split("\r\n").slice(0, -1);
  physical.forEach((l, n) => {
    const octets = Buffer.byteLength(l, "utf8");
    if (octets > 75) bad(`line ${n + 1} has ${octets} octets (> 75): ${l.slice(0, 40)}…`);
    if (/[\ud800-\udbff]$/.test(l) || /^[ \t]?[\udc00-\udfff]/.test(l)) bad(`line ${n + 1}: a fold splits a character`);
    if (Buffer.from(l, "utf8").toString("utf8") !== l) bad(`line ${n + 1}: not valid UTF-8`);
    if (l === "") bad(`line ${n + 1} is empty`);
  });
  let cal;
  try { cal = parseCalendar(text); } catch (err) { bad(err.message); return problems; }
  for (const raw of unfold(text)) {
    const p = contentLine(raw);
    if (!NAME.test(p.name)) bad(`bad property name ${p.name}`);
    if (CONTROL.test(p.value)) bad(`${p.name}: control character in the value`);
    if (TEXT_PROPS.has(p.name) && !/^(?:[^\\;,]|\\[\\;,nN])*$/.test(p.value)) bad(`${p.name}: unescaped \\ ; or , in TEXT «${p.value.slice(0, 60)}»`);
  }
  if (cal.name !== "VCALENDAR") bad(`top component is ${cal.name}`);
  if (props(cal, "VERSION").length !== 1 || prop(cal, "VERSION")?.value !== "2.0") bad("VCALENDAR needs VERSION:2.0 exactly once");
  if (props(cal, "PRODID").length !== 1) bad("VCALENDAR needs PRODID exactly once");
  if (!cal.children.length) bad("VCALENDAR needs at least one component");
  const tzids = new Set(components(cal, "VTIMEZONE").map((z) => prop(z, "TZID")?.value));
  for (const z of components(cal, "VTIMEZONE")) {
    const obs = z.children.filter((c) => c.name === "STANDARD" || c.name === "DAYLIGHT");
    if (!obs.length) bad(`VTIMEZONE ${prop(z, "TZID")?.value} has no STANDARD/DAYLIGHT`);
    for (const o of obs) for (const k of ["DTSTART", "TZOFFSETFROM", "TZOFFSETTO"]) if (props(o, k).length !== 1) bad(`VTIMEZONE ${o.name} needs ${k}`);
  }
  const uids = new Set();
  const walk = (comp) => {
    for (const p of comp.props) if (p.params.TZID && !tzids.has(p.params.TZID)) bad(`${p.name} uses TZID=${p.params.TZID} without a VTIMEZONE`);
    comp.children.forEach(walk);
  };
  walk(cal);
  for (const ev of components(cal, "VEVENT")) {
    const uid = prop(ev, "UID")?.value;
    for (const k of ["UID", "DTSTAMP", "DTSTART"]) if (props(ev, k).length !== 1) bad(`VEVENT ${uid}: needs exactly one ${k}`);
    if (uids.has(uid)) bad(`UID ${uid} twice`);
    uids.add(uid);
    if (!/^\d{8}T\d{6}Z$/.test(prop(ev, "DTSTAMP")?.value || "")) bad(`VEVENT ${uid}: DTSTAMP must be UTC: ${prop(ev, "DTSTAMP")?.value}`);
    for (const k of ["CREATED", "LAST-MODIFIED"]) if (prop(ev, k) && !/^\d{8}T\d{6}Z$/.test(prop(ev, k).value)) bad(`VEVENT ${uid}: ${k} must be UTC`);
    if (prop(ev, "DTEND") && prop(ev, "DURATION")) bad(`VEVENT ${uid}: both DTEND and DURATION`);
    if (props(ev, "DURATION").length > 1) bad(`VEVENT ${uid}: DURATION more than once`);
    if (prop(ev, "DURATION")) {
      try { const d = parseDuration(prop(ev, "DURATION").value); if (d.sign < 0 || (!d.days && !d.exactMs)) bad(`VEVENT ${uid}: DURATION must be positive`); } catch (err) { bad(`VEVENT ${uid}: ${err.message}`); }
    }
    if ((prop(ev, "DTEND") || prop(ev, "DURATION")) && prop(ev, "DTSTART")) {
      // 3.6.1: «the "DTEND" property … MUST be specified as a date with local time [that is] later in time than
      // the value of the "DTSTART" property». Local times are resolved by 3.3.5, so a DST night is judged right.
      try {
        if (eventEndMs(ev, cal) <= toUtcMs(prop(ev, "DTSTART"), cal, { resolve: true })) bad(`VEVENT ${uid}: ${prop(ev, "DTEND") ? "DTEND" : "DTSTART + DURATION"} is not after DTSTART`);
      } catch (err) { bad(`VEVENT ${uid}: ${err.message}`); }
    }
    for (const a of components(ev, "VALARM")) {
      if (props(a, "ACTION").length !== 1 || props(a, "TRIGGER").length !== 1) bad(`VALARM in ${uid}: needs ACTION and TRIGGER`);
      if (prop(a, "ACTION")?.value === "DISPLAY" && !prop(a, "DESCRIPTION")) bad(`VALARM in ${uid}: DISPLAY needs DESCRIPTION`);
    }
  }
  return problems;
}
