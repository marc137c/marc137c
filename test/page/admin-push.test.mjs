// /admin «Oppsett → Varsler på denne enheten» (admin.html + admin.js) against a fake DOM built from the real
// admin.html and a fake push-capable browser (test/helpers/admin-page.mjs). Invariants:
//   1. every element admin.js uses exists in admin.html;
//   2. a browser without service worker, PushManager or Notification (Safari 10, Chrome 60, Firefox 55, old
//      browsers with the compat.js dialog shim) gets no push buttons of its own, registers nothing and only asks the
//      server how many devices get notifications (GET /api/admin/push); an iPhone outside the Home Screen gets the
//      Norwegian «Del → Legg til på Hjem-skjerm» instruction. There, and where notifications are blocked,
//      «Slå av varsler på alle andre enheter» still shows when other devices get them;
//   3. «Slå på varsler» subscribes in the tap itself (Safari, also on iPhone, allows it only there; subscribe()
//      asks for permission), with exactly the server's public key and userVisibleOnly, and sends the subscription
//      to the server with the admin token; a refusal sends nothing;
//   4. «Send testvarsel» asks the server to test this device only; «Slå av» unsubscribes in the browser first and
//      only then tells the server, so a device can never turn itself back on;
//   5. an existing subscription is given to the server again (when «Oppsett» opens and at start), and one made with
//      another key, or one the push service called gone (the server answers 410), is dropped and shown as off;
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
const pushRequests = (page) => pushCalls(page).map((c) => `${c.method} ${c.path}`);
const visible = (page, id) => !page.$(id).hidden;
const buttons = (page) => ["push-on", "push-retry", "push-test", "push-off"].filter((id) => visible(page, id));
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
    for (const id of ["push", "push-msg", "push-ios", "push-on", "push-retry", "push-test", "push-off", "push-reset"]) assert.ok(page.$(id), id);
  });

  test(`admin push panel: a browser without push gets no buttons, no service worker, and only asks for the device count${label}`, async () => {
    for (const navigator of [{}, { serviceWorker: { register: () => { throw new Error("must not register"); } } }]) {
      const page = await openSettings({ oldBrowser, navigator, routes: routes() });
      assert.deepEqual(buttons(page), []);
      assert.equal(page.$("push-reset").hidden, true, "no other device gets notifications");
      assert.equal(msg(page), "Denne nettleseren kan ikke vise varsler. Bruk en nyere Chrome, Edge, Firefox eller Safari.");
      assert.equal(page.$("push-ios").hidden, true);
      assert.deepEqual(pushRequests(page), ["GET /api/admin/push"]);
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
  assert.deepEqual(pushRequests(page), ["GET /api/admin/push"], "only the device count");
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

test("admin push panel: «Slå på varsler» subscribes in the tap itself with the server's key, and sends it with the token", async () => {
  const device = makeDevice("apple");
  const b = fakePushBrowser({ device });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
  page.$("push-on").click();
  assert.equal(b.log.subscribes.length, 1, "subscribe() runs inside the tap, before anything is awaited (iPhone needs that)");
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

test("admin push panel: after a short login («Hold meg innlogget» off) the panel says until when notifications come", async () => {
  const until = new Date(Date.now() + 5 * 3600e3);
  const pad = (n) => String(n).padStart(2, "0");
  const today = (d) => d.toDateString() === new Date().toDateString();
  const b = fakePushBrowser({ device: makeDevice("wns") });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes({
    "POST /api/admin/push/subscribe": () => ({ status: 201, body: { ok: true, devices: 1, until: until.toISOString() } }),
  }) });
  page.$("push-on").click();
  await page.flush();
  assert.equal(msg(page), `Varsler er på til innloggingen her går ut, ${today(until) ? "" : "i morgen "}kl. ${pad(until.getHours())}:${pad(until.getMinutes())}. Når du logger inn på nytt, varer de like lenge som den nye innloggingen.`);
  assert.deepEqual(buttons(page), ["push-test", "push-off"]);
});

// Since step 2 every login has an end, «Hold meg innlogget» too (60 days): nothing may promise notifications
// 'hele tiden' (all the time), and a 60-day login shows its date
test("admin push panel: a 60-day login shows the date notifications stop; no text promises them 'hele tiden'", async () => {
  const until = new Date(Date.now() + 60 * 24 * 3600e3);
  const b = fakePushBrowser({ device: makeDevice("wns") });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes({
    "POST /api/admin/push/subscribe": () => ({ status: 201, body: { ok: true, devices: 1, until: until.toISOString() } }),
  }) });
  page.$("push-on").click();
  await page.flush();
  const month = new Intl.DateTimeFormat("nb-NO", { month: "long" }).format(until);
  assert.match(msg(page), new RegExp(`^Varsler er på til innloggingen her går ut, ${until.getDate()}\\. ${month} kl\\. \\d\\d:\\d\\d\\. Når du logger inn på nytt`));
  const { readFileSync } = await import("node:fs");
  for (const f of ["admin.js", "admin.html", "README.md"]) {
    assert.doesNotMatch(readFileSync(new URL("../../viggos-barbershop/" + f, import.meta.url), "utf8"), /hele tiden|fortsetter de til du slår dem av/, f);
  }
});

test("admin push panel: refusing permission sends nothing; «blocked» offers only «Prøv igjen»", async () => {
  for (const [answer, text, left] of [["denied", /blokkert/, ["push-retry"]], ["default", /Du må tillate varsler/, ["push-on"]]]) {
    const b = fakePushBrowser({ device: makeDevice(), answer });
    const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
    page.$("push-on").click();
    await page.flush();
    assert.match(msg(page), text, answer);
    assert.equal(b.log.permissionAsks, 1, answer);
    assert.equal(b.current(), null, answer);
    assert.equal(pushCalls(page).filter((c) => c.method === "POST").length, 0, answer);
    assert.deepEqual(buttons(page), left, answer);
  }
  const b = fakePushBrowser({ device: makeDevice(), permission: "denied" });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
  assert.match(msg(page), /blokkert/, "already blocked when «Oppsett» opens");
  assert.deepEqual(buttons(page), ["push-retry"]);
  assert.deepEqual(pushRequests(page), ["GET /api/admin/push"], "only the device count");
  assert.deepEqual(b.log.registered, []);
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

const GONE = { status: 410, body: { error: "Denne enheten kan ikke lenger få varsler. Trykk «Slå på varsler» igjen.", code: "gone" } };

test("admin push panel: a subscription the push service called gone is dropped in the browser and shown as off", async () => {
  // gone at start (pushSync), or only by the time «Oppsett» opens (pushLoad)
  for (const goneFrom of [1, 2]) {
    const device = makeDevice("fcm");
    const b = fakePushBrowser({ device, permission: "granted", subscribed: KEY_BYTES });
    let n = 0;
    const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes({
      "GET /api/admin/push": () => ({ ...INFO, devices: 1 }),
      "POST /api/admin/push/subscribe": () => (++n >= goneFrom ? GONE : { ok: true, devices: 2 }),
    }) });
    assert.equal(b.current(), null, "the dead subscription is gone from the browser");
    assert.deepEqual(b.log.unsubscribed, [device.endpoint]);
    assert.deepEqual(buttons(page), ["push-on"], String(goneFrom));
    assert.equal(msg(page), "Varslene må slås på igjen på denne enheten. 1 annen enhet får varsler.", String(goneFrom));
    // «Slå på varsler» with the same dead subscription (subscribe() hands back an existing one)
    page.$("push-on").click();
    await page.flush();
    // (this fake browser gives the same endpoint again; a real one makes a new endpoint after unsubscribe())
    assert.equal(msg(page), "Denne enheten kan ikke lenger få varsler. Trykk «Slå på varsler» igjen.", "the server still refuses this one");
    assert.equal(b.current(), null, "and it is dropped again, so the next tap makes a new one");
    assert.deepEqual(buttons(page), ["push-on"]);
  }
});

test("admin push panel: at start, a subscription the server answers 410 for is dropped in the browser", async () => {
  const b = fakePushBrowser({ device: makeDevice("fcm"), permission: "granted", subscribed: KEY_BYTES });
  await loadAdmin({ navigator: b.navigator, globals: b.globals, routes: routes({ "POST /api/admin/push/subscribe": () => GONE }) });
  assert.equal(b.current(), null);
  for (const status of [400, 500, 503]) {
    const c = fakePushBrowser({ device: makeDevice("fcm"), permission: "granted", subscribed: KEY_BYTES });
    await loadAdmin({ navigator: c.navigator, globals: c.globals, routes: routes({ "POST /api/admin/push/subscribe": () => ({ status, body: { error: "x" } }) }) });
    assert.ok(c.current(), `a ${status} at start keeps the subscription`);
  }
});

test("admin push panel: end to end, after the push service answers 410 /admin shows off, never «på»", async (t) => {
  t.mock.method(console, "warn", () => {});
  const PASSWORD = "fake-admin-password";
  const device = makeDevice("fcm");
  let status = 201;
  const push = fakePushService({ devices: [device], reply: () => status });
  const d = testDeps({ now: "2026-11-12T09:00:00Z", env: { ADMIN_PASSWORD: PASSWORD }, fetch: push.fetch });
  const token = makeToken(PASSWORD, d.clock.now());
  const toServer = (call) => adminFn.handle(request(call.path, { method: call.method, headers: { Authorization: call.headers.Authorization }, json: call.body }), PRODUCTION, d).then(read);
  const serverRoutes = {};
  for (const r of ["GET /api/admin/push", "POST /api/admin/push/subscribe"]) serverRoutes[r] = toServer;
  const b = fakePushBrowser({ device });
  const page = await openSettings({ token, navigator: b.navigator, globals: b.globals, routes: serverRoutes });
  page.$("push-on").click();
  await page.flush();
  assert.match(msg(page), /^Varsler er på/);
  status = 410; // FCM unregisters the token; Chrome keeps the PushSubscription and fires no event
  const res = await read(await bookingsFn.handle(request("/api/bookings", { method: "POST", json: {
    service: "Herreklipp", date: "2026-11-14", start: 690, addons: [], name: "Per Hansen", phone: "41234567",
  } }), PRODUCTION, d));
  assert.equal(res.status, 201);
  page.$("settings-close").click();
  page.$("settings-open").click();
  await page.flush();
  assert.equal(msg(page), "Varslene må slås på igjen på denne enheten.");
  assert.deepEqual(buttons(page), ["push-on"]);
  assert.equal(b.current(), null);
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

// ---------- 8. A push service that never answers ----------
test("admin push panel: if subscribe() never finishes, after 20 s the barber is told and the button works again", async () => {
  const device = makeDevice("fcm");
  const b = fakePushBrowser({ device, permission: "granted", subscribeHangs: true });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
  page.$("push-on").click();
  await page.flush();
  assert.deepEqual([msg(page), page.$("push-on").disabled], ["Slår på …", true]);
  await page.advance(19999);
  assert.deepEqual([msg(page), page.$("push-on").disabled], ["Slår på …", true], "not before the time limit");
  await page.advance(1);
  assert.equal(msg(page), "Fikk ikke kontakt med varseltjenesten. Sjekk nettet og prøv igjen.");
  assert.equal(page.$("push-on").disabled, false);
  assert.deepEqual(buttons(page), ["push-on"]);
  assert.equal(pushCalls(page).filter((c) => c.path === "/api/admin/push/subscribe").length, 0);
  // The subscription arrives late after all: the server still gets it, and the panel shows «on»
  b.settleSubscribe();
  await page.flush();
  const posts = pushCalls(page).filter((c) => c.path === "/api/admin/push/subscribe");
  assert.deepEqual(posts.map((c) => c.body), [{ subscription: device.subscription }]);
  assert.match(msg(page), /^Varsler er på/);
  assert.deepEqual(buttons(page), ["push-test", "push-off"]);
  assert.equal(page.timers(), 0, "no timer is left behind");
});

test("admin push panel: closing and reopening «Oppsett» during a hanging «Slå på varsler» gives a working button", async () => {
  const b = fakePushBrowser({ device: makeDevice("mozilla"), permission: "granted", subscribeHangs: true });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
  page.$("push-on").click();
  await page.flush();
  assert.equal(page.$("push-on").disabled, true);
  page.$("settings-close").click();
  await page.flush();
  page.$("settings-open").click();
  await page.flush();
  assert.equal(msg(page), "Varsler er av på denne enheten.");
  assert.deepEqual(buttons(page), ["push-on"]);
  assert.equal(page.$("push-on").disabled, false, "the button is never left disabled after reopening");
  page.$("push-on").click();
  assert.equal(b.log.subscribes.length, 2, "a second tap tries again");
  // The time limit of the first, abandoned tap does not overwrite the panel of the second
  await page.advance(20000);
  assert.equal(msg(page), "Fikk ikke kontakt med varseltjenesten. Sjekk nettet og prøv igjen.");
  assert.equal(page.$("push-on").disabled, false);
});

test("admin push panel: a fast subscribe() leaves no timer and is never reported as a time-out", async () => {
  const b = fakePushBrowser({ device: makeDevice("apple"), permission: "granted" });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
  page.$("push-on").click();
  await page.flush();
  assert.match(msg(page), /^Varsler er på/);
  assert.equal(page.timers(), 0);
  await page.advance(60000);
  assert.match(msg(page), /^Varsler er på/);
});

// ---------- 9. «Slå av varsler på alle andre enheter» ----------
const resetShown = (page) => !page.$("push-reset").hidden;

test("admin push panel: «Slå av varsler på alle andre enheter» shows only when other devices get notifications", async () => {
  const cases = [
    [{}, 0, false], [{}, 2, true],                                   // this device off: devices = the others
    [{ permission: "granted", subscribed: KEY_BYTES }, 1, false],    // on: only this one
    [{ permission: "granted", subscribed: KEY_BYTES }, 3, true],     // on: this one and two others
  ];
  for (const [opts, devices, shown] of cases) {
    const b = fakePushBrowser({ device: makeDevice(), ...opts });
    const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes({
      "GET /api/admin/push": () => ({ ...INFO, devices }),
      "POST /api/admin/push/subscribe": () => ({ ok: true, devices }),
    }) });
    assert.equal(resetShown(page), shown, JSON.stringify([opts.permission, devices]));
    if (opts.subscribed && devices === 3) assert.match(msg(page), /^Varsler er på\..* 2 andre enheter får varsler\.$/);
  }
  // Also where this browser cannot get notifications itself, or has them blocked
  for (const [label, opts] of [
    ["no push", { navigator: {} }],
    ["iPhone Safari tab", { navigator: fakePushBrowser({ device: makeDevice(), ios: true, push: false }).navigator }],
    ["blocked", fakePushBrowser({ device: makeDevice(), permission: "denied" })],
  ]) {
    for (const devices of [0, 4]) {
      const page = await openSettings({ navigator: opts.navigator, globals: opts.globals, routes: routes({ "GET /api/admin/push": () => ({ ...INFO, devices }) }) });
      assert.equal(resetShown(page), devices > 0, `${label}, ${devices}`);
    }
  }
});

test("admin push panel: without push here (iPhone Safari tab, old browser) or with it blocked, the other devices can still be cut off", async () => {
  const cases = [
    ["iPhone Safari tab", () => fakePushBrowser({ device: makeDevice("apple"), ios: true, push: false }), "2 andre enheter får varsler.", []],
    ["iPhone Home Screen app before iOS 16.4", () => fakePushBrowser({ device: makeDevice("apple"), ios: true, standalone: true, push: false }), "Varsler på iPhone krever iOS 16.4 eller nyere. Oppdater under Innstillinger → Generelt → Programvareoppdatering. 2 andre enheter får varsler.", []],
    ["no service worker", () => ({ navigator: {}, globals: {} }), "Denne nettleseren kan ikke vise varsler. Bruk en nyere Chrome, Edge, Firefox eller Safari. 2 andre enheter får varsler.", []],
    ["blocked", () => fakePushBrowser({ device: makeDevice(), permission: "denied" }), BLOCKED_TEXT + " 2 andre enheter får varsler.", ["push-retry"]],
  ];
  for (const oldBrowser of [false, true]) {
    for (const [label, make, text, left] of cases) {
      const b = make();
      const page = await openSettings({ oldBrowser, navigator: b.navigator, globals: b.globals, routes: routes({
        "GET /api/admin/push": () => ({ ...INFO, devices: 2 }),
        "POST /api/admin/push/reset": () => ({ ok: true, devices: 0 }),
      }) });
      assert.equal(msg(page), text, label);
      assert.deepEqual(buttons(page), left, label);
      assert.equal(resetShown(page), true, label);
      page.$("push-reset").click();
      await page.flush();
      assert.match(page.confirms[0], /^Slå av varsler på de 2 andre enhetene?/, label);
      assert.match(page.confirms[0], /og logge ut alle andre enheter\?/, label);
      assert.match(page.confirms[0], /Bytt passordet i Netlify, og publiser på nytt/, label);
      const reset = pushCalls(page).find((c) => c.path === "/api/admin/push/reset");
      assert.deepEqual([reset.method, reset.headers.Authorization], ["POST", "Bearer test-admin-token"], label);
      assert.equal(msg(page), "Varsler er slått av på alle andre enheter.", label);
      assert.deepEqual(buttons(page), left, `${label}: never «Slå på varsler» where it cannot work`);
      assert.equal(resetShown(page), false, label);
      assert.deepEqual(pushRequests(page).filter((r) => r.startsWith("POST")), ["POST /api/admin/push/reset"], `${label}: nothing is subscribed`);
      assert.deepEqual(page.missing, [], label);
    }
  }
});

test("admin push panel: end to end, an iPhone Safari tab cuts off a lost phone, which gets no further booking", async () => {
  const PASSWORD = "fake-admin-password";
  const lost = makeDevice("fcm");
  const push = fakePushService({ devices: [lost] });
  const d = testDeps({ now: "2026-11-12T09:00:00Z", env: { ADMIN_PASSWORD: PASSWORD }, fetch: push.fetch });
  const token = makeToken(PASSWORD, d.clock.now(), 60 * 24 * 3600e3);
  const toServer = (call) => adminFn.handle(request(call.path, { method: call.method, headers: { Authorization: call.headers.Authorization }, json: call.body }), PRODUCTION, d).then(read);
  await toServer({ path: "/api/admin/push", method: "GET", headers: { Authorization: "Bearer " + token } });
  assert.equal((await toServer({ path: "/api/admin/push/subscribe", method: "POST", headers: { Authorization: "Bearer " + token }, body: { subscription: lost.subscription } })).status, 201);
  const b = fakePushBrowser({ device: makeDevice("apple"), ios: true, push: false });
  const page = await openSettings({ token, navigator: b.navigator, globals: b.globals, routes: { "GET /api/admin/push": toServer, "POST /api/admin/push/reset": toServer } });
  assert.equal(msg(page), "1 annen enhet får varsler.");
  page.$("push-reset").click();
  await page.flush();
  assert.equal(msg(page), "Varsler er slått av på alle andre enheter.");
  const res = await read(await bookingsFn.handle(request("/api/bookings", { method: "POST", json: {
    service: "Herreklipp", date: "2026-11-14", start: 690, addons: [], name: "Per Hansen", phone: "41234567",
  } }), PRODUCTION, d));
  assert.equal(res.status, 201);
  assert.equal(push.deliveries.length, 0, "the lost phone gets nothing");
});

test("admin push panel: reset asks first, needs the token, and turns this device on again afterwards", async () => {
  const device = makeDevice("apple");
  let answer = false;
  const b = fakePushBrowser({ device, permission: "granted", subscribed: KEY_BYTES });
  const order = [];
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, confirm: () => answer, routes: routes({
    "GET /api/admin/push": () => ({ ...INFO, devices: 3 }),
    "POST /api/admin/push/subscribe": () => { order.push("subscribe"); return { ok: true, devices: order.includes("reset") ? 1 : 3 }; },
    "POST /api/admin/push/reset": () => { order.push("reset"); return { ok: true, devices: 0 }; },
  }) });
  order.length = 0;
  page.$("push-reset").click();
  await page.flush();
  assert.match(page.confirms[0], /^Slå av varsler på de 2 andre enhetene, og logge ut alle andre enheter\?/);
  assert.deepEqual(order, [], "nothing happens unless the barber confirms");
  answer = true;
  page.$("push-reset").click();
  await page.flush();
  assert.deepEqual(order, ["reset", "subscribe"], "this device is subscribed again after the reset");
  const reset = pushCalls(page).find((c) => c.path === "/api/admin/push/reset");
  assert.deepEqual([reset.method, reset.headers.Authorization], ["POST", "Bearer test-admin-token"]);
  assert.deepEqual(pushCalls(page).filter((c) => c.path === "/api/admin/push/subscribe").pop().body, { subscription: device.subscription });
  assert.equal(msg(page), "Varsler er slått av på alle andre enheter. Denne enheten får fortsatt varsler.");
  assert.deepEqual(buttons(page), ["push-test", "push-off"]);
  assert.equal(resetShown(page), false, "no other device left");
  assert.equal(b.log.unsubscribed.length, 0, "this browser keeps its subscription");
});

test("admin push panel: reset from a device that is off does not turn it on", async () => {
  const b = fakePushBrowser({ device: makeDevice() });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes({
    "GET /api/admin/push": () => ({ ...INFO, devices: 1 }),
    "POST /api/admin/push/reset": () => ({ ok: true, devices: 0 }),
  }) });
  assert.equal(resetShown(page), true);
  page.$("push-reset").click();
  await page.flush();
  assert.match(page.confirms[0], /^Slå av varsler på den andre enheten, og logge ut alle andre enheter\?/);
  assert.equal(pushCalls(page).filter((c) => c.path === "/api/admin/push/subscribe").length, 0);
  assert.equal(msg(page), "Varsler er slått av på alle andre enheter.");
  assert.deepEqual(buttons(page), ["push-on"]);
  assert.equal(resetShown(page), false);
});

test("admin push panel: end to end, a reset from the phone leaves only the phone, and only it gets the next booking", async () => {
  const PASSWORD = "fake-admin-password";
  const phone = makeDevice("apple"), lost = makeDevice("fcm");
  const push = fakePushService({ devices: [phone, lost] });
  const d = testDeps({ now: "2026-11-12T09:00:00Z", env: { ADMIN_PASSWORD: PASSWORD }, fetch: push.fetch });
  const token = makeToken(PASSWORD, d.clock.now());
  const toServer = (call) => adminFn.handle(request(call.path, { method: call.method, headers: { Authorization: call.headers.Authorization }, json: call.body }), PRODUCTION, d).then(read);
  assert.equal((await toServer({ path: "/api/admin/push", method: "GET", headers: { Authorization: "Bearer " + token } })).status, 200);
  assert.equal((await toServer({ path: "/api/admin/push/subscribe", method: "POST", headers: { Authorization: "Bearer " + token }, body: { subscription: lost.subscription } })).status, 201);
  const b = fakePushBrowser({ device: phone });
  const serverRoutes = {};
  for (const r of ["GET /api/admin/push", "POST /api/admin/push/subscribe", "POST /api/admin/push/reset"]) serverRoutes[r] = toServer;
  const page = await openSettings({ token, navigator: b.navigator, globals: b.globals, routes: serverRoutes });
  page.$("push-on").click();
  await page.flush();
  assert.match(msg(page), /^Varsler er på.* 1 annen enhet får varsler\.$/);
  page.$("push-reset").click();
  await page.flush();
  assert.equal(msg(page), "Varsler er slått av på alle andre enheter. Denne enheten får fortsatt varsler.");
  const res = await read(await bookingsFn.handle(request("/api/bookings", { method: "POST", json: {
    service: "Herreklipp", date: "2026-11-14", start: 690, addons: [], name: "Per Hansen", phone: "41234567",
  } }), PRODUCTION, d));
  assert.equal(res.status, 201);
  assert.deepEqual(push.deliveries.map((x) => x.device), [phone], "the lost phone gets nothing");
});

// ---------- 10. Blocked, then allowed in the settings ----------
const BLOCKED_TEXT = "Varsler er blokkert for denne siden. Tillat varsler i nettleserens innstillinger (på iPhone: Innstillinger → Varslinger → Timebok), og trykk Prøv igjen.";
const STILL_BLOCKED_TEXT = "Fortsatt blokkert. Åpne nettleserens innstillinger for denne siden (på iPhone: Innstillinger → Varslinger → Timebok), velg Tillat for varsler, og kom tilbake hit.";
const CHECKING_TEXT = "Sjekker …";
const showPage = (page) => (page.doc.listeners.visibilitychange || []).forEach((fn) => fn({ type: "visibilitychange" }));

test("admin push panel: blocked → «Prøv igjen»; after allowing notifications in the settings it offers «Slå på varsler»", async () => {
  const b = fakePushBrowser({ device: makeDevice(), permission: "denied" });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
  assert.equal(msg(page), BLOCKED_TEXT);
  assert.deepEqual(buttons(page), ["push-retry"]);
  // Every tap gives a visible answer at once: «Sjekker …» with the button greyed out, then the result
  const tap = async () => {
    page.$("push-retry").click();
    assert.equal(msg(page), CHECKING_TEXT, "the tap shows at once that it is checking");
    assert.equal(page.$("push-retry").disabled, true, "and greys out the button meanwhile");
    await page.flush();
    assert.equal(msg(page), CHECKING_TEXT, "the answer comes a moment later, not in the same instant");
    await page.advance(400);
  };
  await tap();
  assert.equal(msg(page), STILL_BLOCKED_TEXT, "still blocked: the tap gets a visibly different answer");
  assert.notEqual(STILL_BLOCKED_TEXT, BLOCKED_TEXT);
  assert.deepEqual(buttons(page), ["push-retry"]);
  assert.equal(page.$("push-retry").disabled, false);
  await tap();
  assert.equal(msg(page), STILL_BLOCKED_TEXT, "the second tap also went through «Sjekker …» before the answer");
  await tap();
  assert.equal(msg(page), STILL_BLOCKED_TEXT, "and the third");
  assert.deepEqual(pushRequests(page).filter((r) => r.startsWith("POST")), [], "nothing is subscribed while blocked");
  assert.deepEqual(b.log.registered, [], "and no service worker is registered");
  b.setPermission("granted");
  await tap();
  assert.deepEqual(buttons(page), ["push-on"]);
  assert.equal(msg(page), "Varsler er av på denne enheten.");
  assert.equal(page.$("push-on").disabled, false);
});

test("admin push panel: «Prøv igjen» while blocked keeps the device count and «Slå av varsler på alle andre enheter»", async () => {
  const b = fakePushBrowser({ device: makeDevice(), permission: "denied" });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes({ "GET /api/admin/push": () => ({ ...INFO, devices: 1 }) }) });
  assert.equal(msg(page), BLOCKED_TEXT + " 1 annen enhet får varsler.");
  page.$("push-retry").click();
  assert.equal(msg(page), CHECKING_TEXT, "the tap shows at once that it is checking");
  await page.advance(400);
  assert.equal(msg(page), STILL_BLOCKED_TEXT + " 1 annen enhet får varsler.");
  assert.equal(page.$("push-reset").hidden, false);
  // Coming back from the settings still blocked (no tap) shows the usual text again
  showPage(page);
  await page.flush();
  assert.equal(msg(page), BLOCKED_TEXT + " 1 annen enhet får varsler.");
});

test("admin push panel: coming back to the page with «Oppsett» open shows the new permission (and does nothing when it is closed)", async () => {
  const b = fakePushBrowser({ device: makeDevice(), permission: "denied" });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
  b.setPermission("default"); // reset in the browser's site settings
  showPage(page);
  await page.flush();
  assert.deepEqual(buttons(page), ["push-on"]);
  page.$("settings-close").click();
  await page.flush();
  const before = pushCalls(page).length;
  b.setPermission("denied");
  showPage(page);
  await page.flush();
  assert.equal(pushCalls(page).length, before, "no push work while «Oppsett» is closed");
  assert.equal(msg(page), "");
});

test("admin push panel: a permission change the browser reports (navigator.permissions) refreshes the open panel", async () => {
  const b = fakePushBrowser({ device: makeDevice(), permission: "denied", permissionsApi: true });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
  assert.deepEqual(buttons(page), ["push-retry"]);
  b.setPermission("granted");
  await page.flush();
  assert.deepEqual(buttons(page), ["push-on"]);
  // Browsers without navigator.permissions, or that refuse «notifications», are fine
  for (const permissions of [undefined, { query: () => { throw new TypeError("nope"); } }, { query: () => Promise.reject(new TypeError("nope")) }]) {
    const c = fakePushBrowser({ device: makeDevice(), permission: "denied" });
    c.navigator.permissions = permissions;
    const p = await openSettings({ navigator: c.navigator, globals: c.globals, routes: routes() });
    assert.deepEqual(buttons(p), ["push-retry"]);
  }
});

test("admin push panel: coming back to the page during «Slår på …» does not interrupt it", async () => {
  const b = fakePushBrowser({ device: makeDevice("apple"), permission: "granted", subscribeHangs: true });
  const page = await openSettings({ navigator: b.navigator, globals: b.globals, routes: routes() });
  page.$("push-on").click();
  await page.flush();
  const gets = pushCalls(page).filter((c) => c.method === "GET").length;
  showPage(page);
  await page.flush();
  assert.equal(pushCalls(page).filter((c) => c.method === "GET").length, gets, "the panel is not reloaded while a tap is working");
  b.settleSubscribe();
  await page.flush();
  assert.match(msg(page), /^Varsler er på/);
});

test("admin push panel: end to end, after a password change a device gets notifications again only once it logs in with the new password", async () => {
  const OLD = "old-password", NEW = "new-password";
  const phone = makeDevice("apple");
  const push = fakePushService({ devices: [phone] });
  const d = testDeps({ now: "2026-11-12T09:00:00Z", env: { ADMIN_PASSWORD: OLD }, fetch: push.fetch });
  const toServer = (call) => adminFn.handle(request(call.path, { method: call.method, headers: { Authorization: call.headers.Authorization }, json: call.body }), PRODUCTION, d).then(read);
  const serverRoutes = {};
  for (const r of ["GET /api/admin/push", "POST /api/admin/push/subscribe"]) serverRoutes[r] = toServer;
  const b = fakePushBrowser({ device: phone });
  const page = await openSettings({ token: makeToken(OLD, d.clock.now()), navigator: b.navigator, globals: b.globals, routes: serverRoutes });
  page.$("push-on").click();
  await page.flush();
  assert.match(msg(page), /^Varsler er på/);
  let slot = 600;
  const book = () => bookingsFn.handle(request("/api/bookings", { method: "POST", json: {
    service: "Herreklipp", date: "2026-11-14", start: (slot += 30), addons: [], name: "Per Hansen", phone: "41234567",
  } }), PRODUCTION, d).then(read);
  d.env.ADMIN_PASSWORD = NEW;
  assert.equal((await book()).status, 201);
  assert.equal(push.deliveries.length, 0, "the old password's device is cut off");
  // The same browser opens /admin again, logged in with the new password: it turns itself back on
  await loadAdmin({ token: makeToken(NEW, d.clock.now()), navigator: b.navigator, globals: b.globals, routes: serverRoutes });
  assert.equal((await book()).status, 201);
  assert.deepEqual(push.deliveries.map((x) => x.device), [phone]);
});

// ---------- 11. Reset keeps this device logged in ----------
// POST /api/admin/push/reset ends every other login (auth/epoch) and answers { ok, devices: 0, token }: the page
// must keep that new token, or the barber who pressed the button is logged out too on the next request.
test("admin push panel: end to end, after «Slå av varsler på alle andre enheter» this device stays logged in with the new token", async () => {
  const PASSWORD = "fake-admin-password";
  const push = fakePushService({ devices: [] });
  const d = testDeps({ now: "2026-11-12T09:00:00Z", env: { ADMIN_PASSWORD: PASSWORD }, fetch: push.fetch });
  const token = makeToken(PASSWORD, d.clock.now(), 60 * 24 * 3600e3);
  const toServer = (call) => adminFn.handle(request(call.url || call.path, { method: call.method, headers: { Authorization: call.headers.Authorization }, json: call.body }), PRODUCTION, d).then(read);
  // Another device is on, so the reset button shows
  const other = makeDevice("fcm");
  await toServer({ path: "/api/admin/push", method: "GET", headers: { Authorization: "Bearer " + token } });
  assert.equal((await toServer({ path: "/api/admin/push/subscribe", method: "POST", headers: { Authorization: "Bearer " + token }, body: { subscription: other.subscription } })).status, 201);
  d.clock.advance(1000);
  const b = fakePushBrowser({ device: makeDevice("apple"), ios: true, push: false });
  const page = await openSettings({ token, navigator: b.navigator, globals: b.globals, routes: {
    "GET /api/admin/push": toServer, "POST /api/admin/push/reset": toServer, "GET /api/admin/items": toServer, "GET /api/admin/calendar": toServer,
  } });
  page.$("push-reset").click();
  await page.flush();
  assert.equal(msg(page), "Varsler er slått av på alle andre enheter.");
  const kept = page.local.getItem("viggo-admin-token");
  assert.ok(kept && kept !== token, "the new token from the reset answer is stored");
  assert.equal((await toServer({ path: "/api/admin/items", method: "GET", headers: { Authorization: "Bearer " + token } })).status, 401, "the old token is ended");
  page.$("settings-close").click();
  page.$("next").click();
  await page.flush();
  assert.equal(page.$("login").hidden, true, "still logged in");
  assert.equal(page.calls.at(-1).headers.Authorization, "Bearer " + kept);
});
