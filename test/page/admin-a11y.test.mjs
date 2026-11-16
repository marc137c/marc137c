// /admin accessibility rules that can be checked without a browser (F72, RC8): no interactive element inside a
// button (a card is a div holding a real <button>, with the phone link beside it), every dialog has a name, the
// week strip is a named group whose current day has aria-current="date". The manual pack runs axe-core on top.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadAdmin, itemsRoute } from "../helpers/admin-page.mjs";
import { parseDocument } from "../helpers/mini-dom.mjs";
import { item, block } from "../fixtures/admin-days.mjs";

const HTML = readFileSync(new URL("../../viggos-barbershop/admin.html", import.meta.url), "utf8");
const DAY = "2026-11-19";
const list = [item(DAY, 600, 30, { name: "Ola", phone: "912 34 567", source: "nettside", note: "Kort på sidene" }), block(DAY, 720, 60, { note: "Lunsj" }),
  item(DAY, 780, 30, { name: "Kari", phone: "", status: "cancelled" })];
const INTERACTIVE = "a[href], button, input, select, textarea, [tabindex], [role=button], [role=link]";
const open = () => loadAdmin({ now: DAY + "T09:00", routes: { "GET /api/admin/items": itemsRoute(list) } });

test("a11y F72: no interactive element inside a button or [role=button] in the timeline; each card is a div with one button", async () => {
  const page = await open();
  const root = page.rendered("timeline");
  for (const outer of root.querySelectorAll("button, [role=button]")) {
    assert.equal(outer.querySelectorAll(INTERACTIVE).length, 0, "nested inside: " + outer.outerHTML.slice(0, 160));
  }
  assert.equal(root.querySelectorAll("[role=button]").length, 0, "no div pretending to be a button");
  const cards = root.querySelectorAll("[data-id]");
  assert.equal(cards.length, 3);
  for (const c of cards) {
    assert.equal(c.localName, "div", "the card is a div");
    assert.equal(c.querySelectorAll("button.item-open").length, 1, "one button opens it");
  }
  const ola = root.querySelector(`[data-id="${list[0].id}"]`);
  const tel = ola.querySelector("a.item-tel");
  assert.ok(tel, "the phone is a link");
  assert.equal(tel.getAttribute("href"), "tel:91234567");
  assert.ok(!tel.closest("button"), "beside the button, not in it");
  assert.match(ola.querySelector("button.item-open").textContent, /Ola/);
  assert.equal(page.$("timeline").listeners.keydown, undefined, "no keydown handler: a real button handles Enter and Space");
});

test("a11y F72: the card's button opens the editor; the phone link does not", async () => {
  const page = await open();
  page.tap("timeline", `[data-id="${list[0].id}"] a`);
  assert.equal(page.$("editor").open, false, "a tap on the phone number only calls");
  page.tap("timeline", `[data-id="${list[0].id}"] button.item-open`);
  assert.equal(page.$("editor").open, true);
  assert.equal(page.field("name").value, "Ola");
  page.$("cancel-edit").click();
  page.tap("timeline", `[data-id="${list[1].id}"] button.item-open`);
  assert.equal(page.$("edit-title").textContent, "Endre blokkering");
});

test("a11y F72: every dialog in admin.html has a name that points at an element", () => {
  const doc = parseDocument(HTML);
  const dialogs = doc.querySelectorAll("dialog");
  assert.ok(dialogs.length >= 2);
  for (const d of dialogs) {
    const by = d.getAttribute("aria-labelledby");
    assert.ok(by || d.getAttribute("aria-label"), "dialog #" + d.getAttribute("id") + " has a name");
    if (by) assert.ok(doc.getElementById(by) && doc.getElementById(by).textContent.trim(), `#${by} exists and has text`);
  }
  assert.equal(doc.getElementById("editor").getAttribute("aria-labelledby"), "edit-title");
});

test("a11y F72: the week strip is a named group, and only the day on screen has aria-current=\"date\"", async () => {
  const doc = parseDocument(HTML);
  const week = doc.getElementById("week");
  assert.equal(week.getAttribute("role"), "group");
  assert.ok(week.getAttribute("aria-label"));
  const page = await open();
  const current = page.rendered("week").querySelectorAll('[aria-current="date"]');
  assert.equal(current.length, 1);
  assert.equal(current[0].getAttribute("data-day"), DAY);
  assert.ok(current[0].classList.contains("is-active"));
  page.$("next").click();
  await page.flush();
  assert.equal(page.rendered("week").querySelector('[aria-current="date"]').getAttribute("data-day"), "2026-11-20");
});

test("a11y F72: the card button looks like the card (reset), and old Safari still stacks its lines", () => {
  const css = readFileSync(new URL("../../viggos-barbershop/admin.css", import.meta.url), "utf8");
  const m = /\.item-open\s*\{([^}]*)\}/.exec(css);
  assert.ok(m, ".item-open rule");
  for (const p of [/background:\s*none/, /border:\s*0/, /width:\s*100%/, /text-align:\s*left/, /font:\s*inherit/, /color:\s*inherit/]) assert.match(m[1], p);
  assert.match(css, /\.item-open > span[^{]*\{[^}]*display:\s*block/, "Safari 10.1-14.0 ignore display:grid on <button>");
});
