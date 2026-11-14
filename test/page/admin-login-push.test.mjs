// The /admin login page on a device that still has notifications about new bookings turned on (fix-up 2, item 1):
// the login ran out (a 401), the tab was closed (a start with no token), or the barber logged out and kept them.
// Run against the real admin.html + admin.js in the fake DOM (test/helpers/admin-page.mjs). Invariants:
//   1. whenever the login page shows on a device whose browser still has a push subscription, it says so and offers
//      «Slå av varsler her»; on any other device (none, notifications blocked, no push in the browser, old browsers
//      with the compat.js dialog shim) nothing about notifications is shown;
//   2. «Slå av varsler her» needs no login: it unsubscribes in the browser only (the push service then answers 410
//      and the server removes the device), sends nothing to the server, and says it is done;
//   3. if the browser cannot unsubscribe (or never answers), the barber is told what to do and can try again;
//   4. logging in hides it, and a slow lookup can never show it over the timebook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin, fakePushBrowser } from "../helpers/admin-page.mjs";
import { makeDevice } from "../helpers/fake-push.mjs";

const SERVER_KEY = makeDevice().subscription.keys.p256dh;
const KEY_BYTES = [...Buffer.from(SERVER_KEY, "base64url")];
const ON_TEXT = "Denne enheten har fortsatt varsler om nye bestillinger slått på.";
const EXPIRED = { status: 401, body: { error: "Logg inn på nytt." } };
const shown = (page) => page.$("login-push").hidden === false;
const loginShown = (page) => page.$("login").hidden === false && page.$("app").hidden === true;

test("login push: a 401 on a subscribed device shows the login with the notice and «Slå av varsler her»", async () => {
  const device = makeDevice("fcm");
  const b = fakePushBrowser({ device, permission: "granted", subscribed: KEY_BYTES });
  const page = await loadAdmin({ navigator: b.navigator, globals: b.globals, routes: { "GET /api/admin/items": () => EXPIRED, "GET /api/admin/push": () => EXPIRED } });
  assert.ok(loginShown(page));
  assert.equal(page.$("login-msg").textContent, "Logg inn på nytt.");
  assert.ok(shown(page));
  assert.equal(page.$("login-push-msg").textContent, ON_TEXT);
  assert.equal(page.$("login-push-off").hidden, false);
  assert.deepEqual(b.log.unsubscribed, [], "nothing is turned off without asking");
  assert.deepEqual(page.missing, []);

  const before = page.calls.length;
  page.$("login-push-off").click();
  assert.equal(page.$("login-push-off").disabled, true, "no double tap");
  await page.flush();
  assert.deepEqual(b.log.unsubscribed, [device.endpoint]);
  assert.equal(b.current(), null, "the browser has no subscription left");
  assert.equal(page.calls.length, before, "nothing is sent to the server (there is no login)");
  assert.equal(page.$("login-push-msg").textContent, "Varsler om nye bestillinger er slått av på denne enheten.");
  assert.match(page.$("login-push-msg").className, /\bok\b/);
  assert.equal(page.$("login-push-off").hidden, true);
  assert.equal(page.timers(), 0, "no timer is left behind");
});

test("login push: a start with no token (the tab was closed) on a subscribed device shows it too", async () => {
  const b = fakePushBrowser({ device: makeDevice("apple"), permission: "granted", subscribed: KEY_BYTES });
  const page = await loadAdmin({ token: null, navigator: b.navigator, globals: b.globals });
  assert.ok(loginShown(page));
  assert.equal(page.$("login-msg").textContent, "");
  assert.ok(shown(page));
  assert.equal(page.$("login-push-msg").textContent, ON_TEXT);
  assert.deepEqual(page.calls.filter((c) => c.path.startsWith("/api/admin/push")), [], "the login page asks the server nothing");
});

test("login push: nothing about notifications on a device without a subscription, with them blocked, or without push", async () => {
  const cases = [
    ["push browser, never turned on", () => fakePushBrowser({ device: makeDevice() })],
    ["permission granted, no subscription", () => fakePushBrowser({ device: makeDevice(), permission: "granted", registered: true })],
    ["subscription, but notifications blocked", () => fakePushBrowser({ device: makeDevice(), permission: "denied", subscribed: KEY_BYTES })],
    ["Safari 10 / Chrome 60 / Firefox 55 (no service worker)", () => ({ navigator: {}, globals: {} })],
    ["iPhone Safari outside the Home Screen", () => fakePushBrowser({ device: makeDevice("apple"), ios: true, push: false })],
  ];
  for (const oldBrowser of [false, true]) {
    for (const [label, make] of cases) {
      for (const token of [null, "expired"]) {
        const b = make();
        const page = await loadAdmin({ oldBrowser, token, navigator: b.navigator, globals: b.globals, routes: { "GET /api/admin/items": () => EXPIRED } });
        assert.ok(loginShown(page), label);
        assert.equal(shown(page), false, `${label} (${token ? "401" : "no token"}${oldBrowser ? ", compat.js" : ""})`);
        assert.deepEqual(page.missing, [], label);
      }
    }
  }
});

test("login push: if the browser cannot unsubscribe, the barber is told what to do and can try again", async () => {
  const b = fakePushBrowser({ device: makeDevice("mozilla"), permission: "granted", subscribed: KEY_BYTES, unsubscribeOk: false });
  const page = await loadAdmin({ token: null, navigator: b.navigator, globals: b.globals });
  page.$("login-push-off").click();
  await page.flush();
  assert.equal(page.$("login-push-msg").textContent, "Kunne ikke slå av varslene her. Slå av varsler for denne siden i nettleserens innstillinger.");
  assert.equal(page.$("login-push-off").hidden, false);
  assert.equal(page.$("login-push-off").disabled, false, "the button works again");
  page.$("login-push-off").click();
  await page.flush();
  assert.equal(b.log.unsubscribed.length, 2, "a second tap tries again");
  // An unsubscribe() that never settles (push service unreachable) does not leave the button stuck
  const c = fakePushBrowser({ device: makeDevice("fcm"), permission: "granted", subscribed: KEY_BYTES });
  const hanging = await loadAdmin({ token: null, navigator: c.navigator, globals: c.globals });
  c.current().unsubscribe = () => new Promise(() => {});
  hanging.$("login-push-off").click();
  await hanging.flush();
  assert.equal(hanging.$("login-push-off").disabled, true);
  await hanging.advance(8000);
  assert.equal(hanging.$("login-push-off").disabled, false);
  assert.match(hanging.$("login-push-msg").textContent, /^Kunne ikke slå av varslene her/);
});

test("login push: logging in hides it, and a slow lookup never shows it over the timebook", async () => {
  const b = fakePushBrowser({ device: makeDevice("wns"), permission: "granted", subscribed: KEY_BYTES });
  const login = {
    "POST /api/admin/login": () => ({ token: "new-token", expiresIn: 1 }),
    "GET /api/admin/push": () => ({ publicKey: SERVER_KEY, devices: 1 }),
    "POST /api/admin/push/subscribe": () => ({ ok: true, devices: 1 }),
  };
  let page = await loadAdmin({ token: null, navigator: b.navigator, globals: b.globals, routes: login });
  assert.ok(shown(page));
  page.$("login-form").dispatch("submit", { submitter: page.doc.createElement("button") });
  await page.flush();
  assert.equal(page.$("app").hidden, false);
  assert.equal(shown(page), false);
  // The lookup answers only after the barber has logged in
  const slow = fakePushBrowser({ device: makeDevice("fcm"), permission: "granted", subscribed: KEY_BYTES });
  const getRegistration = slow.navigator.serviceWorker.getRegistration;
  let answer;
  slow.navigator.serviceWorker.getRegistration = (scope) => new Promise((r) => { answer = () => r(getRegistration(scope)); });
  page = await loadAdmin({ token: null, navigator: slow.navigator, globals: slow.globals, routes: login });
  slow.navigator.serviceWorker.getRegistration = getRegistration;
  page.$("login-form").dispatch("submit", { submitter: page.doc.createElement("button") });
  await page.flush();
  answer();
  await page.flush();
  assert.equal(page.$("app").hidden, false);
  assert.equal(shown(page), false);
});
