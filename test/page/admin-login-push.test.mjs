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
  // Round 3: every tap shows «Slår av …» (button greyed out) for a moment, also when the browser says no at once, so a
  // second tap with the same answer is never a tap that seems to do nothing
  for (let n = 1; n <= 2; n++) {
    page.$("login-push-off").click();
    await page.flush();
    assert.equal(page.$("login-push-msg").textContent, "Slår av …", `tap ${n}`);
    assert.equal(page.$("login-push-off").disabled, true);
    await page.advance(400);
    assert.equal(page.$("login-push-msg").textContent, "Kunne ikke slå av varslene her. Slå av varsler for denne siden i nettleserens innstillinger.");
    assert.equal(page.$("login-push-off").hidden, false);
    assert.equal(page.$("login-push-off").disabled, false, "the button works again");
  }
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

// Notify leftover (major): every subscription ends with its login (step 2). When that end has passed, the server
// sends nothing any more (after one last notice without customer data), so the login page must not say they are
// still on. The device remembers the end the server gave (localStorage), and says when they stopped.
test("login push: after the login the notifications were turned on with has run out, the login page says they stopped", async () => {
  const device = makeDevice("fcm");
  const b = fakePushBrowser({ device, permission: "granted", subscribed: KEY_BYTES });
  let expired = false;
  const until = "2026-11-17T02:46:00";
  const page = await loadAdmin({ now: "2026-11-16T14:46", navigator: b.navigator, globals: b.globals, routes: {
    "GET /api/admin/items": () => (expired ? EXPIRED : { items: [], config: { hours: {}, durations: {}, addons: [] } }),
    "GET /api/admin/push": () => (expired ? EXPIRED : { publicKey: SERVER_KEY, devices: 1 }),
    "POST /api/admin/push/subscribe": () => ({ ok: true, devices: 1, until: new Date(until).toISOString() }),
  } });
  await page.flush();
  assert.ok(page.calls.some((c) => c.path === "/api/admin/push/subscribe"), "the start-up sync gave the server the subscription");
  // 13 hours later the 12-hour login has run out
  page.setNow("2026-11-17T03:46");
  expired = true;
  page.wake();
  await page.flush();
  assert.ok(loginShown(page));
  assert.ok(shown(page));
  const text = page.$("login-push-msg").textContent;
  assert.equal(text, "Varslene her stoppet da innloggingen gikk ut (kl. 02:46). Logg inn igjen for å få dem.");
  assert.doesNotMatch(text, /fortsatt/);
  assert.equal(page.$("login-push-off").hidden, false, "«Slå av varsler her» stays, as optional clean-up");
});

test("login push: before that end (the barber logged out and kept them), it still says they are on", async () => {
  const device = makeDevice("fcm");
  const b = fakePushBrowser({ device, permission: "granted", subscribed: KEY_BYTES });
  const note = JSON.stringify({ endpoint: device.endpoint, until: "2026-11-17T02:46:00.000Z" });
  const page = await loadAdmin({ now: "2026-11-16T14:46", token: null, storage: { "viggo-push": note }, navigator: b.navigator, globals: b.globals });
  assert.equal(page.$("login-push-msg").textContent, ON_TEXT);
  // A note about another (older) subscription says nothing about this one
  const other = await loadAdmin({ now: "2026-12-30T14:46", token: null, storage: { "viggo-push": JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/old", until: "2026-11-17T02:46:00.000Z" }) }, navigator: b.navigator, globals: b.globals });
  assert.equal(other.$("login-push-msg").textContent, ON_TEXT);
});

// Round 2 (probe P1): after «Slå av varsler på alle andre enheter» on another device (or a new password), the server
// has removed this device, but the login page said «fortsatt … slått på». The 401 now says why (code), and only a
// device whose server record can still be current says «fortsatt».
const OFF_ELSEWHERE = "Varslene her er slått av (logget ut fra en annen enhet eller nytt passord). Logg inn igjen for å få dem.";
for (const [label, code] of [["reset from another device", "revoked"], ["a new password", "invalid"]]) {
  test(`login push: after ${label} (401 ${code}) the login page says notifications here are off, and keeps «Slå av varsler her»`, async () => {
    const b = fakePushBrowser({ device: makeDevice("fcm"), permission: "granted", subscribed: KEY_BYTES });
    const gone = { status: 401, body: { error: "Logg inn på nytt.", code } };
    const page = await loadAdmin({ navigator: b.navigator, globals: b.globals, routes: { "GET /api/admin/items": () => gone, "GET /api/admin/push": () => gone } });
    assert.ok(loginShown(page));
    assert.ok(shown(page));
    assert.equal(page.$("login-push-msg").textContent, OFF_ELSEWHERE);
    assert.equal(page.$("login-push-off").hidden, false, "cleanup in the browser is still offered");
  });
}
test("login push: a 401 expired with no note keeps today's «fortsatt slått på» text", async () => {
  const b = fakePushBrowser({ device: makeDevice("fcm"), permission: "granted", subscribed: KEY_BYTES });
  const expired = { status: 401, body: { error: "Logg inn på nytt.", code: "expired" } };
  const page = await loadAdmin({ navigator: b.navigator, globals: b.globals, routes: { "GET /api/admin/items": () => expired, "GET /api/admin/push": () => expired } });
  assert.equal(page.$("login-push-msg").textContent, ON_TEXT);
});

// Fix-up round 2 (probe R2-P1b, R2-INVALID-reload): the reason for the 401 lived only in memory, and the 401 had
// already removed the token, so a reload (the Home Screen app reopened, same localStorage, same browser subscription)
// said «fortsatt … slått på» again although the server had removed this device. Guard: what the login page says about
// notifications comes from saved state or a server answer, never from memory alone, and every case runs twice: in the
// tab that got the 401, and reloaded with the same localStorage and subscription.
const reload = (page, b, now) => loadAdmin({ now, token: null, storage: Object.fromEntries(page.local._map), navigator: b.navigator, globals: b.globals });
const STOPPED_AT = /^Varslene her stoppet da innloggingen gikk ut \(kl\. \d\d:46\)\. Logg inn igjen for å få dem\.$/;
for (const [label, code, expected] of [
  ["reset from another device", "revoked", OFF_ELSEWHERE],
  ["a new password", "invalid", OFF_ELSEWHERE],
  ["an expired login (before the note's end)", "expired", ON_TEXT],
]) {
  test(`login push (same tab and reloaded): after ${label} (401 ${code}) the text is the same both times`, async () => {
    const device = makeDevice("fcm");
    const b = fakePushBrowser({ device, permission: "granted", subscribed: KEY_BYTES });
    const note = JSON.stringify({ endpoint: device.endpoint, until: "2027-01-15T02:46:00.000Z" });
    const gone = { status: 401, body: { error: "Logg inn på nytt.", code } };
    const page = await loadAdmin({ now: "2026-11-16T14:46", storage: { "viggo-push": note }, navigator: b.navigator, globals: b.globals, routes: { "GET /api/admin/items": () => gone, "GET /api/admin/push": () => gone } });
    assert.ok(loginShown(page));
    assert.equal(page.$("login-push-msg").textContent, expected, "in the tab that got the 401");
    assert.equal(page.local.getItem("viggo-admin-token"), null, "the 401 removed the token");
    const again = await reload(page, b, "2026-11-16T15:10");
    assert.ok(loginShown(again));
    assert.equal(again.$("login-push-msg").textContent, expected, "after a reload");
    assert.equal(again.$("login-push-off").hidden, false);
  });
}
test("login push (reloaded): an expired 12-h login says they stopped, also after a reload", async () => {
  const device = makeDevice("fcm");
  const b = fakePushBrowser({ device, permission: "granted", subscribed: KEY_BYTES });
  const note = JSON.stringify({ endpoint: device.endpoint, until: "2026-11-17T02:46:00.000Z" });
  const page = await loadAdmin({ now: "2026-11-17T09:00", token: null, storage: { "viggo-push": note }, navigator: b.navigator, globals: b.globals });
  assert.match(page.$("login-push-msg").textContent, STOPPED_AT);
  const again = await reload(page, b, "2026-11-17T09:30");
  assert.equal(again.$("login-push-msg").textContent, page.$("login-push-msg").textContent);
});
test("login push (reloaded): logged out on purpose with notifications kept says they are still on, also after a reload", async () => {
  const device = makeDevice("fcm");
  const b = fakePushBrowser({ device, permission: "granted", subscribed: KEY_BYTES });
  const note = JSON.stringify({ endpoint: device.endpoint, until: "2027-01-15T02:46:00.000Z" });
  const page = await loadAdmin({ now: "2026-11-16T14:46", storage: { "viggo-push": note }, confirm: () => false, navigator: b.navigator, globals: b.globals });
  page.$("logout").click();
  await page.flush();
  assert.ok(loginShown(page));
  assert.equal(page.$("login-push-msg").textContent, ON_TEXT);
  const again = await reload(page, b, "2026-11-16T15:10");
  assert.equal(again.$("login-push-msg").textContent, ON_TEXT);
});
test("login push: a saved «off» reason (from an earlier 401 revoked) is shown at a fresh start with no 401", async () => {
  const device = makeDevice("fcm");
  const b = fakePushBrowser({ device, permission: "granted", subscribed: KEY_BYTES });
  const page = await loadAdmin({ now: "2026-11-16T14:46", token: null, storage: { "viggo-push": JSON.stringify({ endpoint: device.endpoint, off: "revoked" }) }, navigator: b.navigator, globals: b.globals });
  assert.equal(page.$("login-push-msg").textContent, OFF_ELSEWHERE, "the saved reason, with no 401 in this tab");
});
