// viggos-barbershop/admin-sw.js, the service worker for /admin, run in node:vm with a fake service worker global.
// Invariants:
//   1. it only shows notifications and opens the timebook: no fetch handler, so it never intercepts or caches;
//   2. every push shows a notification (iPhone and Chrome revoke push for silent pushes), also with no data,
//      broken JSON or a payload that is not an object;
//   3. a tap opens /admin on the booking's day: an open /admin window is focused and told the day, otherwise a
//      new window opens; a payload can never make it open another site or another page;
//   4. when the browser replaces the subscription, a new one is made with the same server key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SW = readFileSync(fileURLToPath(new URL("../../viggos-barbershop/admin-sw.js", import.meta.url)), "utf8");
const ORIGIN = "https://viggos.test";
const BOOKING = { title: "Ny time", body: "Fredag 13. november kl. 10:00 · Herreklipp · Ola Nordmann", url: "/admin?dag=2026-11-13", tag: "ny-time-2026-11-13_abc" };

function loadSw({ windows = [] } = {}) {
  const listeners = {};
  const shown = [], opened = [], subscribed = [], waits = [];
  let skipped = 0, claimed = 0;
  const self = {
    location: { origin: ORIGIN, href: ORIGIN + "/admin-sw.js" },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    skipWaiting: () => { skipped++; return Promise.resolve(); },
    registration: {
      showNotification: (title, options) => { shown.push({ title, options }); return Promise.resolve(); },
      pushManager: { subscribe: (opts) => { subscribed.push(opts); return Promise.resolve({}); } },
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
  return { self, listeners, shown, opened, subscribed, fire, pushEvent, counts: () => ({ skipped, claimed }) };
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

test("admin sw: a replaced subscription is renewed with the same server key", async () => {
  const key = new Uint8Array([4, 1, 2, 3]).buffer;
  const sw = loadSw();
  await sw.fire("pushsubscriptionchange", { oldSubscription: { options: { applicationServerKey: key, userVisibleOnly: true } } });
  assert.equal(sw.subscribed.length, 1);
  assert.equal(sw.subscribed[0].applicationServerKey, key);
  assert.equal(sw.subscribed[0].userVisibleOnly, true);
  await sw.fire("pushsubscriptionchange", {});
  assert.equal(sw.subscribed.length, 1, "without the old key there is nothing to renew with");
});
