// The front page's own script (viggos-barbershop/script.js) run on the real index.html with compat.js and i18n.js
// (test/helpers/site-page.mjs): the mobile menu (F66, F54), the gallery lightbox (F53) and, further down, the hero
// status line (F7, owner decision D4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSite } from "../helpers/site-page.mjs";
import { click, Event } from "../helpers/mini-dom.mjs";
import { CASES, closed as CLOSED } from "../fixtures/closed-days.mjs";
import { CONFIG } from "../../netlify/lib/booking-core.mjs";

// A browser with <dialog>: showModal/close as the platform does them, and «close» fired on every close
function nativeDialogs(ctx) {
  ctx.HTMLDialogElement = function HTMLDialogElement() {};
  ctx.document.querySelectorAll("dialog").forEach((d) => {
    d.showModal = () => { d.setAttribute("open", ""); };
    d.close = () => { if (!d.hasAttribute("open")) return; d.removeAttribute("open"); d.dispatchEvent(new Event("close")); };
  });
}

const page = (opts = {}) => loadSite(Object.assign({ scripts: ["compat.js", "script.js"] }, opts));
const key = (el, init) => el.dispatchEvent(Object.assign(new Event("keydown", { bubbles: true, cancelable: true }), init));
const tap = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
const isOpen = (site) => site.$("nav-menu").classList.contains("open");
const toggle = (site) => site.qs(".nav-toggle");

// ---------- F66 + F54: the mobile menu ----------
test("F66: opening the menu moves focus to its first link", async () => {
  const site = await page();
  click(toggle(site));
  assert.ok(isOpen(site));
  assert.equal(toggle(site).getAttribute("aria-expanded"), "true");
  const first = site.$("nav-menu").querySelector("a");
  assert.ok(site.doc.activeElement === first, "focus is on «Tjenester»");
});

for (const [label, init] of [["key Escape", { key: "Escape" }], ["key Esc (Safari 10.0, old Edge)", { key: "Esc" }], ["keyCode 27 (no .key, iOS < 10.3)", { keyCode: 27 }]]) {
  test(`F54: ${label} closes the open menu and puts focus back on the toggle`, async () => {
    const site = await page();
    click(toggle(site));
    key(site.doc.activeElement, init);
    assert.ok(!isOpen(site), "closed");
    assert.equal(toggle(site).getAttribute("aria-expanded"), "false");
    assert.equal(toggle(site).getAttribute("aria-label"), "Åpne meny");
    assert.ok(site.doc.activeElement === toggle(site), "focus back on the toggle");
  });
}

test("F54: Escape with the menu closed does nothing (focus stays where it is)", async () => {
  const site = await page();
  const link = site.qs(".brand");
  link.focus();
  key(link, { key: "Escape" });
  assert.ok(site.doc.activeElement === link);
});

test("F54: without PointerEvent (iOS < 13), a touch outside the menu closes it, a touch inside does not", async () => {
  const site = await page();
  assert.equal(typeof site.ctx.PointerEvent, "undefined");
  click(toggle(site));
  tap(site.$("nav-menu").querySelector("a"), "touchstart");
  assert.ok(isOpen(site), "a touch on a menu link keeps it open (the click then closes it)");
  tap(toggle(site).querySelector("span"), "touchstart");
  assert.ok(isOpen(site), "a touch on the toggle is left to the toggle's own click");
  tap(site.$("main"), "touchstart");
  assert.ok(!isOpen(site), "a touch on the page closes it");
  click(toggle(site));
  tap(site.qs(".hero"), "mousedown");
  assert.ok(!isOpen(site), "a mouse press outside closes it too");
});

test("F54: with PointerEvent, a pointerdown outside closes the menu", async () => {
  const site = await page({ before: (ctx) => { ctx.PointerEvent = function PointerEvent() {}; } });
  click(toggle(site));
  tap(site.$("nav-menu"), "pointerdown");
  assert.ok(isOpen(site));
  tap(site.$("main"), "pointerdown");
  assert.ok(!isOpen(site));
});

test("F54: a link in the menu still closes it", async () => {
  const site = await page();
  click(toggle(site));
  click(site.$("nav-menu").querySelectorAll("a")[2]);
  assert.ok(!isOpen(site));
});

// ---------- F53: the lightbox lets go of the big picture when it closes ----------
for (const [label, before] of [["with <dialog>", nativeDialogs], ["without <dialog> (compat.js shim: Firefox < 98, Safari < 15.4)", null]]) {
  test(`F53: ${label}: closing the lightbox removes the picture; the next one shows its own`, async () => {
    const site = await page({ before });
    const items = site.qsa(".gallery-item");
    const img = site.$("lightbox-img");
    const dlg = site.$("lightbox");
    click(items[0]);
    assert.ok(dlg.hasAttribute("open"), "open");
    assert.equal(img.getAttribute("src"), items[0].getAttribute("data-full").replace(/\.webp$/, ".jpg"));
    assert.ok(img.getAttribute("alt").length > 0);
    click(site.$("lightbox-close"));
    assert.ok(!dlg.hasAttribute("open"), "closed");
    assert.equal(img.hasAttribute("src"), false, "no src after closing (the old picture never flashes)");
    assert.equal(img.getAttribute("alt"), "");
    click(items[4]);
    assert.equal(img.getAttribute("src"), items[4].getAttribute("data-full").replace(/\.webp$/, ".jpg"), "item 5's own picture");
  });
}

// ---------- F47: the map loads only after a click ----------
test("F47: «Vis kart (Google Maps)» loads the map into the iframe and hands it the focus", async () => {
  const site = await page();
  const frame = site.qs("iframe");
  assert.equal(frame.hasAttribute("src"), false);
  click(site.$("map-load"));
  assert.equal(frame.getAttribute("src"), frame.getAttribute("data-src"));
  assert.equal(frame.hidden, false);
  assert.ok(site.$("map-load").closest("[hidden]"), "the button is gone");
  assert.ok(site.doc.activeElement === frame, "focus moves to the map, not to the top of the page");
});

test("F47: in English the button says so too", async () => {
  const site = await page({ lang: "en" });
  assert.equal(site.$("map-load").textContent, "Show map (Google Maps)");
});

// ---------- F7 / owner decision D4: the hero status line knows the barber's fully blocked days ----------
// The page runs booking.js for real; its /api/availability answer reaches script.js through
// window.bookingAvailabilityListeners. The server's date and clock win over the visitor's.
const DAY_NO = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
const weekday = (date) => new Date(date + "T12:00:00Z").getUTCDay();
const addDays = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const availability = (today, nowMinutes, closed = []) => ({
  today, nowMinutes, lastDate: addDays(today, 60), hours: CONFIG.hours, slotMin: 30, leadMin: 60, maxDays: 60,
  durations: { "Full service": 60, "Herreklipp": 30 }, busy: {}, closed,
});
async function hero(answer, opts = {}) {
  const routes = answer ? { "/api/availability": { body: answer } } : {};
  const site = await loadSite(Object.assign({ scripts: ["compat.js", "script.js", "booking.js"], routes }, opts));
  await site.advance(10);
  return site;
}
const status = (site) => site.$("open-status");

test("D4: before any answer the static hours are used (Monday 12:00 in Oslo is open, not red)", async () => {
  const site = await hero(null, { now: "2026-11-16T12:00:00+01:00" });
  assert.equal(status(site).textContent, "I dag kl. 10:00–18:00");
  assert.equal(status(site).classList.contains("closed"), false);
  assert.ok(status(site).classList.contains("anim"));
});

test("D4: a fully blocked today says «Stengt i dag», turns red, keeps «anim» and names the next open day", async () => {
  const site = await hero(availability("2026-11-16", 720, ["2026-11-16"]), { now: "2026-11-16T12:00:00+01:00" });
  assert.equal(status(site).textContent, "Stengt i dag · Åpner i morgen kl. 10:00");
  assert.ok(status(site).classList.contains("closed"));
  assert.ok(status(site).classList.contains("anim"), "the entrance animation class stays");
});

test("D4: «opens on» skips blocked days, and a day a week or more away is named with its date", async () => {
  const site = await hero(availability("2026-11-16", 720, ["2026-11-16", "2026-11-17", "2026-11-18"]));
  assert.equal(status(site).textContent, "Stengt i dag · Åpner torsdag kl. 10:00");
  const holiday = Array.from({ length: 12 }, (_, i) => addDays("2026-11-16", i));
  const long = await hero(availability("2026-11-16", 720, holiday));
  assert.equal(long.$("open-status").textContent, "Stengt i dag · Åpner lørdag 28. november kl. 10:00");
});

test("D4: after closing on Saturday, a blocked Monday is skipped too", async () => {
  const site = await hero(availability("2026-11-21", 1030, ["2026-11-23"]));
  assert.equal(status(site).textContent, "Åpner tirsdag kl. 10:00");
  assert.ok(status(site).classList.contains("closed"));
});

test("D4: the server's date and clock win over the visitor's (a phone set to the wrong day)", async () => {
  const site = await hero(availability("2026-11-15", 720), { now: "2026-11-16T12:00:00+01:00" });
  assert.equal(status(site).textContent, "Åpner i morgen kl. 10:00", "Sunday on the server");
  assert.ok(status(site).classList.contains("closed"));
});

test("D4: the line follows the clock from the server's answer (17:59 open, 18:01 closed)", async () => {
  const site = await hero(availability("2026-11-16", 1079));
  assert.equal(status(site).textContent, "I dag kl. 10:00–18:00");
  site.ctx.bookingAvailabilityListeners.length = 0; // no newer answer: only the passing minutes count
  site.requests.length = 0;
  await site.advance(2 * 60000);
  assert.equal(status(site).textContent, "Åpner i morgen kl. 10:00");
  assert.ok(status(site).classList.contains("closed"));
});

test("D4: in English the blocked day reads «Closed today»", async () => {
  const site = await hero(availability("2026-11-16", 720, ["2026-11-16"]), { lang: "en" });
  assert.equal(status(site).textContent, "Closed today · Opens tomorrow at 10:00 AM");
});

// The shared fixture (test/fixtures/closed-days.mjs): the same dates the server lists as closed, at noon
for (const c of CASES) {
  test(`D4 fixture: ${c.label} (${c.date}) → ${c.closed ? "Stengt i dag" : "not blocked"}`, async () => {
    const site = await hero(availability(c.date, 720, CLOSED));
    const el = status(site);
    const hours = CONFIG.hours[weekday(c.date)];
    if (c.closed) {
      assert.match(el.textContent, /^Stengt i dag · Åpner /);
      assert.ok(el.classList.contains("closed"));
    } else if (hours) {
      assert.equal(el.textContent, `I dag kl. 10:00–${hours[1] === 1080 ? "18" : "17"}:00`);
      assert.equal(el.classList.contains("closed"), false);
    } else {
      assert.ok(el.classList.contains("closed"), "Sunday");
    }
    if (!(c.closed || !hours)) return;
    let i = 1;
    while (!CONFIG.hours[weekday(addDays(c.date, i))] || CLOSED.includes(addDays(c.date, i))) i++;
    const next = addDays(c.date, i);
    const name = i === 1 ? "i morgen" : DAY_NO[weekday(next)];
    assert.ok(el.textContent.includes(`Åpner ${name}`), `${el.textContent} names ${next}`);
  });
}

// ---------- Round 2: /#bestill from personvern.html and 404.html lands at the booking form (SPEC R31) ----------
// The front page opens at the top (the head script and script.js strip any #anchor), so «Bestill time» on the privacy
// page and the 404 page landed on the hero. The one exception is #bestill: the page opens at the booking section,
// once, and the address loses the anchor (a reload starts at the top again). Any other anchor keeps the top rule.
async function landWith(hash) {
  const into = [], tops = [];
  const site = await loadSite({ scripts: ["script.js"], inline: true, before(ctx) {
    ctx.location.hash = hash;
    ctx.location.href += hash;
    ctx.pageYOffset = 300; // the browser already jumped somewhere
    ctx.scrollTo = (x, y) => tops.push([x, y]);
    const el = ctx.document.getElementById(hash.slice(1));
    if (el) el.scrollIntoView = () => into.push(hash);
  } });
  site.fire("load");
  await site.advance(2000);
  return { site, into, tops };
}
test("site round 2: /#bestill opens at the booking section and drops the anchor from the address", async () => {
  const { site, into, tops } = await landWith("#bestill");
  assert.ok(into.length >= 1, "scrolled to #bestill");
  assert.deepEqual(tops, [], "never to the top");
  assert.equal(site.location.hash, "", "the address has no anchor left");
});
test("site round 2: any other anchor (/#om) still opens at the top", async () => {
  const { site, into, tops } = await landWith("#om");
  assert.deepEqual(into, []);
  assert.ok(tops.length >= 1 && tops.every(([x, y]) => x === 0 && y === 0));
  assert.equal(site.location.hash, "");
});

// Fix-up round 2: Safari 10–11.0 and iOS 10–11.4 ignore referrerpolicy="no-referrer" on the iframe (caniuse
// «referrer-policy»: partial there), so «Vis kart» sent Google the front page's full address, ?fbclid/utm included,
// while personvern.html says the map gets no referrer. Where the iframe has no referrerPolicy, «Vis kart» is a
// plain link with rel="noopener noreferrer" (supported on every target) that opens Google Maps in a new tab.
test("F47 old Safari: an iframe without referrerPolicy turns «Vis kart» into a noreferrer link, and nothing is embedded", async () => {
  const site = await page({ search: "?fbclid=abc&utm_source=ig", before: (ctx) => { delete ctx.document.querySelector("iframe").referrerPolicy; } });
  const frame = site.qs("iframe");
  const link = site.$("map-load");
  assert.equal(link.tagName, "A", "a link, not a button");
  assert.deepEqual(link.getAttribute("rel").split(/\s+/).sort(), ["noopener", "noreferrer"]);
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("href"), frame.getAttribute("data-src").replace("&output=embed", ""));
  assert.equal(link.textContent, "Vis kart (Google Maps)");
  click(link);
  assert.equal(frame.hasAttribute("src"), false, "no embedded map, so no Referer from the iframe");
  await site.setLang("en");
  assert.equal(site.$("map-load").textContent, "Show map (Google Maps)", "the link is translated like the button");
});
test("F47: a browser with referrerPolicy on the iframe keeps the button and the embedded map", async () => {
  const site = await page();
  assert.equal(site.$("map-load").tagName, "BUTTON");
});
