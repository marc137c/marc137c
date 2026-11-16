// Owner decision D6 (F11, F36): personvern.html states verified facts only, matches the flows that actually ship,
// and is linked from the footer and under the booking button. The facts come from the code, not from memory:
// the retention periods are imported, and every external flow found in the code must be named on the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RETENTION_DAYS, STATS_KEEP_DAYS, COUNTER_MAX_AGE_MS } from "../../netlify/lib/store-keys.mjs";
import { PUSH_SERVICES } from "../../netlify/lib/push.mjs";
import { SOURCES } from "../../netlify/functions/stats.mjs";
import { parseDocument } from "../helpers/mini-dom.mjs";
import { loadSite } from "../helpers/site-page.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SITE = ROOT + "viggos-barbershop/";
const read = (f) => readFileSync(SITE + f, "utf8");
const readRoot = (f) => readFileSync(ROOT + f, "utf8");
// The page's visible text, without tags and with collapsed spaces
const pageText = () => read("personvern.html").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

test("D6: personvern.html exists, is Norwegian and names the controller exactly as in README «Bedriftsinfo (bekreftet)»", () => {
  assert.ok(existsSync(SITE + "personvern.html"));
  const html = read("personvern.html");
  assert.match(html, /<html lang="nb">/);
  assert.match(html, /<title>[^<]*Personvern[^<]*<\/title>/);
  const readme = read("README.md");
  const text = pageText();
  for (const fact of ["Viggos Barbershop Kurti", "937 845 812", "Violgata 22", "1776 Halden", "409 63 911", "kurtivigan1@gmail.com"]) {
    assert.ok(readme.includes(fact), `README confirms ${fact}`);
    assert.ok(text.includes(fact), `the page names ${fact}`);
  }
  assert.match(html, /href="tel:\+4740963911"/);
  assert.match(html, /href="mailto:kurtivigan1@gmail\.com"/);
});

test("D6: what is collected, why, on what basis, for how long, and the visitor's rights", () => {
  const text = pageText();
  for (const word of ["navn", "telefonnummer", "tjeneste", "tillegg", "dato", "klokkeslett"]) assert.ok(text.toLowerCase().includes(word), word);
  assert.ok(text.includes("artikkel 6 nr. 1 bokstav b"), "GDPR art. 6(1)(b)");
  assert.ok(text.includes(`${RETENTION_DAYS} dager`), `bookings are deleted ${RETENTION_DAYS} dager after the appointment`);
  assert.ok(text.includes(`${COUNTER_MAX_AGE_MS / 3600000} timer`), "abuse counters: 24 timer");
});

// Round 2 (SPEC R30): every retention period on the page is the worst-case lifetime: the threshold plus the time
// until the next scheduled clean-up (retention.mjs config.schedule). «De slettes 24 timer etter siste forsøk» was
// false: a counter could live about 48 hours. test/functions/retention.test.mjs checks the code against the same sums.
test("D6 round 2: the page states each worst case (threshold + one clean-up interval), and no shorter promise", async () => {
  const { config } = await import("../../netlify/functions/retention.mjs");
  const every = { "@hourly": 3600e3, "@daily": 864e5 }[config.schedule];
  assert.ok(every, config.schedule);
  const text = pageText();
  const counterH = (COUNTER_MAX_AGE_MS + every) / 3600e3;
  assert.ok(text.includes(`senest etter ${counterH} timer`), `abuse counters: senest etter ${counterH} timer`);
  assert.ok(!/slettes 24 timer etter siste forsøk/.test(text), "never «slettes 24 timer etter siste forsøk»");
  assert.ok(text.includes(`senest ${RETENTION_DAYS + every / 864e5} dager etter timedatoen`), "bookings: the worst case");
  assert.ok(text.includes(`senest etter ${STATS_KEEP_DAYS + every / 864e5} dager`), "statistics: the worst case");
  const spec = readRoot("docs/SPEC.md"), deploy = readRoot("DEPLOY.md");
  assert.ok(spec.includes(`at the latest ${counterH} hours`), "SPEC states the counters' worst case");
  assert.ok(!/deleted 24 hours after the newest attempt/.test(spec));
  assert.ok(!/slettes etter 24 timer\)/.test(deploy), "DEPLOY.md does not promise 24 hours");
  for (const right of ["innsyn", "retting", "sletting", "Datatilsynet"]) assert.ok(text.includes(right), right);
  assert.match(read("personvern.html"), /href="https:\/\/www\.datatilsynet\.no\/"/);
});

test("D6: every external flow in the code is named on the page", () => {
  const text = pageText();
  const index = read("index.html");
  if (/google\.com\/maps/.test(index)) assert.ok(text.includes("Google Maps"), "the map and directions: Google Maps");
  if (/r\.photo/.test(read("reviews.js"))) assert.ok(/Google/.test(text) && text.includes("anmeld"), "reviewer photos come from Google");
  if (/<img[^>]*p\.image/.test(read("social-feed.js"))) assert.ok(text.includes("Instagram") && text.includes("Meta"), "Instagram images (Meta)");
  for (const svc of PUSH_SERVICES) {
    const company = svc.name.split(" ")[0];
    assert.ok(text.includes(company), `push service ${svc.name} → ${company}`);
  }
  if (/feedLinks/.test(readRoot("netlify/lib/calendar.mjs"))) assert.ok(text.includes("kalender") && text.includes("iCloud") && text.includes("Google Kalender"), "the barber's phone calendar");
  assert.ok(text.includes("Netlify"), "Netlify hosts the site, the functions and the storage");
  assert.ok(text.includes("Netlify Blobs"));
  // D2: no Forms copy, so the page never names Netlify Forms, and index.html never asks Netlify to collect a form
  assert.doesNotMatch(index, /data-netlify/);
  assert.ok(!text.includes("Netlify Forms"));
});

test("D6: the page does not claim flows that no longer exist", () => {
  const text = pageText();
  assert.ok(!/fonts\.googleapis|Google Fonts lastes|lastes fra Google Fonts/.test(read("personvern.html")), "fonts are self-hosted (F47)");
  assert.ok(text.includes("Google Fonts"), "and the page says they are not loaded from Google Fonts");
  assert.ok(!/e-post med bestillingen|bekreftelse på e-post/i.test(text), "no booking e-mail exists");
});

test("D6: the visitor statistics are described as they are built (stats.mjs)", () => {
  const text = pageText();
  assert.ok(text.includes("informasjonskapsler"), "says no cookies");
  assert.ok(text.includes("IP-adresse"), "says no IP address is stored");
  assert.ok(text.includes(`${STATS_KEEP_DAYS} dager`), `kept ${STATS_KEEP_DAYS} dager`);
  const names = { instagram: "Instagram", facebook: "Facebook", google: "Google", tiktok: "TikTok", direkte: "direkte", annet: "annet" };
  for (const s of SOURCES) assert.ok(text.includes(names[s]), `source ${s}`);
  const stats = readRoot("netlify/functions/stats.mjs");
  assert.doesNotMatch(stats, /set-cookie|document\.cookie/i, "stats.mjs sets no cookie");
  assert.doesNotMatch(read("script.js"), /document\.cookie/, "the page sets no cookie");
});

test("D6: personvern.html counts its own visit like the front page (page «personvern» in stats.mjs)", async () => {
  assert.match(readRoot("netlify/functions/stats.mjs"), /personvern/);
  const site = await loadSite({ page: "personvern.html", inline: true });
  assert.equal(site.beacons.length, 1);
  assert.equal(site.beacons[0].url, "/api/hit");
  assert.equal(JSON.parse(site.beacons[0].body).p, "/personvern.html");
});

test("D6: index.html links personvern.html from the footer and under the booking button (both languages)", async () => {
  const doc = parseDocument(read("index.html"));
  assert.ok(doc.querySelector('.site-footer a[href="/personvern.html"]'), "footer link");
  const note = doc.querySelector("form.booking .booking-privacy");
  assert.ok(note, "a privacy line in the booking form");
  const siblings = note.parentNode.children;
  const prev = siblings[siblings.indexOf(note) - 1];
  assert.ok(prev && prev.localName === "button" && prev.getAttribute("type") === "submit", "right under the booking button");
  assert.ok(note.querySelector('a[href="/personvern.html"]'));
  const en = await loadSite({ lang: "en" });
  const line = en.qs(".booking-privacy");
  assert.match(line.textContent, /name and phone number/);
  assert.ok(line.querySelector('a[href="/personvern.html"]'), "the English line links too");
});

// Round 2 (SPEC R31): a link from another page to /#x must land at #x. The front page opens at the top and drops
// anchors, except those script.js names in START_AT (site-script.test.mjs proves it scrolls there).
test("D6 round 2: every /#anchor link from personvern.html and 404.html is one the front page opens at", () => {
  const allowed = (/const START_AT = \[([^\]]*)\]/.exec(read("script.js")) || [, ""])[1].match(/"[^"]+"/g) || [];
  for (const f of ["personvern.html", "404.html"]) {
    for (const m of read(f).matchAll(/\shref="\/(?:\?[^"#]*)?#([^"]+)"/g)) {
      assert.ok(allowed.includes(`"${m[1]}"`), `${f}: /#${m[1]} lands at the top of the front page (START_AT: ${allowed.join(", ") || "none"})`);
    }
  }
});

test("D6: every local link in index.html, personvern.html and 404.html points at a file that exists", () => {
  for (const f of ["index.html", "personvern.html", "404.html"]) {
    const html = read(f);
    for (const m of html.matchAll(/\s(?:href|src|data-full)="([^"]+)"/g)) {
      const u = m[1];
      if (/^(https?:|mailto:|tel:|data:|#|\/\/)/i.test(u)) continue;
      const path = u.split(/[?#]/)[0].replace(/^\//, "");
      if (path === "" || path === "admin") continue; // the front page; /admin is admin.html
      assert.ok(existsSync(SITE + path), `${f}: ${u}`);
    }
    if (f !== "index.html") for (const m of html.matchAll(/\shref="([^"#][^"]*)"/g)) {
      if (!/^(https?:|mailto:|tel:)/.test(m[1])) assert.ok(m[1].startsWith("/"), `${f}: ${m[1]} is root-absolute`);
    }
  }
});
