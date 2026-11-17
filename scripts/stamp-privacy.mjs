// «Sist oppdatert» on personvern.html (round 3, still_open 20) is the date of the last change to the page's text, set
// by this step, never by hand. scripts/personvern-stamp.json holds that date and a fingerprint of the page's content:
// the visible text and the link targets, without the date line, scripts, styles, comments and spacing.
//
//   node scripts/stamp-privacy.mjs          after changing the page's text: the date becomes today (Oslo) and the
//                                           fingerprint is renewed; with the text unchanged it changes nothing
//   node scripts/stamp-privacy.mjs --check  exit 1 when the text changed without a new stamp, or the page's date is
//                                           not the stamped one. test/scripts/stamp-privacy.test.mjs runs the same
//                                           check in npm test, which Netlify runs before every deploy (netlify.toml),
//                                           so a page with a stale date never builds.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const PAGE = "viggos-barbershop/personvern.html";
export const STAMP = "scripts/personvern-stamp.json";

const MONTHS = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];
const DATE_LINE = /<p class="small">Sist oppdatert <time datetime="(\d{4}-\d{2}-\d{2})">([^<]*)<\/time>\.<\/p>/;
const DATE_LINE_ALL = new RegExp(DATE_LINE.source, "g");

export const norwegianDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d}. ${MONTHS[m - 1]} ${y}`;
};

// Today's date in Oslo as YYYY-MM-DD
export function osloToday(now = new Date()) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// What the visitor reads (and where the links go), without the date line itself
export function content(html) {
  return html.replace(DATE_LINE_ALL, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<a\b[^>]*?\shref="([^"]*)"[^>]*>/gi, " [$1] ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const fingerprint = (html) => createHash("sha256").update(content(html), "utf8").digest("hex").slice(0, 16);

export function shownDate(html) {
  const m = DATE_LINE.exec(html);
  return m ? { iso: m[1], text: m[2] } : null;
}

// What is wrong with the page against its stamp ([] = nothing)
export function problems(html, stamp) {
  const shown = shownDate(html);
  if (!shown) return [`${PAGE} has no line «<p class="small">Sist oppdatert <time datetime="YYYY-MM-DD">…</time>.</p>»`];
  const out = [];
  if (shown.text !== norwegianDate(shown.iso)) out.push(`the date reads «${shown.text}», but its datetime ${shown.iso} is «${norwegianDate(shown.iso)}»`);
  if (!stamp || fingerprint(html) !== stamp.text) {
    out.push(`the text of ${PAGE} changed after its «Sist oppdatert» stamp${stamp ? ` (${stamp.date})` : ""}: run node scripts/stamp-privacy.mjs`);
  } else if (shown.iso !== stamp.date) {
    out.push(`the page says ${shown.iso}, but the text was stamped on ${stamp.date}: run node scripts/stamp-privacy.mjs`);
  }
  return out;
}

// The stamp step: a changed text gets today's date; an unchanged text keeps its stamp, whatever day the step runs.
// html: null when the page has no date line (the step does not invent one).
export function restamp(html, stamp, today) {
  const text = fingerprint(html);
  const date = stamp && stamp.text === text ? stamp.date : today;
  const line = `<p class="small">Sist oppdatert <time datetime="${date}">${norwegianDate(date)}</time>.</p>`;
  return { html: DATE_LINE.test(html) ? html.replace(DATE_LINE, () => line) : null, stamp: { date, text } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const html = readFileSync(ROOT + PAGE, "utf8");
  let stamp = null;
  try { stamp = JSON.parse(readFileSync(ROOT + STAMP, "utf8")); } catch (e) { stamp = null; }
  if (process.argv.includes("--check")) {
    const list = problems(html, stamp);
    for (const p of list) console.error(`stamp-privacy: ${p}`);
    if (!list.length) console.log(`stamp-privacy OK: «Sist oppdatert ${norwegianDate(stamp.date)}» matches the text`);
    process.exit(list.length ? 1 : 0);
  }
  const next = restamp(html, stamp, osloToday());
  if (next.html === null) {
    console.error(problems(html, stamp)[0]);
    process.exit(1);
  }
  if (next.html !== html) writeFileSync(ROOT + PAGE, next.html);
  writeFileSync(ROOT + STAMP, JSON.stringify(next.stamp, null, 2) + "\n");
  console.log(`stamp-privacy: «Sist oppdatert ${norwegianDate(next.stamp.date)}»${stamp && stamp.date === next.stamp.date ? " (the text is unchanged)" : ""}`);
}
