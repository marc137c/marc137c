// /admin «Oppsett → Kalender på telefonen» (viggos-barbershop/admin.html + admin.js), run against a fake DOM
// built from the real admin.html (test/helpers/admin-page.mjs). Invariants:
//   1. every element admin.js uses exists in admin.html;
//   2. the link (which carries the secret) is fetched only when «Oppsett» opens, with the admin token, and is
//      taken off the page again when the dialog closes;
//   3. no link → «Lag kalenderlenke»; a link → «Legg til på iPhone» (webcal://), «Legg til i Google Kalender»
//      (add by URL) and the https link to copy;
//   4. «Lag ny lenke» asks first and does nothing unless the barber confirms; then it asks the server to replace;
//   5. copying uses the clipboard API where it exists, execCommand("copy") otherwise, and the button is hidden
//      when the browser can do neither;
//   6. the same works with compat.js's <dialog> shim (Safari < 15.4, Firefox < 98);
//   7. an expired login closes the dialog and shows the login.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin } from "../helpers/admin-page.mjs";

const TOKEN = "Z".repeat(43);
const LINKS = {
  https: `https://viggos.test/api/calendar/${TOKEN}.ics`,
  webcal: `webcal://viggos.test/api/calendar/${TOKEN}.ics`,
  google: "https://calendar.google.com/calendar/r?cid=" + encodeURIComponent(`webcal://viggos.test/api/calendar/${TOKEN}.ics`),
};
const NEW_TOKEN = "Y".repeat(43);
const NEW_LINKS = { https: LINKS.https.replace(TOKEN, NEW_TOKEN), webcal: LINKS.webcal.replace(TOKEN, NEW_TOKEN), google: LINKS.google.replace(TOKEN, NEW_TOKEN) };
const READY = { enabled: true, createdAt: "2026-11-16T08:00:00.000Z", links: LINKS };

const calCalls = (page) => page.calls.filter((c) => c.path === "/api/admin/calendar");
const visible = (page, id) => !page.$(id).hidden;

async function openSettings(opts) {
  const page = await loadAdmin(opts);
  page.$("settings-open").click();
  await page.flush();
  return page;
}

for (const oldBrowser of [false, true]) {
  const label = oldBrowser ? " (old browser: compat.js dialog shim)" : "";

  test(`admin calendar panel: every element admin.js uses is in admin.html${label}`, async () => {
    const page = await openSettings({ oldBrowser, routes: { "GET /api/admin/calendar": () => READY } });
    assert.deepEqual(page.missing, []);
    for (const id of ["settings", "settings-open", "settings-close", "cal", "cal-msg", "cal-none", "cal-create", "cal-ready", "cal-ios", "cal-google", "cal-url", "cal-copy", "cal-renew"]) {
      assert.ok(page.$(id), id);
    }
    assert.equal(page.$("settings").tagName, "DIALOG");
    assert.equal(page.$("cal-ios").tagName, "A");
    assert.equal(page.$("cal-google").tagName, "A");
  });

  test(`admin calendar panel: the link is fetched only when «Oppsett» opens, with the admin token${label}`, async () => {
    const page = await loadAdmin({ oldBrowser, routes: { "GET /api/admin/calendar": () => READY } });
    assert.deepEqual(calCalls(page), [], "not on page load");
    assert.equal(page.$("cal-url").value, "");
    page.$("settings-open").click();
    assert.equal(page.$("settings").open, true);
    assert.equal(page.$("cal-msg").textContent, "Henter …");
    await page.flush();
    const [get] = calCalls(page);
    assert.equal(get.method, "GET");
    assert.equal(get.headers.Authorization, "Bearer test-admin-token");
    assert.ok(visible(page, "cal-ready"));
    assert.ok(!visible(page, "cal-none"));
    assert.equal(page.$("cal-ios").href, LINKS.webcal);
    assert.equal(page.$("cal-google").href, LINKS.google);
    assert.equal(page.$("cal-url").value, LINKS.https);
    assert.equal(page.$("cal-msg").textContent, "");
    // Closing takes the secret off the page
    page.$("settings-close").click();
    assert.equal(page.$("settings").open, false);
    assert.equal(page.$("cal-url").value, "");
    assert.equal(page.$("cal-ios").href, "#");
    assert.equal(page.$("cal-google").href, "#");
    assert.ok(!visible(page, "cal-ready"));
  });

  test(`admin calendar panel: with no link yet it offers «Lag kalenderlenke», which creates one${label}`, async () => {
    const page = await openSettings({ oldBrowser, routes: {
      "GET /api/admin/calendar": () => ({ enabled: false }),
      "POST /api/admin/calendar": () => ({ status: 201, body: READY }),
    } });
    assert.ok(visible(page, "cal-none"));
    assert.ok(!visible(page, "cal-ready"));
    assert.equal(page.$("cal-msg").textContent, "Du har ingen kalenderlenke ennå.");
    page.$("cal-create").click();
    assert.equal(page.$("cal-create").disabled, true, "no double create while waiting");
    await page.flush();
    const post = calCalls(page).find((c) => c.method === "POST");
    assert.deepEqual(post.body, { replace: false });
    assert.equal(post.headers.Authorization, "Bearer test-admin-token");
    assert.equal(page.$("cal-create").disabled, false);
    assert.ok(visible(page, "cal-ready"));
    assert.equal(page.$("cal-url").value, LINKS.https);
    assert.match(page.$("cal-msg").textContent, /Lenken er klar/);
    assert.deepEqual(page.confirms, [], "creating the first link needs no confirmation");
  });

  test(`admin calendar panel: «Lag ny lenke» asks first; no means nothing is sent${label}`, async () => {
    const page = await openSettings({ oldBrowser, confirm: () => false, routes: { "GET /api/admin/calendar": () => READY } });
    page.$("cal-renew").click();
    await page.flush();
    assert.equal(page.confirms.length, 1);
    assert.match(page.confirms[0], /^Lage en ny kalenderlenke\?/);
    assert.match(page.confirms[0], /slutter å virke med en gang/);
    assert.deepEqual(calCalls(page).map((c) => c.method), ["GET"], "no POST without a yes");
    assert.equal(page.$("cal-url").value, LINKS.https, "the link is unchanged");
  });

  test(`admin calendar panel: «Lag ny lenke» + yes replaces the link and shows the new one${label}`, async () => {
    const page = await openSettings({ oldBrowser, confirm: () => true, routes: {
      "GET /api/admin/calendar": () => READY,
      "POST /api/admin/calendar": (call) => ({ status: 201, body: { ...READY, links: call.body.replace ? NEW_LINKS : LINKS } }),
    } });
    page.$("cal-renew").click();
    await page.flush();
    const post = calCalls(page).find((c) => c.method === "POST");
    assert.deepEqual(post.body, { replace: true });
    assert.equal(page.$("cal-url").value, NEW_LINKS.https);
    assert.equal(page.$("cal-ios").href, NEW_LINKS.webcal);
    assert.equal(page.$("cal-google").href, NEW_LINKS.google);
    assert.match(page.$("cal-msg").textContent, /Den gamle virker ikke lenger/);
  });

  test(`admin calendar panel: copy uses the clipboard API when it exists${label}`, async () => {
    const written = [];
    const page = await openSettings({ oldBrowser, navigator: { clipboard: { writeText: (t) => { written.push(t); return Promise.resolve(); } } }, routes: { "GET /api/admin/calendar": () => READY } });
    assert.ok(visible(page, "cal-copy"));
    page.$("cal-copy").click();
    await page.flush();
    assert.deepEqual(written, [LINKS.https]);
    assert.equal(page.$("cal-msg").textContent, "Lenken er kopiert.");
  });

  test(`admin calendar panel: without the clipboard API it copies with execCommand (Safari 10, Chrome 60, Firefox 55)${label}`, async () => {
    const page = await openSettings({ oldBrowser, navigator: {}, queryCommandSupported: (c) => c === "copy", execCommand: (cmd, doc) => cmd === "copy" && doc.activeElement && doc.activeElement.selectedText === LINKS.https, routes: { "GET /api/admin/calendar": () => READY } });
    assert.ok(visible(page, "cal-copy"));
    page.$("cal-copy").click();
    await page.flush();
    assert.deepEqual(page.doc.execCommandCalls, ["copy"]);
    assert.equal(page.$("cal-msg").textContent, "Lenken er kopiert.");
  });

  test(`admin calendar panel: if copying fails it tells the barber to copy by hand; with no way to copy the button is hidden${label}`, async () => {
    let page = await openSettings({ oldBrowser, navigator: { clipboard: { writeText: () => Promise.reject(new Error("denied")) } }, queryCommandSupported: () => true, execCommand: () => false, routes: { "GET /api/admin/calendar": () => READY } });
    page.$("cal-copy").click();
    await page.flush();
    assert.match(page.$("cal-msg").textContent, /Hold fingeren på lenken og velg Kopier/);
    page = await openSettings({ oldBrowser, navigator: {}, routes: { "GET /api/admin/calendar": () => READY } });
    assert.equal(page.$("cal-copy").hidden, true, "no clipboard API and no execCommand: no button");
    assert.equal(page.$("cal-url").value, LINKS.https, "the link is still there to copy by hand");
  });

  test(`admin calendar panel: an expired login closes the dialog and shows the login${label}`, async () => {
    const page = await openSettings({ oldBrowser, routes: { "GET /api/admin/calendar": () => ({ status: 401, body: { error: "Logg inn på nytt." } }) } });
    assert.equal(page.$("settings").open, false);
    assert.equal(page.$("login").hidden, false);
    assert.equal(page.$("app").hidden, true);
    assert.equal(page.$("login-msg").textContent, "Logg inn på nytt.");
    assert.equal(page.local.getItem("viggo-admin-token"), null);
  });

  test(`admin calendar panel: no connection gives a Norwegian message${label}`, async () => {
    const page = await openSettings({ oldBrowser, routes: { "GET /api/admin/calendar": () => { throw new TypeError("Failed to fetch"); } } });
    assert.equal(page.$("cal-msg").textContent, "Ingen forbindelse. Prøv igjen.");
    assert.ok(!visible(page, "cal-ready"));
    assert.ok(!visible(page, "cal-none"));
  });
}

test("admin calendar panel: after a password change the barber is told the old link stopped, and can make a new one", async () => {
  let made = 0;
  const page = await openSettings({ routes: {
    "GET /api/admin/calendar": () => ({ enabled: false, expired: true }),
    "POST /api/admin/calendar": (call) => { made++; assert.deepEqual(call.body, { replace: false }); return { status: 201, body: READY }; },
  } });
  assert.match(page.$("cal-msg").textContent, /^Passordet er byttet, så den gamle kalenderlenken virker ikke lenger\. Lag en ny lenke/);
  assert.equal(visible(page, "cal-none"), true);
  assert.equal(visible(page, "cal-ready"), false);
  assert.equal(page.$("cal-url").value, "");
  page.$("cal-create").click();
  await page.flush();
  assert.equal(made, 1);
  assert.equal(page.$("cal-url").value, LINKS.https);
});

test("admin calendar panel: the page says plainly that a password change stops the link", async () => {
  const html = (await import("node:fs")).readFileSync(new URL("../../viggos-barbershop/admin.html", import.meta.url), "utf8");
  assert.match(html, /Bytter du admin-passordet \(i Netlify, og publiserer på nytt\), slutter lenken også å virke, og du må lage en ny\./);
});

// compat.js's <dialog> stand-in (Firefox < 98, Safari < 15.4) must say «close» like a real <dialog>, or Esc would
// leave the secret link and the push state on the page.
for (const Event of [undefined, function Event() { throw new TypeError("Illegal constructor"); }]) {
  const label = Event ? " (no Event constructor: createEvent)" : "";
  test(`admin settings (old browser): Esc closes «Oppsett» and takes the link and the push state off the page${label}`, async () => {
    const { fakePushBrowser } = await import("../helpers/admin-page.mjs");
    const { makeDevice } = await import("../helpers/fake-push.mjs");
    const device = makeDevice("mozilla");
    const key = device.subscription.keys.p256dh;
    const b = fakePushBrowser({ device, permission: "granted", subscribed: [...Buffer.from(key, "base64url")] });
    const page = await openSettings({ oldBrowser: true, navigator: b.navigator, globals: { ...b.globals, ...(Event ? { Event } : {}) }, routes: {
      "GET /api/admin/calendar": () => READY,
      "GET /api/admin/push": () => ({ publicKey: key, devices: 1 }),
      "POST /api/admin/push/subscribe": () => ({ ok: true, devices: 1 }),
    } });
    assert.equal(page.$("settings").classList.contains("dialog-shim"), true, "the stand-in is in use");
    assert.equal(page.$("cal-url").value, LINKS.https);
    assert.match(page.$("push-msg").textContent, /^Varsler er på/);
    const e = page.doc.key("Escape");
    assert.equal(e.defaultPrevented, true);
    assert.equal(page.$("settings").open, false);
    assert.equal(page.$("cal-url").value, "", "the secret link is gone from the page");
    assert.equal(page.$("cal-ios").href, "#");
    assert.equal(page.$("cal-google").href, "#");
    assert.equal(page.$("cal-msg").textContent, "");
    assert.equal(page.$("push-msg").textContent, "");
    assert.deepEqual(["push-on", "push-test", "push-off"].filter((id) => !page.$(id).hidden), []);
  });
}
