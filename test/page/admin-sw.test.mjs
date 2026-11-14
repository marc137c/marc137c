// viggos-barbershop/admin-sw.js, the service worker for /admin, run in node:vm with a fake service worker global.
// Invariants:
//   1. it only shows notifications and opens the timebook: no fetch handler, so it never intercepts or caches;
//   2. every push shows a notification (iPhone and Chrome revoke push for silent pushes), also with no data,
//      broken JSON or a payload that is not an object;
//   3. a tap opens /admin on the booking's day: an open /admin window is focused and told the day, otherwise a
//      new window opens; a payload can never make it open another site or another page;
//   4. when the browser replaces the subscription (pushsubscriptionchange), a new one is made with the same server
//      key (or the browser's new one is used) and given to the server at /api/push/renew with the old endpoint and
//      its auth secret, so the next booking reaches it; if that fails in any way, a «Timebok» notification asks the
//      barber to open the timebook, so nothing is missed silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { makeDevice, fakePushService } from "../helpers/fake-push.mjs";
import { testDeps, request, read, SITE, PRODUCTION } from "../helpers/deps.mjs";
import { makeToken } from "../../netlify/lib/booking-core.mjs";
import * as adminFn from "../../netlify/functions/admin.mjs";
import * as bookingsFn from "../../netlify/functions/bookings.mjs";
import * as renewFn from "../../netlify/functions/push-renew.mjs";

const SW = readFileSync(fileURLToPath(new URL("../../viggos-barbershop/admin-sw.js", import.meta.url)), "utf8");
const ORIGIN = "https://viggos.test";
const BOOKING = { title: "Ny time", body: "Fredag 13. november kl. 10:00 · Herreklipp · Ola Nordmann", url: "/admin?dag=2026-11-13", tag: "ny-time-2026-11-13_abc" };

// fetch: the server's answer to the service worker's own requests (only POST /api/push/renew); default 200
// subscribe: what pushManager.subscribe() resolves with (a function of its options), or throws to reject
function loadSw({ windows = [], fetch = () => new Response(JSON.stringify({ ok: true }), { status: 200 }), subscribe = () => ({}) } = {}) {
  const listeners = {};
  const shown = [], opened = [], subscribed = [], waits = [], fetches = [];
  let skipped = 0, claimed = 0;
  const self = {
    location: { origin: ORIGIN, href: ORIGIN + "/admin-sw.js" },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    skipWaiting: () => { skipped++; return Promise.resolve(); },
    btoa: (s) => Buffer.from(String(s), "latin1").toString("base64"),
    fetch: (url, init) => { fetches.push({ url, init, body: init && init.body ? JSON.parse(init.body) : undefined }); return Promise.resolve().then(() => fetch(url, init)); },
    registration: {
      showNotification: (title, options) => { shown.push({ title, options }); return Promise.resolve(); },
      pushManager: { subscribe: (opts) => { subscribed.push(opts); return Promise.resolve().then(() => subscribe(opts)); } },
    },
    clients: {
      claim: () => { claimed++; return Promise.resolve(); },
      matchAll: (opts) => { self.matchAllOpts = opts; return Promise.resolve(windows); },
      openWindow: (url) => { opened.push(url); return Promise.resolve(null); },
    },
  };
  vm.runInNewContext(SW, { self, URL, console }, { filename: "admin-sw.js" });
  const fire = (type, event = {}) => {
    const e = { ...event, waitUntil: (p) => waits.push(Promise.resolve(p)) };
    for (const fn of listeners[type] || []) fn(e);
    return Promise.all(waits.splice(0));
  };
  const pushEvent = (data) => ({ data: data === undefined ? null : { json: () => (typeof data === "string" ? JSON.parse(data) : data) } });
  return { self, listeners, shown, opened, subscribed, fetches, fire, pushEvent, counts: () => ({ skipped, claimed }) };
}

const windowAt = (path) => {
  const w = { url: ORIGIN + path, messages: [], focused: 0 };
  w.postMessage = (m) => w.messages.push(m);
  w.focus = () => { w.focused++; return Promise.resolve(w); };
  return w;
};
const clickEvent = (url) => {
  const n = { data: { url }, closed: false, close() { this.closed = true; } };
  return { notification: n };
};

test("admin sw: listens for install, activate, push, notificationclick and pushsubscriptionchange, and never for fetch", async () => {
  const sw = loadSw();
  assert.deepEqual(Object.keys(sw.listeners).sort(), ["activate", "install", "notificationclick", "push", "pushsubscriptionchange"]);
  await sw.fire("install");
  await sw.fire("activate");
  assert.deepEqual(sw.counts(), { skipped: 1, claimed: 1 }, "a new version takes over at once");
});

test("admin sw: a booking push shows «Ny time» with its text, tag and icon, and remembers the day to open", async () => {
  const sw = loadSw();
  await sw.fire("push", sw.pushEvent(BOOKING));
  assert.equal(sw.shown.length, 1);
  const { title, options } = sw.shown[0];
  assert.equal(title, "Ny time");
  assert.equal(options.body, BOOKING.body);
  assert.equal(options.tag, BOOKING.tag);
  assert.equal(options.icon, "/admin-icon-192.png");
  assert.equal(options.lang, "nb");
  assert.deepEqual(JSON.parse(JSON.stringify(options.data)), { url: "/admin?dag=2026-11-13" });
});

test("admin sw: every push shows a notification, whatever its data", async () => {
  for (const data of [undefined, "null", "[1,2]", "42", '"text"', {}, { title: 5, body: null, tag: 7 }]) {
    const sw = loadSw();
    const event = sw.pushEvent(data);
    await sw.fire("push", event);
    assert.equal(sw.shown.length, 1, JSON.stringify(data));
    assert.equal(sw.shown[0].title, "Timebok");
    assert.equal(typeof sw.shown[0].options.body, "string");
    assert.equal(sw.shown[0].options.tag, undefined);
  }
  const sw = loadSw();
  await sw.fire("push", { data: { json: () => { throw new SyntaxError("Unexpected token"); } } });
  assert.equal(sw.shown.length, 1, "broken JSON still shows a notification");
});

test("admin sw: a payload can never make a tap open another site or another page", async () => {
  for (const url of ["https://evil.example/admin", "//evil.example/admin", "javascript:alert(1)", "/", "/api/admin/items", "/administrator", "/admin/../api", "data:text/html,x", 5]) {
    const sw = loadSw();
    await sw.fire("push", sw.pushEvent({ ...BOOKING, url }));
    assert.equal(sw.shown[0].options.data.url, "/admin", String(url));
    await sw.fire("notificationclick", clickEvent(url));
    assert.deepEqual(sw.opened, ["/admin"], String(url));
  }
  const sw = loadSw();
  await sw.fire("push", sw.pushEvent({ ...BOOKING, url: "/admin.html?dag=2026-11-20" }));
  assert.equal(sw.shown[0].options.data.url, "/admin.html?dag=2026-11-20");
});

test("admin sw: a tap with /admin open focuses it and tells it the day; nothing new opens", async () => {
  const site = windowAt("/"), timebook = windowAt("/admin?dag=2026-11-01");
  const sw = loadSw({ windows: [site, timebook] });
  const event = clickEvent("/admin?dag=2026-11-13");
  await sw.fire("notificationclick", event);
  assert.equal(event.notification.closed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(sw.self.matchAllOpts)), { type: "window", includeUncontrolled: true });
  assert.deepEqual(timebook.messages.map((m) => JSON.parse(JSON.stringify(m))), [{ type: "open-day", date: "2026-11-13" }]);
  assert.equal(timebook.focused, 1);
  assert.deepEqual(site.messages, [], "the public site is left alone");
  assert.deepEqual(sw.opened, []);
});

test("admin sw: a tap without /admin open opens it on the booking's day", async () => {
  const sw = loadSw({ windows: [windowAt("/"), windowAt("/#booking")] });
  await sw.fire("notificationclick", clickEvent("/admin?dag=2026-11-13"));
  assert.deepEqual(sw.opened, ["/admin?dag=2026-11-13"]);
  const none = loadSw();
  await none.fire("notificationclick", clickEvent("/admin"));
  assert.deepEqual(none.opened, ["/admin"], "the test notification opens the timebook");
});

// ---------- 4. pushsubscriptionchange ----------
const arrayBuffer = (buf) => Uint8Array.from(buf).buffer;
// A PushSubscription as the browser hands it to the service worker
const browserSub = (device, key = arrayBuffer([4, 1, 2, 3])) => ({
  endpoint: device.endpoint,
  options: { applicationServerKey: key, userVisibleOnly: true },
  getKey: (name) => (name === "auth" ? arrayBuffer(device.auth) : name === "p256dh" ? arrayBuffer(device.publicKey) : null),
  toJSON: () => device.subscription,
});
const REMINDER = { title: "Timebok", body: "Åpne Timebok for å fortsette å få varsel om nye bestillinger.", url: "/admin" };
const shownAs = (n) => ({ title: n.title, body: n.options.body, url: n.options.data.url });

test("admin sw: a replaced subscription is renewed with the same server key and given to the server", async () => {
  const oldDevice = makeDevice("mozilla"), newDevice = makeDevice("mozilla");
  const old = browserSub(oldDevice);
  const sw = loadSw({ subscribe: () => browserSub(newDevice) });
  await sw.fire("pushsubscriptionchange", { oldSubscription: old });
  assert.equal(sw.subscribed.length, 1);
  assert.equal(sw.subscribed[0].applicationServerKey, old.options.applicationServerKey);
  assert.equal(sw.subscribed[0].userVisibleOnly, true);
  assert.equal(sw.fetches.length, 1);
  const [f] = sw.fetches;
  assert.equal(f.url, "/api/push/renew", "only to this site's own renew path");
  assert.equal(f.init.method, "POST");
  assert.equal(f.init.headers["Content-Type"], "application/json");
  assert.deepEqual(f.body, { oldEndpoint: oldDevice.endpoint, oldAuth: oldDevice.subscription.keys.auth, subscription: newDevice.subscription });
  assert.deepEqual(sw.shown, [], "no reminder when the server took it");
});

test("admin sw: a new subscription the browser already made is used as it is", async () => {
  const oldDevice = makeDevice("fcm"), newDevice = makeDevice("fcm");
  const sw = loadSw();
  await sw.fire("pushsubscriptionchange", { oldSubscription: browserSub(oldDevice), newSubscription: browserSub(newDevice) });
  assert.equal(sw.subscribed.length, 0);
  assert.deepEqual(sw.fetches[0].body.subscription, newDevice.subscription);
  assert.deepEqual(sw.shown, []);
});

test("admin sw: if the subscription cannot be renewed or the server does not take it, a Timebok notification says so", async () => {
  const old = () => browserSub(makeDevice("mozilla"));
  const cases = [
    ["the server says no", { fetch: () => new Response("{}", { status: 404 }) }, { oldSubscription: old() }],
    ["the server is down", { fetch: () => new Response("{}", { status: 503 }) }, { oldSubscription: old() }],
    ["no network", { fetch: () => { throw new TypeError("Failed to fetch"); } }, { oldSubscription: old() }],
    ["subscribe() fails", { subscribe: () => { throw new Error("AbortError"); } }, { oldSubscription: old() }],
    ["no old subscription", {}, {}],
    ["an old subscription without its key", {}, { oldSubscription: { ...old(), options: {} } }],
    ["no auth secret", { subscribe: () => browserSub(makeDevice("mozilla")) }, { oldSubscription: { ...old(), getKey: () => null } }],
  ];
  for (const [label, opts, event] of cases) {
    const sw = loadSw({ subscribe: () => browserSub(makeDevice("mozilla")), ...opts });
    await sw.fire("pushsubscriptionchange", event);
    assert.deepEqual(sw.shown.map(shownAs), [REMINDER], label);
    assert.equal(sw.shown[0].options.tag, "forny-varsler", label);
    assert.ok(sw.fetches.every((f) => f.url === "/api/push/renew"), label);
  }
  // A tap on the reminder opens the timebook (which gives the server the subscription)
  const sw = loadSw();
  await sw.fire("notificationclick", clickEvent(REMINDER.url));
  assert.deepEqual(sw.opened, ["/admin"]);
});

test("admin sw: end to end, after pushsubscriptionchange the next booking reaches the new subscription", async (t) => {
  t.mock.method(console, "warn", () => {});
  const PASSWORD = "fake-admin-password";
  const oldDevice = makeDevice("mozilla"), newDevice = makeDevice("mozilla");
  const push = fakePushService({ devices: [oldDevice, newDevice], reply: (del) => (del.device === oldDevice ? 410 : 201) });
  const d = testDeps({ now: "2026-11-12T09:00:00Z", env: { ADMIN_PASSWORD: PASSWORD }, fetch: push.fetch });
  const auth = { Authorization: "Bearer " + makeToken(PASSWORD, d.clock.now(), 60 * 24 * 3600e3) };
  await adminFn.handle(request("/api/admin/push", { headers: auth }), PRODUCTION, d);
  const sub = await read(await adminFn.handle(request("/api/admin/push/subscribe", { method: "POST", headers: auth, json: { subscription: oldDevice.subscription } }), PRODUCTION, d));
  assert.equal(sub.status, 201);
  // The service worker's fetch goes to the real /api/push/renew handler (same origin, as a browser sends it)
  const answers = [];
  const sw = loadSw({
    subscribe: () => browserSub(newDevice),
    fetch: async (url, init) => {
      const res = await renewFn.handle(new Request(SITE + url, { ...init, headers: { ...init.headers, "Sec-Fetch-Site": "same-origin" } }), PRODUCTION, d);
      answers.push(res.status);
      return res;
    },
  });
  await sw.fire("pushsubscriptionchange", { oldSubscription: browserSub(oldDevice) });
  assert.deepEqual(answers, [200]);
  assert.deepEqual(sw.shown, []);
  const res = await read(await bookingsFn.handle(request("/api/bookings", { method: "POST", json: {
    service: "Herreklipp", date: "2026-11-14", start: 690, addons: [], name: "Per Hansen", phone: "41234567",
  } }), PRODUCTION, d));
  assert.equal(res.status, 201);
  assert.deepEqual(push.deliveries.map((x) => x.device), [newDevice], "only the new subscription, and it decrypts");
  assert.equal(push.deliveries[0].payload.title, "Ny time");
});
