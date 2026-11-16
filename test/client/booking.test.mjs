// The booking page (viggos-barbershop/booking.js, i18n.js and the #bestill form in index.html), run in the client
// harness against a fake server with the real rules. Owner decisions D2/D3 (docs/SPEC.md): Netlify Blobs is the only
// store of a booking, and whenever the booking API fails, times out or answers something we cannot trust, the
// customer is told to call 409 63 911, keeps what they typed, and is never told the time is confirmed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, later, FRIDAY, RATE_LIMITED } from "./booking-harness.mjs";

const CALL = "409 63 911";
const PROMISE = /mottatt|bekrefter|received|confirm/i;

// A booking for Friday 14:00 whose POST gets `answer`; returns the page after `wait` ms.
async function failedBooking(answer, { wait = 1000, lang = null } = {}) {
  const site = await boot({ lang, setup: (s) => s.when((r) => r.url === "/api/bookings", answer) });
  await site.pick(FRIDAY);
  await site.book();
  await site.advance(wait);
  return site;
}
const kept = (site) => {
  assert.equal(site.$("f-name").value, FRIDAY.name, "the name is still in the field");
  assert.equal(site.$("f-phone").value, FRIDAY.phone, "the phone is still in the field");
  assert.equal(site.select.value, FRIDAY.service, "the service is still chosen");
  assert.match(site.summary(), /fredag 13\. november kl\. 14:00|Friday 13 November at 2:00 PM/, "the chosen day and time are still shown");
};

const FAILURES = [
  { label: "network error", answer: { network: true }, kind: "uncertain" },
  { label: "no answer within 20 s", answer: { hang: true }, wait: 20000, kind: "uncertain" },
  { label: "500", answer: { status: 500, body: { error: "Noe gikk galt. Ring oss gjerne." } }, kind: "uncertain" },
  { label: "502 HTML", answer: { status: 502, body: "<html><body>Bad gateway</body></html>" }, kind: "uncertain" },
  { label: "503", answer: { status: 503, body: { error: "Mange endringer samtidig. Prøv igjen." } }, kind: "uncertain" },
  { label: "504", answer: { status: 504, body: "<html>Gateway timeout</html>" }, kind: "uncertain" },
  { label: "404", answer: { status: 404, body: "<!doctype html><title>Not found</title>" }, kind: "notSaved" },
  { label: "429", answer: RATE_LIMITED, kind: "rateLimited" },
  { label: "429 without a JSON body", answer: { status: 429, body: "Too Many Requests" }, kind: "rateLimited" },
];

for (const f of FAILURES) {
  test(`F6: a booking that gets ${f.label} tells the customer to call ${CALL}, promises nothing and keeps the form`, async () => {
    const site = await failedBooking(f.answer, { wait: f.wait });
    const msg = site.message();
    assert.ok(msg.includes(CALL), "the message names the phone number: " + msg);
    assert.doesNotMatch(msg, PROMISE);
    assert.equal(msg, site.s()[f.kind], `the ${f.kind} text`);
    kept(site);
    assert.deepEqual(site.otherRequests(), [], "no request other than the booking API (no Netlify Forms copy)");
    assert.equal(site.server.bookings().length, 0);
    assert.equal(site.submitButton.disabled, false, "the customer can still press the button");
  });
}

test("F6: in English, every failure text names the phone number and promises nothing", async () => {
  for (const f of FAILURES) {
    const site = await failedBooking(f.answer, { lang: "en", wait: f.wait });
    const msg = site.message();
    assert.ok(msg.includes(CALL), `${f.label}: ${msg}`);
    assert.doesNotMatch(msg, PROMISE, f.label);
    assert.equal(msg, site.s()[f.kind], `${f.label}: the English ${f.kind} text`);
    assert.deepEqual(site.otherRequests(), [], f.label);
    kept(site);
  }
});

test("NEW-429: the rate-limit text asks for a phone call and never says to try again", async () => {
  for (const lang of [null, "en"]) {
    const site = await failedBooking(RATE_LIMITED, { lang });
    const msg = site.message();
    assert.equal(msg, site.s().rateLimited);
    assert.ok(msg.includes(CALL), msg);
    assert.doesNotMatch(msg, /prøv igjen|try again|noe gikk galt|something went wrong/i);
    assert.equal(site.bookingPosts().length, 1, "the page does not retry by itself");
  }
  const s = (await boot()).s();
  assert.equal(s.rateLimited, "For mange bestillinger fra dette nummeret akkurat nå. Ring oss på 409 63 911.");
});

test("F1: a booking the server stored but whose reply was lost: the retry sends the same requestId and ends booked, stored once", async () => {
  let first = true;
  const site = await boot({
    setup: (s) => s.when((r) => r.url === "/api/bookings" && first, (req, srv) => { first = false; srv.book(req); return { network: true }; }),
  });
  await site.pick(FRIDAY);
  await site.book();
  await site.advance(1000);
  assert.equal(site.message(), site.s().uncertain, "the lost reply is an uncertain outcome");
  assert.equal(site.server.bookings().length, 1, "the server did store it");
  await site.book();
  await site.advance(1000);
  const posts = site.bookingPosts();
  assert.equal(posts.length, 2);
  assert.match(posts[0].json.requestId, /^[A-Za-z0-9_-]{8,64}$/, "the server's requestId pattern");
  assert.equal(posts[1].json.requestId, posts[0].json.requestId, "the retry is the same request");
  assert.match(site.message(), /^Timen er booket: Herreklipp · fredag 13\. november kl\. 14:00\./);
  assert.equal(site.server.bookings().length, 1, "one stored booking, not a second one or a 'taken'");
});

test("F1: a changed booking gets a new requestId, and the body carries no language field", async () => {
  const site = await boot({ setup: (s) => s.when((r) => r.url === "/api/bookings", { network: true }) });
  await site.pick(FRIDAY);
  await site.book();
  await site.advance(1000);
  await site.book();
  await site.advance(1000);
  site.type(site.$("f-phone"), "409 63 956");
  await site.book();
  await site.advance(1000);
  const ids = site.bookingPosts().map((p) => p.json.requestId);
  assert.equal(ids.length, 3);
  assert.equal(ids[1], ids[0], "unchanged: same id");
  assert.notEqual(ids[2], ids[0], "another phone number: a new id");
  for (const p of site.bookingPosts()) {
    assert.deepEqual(Object.keys(p.json).sort(), ["addons", "botField", "date", "name", "phone", "requestId", "service", "start"]);
  }
});

test("F22: while 'Sender …' shows, the form is locked, and the stored booking is what was on screen at submit", async () => {
  const gate = later();
  const site = await boot({ setup: (s) => s.when((r) => r.url === "/api/bookings", (req, srv) => gate.then(() => srv.book(req)), 1) });
  await site.pick(FRIDAY);
  const addon = site.qs(".addon-picks input");
  site.click(addon);
  await site.book();
  assert.equal(site.message(), site.s().sending);
  assert.equal(site.form.getAttribute("aria-busy"), "true");
  assert.equal(site.submitButton.disabled, true);
  assert.equal(site.type(site.$("f-phone"), "409 63 911"), false, "the phone field is read-only");
  assert.equal(site.type(site.$("f-name"), "Ola Nordmann"), false, "the name field is read-only");
  assert.equal(site.choose(site.select, "Barneklipp"), false, "the service cannot change");
  assert.equal(site.click(addon), false, "the add-ons cannot change");
  const summary = site.summary();
  site.click(site.slot(870)); await site.flush();
  site.click(await site.day("2026-11-16")); await site.flush();
  site.click(site.qs('.svc-link[data-service="Barneklipp"]')); await site.flush();
  assert.equal(site.summary(), summary, "day, time and price-list taps are ignored while sending");
  assert.equal(site.select.value, FRIDAY.service);
  gate.resolve();
  await site.advance(1000);
  const stored = site.server.bookings();
  assert.equal(stored.length, 1);
  assert.deepEqual([stored[0].service, stored[0].date, stored[0].start, stored[0].name, stored[0].phone, stored[0].addons],
    [FRIDAY.service, FRIDAY.date, FRIDAY.time, FRIDAY.name, FRIDAY.phone, ["Vask kort hår"]]);
  assert.match(site.message(), /^Timen er booket: Herreklipp · fredag 13\. november kl\. 14:00\./);
  assert.deepEqual(site.otherRequests(), []);
  // unlocked again
  assert.equal(site.form.getAttribute("aria-busy"), "false");
  assert.equal(site.select.disabled, false);
  assert.equal(site.$("f-phone").readOnly, false);
  assert.equal(addon.disabled, false);
});

test("F22: every way a send ends unlocks the form", async () => {
  for (const answer of [{ network: true }, { hang: true }, { status: 500, body: {} }, { status: 404, body: "x" }, RATE_LIMITED,
    { status: 409, body: { code: "taken", error: "taken" } }, { status: 400, body: { code: "bad_phone", error: "bad_phone" } }]) {
    const site = await failedBooking(answer, { wait: 20000 });
    const label = JSON.stringify(answer);
    assert.notEqual(site.message(), site.s().sending, label);
    assert.equal(site.submitButton.disabled, false, label);
    assert.equal(site.select.disabled, false, label);
    assert.equal(site.$("f-name").readOnly, false, label);
    assert.equal(site.$("f-phone").readOnly, false, label);
    assert.ok(site.qsa(".addon-picks input").every((c) => !c.disabled), label);
    assert.notEqual(site.form.getAttribute("aria-busy"), "true", label);
    assert.equal(site.type(site.$("f-phone"), "409 63 912"), true, label);
  }
});

test("F90: a booking with no answer says 'Sender …' for 20 s, then tells the customer to call; a late success still confirms", async () => {
  const reply = later();
  const site = await boot({ setup: (s) => s.when((r) => r.url === "/api/bookings", (req, srv) => reply.then(() => srv.book(req)), 1) });
  await site.pick(FRIDAY);
  await site.book();
  await site.advance(19000);
  assert.equal(site.message(), site.s().sending, "still waiting after 19 s");
  await site.advance(1000);
  assert.equal(site.message(), site.s().uncertain, "after 20 s: we do not know, call us");
  assert.equal(site.submitButton.disabled, false);
  kept(site);
  reply.resolve();
  await site.advance(1000);
  assert.match(site.message(), /^Timen er booket: Herreklipp · fredag 13\. november kl\. 14:00\./, "the late 2xx is shown");
  assert.equal(site.server.bookings().length, 1);
});

test("F90: a stored booking is confirmed at once, even when the availability refresh after it never answers", async () => {
  const site = await boot();
  await site.pick(FRIDAY);
  site.server.when((r) => r.url === "/api/availability", { hang: true });
  await site.book();
  assert.match(site.message(), /^Timen er booket: /, "no time had to pass");
  assert.equal(site.submitButton.disabled, false);
  assert.equal(site.server.bookings().length, 1);
});

test("F90: an availability answer that hangs gives up after 15 s, and an older answer arriving after a newer one is ignored", async () => {
  const slow = later();
  const site = await boot({ setup: (s) => s.when((r) => r.url === "/api/availability", () => slow, 1) });
  // the first load hangs: the page still offers Friday 14:00 from what it knows
  await site.pick({ service: "Herreklipp", date: "2026-11-13" });
  assert.ok(site.slot(840), "14:00 is offered before any answer");
  const stale = site.server.availability();           // Friday 14:00 still free in this old answer
  site.server.add({ date: "2026-11-13", start: 840, dur: 30 });
  await site.poll();                                  // a newer answer: 14:00 taken
  assert.ok(!site.slot(840), "the newer answer is applied");
  slow.resolve({ status: 200, body: stale });         // the old answer finally arrives
  await site.advance(1000);
  assert.ok(!site.slot(840), "the older answer does not bring 14:00 back");
  const gets = site.server.requests.filter((r) => r.url === "/api/availability").length;
  site.server.when((r) => r.url === "/api/availability", { hang: true }, 1);
  await site.poll();
  await site.advance(15000);
  await site.poll();
  assert.equal(site.server.requests.filter((r) => r.url === "/api/availability").length, gets + 2, "polling goes on after a hung load");
});

// F8: a message about the service, the day or the time is shown at that step (where focus goes), scrolled into view
// first, and still announced through #form-msg (role=status, visually hidden then). Name and phone stay under the button.
function oneMessageAt(site, boxId, text) {
  const shown = site.visibleMessages();
  assert.deepEqual(shown.map((el) => el.id), [boxId], "exactly one visible message, in #" + boxId);
  assert.equal(shown[0].textContent, text);
  const step = site.$(boxId).closest(".step");
  assert.ok(step && step.contains(site.focused), "focus is inside the step with the message: " + (site.focused && site.focused.outerHTML.slice(0, 80)));
  assert.ok(site.announced().includes(text), "screen readers get the text");
  assert.equal(site.$(boxId).getAttribute("aria-hidden"), "true", "the step box is not announced twice");
}

test("F8: a submit with no service, no day or no time shows one message at that step, scrolls to it, then moves focus there", async () => {
  const site = await boot();
  const before = site.scrolls.length;
  await site.book();
  oneMessageAt(site, "msg-service", site.s().needService);
  assert.ok(site.focused === site.select, "focus on the service select");
  const sc = site.scrolls.slice(before);
  assert.equal(sc.length, 1, "scrolled once");
  assert.equal(sc[0].behavior, "auto", "no smooth scroll fighting the focus scroll");
  assert.ok(sc[0].focused !== site.select, "the scroll happens before focus moves");
  assert.equal(sc[0].y, -90, "the box ends 90 px below the top (under the fixed menu)");
  assert.equal(site.doc.documentElement.style.scrollBehavior || "", "", "the page's scroll behaviour is put back");

  site.choose(site.select, "Herreklipp"); await site.flush();
  await site.book();
  oneMessageAt(site, "msg-day", site.s().needDay);
  assert.ok(site.focused.classList.contains("cal-day") && !site.focused.disabled, "focus on the first open day");

  await site.pick({ date: "2026-11-13" });
  assert.equal(site.message(), "", "choosing clears the message");
  await site.book();
  oneMessageAt(site, "msg-time", site.s().needTime);
  assert.ok(site.focused.classList.contains("slot") && !site.focused.disabled, "focus on the first free time");

  await site.pick({ time: 840 });
  await site.book();
  const shown = site.visibleMessages();
  assert.deepEqual(shown.map((el) => el.id), ["form-msg"], "the name message stays under the button");
  assert.equal(shown[0].textContent, site.s().needName);
  assert.ok(site.focused === site.$("f-name"));
});

test("F8: a 409 puts 'takenNow' in #msg-time with focus on a free time", async () => {
  const site = await boot();
  await site.pick(FRIDAY);
  site.server.add({ date: FRIDAY.date, start: FRIDAY.time, dur: 30 });
  await site.book();
  await site.advance(1000);
  oneMessageAt(site, "msg-time", site.s().takenNow);
  assert.ok(site.focused.classList.contains("slot") && !site.focused.disabled);
  assert.ok(!site.slot(FRIDAY.time), "14:00 is no longer offered");
});

// F19: the server's answer decides "now" and the booking rules; the device clock is only used before it answers.
const TODAY = "2026-11-12";
const offered = (site) => site.slots().filter((x) => x.t !== null && !x.disabled).map((x) => x.t);

test("F19: with the server clock 90 s ahead of the device, 17:30 today is not offered (the server would say too_early)", async () => {
  const site = await boot({ now: "2026-11-12T16:30:00+01:00", serverAheadMs: 90000 });
  await site.pick({ service: "Herreklipp", date: TODAY });
  assert.ok(!offered(site).includes(1050), "17:30 is not offered: " + offered(site));
  assert.equal(site.slots().filter((x) => x.t === 1050).length, 0);
});

for (const [label, now, ahead, has1730] of [
  ["10 min behind", "2026-11-12T16:25:00+01:00", 600000, false],
  ["10 min ahead of", "2026-11-12T16:35:00+01:00", -600000, true],
]) {
  test(`F19: a device clock ${label} the server still offers exactly the server's times`, async () => {
    const site = await boot({ now, serverAheadMs: ahead });
    await site.pick({ service: "Herreklipp", date: TODAY });
    assert.equal(offered(site).includes(1050), has1730, "17:30: " + offered(site));
    assert.deepEqual(offered(site).filter((t) => t !== 1050), [], "nothing before 17:30");
  });
}

test("F19: a 400 too_early drops the time, says why at step 3, reloads availability, and a second tap sends nothing", async () => {
  const site = await boot({ now: "2026-11-12T16:00:00+01:00", setup: (s) => s.when((r) => r.url === "/api/bookings", { status: 400, body: { code: "too_early", error: "Tidspunktet er for tidlig." } }, 1) });
  await site.pick({ service: "Herreklipp", date: TODAY, time: 1020, name: FRIDAY.name, phone: FRIDAY.phone });
  const gets = site.server.requests.filter((r) => r.url === "/api/availability").length;
  await site.book();
  await site.advance(500);
  assert.ok(site.server.requests.filter((r) => r.url === "/api/availability").length > gets, "availability is loaded again");
  assert.equal(site.slots().filter((x) => /is-selected/.test(x.cls)).length, 0, "no time is selected");
  assert.equal(site.summary(), "");
  assert.deepEqual(site.visibleMessages().map((el) => el.id), ["msg-time"]);
  assert.equal(site.message(), site.s().timeGone);
  await site.book();
  await site.advance(500);
  assert.equal(site.bookingPosts().length, 1, "the rejected start is not sent again");
  assert.equal(site.$("f-name").value, FRIDAY.name, "name and phone stay");
});

for (const code of ["bad_date", "closed"]) {
  test(`F19: a 400 ${code} drops the day and says why at step 2`, async () => {
    const site = await boot({ setup: (s) => s.when((r) => r.url === "/api/bookings", { status: 400, body: { code, error: code } }, 1) });
    await site.pick(FRIDAY);
    await site.book();
    await site.advance(500);
    assert.equal(site.summary(), "");
    assert.equal(site.qsa("#cal-grid .is-selected").length, 0, "no day is selected");
    assert.deepEqual(site.visibleMessages().map((el) => el.id), ["msg-day"]);
    assert.equal(site.message(), site.s().dayGone);
    assert.ok(site.focused.classList.contains("cal-day"));
  });
}

test("F19: slotMin, leadMin and maxDays come from the server after a range check", async () => {
  const site = await boot({ now: "2026-11-12T10:00:00+01:00", setup: (s) => { s.config.leadMin = 120; s.config.maxDays = 30; } });
  await site.pick({ service: "Herreklipp", date: TODAY });
  assert.equal(Math.min(...offered(site)), 720, "today from 12:00 (two hours ahead)");
  assert.ok(!(await site.day("2026-12-12")).disabled, "day 30 (a Saturday) can be booked");
  assert.ok((await site.day("2026-12-14")).disabled, "day 32 (a Monday) cannot");
  const odd = await boot({ setup: (s) => { s.config.slotMin = 0; s.config.leadMin = -5; s.config.maxDays = "60"; } });
  await odd.pick({ service: "Herreklipp", date: "2026-11-13" });
  assert.deepEqual(offered(odd).slice(0, 3), [600, 630, 660], "out-of-range values are ignored");
});

// F24: the server's durations are merged into the page's, never replace them, so a service the server stops listing
// keeps its known length instead of falling back to 30 minutes.
test("F24: when the server stops listing 'Full service', its 17:30 slot stays too short and nothing is sent", async () => {
  const site = await boot({ setup: (s) => { delete s.config.durations["Full service"]; s.config.durations["Full pakke"] = 60; } });
  await site.pick({ service: "Full service", date: "2026-11-16", name: FRIDAY.name, phone: FRIDAY.phone });
  const last = site.slots().filter((x) => /^17:30\b/.test(x.text))[0];
  assert.ok(last && /is-short/.test(last.cls) && last.disabled, "17:30 + 60 min does not fit before 18:00: " + (last && last.cls));
  assert.equal(site.click(last.el), false, "it cannot be tapped");
  await site.book();
  assert.equal(site.bookingPosts().length, 0, "nothing is sent");
});

test("F24: a bad_service answer asks the customer to reload the page, at step 1", async () => {
  const site = await boot({ setup: (s) => s.when((r) => r.url === "/api/bookings", { status: 400, body: { code: "bad_service", error: "Ukjent tjeneste." } }, 1) });
  await site.pick(FRIDAY);
  await site.book();
  await site.advance(500);
  assert.deepEqual(site.visibleMessages().map((el) => el.id), ["msg-service"]);
  assert.equal(site.message(), site.s().reloadPage);
  assert.equal(site.s().reloadPage, "Siden er oppdatert. Last inn siden på nytt og prøv igjen.");
  assert.ok(site.focused === site.select);
  kept(site);
});

// F25: the server refuses a phone over 30 characters (bad_phone); the page never lets one through.
test("F25: the phone field takes at most 30 characters, and a longer value is refused before anything is sent", async () => {
  const site = await boot();
  assert.equal(site.$("f-phone").getAttribute("maxlength"), "30");
  await site.pick(Object.assign({}, FRIDAY, { phone: "+47 409 63 955 (jobb, ring etter kl. 16)" }));
  assert.equal(site.$("f-phone").value.length, 30, "the browser cuts it at 30");
  site.$("f-phone").removeAttribute("maxlength"); // a browser that ignores maxlength
  site.type(site.$("f-phone"), "409 63 955                      x");
  await site.book();
  assert.equal(site.bookingPosts().length, 0, "nothing is sent");
  assert.equal(site.message(), site.s().needPhone);
  assert.ok(site.focused === site.$("f-phone"));
});

test("F73: a successful booking is stored once and nothing else is sent (no Netlify Forms copy)", async () => {
  const site = await boot();
  await site.pick(FRIDAY);
  await site.book();
  await site.advance(1000);
  assert.match(site.message(), /^Timen er booket: Herreklipp · fredag 13\. november kl\. 14:00\./);
  assert.deepEqual(site.otherRequests(), []);
  assert.equal(site.bookingPosts().length, 1);
  const stored = site.server.bookings();
  assert.equal(stored.length, 1);
  assert.deepEqual([stored[0].date, stored[0].start, stored[0].service, stored[0].name, stored[0].phone],
    [FRIDAY.date, FRIDAY.time, FRIDAY.service, FRIDAY.name, FRIDAY.phone]);
  assert.equal(site.form._nativeSubmits || 0, 0, "the browser never posts the form itself");
});
