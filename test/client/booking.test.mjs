// The booking page (viggos-barbershop/booking.js, i18n.js and the #bestill form in index.html), run in the client
// harness against a fake server with the real rules. Owner decisions D2/D3 (docs/SPEC.md): Netlify Blobs is the only
// store of a booking, and whenever the booking API fails, times out or answers something we cannot trust, the
// customer is told to call 409 63 911, keeps what they typed, and is never told the time is confirmed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, FRIDAY, RATE_LIMITED } from "./booking-harness.mjs";

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
    const site = await failedBooking(f.answer);
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
    const site = await failedBooking(f.answer, { lang: "en" });
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
