// /admin when this device's notifications were lost without the barber doing anything (notify leftovers): the
// browser replaced or lost the subscription, or the push service dropped it.
//   1. The service worker's reminder opens /admin?varsler=1 (or tells an open timebook «open-push»): Oppsett opens
//      at «Slå på varsler», after logging in if needed, so subscribe() still runs in the barber's own tap.
//   2. A device that had notifications on (it remembers its own endpoint) and finds no subscription at start, or
//      is told 410 by the server, says so on the main screen with a button to Oppsett, and tells the server to
//      forget the dead endpoint, so Oppsett does not count it as «1 annen enhet».
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin, fakePushBrowser, itemsRoute } from "../helpers/admin-page.mjs";
import { makeDevice } from "../helpers/fake-push.mjs";

const SERVER_KEY = makeDevice().subscription.keys.p256dh;
const KEY_BYTES = [...Buffer.from(SERVER_KEY, "base64url")];
const EXPIRED = { status: 401, body: { error: "Logg inn på nytt." } };
const visible = (page, id) => !page.$(id).hidden;
const LOST_TEXT = "Varsler om nye bestillinger er slått av på denne enheten.";

// A fake server for /api/admin/push that keeps its device list
function pushServer(endpoints = []) {
  const devices = new Set(endpoints);
  return {
    devices,
    routes: {
      "GET /api/admin/items": itemsRoute([]),
      "GET /api/admin/calendar": () => ({ enabled: false }),
      "GET /api/admin/push": (c) => {
        const q = new URL(c.url, "https://x").searchParams;
        const out = { publicKey: SERVER_KEY, devices: devices.size };
        if (q.has("endpoint")) out.thisDevice = devices.has(q.get("endpoint"));
        return out;
      },
      "POST /api/admin/push/subscribe": (c) => { devices.add(c.body.subscription.endpoint); return { status: 201, body: { ok: true, devices: devices.size, until: "2027-01-15T09:00:00.000Z" } }; },
      "POST /api/admin/push/unsubscribe": (c) => { devices.delete(c.body.endpoint); return { ok: true, devices: devices.size }; },
    },
  };
}

test("lost 1: /admin?varsler=1 (the reminder's tap) opens Oppsett with «Slå på varsler» ready, which subscribes in the tap", async () => {
  const device = makeDevice("fcm");
  const b = fakePushBrowser({ device, permission: "granted", registered: true });
  const server = pushServer();
  const page = await loadAdmin({ search: "?varsler=1", navigator: b.navigator, globals: b.globals, routes: server.routes });
  assert.equal(page.$("settings").open, true, "Oppsett is open without the barber looking for it");
  assert.equal(visible(page, "push-on"), true);
  assert.equal(page.doc.activeElement, page.$("push-on"), "«Slå på varsler» has the focus");
  page.$("push-on").click();
  assert.equal(b.log.subscribes.length, 1, "subscribe() runs in the tap itself");
  await page.flush();
  assert.ok(server.devices.has(device.endpoint));
});

test("lost 1: /admin?varsler=1 on a device whose login ran out opens Oppsett right after logging in", async () => {
  const b = fakePushBrowser({ device: makeDevice("fcm"), permission: "granted", registered: true });
  const server = pushServer();
  const page = await loadAdmin({ token: null, search: "?varsler=1", navigator: b.navigator, globals: b.globals, routes: { ...server.routes, "POST /api/admin/login": () => ({ token: "new" }) } });
  assert.equal(page.$("login").hidden, false);
  assert.equal(page.$("settings").open, false);
  page.$("pw").value = "riktig";
  page.submit("login-form");
  await page.flush();
  assert.equal(page.$("settings").open, true);
  assert.equal(visible(page, "push-on"), true);
});

test("lost 1: the reminder tapped while the timebook is open («open-push» from the service worker) opens Oppsett", async () => {
  const b = fakePushBrowser({ device: makeDevice("fcm"), permission: "granted", registered: true });
  const page = await loadAdmin({ navigator: b.navigator, globals: b.globals, routes: pushServer().routes });
  assert.equal(page.$("settings").open, false);
  b.emit({ type: "open-push" });
  await page.flush();
  assert.equal(page.$("settings").open, true);
  assert.equal(visible(page, "push-on"), true);
});

test("lost 2: a device that had notifications on and finds no subscription says so on the main screen, and the server forgets it", async () => {
  const device = makeDevice("fcm");
  const other = "https://fcm.googleapis.com/fcm/send/other-phone";
  const b = fakePushBrowser({ device, permission: "granted", registered: true }); // no subscription any more
  const server = pushServer([device.endpoint, other]);
  const note = JSON.stringify({ endpoint: device.endpoint, until: "2027-01-15T09:00:00.000Z" });
  const page = await loadAdmin({ storage: { "viggo-push": note }, navigator: b.navigator, globals: b.globals, routes: server.routes });
  assert.equal(visible(page, "push-lost"), true, "the main screen says it");
  assert.equal(page.$("push-lost-msg").textContent, LOST_TEXT);
  const forget = page.calls.find((c) => c.path === "/api/admin/push/unsubscribe");
  assert.deepEqual(forget && forget.body, { endpoint: device.endpoint }, "the dead endpoint is removed on the server");
  assert.deepEqual([...server.devices], [other]);
  page.$("push-lost-on").click();
  await page.flush();
  assert.equal(page.$("settings").open, true);
  assert.equal(visible(page, "push-on"), true);
  assert.equal(page.$("push-msg").textContent, "Varslene må slås på igjen på denne enheten. 1 annen enhet får varsler.", "the other phone, not this one");
  page.$("push-on").click();
  await page.flush();
  assert.equal(visible(page, "push-lost"), false, "turned on again: the line goes away");
});

test("lost 2: if the server could not forget it at start, Oppsett still counts only the other devices (thisDevice)", async () => {
  const device = makeDevice("fcm");
  const other = "https://fcm.googleapis.com/fcm/send/other-phone";
  const b = fakePushBrowser({ device, permission: "granted", registered: true });
  const server = pushServer([device.endpoint, other]);
  const routes = { ...server.routes, "POST /api/admin/push/unsubscribe": () => { throw new TypeError("Load failed"); } };
  const page = await loadAdmin({ storage: { "viggo-push": JSON.stringify({ endpoint: device.endpoint }) }, navigator: b.navigator, globals: b.globals, routes });
  page.$("settings-open").click();
  await page.flush();
  const asked = page.calls.filter((c) => c.path === "/api/admin/push" && c.method === "GET").map((c) => c.url);
  assert.ok(asked.includes("/api/admin/push?endpoint=" + encodeURIComponent(device.endpoint)), asked.join(", "));
  assert.equal(page.$("push-msg").textContent, "Varslene må slås på igjen på denne enheten. 1 annen enhet får varsler.");
  assert.equal(page.$("push-reset").hidden, false, "«Slå av varsler på alle andre enheter» is for the one other phone");
});

test("lost 2: the push service called this subscription gone (410 at start): it is dropped and the main screen says so", async () => {
  const device = makeDevice("fcm");
  const b = fakePushBrowser({ device, permission: "granted", subscribed: KEY_BYTES });
  const server = pushServer();
  const routes = { ...server.routes, "POST /api/admin/push/subscribe": () => ({ status: 410, body: { error: "Borte.", code: "gone" } }) };
  const page = await loadAdmin({ navigator: b.navigator, globals: b.globals, routes });
  assert.deepEqual(b.log.unsubscribed, [device.endpoint]);
  assert.equal(visible(page, "push-lost"), true);
});

test("lost 2: nothing is shown on a device that never had notifications, or that turned them off itself", async () => {
  const device = makeDevice("fcm");
  const b = fakePushBrowser({ device, permission: "granted", registered: true });
  const page = await loadAdmin({ navigator: b.navigator, globals: b.globals, routes: pushServer().routes });
  assert.equal(visible(page, "push-lost"), false);
  assert.equal(page.calls.filter((c) => c.path === "/api/admin/push/unsubscribe").length, 0);
  // On, then «Slå av» in Oppsett: the device forgets its note, so no line appears at the next start
  const on = fakePushBrowser({ device, permission: "granted", subscribed: KEY_BYTES });
  const server = pushServer();
  const p2 = await loadAdmin({ navigator: on.navigator, globals: on.globals, routes: server.routes });
  p2.$("settings-open").click();
  await p2.flush();
  p2.$("push-off").click();
  await p2.flush();
  assert.equal(p2.local.getItem("viggo-push"), null);
  assert.equal(visible(p2, "push-lost"), false);
});

test("lost 1: the reminder tapped while an edit sheet is open never closes the sheet; the main screen line says it instead", async () => {
  const b = fakePushBrowser({ device: makeDevice("fcm"), permission: "granted", registered: true });
  const page = await loadAdmin({ navigator: b.navigator, globals: b.globals, routes: pushServer().routes });
  page.$("add").click();
  page.field("name").value = "Halvskrevet";
  b.emit({ type: "open-push" });
  await page.flush();
  assert.equal(page.$("editor").open, true);
  assert.equal(page.field("name").value, "Halvskrevet");
  assert.equal(page.$("settings").open, false);
  assert.equal(visible(page, "push-lost"), true);
});
