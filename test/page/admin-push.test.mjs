// /admin «Oppsett → Varsler på denne enheten» (admin.html + admin.js) against a fake DOM built from the real
// admin.html and a fake push-capable browser (test/helpers/admin-page.mjs). Invariants:
//   1. every element admin.js uses exists in admin.html;
//   2. a browser without service worker, PushManager or Notification (Safari 10, Chrome 60, Firefox 55, old
//      browsers with the compat.js dialog shim) gets no push buttons, makes no push request and registers nothing;
//      an iPhone outside the Home Screen gets the Norwegian «Del → Legg til på Hjem-skjerm» instruction;
//   3. «Slå på varsler» asks for permission once, subscribes with exactly the server's public key and
//      userVisibleOnly, and sends the subscription to the server with the admin token; a refusal sends nothing;
//   4. «Send testvarsel» asks the server to test this device only; «Slå av» unsubscribes in the browser first and
//      only then tells the server, so a device can never turn itself back on;
//   5. an existing subscription is given to the server again (when «Oppsett» opens and at start), and one made with
//      another key is dropped;
//   6. /admin?dag=… and a tap on a notification open that day;
//   7. end to end through the real handlers: «Slå på varsler» → a web booking → the device decrypts «Ny time».
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin, fakePushBrowser } from "../helpers/admin-page.mjs";
import { makeDevice, fakePushService } from "../helpers/fake-push.mjs";
import { testDeps, request, read, PRODUCTION } from "../helpers/deps.mjs";
import { makeToken } from "../../netlify/lib/booking-core.mjs";
import * as adminFn from "../../netlify/functions/admin.mjs";
import * as bookingsFn from "../../netlify/functions/bookings.mjs";

const SERVER_KEY = makeDevice().subscription.keys.p256dh; // any P-256 point serves as the server's public key here
const KEY_BYTES = [...Buffer.from(SERVER_KEY, "base64url")];
const INFO = { publicKey: SERVER_KEY, devices: 0 };
const pushCalls = (page) => page.calls.filter((c) => c.path.startsWith("/api/admin/push"));
const visible = (page, id) => !page.$(id).hidden;
const buttons = (page) => ["push-on", "push-test", "push-off"].filter((id) => visible(page, id));
const msg = (page) => page.$("push-msg").textContent;

async function openSettings(opts) {
  const page = await loadAdmin(opts);
  page.$("settings-open").click();
  await page.flush();
  return page;
}
const routes = (extra = {}) => ({
  "GET /api/admin/push": () => INFO,
  "POST /api/admin/push/subscribe": () => ({ status: 201, body: { ok: true, devices: 1 } }),
  "POST /api/admin/push/unsubscribe": () => ({ ok: true, devices: 0 }),
  "POST /api/admin/push/test": () => ({ ok: true, devices: 1 }),
  ...extra,
});

for (const oldBrowser of [false, true]) {
  const label = oldBrowser ? " (old browser: compat.js dialog shim)" : "";

  test(`admin push panel: every element admin.js uses is in admin.html${label}`, async () => {
    const b = fakePushBrowser({ device: makeDevice() });
    const page = await openSettings({ oldBrowser, navigator: b.navigator, globals: b.globals, routes: routes() });
    assert.deepEqual(page.missing, []);
    for (const id of ["push", "push-msg", "push-ios", "push-on", "push-test", "push-off"]) assert.ok(page.$(id), id);
  });

  test(`admin push panel: a browser without push gets no buttons, no push request and no service worker${label}`, async () => {
    for (const navigator of [{}, { serviceWorker: { register: () => { throw new Error("must not register"); } } }]) {
      const page = await openSettings({ oldBrowser, navigator, routes: routes() });
      assert.deepEqual(buttons(page), []);
      assert.match(msg(page), /^Denne nettleseren kan ikke vise varsler/);
      assert.equal(page.$("push-ios").hidden, true);
      assert.deepEqual(pushCalls(page), []);
    }
  });
}

test("admin push panel: an iPhone in Safari gets the Home Screen instruction, and no buttons", async () => {
  const b = fakePushBrowser({ device: makeDevice("apple"), ios: true, push: false });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
  assert.equal(page.$("push-ios").hidden, false);
  const text = /<p class="hint" id="push-ios" hidden>([\s\S]*?)<\/p>/.exec(await import("node:fs").then((fs) => fs.readFileSync(new URL("../../viggos-barbershop/admin.html", import.meta.url), "utf8")))[1].replace(/<[^>]+>/g, "");
  assert.match(text, /Del → Legg til på Hjem-skjerm, åpne Timebok derfra, og trykk Slå på varsler/);
  assert.match(text, /iOS 16\.4/);
  assert.deepEqual(buttons(page), []);
  assert.deepEqual(pushCalls(page), []);
  assert.deepEqual(b.log.registered, []);
});

test("admin push panel: an iPhone Home Screen app on iOS < 16.4 is told to update", async () => {
  const b = fakePushBrowser({ device: makeDevice("apple"), ios: true, standalone: true, push: false });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
  assert.equal(page.$("push-ios").hidden, true);
  assert.match(msg(page), /krever iOS 16\.4 eller nyere/);
  assert.deepEqual(buttons(page), []);
});

test("admin push panel: off on this device → only «Slå på varsler», and the service worker is registered for /admin only", async () => {
  const b = fakePushBrowser({ device: makeDevice() });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes({ "GET /api/admin/push": () => ({ ...INFO, devices: 2 }) }) });
  assert.deepEqual(buttons(page), ["push-on"]);
  assert.equal(msg(page), "Varsler er av på denne enheten. 2 andre enheter får varsler.");
  assert.deepEqual(b.log.registered, [{ url: "/admin-sw.js", scope: "/admin" }]);
  const [get] = pushCalls(page);
  assert.deepEqual([get.method, get.path, get.headers.Authorization], ["GET", "/api/admin/push", "Bearer test-admin-token"]);
  assert.equal(b.log.permissionAsks, 0, "nothing is asked before the barber taps");
});

for (const legacyCallback of [false, true]) {
  test(`admin push panel: «Slå på varsler» asks once, subscribes with the server's key and sends it with the token${legacyCallback ? " (callback-style permission, older Safari)" : ""}`, async () => {
    const device = makeDevice("apple");
    const b = fakePushBrowser({ device, legacyCallback });
    const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
    page.$("push-on").click();
    assert.equal(page.$("push-on").disabled, true, "no double tap while waiting");
    await page.flush();
    assert.equal(b.log.permissionAsks, 1);
    assert.equal(b.log.subscribes.length, 1);
    assert.equal(b.log.subscribes[0].userVisibleOnly, true);
    assert.deepEqual([...b.log.subscribes[0].applicationServerKey], KEY_BYTES, "exactly the server's public key");
    const post = pushCalls(page).find((c) => c.path === "/api/admin/push/subscribe");
    assert.equal(post.headers.Authorization, "Bearer test-admin-token");
    assert.deepEqual(post.body, { subscription: device.subscription });
    assert.deepEqual(buttons(page), ["push-test", "push-off"]);
    assert.match(msg(page), /^Varsler er på/);
    assert.equal(page.$("push-on").disabled, false);
  });
}

test("admin push panel: refusing permission sends nothing; «blocked» hides the button", async () => {
  for (const [answer, text, left] of [["denied", /blokkert/, []], ["default", /Du må tillate varsler/, ["push-on"]]]) {
    const b = fakePushBrowser({ device: makeDevice(), answer });
    const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
    page.$("push-on").click();
    await page.flush();
    assert.match(msg(page), text, answer);
    assert.deepEqual(b.log.subscribes, [], answer);
    assert.equal(pushCalls(page).filter((c) => c.method === "POST").length, 0, answer);
    assert.deepEqual(buttons(page), left, answer);
  }
  const b = fakePushBrowser({ device: makeDevice(), permission: "denied" });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
  assert.match(msg(page), /blokkert/, "already blocked when «Oppsett» opens");
  assert.deepEqual(buttons(page), []);
  assert.deepEqual(pushCalls(page), []);
});

test("admin push panel: a subscription the server refuses is undone in the browser", async () => {
  const b = fakePushBrowser({ device: makeDevice() });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes({
    "POST /api/admin/push/subscribe": () => ({ status: 400, body: { error: "Ukjent push-tjeneste. Bruk Safari, Chrome, Edge eller Firefox.", code: "unknown_push_service" } }),
  }) });
  page.$("push-on").click();
  await page.flush();
  assert.match(msg(page), /Ukjent push-tjeneste/);
  assert.equal(b.current(), null);
  assert.deepEqual(buttons(page), ["push-on"]);
});

test("admin push panel: an existing subscription is given to the server again and shown as on", async () => {
  const device = makeDevice("fcm");
  const b = fakePushBrowser({ device, permission: "granted", subscribed: KEY_BYTES });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
  const posts = pushCalls(page).filter((c) => c.path === "/api/admin/push/subscribe");
  assert.ok(posts.length >= 1);
  assert.deepEqual(posts[posts.length - 1].body, { subscription: device.subscription });
  assert.deepEqual(buttons(page), ["push-test", "push-off"]);
  assert.equal(b.log.permissionAsks, 0);
});

test("admin push panel: a subscription made with another server key is dropped, and the barber turns it on again", async () => {
  const b = fakePushBrowser({ device: makeDevice(), permission: "granted", subscribed: [...Buffer.from(makeDevice().subscription.keys.p256dh, "base64url")] });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
  assert.equal(b.current(), null);
  assert.equal(b.log.unsubscribed.length, 1);
  assert.match(msg(page), /må slås på igjen/);
  assert.deepEqual(buttons(page), ["push-on"]);
  assert.equal(pushCalls(page).filter((c) => c.path === "/api/admin/push/subscribe").length, 0, "the stale one is never sent");
});

test("admin push panel: «Send testvarsel» asks the server to test this device only", async () => {
  const device = makeDevice("apple");
  const b = fakePushBrowser({ device, permission: "granted", subscribed: KEY_BYTES });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
  page.$("push-test").click();
  await page.flush();
  const post = pushCalls(page).find((c) => c.path === "/api/admin/push/test");
  assert.deepEqual(post.body, { endpoint: device.endpoint });
  assert.equal(post.headers.Authorization, "Bearer test-admin-token");
  assert.match(msg(page), /^Testvarsel sendt/);
});

test("admin push panel: a test the server says is gone (410) drops the browser's subscription and offers «Slå på varsler»", async () => {
  const b = fakePushBrowser({ device: makeDevice(), permission: "granted", subscribed: KEY_BYTES });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes({
    "POST /api/admin/push/test": () => ({ status: 410, body: { error: "Denne enheten kan ikke lenger få varsler. Trykk «Slå på varsler» igjen.", code: "gone" } }),
  }) });
  page.$("push-test").click();
  await page.flush();
  assert.match(msg(page), /kan ikke lenger få varsler/);
  assert.equal(b.current(), null);
  assert.deepEqual(buttons(page), ["push-on"]);
});

test("admin push panel: «Slå av» unsubscribes in the browser first, then tells the server", async () => {
  const device = makeDevice("mozilla");
  const b = fakePushBrowser({ device, permission: "granted", subscribed: KEY_BYTES });
  const order = [];
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes({
    "POST /api/admin/push/unsubscribe": (call) => { order.push(["server", b.current() === null]); return { ok: true, devices: 1 }; },
  }) });
  page.$("push-off").click();
  await page.flush();
  assert.deepEqual(b.log.unsubscribed, [device.endpoint]);
  assert.deepEqual(order, [["server", true]], "the server hears about it after the browser has let go");
  assert.deepEqual(pushCalls(page).find((c) => c.path === "/api/admin/push/unsubscribe").body, { endpoint: device.endpoint });
  assert.equal(msg(page), "Varsler er slått av på denne enheten. 1 annen enhet får varsler.");
  assert.deepEqual(buttons(page), ["push-on"]);
});

test("admin push panel: if the browser cannot unsubscribe, the server is not told (so nothing turns itself back on)", async () => {
  const b = fakePushBrowser({ device: makeDevice(), permission: "granted", subscribed: KEY_BYTES, unsubscribeOk: false });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
  page.$("push-off").click();
  await page.flush();
  assert.match(msg(page), /Kunne ikke slå av varsler her/);
  assert.equal(pushCalls(page).filter((c) => c.path === "/api/admin/push/unsubscribe").length, 0);
});

test("admin push panel: closing «Oppsett» clears the panel, and a late answer does not come back", async () => {
  let answer;
  const b = fakePushBrowser({ device: makeDevice() });
  const page = await loadAdmin({ navigator: b.navigator, globals: b.globals, routes: routes({ "GET /api/admin/push": () => new Promise((r) => { answer = r; }) }) });
  page.$("settings-open").click();
  await page.flush();
  assert.equal(msg(page), "Henter …");
  page.$("settings-close").click();
  answer(INFO);
  await page.flush();
  assert.equal(msg(page), "");
  assert.deepEqual(buttons(page), []);
});

test("admin push panel: at start a device with notifications on gives the server its subscription; others do nothing", async () => {
  const device = makeDevice("apple");
  let b = fakePushBrowser({ device, permission: "granted", subscribed: KEY_BYTES });
  let page = await loadAdmin({ navigator: b.navigator, globals: b.globals, routes: routes() });
  assert.deepEqual(pushCalls(page).map((c) => `${c.method} ${c.path}`), ["GET /api/admin/push", "POST /api/admin/push/subscribe"]);
  assert.deepEqual(b.log.registered, [], "an existing registration is looked up, not made");
  for (const opts of [{ permission: "default" }, { permission: "granted" }, { permission: "denied", subscribed: KEY_BYTES }]) {
    b = fakePushBrowser({ device, ...opts });
    page = await loadAdmin({ navigator: b.navigator, globals: b.globals, routes: routes() });
    assert.deepEqual(pushCalls(page), [], JSON.stringify(opts));
    assert.deepEqual(b.log.registered, [], JSON.stringify(opts));
  }
});

// ---------- 6. The day from a notification ----------
const itemsDays = (page) => page.calls.filter((c) => c.path === "/api/admin/items").map((c) => /from=([\d-]+)&to=([\d-]+)/.exec(c.url)).filter((m) => m[1] === m[2]).map((m) => m[1]);

test("admin push panel: /admin?dag=… opens that day; a bad date opens today", async () => {
  let page = await loadAdmin({ search: "?dag=2026-11-20" });
  assert.deepEqual(itemsDays(page), ["2026-11-20"]);
  assert.equal(page.$("day").value, "2026-11-20");
  for (const search of ["?dag=2026-02-30", "?dag=x", "?dag=2026-11-20x", ""]) {
    page = await loadAdmin({ search });
    assert.notEqual(itemsDays(page)[0], "2026-11-20", search);
    assert.match(itemsDays(page)[0], /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("admin push panel: a tap on a notification while /admin is open shows that day", async () => {
  const b = fakePushBrowser({ device: makeDevice() });
  const page = await loadAdmin({ navigator: b.navigator, globals: b.globals });
  b.emit({ type: "open-day", date: "2026-12-03" });
  await page.flush();
  assert.equal(page.$("day").value, "2026-12-03");
  assert.equal(itemsDays(page).pop(), "2026-12-03");
  for (const data of [{ type: "open-day", date: null }, { type: "open-day", date: "2026-13-01" }, { type: "other", date: "2026-12-05" }, null, "x"]) {
    b.emit(data);
    await page.flush();
    assert.equal(page.$("day").value, "2026-12-03", JSON.stringify(data));
  }
});

// ---------- 7. End to end ----------
test("admin push panel: end to end through the real handlers, «Slå på varsler» then a web booking reaches the device", async () => {
  const PASSWORD = "fake-admin-password";
  const device = makeDevice("apple");
  const push = fakePushService({ devices: [device] });
  const d = testDeps({ now: "2026-11-12T09:00:00Z", env: { ADMIN_PASSWORD: PASSWORD }, fetch: push.fetch });
  const token = makeToken(PASSWORD, d.clock.now());
  const toServer = (call) => adminFn.handle(request(call.path, { method: call.method, headers: { Authorization: call.headers.Authorization }, json: call.body }), PRODUCTION, d).then(read);
  const b = fakePushBrowser({ device });
  const page = await openSettings({ token, navigator: b.navigator, globals: b.globals, routes: {
    "GET /api/admin/push": toServer, "POST /api/admin/push/subscribe": toServer, "POST /api/admin/push/test": toServer,
  } });
  page.$("push-on").click();
  await page.flush();
  assert.match(msg(page), /^Varsler er på/);
  page.$("push-test").click();
  await page.flush();
  assert.match(msg(page), /^Testvarsel sendt/);
  assert.equal(push.deliveries[0].payload.title, "Testvarsel");
  const res = await read(await bookingsFn.handle(request("/api/bookings", { method: "POST", json: {
    service: "Knivbarbering", date: "2026-11-14", start: 690, addons: [], name: "Per Hansen", phone: "41234567",
  } }), PRODUCTION, d));
  assert.equal(res.status, 201);
  const del = push.deliveries[1];
  assert.equal(del.error, undefined, del.error);
  assert.deepEqual(del.payload, {
    title: "Ny time", body: "Lørdag 14. november kl. 11:30 · Knivbarbering · Per Hansen",
    url: "/admin?dag=2026-11-14", tag: `ny-time-${res.body.booking.id}`,
  });
  assert.equal(del.vapid.ok, true, del.vapid.why);
  assert.deepEqual([...Buffer.from(del.vapid.k, "base64url")], [...b.log.subscribes[0].applicationServerKey], "signed with the key the page subscribed with");
});
