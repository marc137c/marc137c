// The owner's overview page (oversikt/public/index.html + app.js) in the mini DOM with a fake XMLHttpRequest.
// Round 3 (ledger): the page has three states (logged out; logged in while the numbers load or failed; numbers
// shown), but the status line lived inside the container that was only shown on success, so a failed
// /api/overview with a remembered login left a blank white page, and a fresh login whose overview failed stayed on
// the bare login form with no message. Invariants, for every /api/overview outcome × every way to get there:
//   1. the page ends with a visible, non-empty message, or with the numbers shown;
//   2. a control to go on is reachable: «Oppdater» (and «Logg ut») when logged in, «Logg inn» when logged out;
//   3. while the numbers load, «Henter tall …» is visible;
//   4. rule for the whole class: an element a script wrote a status or error text into ([role=alert], .msg) is
//      never inside a [hidden] ancestor at that moment (checked after every step).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { parseDocument, click, submit, type } from "./helpers/mini-dom.mjs";
import { slim } from "../oversikt/netlify/functions/overview.mjs";

const PUB = fileURLToPath(new URL("../oversikt/public/", import.meta.url));
const HTML = fs.readFileSync(PUB + "index.html", "utf8");
const JS = fs.readFileSync(PUB + "app.js", "utf8");
const KEY = "oversikt-token";
const STATS = { today: "2026-11-17", totals: { visits: 30, views: 34 }, sources: { google: 20, direkte: 10 },
  days: [{ date: "2026-11-17", visits: 3, views: 4, bookings: { web: 1, admin: 1, cancelled: 0 } }, { date: "2026-11-16", visits: 5, views: 5, bookings: { web: 0, admin: 0, cancelled: 0 } }],
  bookings: { web: 4, admin: 1, cancelled: 1, services: { Herreklipp: 3 }, weekdays: [0, 1, 0, 0, 0, 2, 1], upcoming7: 2 } };
const OVERVIEW = (n) => ({ range: n, sites: [{ id: "viggos", name: "Viggo's Barbershop", url: "https://www.viggosbarbershop.no", ok: true, data: slim(STATS, n) }] });

const mem = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), has: (k) => m.has(k) };
};

function boot({ token = null } = {}) {
  const doc = parseDocument(HTML);
  const sent = [];
  class XHR {
    open(method, url) { this.method = method; this.url = url; this.headers = {}; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(body) { this.body = body; sent.push(this); }
  }
  const session = mem(token ? { [KEY]: token } : {});
  const local = mem();
  const ctx = { document: doc, XMLHttpRequest: XHR, sessionStorage: session, localStorage: local, Date, Math, JSON, String, Number, Object, Array, console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(JS, ctx, { filename: "oversikt/public/app.js" });
  const $ = (id) => doc.getElementById(id);
  const visible = (el) => !!el && !el.closest("[hidden]");
  const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const page = {
    doc, $, sent, session, local, visible, text,
    // the oldest request not yet answered
    next() { const x = sent.find((r) => !r.answered); assert.ok(x, "the page sent no request"); return x; },
    answer(outcome, body) {
      const x = page.next();
      x.answered = true;
      if (outcome === "network") { x.status = 0; x.onerror(); }
      else if (outcome === "timeout") { x.status = 0; x.ontimeout(); }
      else {
        x.status = outcome;
        x.responseText = outcome === 502 ? "<html><body>Bad Gateway</body></html>" : JSON.stringify(body !== undefined ? body : { error: "Feil " + outcome });
        x.onload();
      }
      page.rule();
      return x;
    },
    // Invariant 4: a status or error text is never written into something the visitor cannot see
    rule() {
      for (const el of doc.querySelectorAll('[role="alert"], .msg')) {
        if (text(el)) assert.ok(visible(el), "«" + text(el) + "» is written into #" + el.getAttribute("id") + ", which sits inside a [hidden] ancestor");
      }
    },
    login(pw = "riktig-passord") { type($("pw"), pw); submit($("login-form")); page.rule(); },
  };
  page.rule();
  return page;
}

// Invariants 1 and 2 at the end of a case
function settled(p, outcome, label) {
  const loginShown = p.visible(p.$("login"));
  const appShown = p.visible(p.$("app"));
  assert.ok(loginShown !== appShown, label + ": exactly one of the login form and the overview is shown");
  if (outcome === 200) {
    assert.ok(appShown && p.visible(p.$("compare")), label + ": the numbers are shown");
    assert.match(p.text(p.$("compare")), /Viggo's Barbershop/, label);
    return;
  }
  const msgs = [p.$("login-msg"), p.$("app-msg")].filter((el) => p.visible(el) && p.text(el));
  assert.ok(msgs.length, label + ": a visible message says what happened (page text: " + JSON.stringify(p.text(p.doc.body).slice(0, 160)) + ")");
  if (appShown) {
    assert.ok(p.visible(p.$("refresh")) && !p.$("refresh").disabled, label + ": «Oppdater» can be reached");
    assert.ok(p.visible(p.$("logout")), label + ": «Logg ut» can be reached");
    assert.doesNotMatch(p.text(p.$("app-msg")), /Henter tall/, label + ": the loading text is replaced");
  } else {
    assert.ok(p.visible(p.doc.querySelector("#login-form button[type=submit]")), label + ": «Logg inn» can be reached");
  }
}
const loading = (p, label) => {
  assert.ok(p.visible(p.$("app-msg")) && /Henter tall/.test(p.text(p.$("app-msg"))), label + ": «Henter tall …» is visible while the numbers load");
};

const OUTCOMES = [200, 401, 429, 500, 502, 503, "network", "timeout"];
const WAYS = {
  "remembered login at start": (outcome) => {
    const p = boot({ token: "t.remembered" });
    loading(p, "start");
    p.answer(outcome, outcome === 200 ? OVERVIEW(30) : undefined);
    return p;
  },
  "fresh login": (outcome) => {
    const p = boot();
    assert.ok(p.visible(p.$("login")), "no token: the login form");
    p.login();
    p.answer(200, { token: "t.fresh" });
    loading(p, "after login");
    p.answer(outcome, outcome === 200 ? OVERVIEW(30) : undefined);
    return p;
  },
  "period switch": (outcome) => {
    const p = boot({ token: "t.remembered" });
    p.answer(200, OVERVIEW(30));
    click(p.doc.querySelector('.seg button[data-days="7"]'));
    p.rule();
    loading(p, "period switch");
    p.answer(outcome, outcome === 200 ? OVERVIEW(7) : undefined);
    return p;
  },
  "Oppdater": (outcome) => {
    const p = boot({ token: "t.remembered" });
    p.answer(200, OVERVIEW(30));
    click(p.$("refresh"));
    p.rule();
    loading(p, "Oppdater");
    p.answer(outcome, outcome === 200 ? OVERVIEW(30) : undefined);
    return p;
  },
};

for (const [way, run] of Object.entries(WAYS)) {
  test(`overview page, ${way}: every /api/overview outcome ends with the numbers or a visible message and a way on`, () => {
    for (const outcome of OUTCOMES) {
      const p = run(outcome);
      settled(p, outcome, way + " → " + outcome);
      if (outcome === 401) {
        assert.ok(p.visible(p.$("login")), way + " → 401: back to the login form");
        assert.match(p.text(p.$("login-msg")), /Logg inn på nytt/);
        assert.ok(!p.session.has(KEY) && !p.local.has(KEY), "the dead token is dropped");
      }
    }
  });
}

test("overview page: a failed /api/login shows its reason on the login form (wrong password, brake, not configured, no connection)", () => {
  const cases = [[401, { error: "Feil passord." }, /Feil passord/], [429, { error: "For mange feil forsøk. Vent 15 minutter." }, /For mange/],
    [503, { error: "Passordet er ikke satt ennå." }, /ikke satt/], [502, undefined, /502/], ["network", undefined, /forbindelse/]];
  for (const [outcome, body, want] of cases) {
    const p = boot();
    p.login("feil");
    p.answer(outcome, body);
    assert.ok(p.visible(p.$("login")), String(outcome));
    assert.match(p.text(p.$("login-msg")), want, String(outcome));
    assert.equal(p.sent.length, 1, "no overview request without a token");
  }
});

test("overview page: an answer to an older request never overwrites a newer one (period switched twice quickly)", () => {
  const p = boot({ token: "t.remembered" });
  p.answer(200, OVERVIEW(30));
  click(p.doc.querySelector('.seg button[data-days="7"]'));
  click(p.doc.querySelector('.seg button[data-days="90"]'));
  const [first, second] = p.sent.slice(1);
  assert.match(first.url, /days=7/);
  assert.match(second.url, /days=90/);
  // the 90-day answer arrives first, then the late 7-day one fails
  second.answered = true; second.status = 200; second.responseText = JSON.stringify(OVERVIEW(90)); second.onload();
  first.answered = true; first.status = 502; first.responseText = "<html></html>"; first.onload();
  p.rule();
  settled(p, 200, "late older answer");
  assert.equal(p.text(p.$("app-msg")), "", "no stale error over the numbers that are shown");
});
