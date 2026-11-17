// Round 3 (still_open 8, t8-availability-down.mjs in audit/round2/verify-booking-page): when GET /api/availability
// failed or hung while POST /api/bookings worked, every time was shown free with no notice. Friday 10:00–15:30 was
// already booked, yet each tap on 10:00 got «Beklager, noen rakk å booke den tiden akkurat nå» (false: it was booked
// long ago). rejected() reloaded, the reload failed again, and 10:00 was offered again and focused. Every 409 keeps its
// hit on the client counter, so the 7th tap gave 429 for the whole address.
// Root cause: the page treated unknown availability as free. Its only source of busy times was the last successful
// GET; it never recorded what the server's own answers proved (a 409 «taken» for that date and start), and the
// `online` flag it set on every load was never read. The failure matrix covered POST /api/bookings only.
// Rule (SPEC R48): the same failure matrix runs on GET /api/availability. While the page has no recent answer it shows a
// notice with 409 63 911 at step 3, a 409 says the time is taken without «akkurat nå» and asks for a call, and a time
// answered 409 «taken» is never offered again until an availability answer fetched after the 409 says otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, FRIDAY } from "./booking-harness.mjs";

const DOWN = {
  "a network error": { answer: { network: true } },
  "no answer within 15 s": { answer: { hang: true }, wait: 15000 },
  "a 500": { answer: { status: 500, body: { error: "Noe gikk galt. Ring oss gjerne." } } },
  "a 502 HTML page": { answer: { status: 502, body: "<html><body>Bad gateway</body></html>" } },
  "a 200 that is not JSON": { answer: { status: 200, body: "<html><body>OK</body></html>" } },
  "a 200 with JSON null": { answer: { status: 200, body: null } },
};
// Friday 10:00–15:30 is booked by others (12 of 16 times), as in t8
const BUSY_FRIDAY = (s) => { for (let t = 600; t < 960; t += 30) s.add({ date: FRIDAY.date, start: t, dur: 30, name: "Annen " + t }); };
const note = (site) => site.$("avail-note").textContent;
const offered = (site) => site.slots().filter((x) => x.t !== null && !x.disabled).map((x) => x.t);

for (const [label, d] of Object.entries(DOWN)) {
  test(`availability down (${label}): a notice with 409 63 911 at step 3, and a 409 is «taken, call us», never «noen rakk … akkurat nå», and never offered again`, async () => {
    const site = await boot({ setup: (s) => { BUSY_FRIDAY(s); s.when((r) => r.url === "/api/availability", d.answer); } });
    await site.advance((d.wait || 0) + 1000);
    const s = site.s();
    assert.equal(note(site), s.availDown, "the notice is shown");
    assert.ok(note(site).includes("409 63 911"));
    assert.ok(site.$("avail-note").closest(".step").contains(site.$("slots")), "at step 3, with the times");
    assert.ok(site.announced().includes(s.availDown), "screen readers get it");
    await site.pick({ service: "Herreklipp", date: FRIDAY.date, name: FRIDAY.name, phone: FRIDAY.phone });
    const tapped = [];
    for (let i = 0; i < 2; i++) {
      const t = offered(site)[0];
      tapped.push(t);
      site.click(site.slot(t));
      await site.flush();
      await site.book();
      await site.advance((d.wait || 0) + 1000); // rejected() reloads first, and that reload fails the same way
      assert.equal(site.message(), s.takenUnknown, `tap ${i + 1} (${t}): the taken text without «akkurat nå»`);
      assert.ok(site.message().includes("409 63 911"));
      assert.ok(!site.message().includes(s.takenNow));
      for (const x of tapped) assert.ok(offered(site).indexOf(x) < 0, `${x} is not offered again`);
      assert.equal(note(site), s.availDown, "the notice stays");
    }
    assert.equal(site.bookingPosts().length, 2, "one request per tap, no automatic retry");
    assert.equal(site.server.bookings().length, 12, "nothing stored");
  });
}

test("availability down (English): the notice and the taken text, each with the number to call", async () => {
  const site = await boot({ lang: "en", setup: (s) => { BUSY_FRIDAY(s); s.when((r) => r.url === "/api/availability", { status: 500, body: {} }); } });
  await site.advance(1000);
  const s = site.s();
  assert.equal(note(site), s.availDown);
  assert.match(s.availDown, /409 63 911/);
  assert.match(s.takenUnknown, /409 63 911/);
  for (const t of [s.availDown, s.takenUnknown]) assert.doesNotMatch(t, /just|confirm|received/i, t);
  site.I18N.set("no");
  await site.flush();
  assert.equal(note(site), site.s().availDown, "the notice follows the language switch");
  assert.doesNotMatch(site.s().takenUnknown, /akkurat nå|bekreft|mottatt/i);
});

test("availability: down at first, then back: the notice goes away and the busy times show as busy", async () => {
  const site = await boot({ setup: (s) => { BUSY_FRIDAY(s); s.when((r) => r.url === "/api/availability", { network: true }, 1); } });
  await site.advance(1000);
  assert.equal(note(site), site.s().availDown);
  await site.poll();
  assert.equal(note(site), "", "a good answer removes the notice");
  await site.pick({ service: "Herreklipp", date: FRIDAY.date });
  assert.deepEqual(offered(site), [960, 990, 1020, 1050], "only 16:00–17:30 are free");
});

test("availability: one failed refresh after a good answer shows no notice; after more than 2 minutes without an answer it does", async () => {
  const site = await boot();
  await site.advance(1000);
  site.server.when((r) => r.url === "/api/availability", { status: 503, body: {} });
  await site.poll();
  assert.equal(note(site), "", "the times are 30 s old: still good enough");
  for (let i = 0; i < 4; i++) await site.poll();
  assert.equal(note(site), site.s().availDown, "2.5 minutes without an answer");
});

// t8 itself: the first answer was good (an empty Friday), then the bookings came and availability went down. The
// times on the page are seconds old, but the first 409 proves them outdated, and the reload after it fails.
test("availability: good at first, then down while Friday fills up: the first 409 already says «taken, call us», with the notice", async () => {
  const site = await boot();
  await site.pick({ service: "Herreklipp", date: FRIDAY.date, name: FRIDAY.name, phone: FRIDAY.phone });
  BUSY_FRIDAY(site.server);
  site.server.when((r) => r.url === "/api/availability", { status: 500, body: {} });
  const s = site.s();
  const t = offered(site)[0];
  site.click(site.slot(t));
  await site.flush();
  await site.book();
  await site.advance(1000);
  assert.equal(site.message(), s.takenUnknown);
  assert.equal(note(site), s.availDown);
  assert.ok(offered(site).indexOf(t) < 0, "not offered again");
  assert.equal(site.server.bookings().length, 12);
});

test("availability: a 409 «taken» while the reload works is still «noen rakk … akkurat nå», at the time step, and the time is busy", async () => {
  const site = await boot();
  await site.pick(FRIDAY);
  site.server.add({ date: FRIDAY.date, start: FRIDAY.time, dur: 30, name: "Annen" });
  await site.book();
  await site.advance(1000);
  assert.equal(site.message(), site.s().takenNow);
  assert.equal(note(site), "");
  assert.ok(!site.slot(FRIDAY.time));
});

test("availability: a time answered 409 stays busy while reloads fail, and comes back only when an answer fetched after the 409 says it is free", async () => {
  const site = await boot();
  await site.pick(FRIDAY);
  // Someone else holds 14:00; every reload from now on fails
  site.server.add({ date: FRIDAY.date, start: FRIDAY.time, dur: 30, name: "Annen" });
  const down = site.server.when((r) => r.url === "/api/availability", { network: true });
  await site.book();
  await site.advance(1000);
  assert.ok(!site.slot(FRIDAY.time), "14:00 is not offered although the reload failed");
  await site.poll();
  assert.ok(!site.slot(FRIDAY.time), "nor after the next failed refresh");
  // The other booking is cancelled and availability answers again: the fresh answer wins
  site.server.items.filter((i) => i.name === "Annen")[0].status = "cancelled";
  down.left = 0;
  await site.poll();
  assert.ok(site.slot(FRIDAY.time), "14:00 is free again");
});
