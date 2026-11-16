// /admin «Logg ut» on a device that gets notifications about new bookings (with the customer's name). Run against
// the real admin.html + admin.js in the fake DOM (test/helpers/admin-page.mjs). Invariants:
//   1. on a subscribed device, «Logg ut» asks whether to turn notifications off here too;
//   2. yes: the browser unsubscribes and the server is told (with the admin token) before the token is dropped;
//      only then is the login shown, saying notifications are off;
//   3. no: nothing is unsubscribed, and the login page says notifications are still on here, with «Slå av varsler
//      her» (test/page/admin-login-push.test.mjs);
//   4. a device without notifications, or a browser without push (Safari 10, Chrome 60, Firefox 55, the compat.js
//      dialog shim), logs out at once without asking;
//   5. a push service or server that does not answer never keeps the barber logged in;
//   6. a logout is shown as done (green «ok»), never in the red error style of «Feil passord.»; only a logout that
//      could not turn notifications off is red, and a real login error after a logout is red again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin, fakePushBrowser } from "../helpers/admin-page.mjs";
import { makeDevice } from "../helpers/fake-push.mjs";

const KEY = "viggo-admin-token";
const SERVER_KEY = makeDevice().subscription.keys.p256dh;
const KEY_BYTES = [...Buffer.from(SERVER_KEY, "base64url")];
const routes = (extra = {}) => ({
  "GET /api/admin/push": () => ({ publicKey: SERVER_KEY, devices: 1 }),
  "POST /api/admin/push/subscribe": () => ({ ok: true, devices: 1 }),
  "POST /api/admin/push/unsubscribe": () => ({ ok: true, devices: 0 }),
  ...extra,
});
const token = (page) => page.local.getItem(KEY);
const loggedOut = (page) => page.$("app").hidden === true && page.$("login").hidden === false && token(page) === null;
const unsubscribeCalls = (page) => page.calls.filter((c) => c.path === "/api/admin/push/unsubscribe");

test("logout: every element is in admin.html", async () => {
  const page = await loadAdmin({});
  page.$("logout").click();
  await page.flush();
  assert.deepEqual(page.missing, []);
});

test("logout: «Logg ut» on a subscribed device unsubscribes in the browser and on the server before the token is dropped", async () => {
  const device = makeDevice("apple");
  const b = fakePushBrowser({ device, permission: "granted", subscribed: KEY_BYTES });
  const order = [];
  let page;
  page = await loadAdmin({ navigator: b.navigator, globals: b.globals, confirm: () => true, routes: routes({
    "POST /api/admin/push/unsubscribe": (call) => { order.push(["server", token(page), call.headers.Authorization]); return { ok: true, devices: 0 }; },
  }) });
  const sub = b.current();
  const original = sub.unsubscribe;
  sub.unsubscribe = function () { order.push(["browser", token(page)]); return original.call(this); };
  page.$("logout").click();
  await page.flush();
  assert.equal(page.confirms.length, 1);
  assert.match(page.confirms[0], /^Slå av varsler om nye bestillinger på denne enheten også\?/);
  assert.deepEqual(order.map((o) => o[0]).sort(), ["browser", "server"]);
  for (const o of order) assert.equal(o[1], "test-admin-token", `${o[0]}: done while still logged in`);
  assert.equal(order.find((o) => o[0] === "server")[2], "Bearer test-admin-token");
  assert.deepEqual(unsubscribeCalls(page).map((c) => c.body), [{ endpoint: device.endpoint }]);
  assert.equal(b.current(), null, "the browser has no subscription left");
  assert.ok(loggedOut(page));
  assert.equal(page.$("login-msg").textContent, "Du er logget ut, og varsler om nye bestillinger er slått av på denne enheten.");
});

test("logout: answering no keeps notifications on here, and the login page says so, with «Slå av varsler her»", async () => {
  const b = fakePushBrowser({ device: makeDevice("fcm"), permission: "granted", subscribed: KEY_BYTES });
  const page = await loadAdmin({ navigator: b.navigator, globals: b.globals, confirm: () => false, routes: routes() });
  page.$("logout").click();
  await page.flush();
  assert.equal(page.confirms.length, 1);
  assert.equal(b.log.unsubscribed.length, 0);
  assert.deepEqual(unsubscribeCalls(page), []);
  assert.ok(b.current(), "still subscribed");
  assert.ok(loggedOut(page));
  assert.equal(page.$("login-msg").textContent, "Du er logget ut.");
  assert.equal(page.$("login-push").hidden, false);
  assert.equal(page.$("login-push-msg").textContent, "Denne enheten har fortsatt varsler om nye bestillinger slått på.");
  assert.equal(page.$("login-push-off").hidden, false);
});

test("logout: without notifications here, or without push in the browser, it logs out at once without asking", async () => {
  const cases = [
    ["push browser, never turned on", () => fakePushBrowser({ device: makeDevice() })],
    ["permission granted, no subscription", () => fakePushBrowser({ device: makeDevice(), permission: "granted", registered: true })],
    ["subscription, but notifications blocked", () => fakePushBrowser({ device: makeDevice(), permission: "denied", subscribed: KEY_BYTES })],
    ["Safari 10 / Chrome 60 / Firefox 55 (no service worker)", () => ({ navigator: {}, globals: {} })],
    ["iPhone Safari outside the Home Screen", () => fakePushBrowser({ device: makeDevice("apple"), ios: true, push: false })],
  ];
  for (const oldBrowser of [false, true]) {
    for (const [label, make] of cases) {
      const b = make();
      const page = await loadAdmin({ oldBrowser, navigator: b.navigator, globals: b.globals, confirm: () => { throw new Error("must not ask"); }, routes: routes() });
      page.$("logout").click();
      await page.flush();
      assert.ok(loggedOut(page), label);
      assert.equal(page.$("login-msg").textContent, "Du er logget ut.", label);
      assert.deepEqual(unsubscribeCalls(page), [], label);
      assert.deepEqual(page.confirms, [], label);
    }
  }
});

test("logout: a server that does not answer never keeps the barber logged in", async () => {
  const b = fakePushBrowser({ device: makeDevice("wns"), permission: "granted", subscribed: KEY_BYTES });
  const page = await loadAdmin({ navigator: b.navigator, globals: b.globals, confirm: () => true, routes: routes({
    "POST /api/admin/push/unsubscribe": () => new Promise(() => {}),
  }) });
  page.$("logout").click();
  await page.flush();
  assert.equal(token(page), "test-admin-token", "still waiting for the server");
  assert.equal(page.$("logout").disabled, true, "no second tap meanwhile");
  await page.advance(8000);
  assert.ok(loggedOut(page));
  assert.equal(page.$("login-msg").textContent, "Du er logget ut, og varsler om nye bestillinger er slått av på denne enheten.", "the browser's own unsubscribe already stopped them");
  assert.equal(page.$("logout").disabled, false);
});

test("logout: if neither the browser nor the server could turn it off, the barber is told what to do", async () => {
  const b = fakePushBrowser({ device: makeDevice("mozilla"), permission: "granted", subscribed: KEY_BYTES, unsubscribeOk: false });
  const page = await loadAdmin({ navigator: b.navigator, globals: b.globals, confirm: () => true, routes: routes({
    "POST /api/admin/push/unsubscribe": () => { throw new TypeError("Failed to fetch"); },
  }) });
  page.$("logout").click();
  await page.flush();
  assert.ok(loggedOut(page));
  assert.match(page.$("login-msg").textContent, /^Du er logget ut, men varslene på denne enheten kunne ikke slås av nå\. Slå av varsler for denne siden i nettleserens innstillinger\.$/);
});

// ---------- 6. How the login page shows it ----------
const style = (page) => page.$("login-msg").className.split(/\s+/).filter(Boolean).sort().join(" ");

test("logout: «Du er logget ut.» is shown as done, not in the red error style", async () => {
  const cases = [
    ["no notifications here", () => fakePushBrowser({ device: makeDevice() }), () => true, "Du er logget ut."],
    ["notifications turned off too", () => fakePushBrowser({ device: makeDevice("apple"), permission: "granted", subscribed: KEY_BYTES }), () => true, "Du er logget ut, og varsler om nye bestillinger er slått av på denne enheten."],
    ["notifications kept", () => fakePushBrowser({ device: makeDevice("fcm"), permission: "granted", subscribed: KEY_BYTES }), () => false, "Du er logget ut."],
    ["Safari 10 (no push)", () => ({ navigator: {}, globals: {} }), () => true, "Du er logget ut."],
  ];
  for (const oldBrowser of [false, true]) {
    for (const [label, make, answer, text] of cases) {
      const b = make();
      const page = await loadAdmin({ oldBrowser, navigator: b.navigator, globals: b.globals, confirm: answer, routes: routes() });
      page.$("logout").click();
      await page.flush();
      assert.equal(page.$("login-msg").textContent, text, label);
      assert.equal(style(page), "msg ok", label);
    }
  }
});

test("logout: only a logout that could not turn notifications off is red, and a wrong password after it is red again", async () => {
  const b = fakePushBrowser({ device: makeDevice("mozilla"), permission: "granted", subscribed: KEY_BYTES, unsubscribeOk: false });
  const page = await loadAdmin({ navigator: b.navigator, globals: b.globals, confirm: () => true, routes: routes({
    "POST /api/admin/push/unsubscribe": () => { throw new TypeError("Failed to fetch"); },
    "POST /api/admin/login": () => ({ status: 401, body: { error: "Feil passord." } }),
  }) });
  page.$("logout").click();
  await page.flush();
  assert.match(page.$("login-msg").textContent, /kunne ikke slås av nå/);
  assert.equal(style(page), "msg", "this one needs the barber to act");

  const ok = await loadAdmin({ routes: routes({ "POST /api/admin/login": () => ({ status: 401, body: { error: "Feil passord." } }) }) });
  ok.$("logout").click();
  await ok.flush();
  assert.equal(style(ok), "msg ok");
  ok.$("login-form").dispatch("submit", { submitter: ok.doc.createElement("button") });
  assert.equal(ok.$("login-msg").textContent, "", "cleared while logging in");
  assert.equal(style(ok), "msg");
  await ok.flush();
  assert.equal(ok.$("login-msg").textContent, "Feil passord.");
  assert.equal(style(ok), "msg", "a real error is red");
});

test("logout: a login that ran out says «Logg inn på nytt.» neutrally, not as an error", async () => {
  const page = await loadAdmin({ routes: routes({ "GET /api/admin/items": () => ({ status: 401, body: { error: "Logg inn på nytt." } }) }) });
  assert.equal(page.$("login-msg").textContent, "Logg inn på nytt.");
  assert.equal(style(page), "info msg");
});

// Every subscription ends with the login it was turned on with (step 2), so the question must not promise
// notifications after logout without an end
test("logout: the question says notifications here go on only until the login would have run out", async () => {
  const b = fakePushBrowser({ device: makeDevice("fcm"), permission: "granted", subscribed: KEY_BYTES });
  const page = await loadAdmin({ navigator: b.navigator, globals: b.globals, confirm: () => false, routes: routes() });
  page.$("logout").click();
  await page.flush();
  assert.match(page.confirms[0], /Avbryt: du får fortsatt varsel om nye bestillinger her, også når du er logget ut, til innloggingen ville gått ut\.$/);
});
