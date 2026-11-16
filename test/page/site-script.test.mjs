// The front page's own script (viggos-barbershop/script.js) run on the real index.html with compat.js and i18n.js
// (test/helpers/site-page.mjs): the mobile menu (F66, F54), the gallery lightbox (F53) and, further down, the hero
// status line (F7, owner decision D4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSite } from "../helpers/site-page.mjs";
import { click, Event } from "../helpers/mini-dom.mjs";

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
