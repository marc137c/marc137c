// Round 3 (still_open 6; t1-late201-then-409, t3-409-then-late201, t4-late201-after-edit and t4-real in
// audit/round2/verify-booking-page): the page called the customer's own, just confirmed booking «someone else's».
// The first POST (Herreklipp Fri 14:00) is stored, its reply comes after the 20-s limit, and the customer edits
// something. A late 201 then arrives before or after an edited retry's answer, or with no retry at all. The page
// said «noen rakk å booke den tiden akkurat nå» or «Tiden du valgte er ikke ledig lenger» and asked for another time,
// and a second booking followed.
// Root cause: the page knew «this busy slot is the customer's own» only from `unsettled`, and record() emptied it at
// the very moment the late 2xx proved the booking stored. A confirmed booking kept only its text and id, so the 409
// branch, renderSlots' drop and lateBooked could not ask «does this overlap a booking this page already has?».
// Rule (SPEC R47): one function, ownAt(date, start, dur), answers for pending AND confirmed own slots, and every path
// that says «noen andre», «ikke ledig lenger» or drops a choice asks it first. Invariant checked here: whatever the
// reply order and the edit, the page never shows takenNow, timeGone, dayFullNow, dayGone or tooShortPicked, it ends
// by saying the 14:00 booking is the customer's, and only one booking is stored, also after the customer taps again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, later, FRIDAY } from "./booking-harness.mjs";

const EDITS = {
  "the phone formatting": async (site) => { site.type(site.$("f-phone"), "40963955"); },
  "a typo fixed in the name": async (site) => { site.type(site.$("f-name"), "Kari Nordman"); },
  "an add-on ticked": async (site) => { site.click(site.qsa(".addon-picks input")[0]); await site.flush(); },
  "the service changed to Barneklipp (same length)": async (site) => { site.choose(site.select, "Barneklipp"); await site.flush(); },
  "the service changed to Full service (14:00–15:00 overlaps)": async (site) => { site.choose(site.select, "Full service"); await site.flush(); },
};
// retry: the customer taps «Bestill time» again after the edit. hold: the retry's answer waits until the late 201 is in.
// fail: the retry's own answer is lost (network error) instead of the server's 409.
const ORDERS = {
  "the late 201 arrives while the edited retry is on its way, then the retry gets 409": { retry: true, hold: true },
  "the late 201 arrives while the edited retry is on its way, then the retry's answer is lost": { retry: true, hold: true, fail: true },
  "the edited retry is answered first (409), then the late 201": { retry: true, hold: false },
  "the late 201 arrives and nobody tapped again": { retry: false },
};
const NEVER = ["takenNow", "timeGone", "dayFullNow", "dayGone", "tooShortPicked"];
const doneLines = (site) => site.$("booking-done").querySelectorAll(".booking-done-line").map((p) => p.textContent);

async function play(order, edit, lang) {
  const g1 = later(), g2 = later();
  let n = 0;
  const site = await boot({ lang, setup: (s) => s.when((r) => r.url === "/api/bookings", (req, srv) => {
    n++;
    if (n === 1) { const res = srv.book(req); return g1.then(() => res); }
    if (n === 2 && order.fail) return g2.then(() => ({ network: true }));
    const res = srv.book(req);
    return n === 2 && order.hold ? g2.then(() => res) : res;
  }) });
  const seen = [];
  const look = (when) => seen.push([when, site.message()]);
  await site.pick(FRIDAY);
  await site.book();
  await site.advance(20000);
  assert.equal(site.message(), site.s().uncertain);
  await edit(site);
  look("after the edit");
  if (order.retry) {
    await site.book();
    await site.advance(500);
    look("after the retry");
    if (order.hold) {
      g1.resolve(); await site.advance(100); look("after the late 201");
      g2.resolve(); await site.advance(1000); look("after the retry's answer");
    } else {
      await site.advance(1000); look("after the retry's answer");
      g1.resolve(); await site.advance(100); look("after the late 201");
    }
  } else {
    await site.advance(5000);
    g1.resolve(); await site.advance(100); look("after the late 201");
  }
  await site.poll(); look("after the 30-s refresh");
  return { site, seen };
}

for (const [oLabel, order] of Object.entries(ORDERS)) {
  for (const [eLabel, edit] of Object.entries(EDITS)) {
    test(`own booking: ${eLabel}, ${oLabel}: never «someone else» or «gone», the page says 14:00 is the customer's, one booking`, async () => {
      const { site, seen } = await play(order, edit, null);
      const s = site.s();
      for (const [when, m] of seen) for (const k of NEVER) assert.ok(!m.includes(s[k]), `${when}: «${m}» (${k})`);
      assert.match(site.message(), /Herreklipp · fredag 13\. november kl\. 14:00/, "the message names the customer's booking");
      assert.ok(site.message().includes("409 63 911"), "with the number to call for a change");
      assert.equal(site.summary(), "", "nothing is left chosen that invites another booking");
      assert.deepEqual(doneLines(site).length, 1, "one line in #booking-done");
      assert.equal(site.server.bookings().length, 1);
      // The customer taps again, then picks the first offered time on Friday as an «other time» would ask: nothing
      // tells them to, and the 14:00 time is not offered
      await site.book();
      await site.advance(1000);
      assert.equal(site.server.bookings().length, 1, "no second booking");
      await site.pick({ service: "Herreklipp", date: FRIDAY.date });
      assert.equal(site.slot(FRIDAY.time), null, "14:00 is shown busy");
    });
  }
}

test("own booking (English): the late 201 while the edited retry is on its way, then 409: «You already have an appointment at that time», never «someone just booked»", async () => {
  const { site, seen } = await play(ORDERS["the late 201 arrives while the edited retry is on its way, then the retry gets 409"], EDITS["the phone formatting"], "en");
  const s = site.s();
  for (const [when, m] of seen) for (const k of NEVER) assert.ok(!m.includes(s[k]), `${when}: «${m}» (${k})`);
  assert.equal(site.message(), s.ownAlready("Men's haircut · Friday 13 November at 2:00 PM"));
  assert.equal(site.server.bookings().length, 1);
});

test("own booking: the texts name the booking and the number to call, in both languages, and promise nothing", async () => {
  for (const lang of [null, "en"]) {
    const site = await boot({ lang });
    const t = site.s().ownAlready("X · Y");
    assert.ok(t.includes("X · Y") && t.includes("409 63 911"), t);
    assert.doesNotMatch(t, /bekreft|mottatt|confirm|received|velg en annen|choose another/i, t);
  }
});

// The confirmed booking stays busy on this page even when the availability reload after it fails, so the customer
// is never offered their own time again (the reload is the only other source of «busy»)
test("own booking: after a 201, 14:00 stays busy on this page although every availability reload fails", async () => {
  const site = await boot();
  await site.pick(FRIDAY);
  site.server.when((r) => r.url === "/api/availability", { status: 500, body: { error: "Noe gikk galt." } });
  await site.book();
  await site.advance(1000);
  assert.match(site.message(), /^Timen er booket: Herreklipp · fredag 13\. november kl\. 14:00\./);
  await site.poll();
  await site.pick({ service: "Barneklipp", date: FRIDAY.date });
  assert.equal(site.slot(FRIDAY.time), null, "14:00 is not offered");
  assert.ok(site.slot(FRIDAY.time + 30), "14:30 still is");
});

// renderSlots' drop asks ownAt too: a choice that becomes impossible because of the customer's own confirmed booking
// is dropped with «already yours», not «Valgt tjeneste rekker ikke før neste avtale» (someone else's appointment)
test("own booking: a choice that overlaps the customer's just confirmed booking is dropped with «already yours», not «too short»", async () => {
  const g1 = later();
  const site = await boot({ setup: (s) => s.when((r) => r.url === "/api/bookings", (req, srv) => { const res = srv.book(req); return g1.then(() => res); }, 1) });
  await site.pick(FRIDAY);
  await site.book();
  await site.advance(20000);
  assert.equal(site.message(), site.s().uncertain);
  await site.pick({ time: FRIDAY.time - 30 }); // 13:30 Herreklipp: next to the uncertain 14:00, not over it
  g1.resolve();
  await site.advance(100);
  assert.equal(doneLines(site).length, 1, "the late 201 is listed");
  assert.match(site.summary(), /kl\. 13:30/, "13:30 does not overlap 14:00, so it stays chosen");
  site.choose(site.select, "Full service"); // 13:30–14:30 now runs into the customer's own 14:00
  await site.flush();
  const s = site.s();
  assert.equal(site.$("msg-time").textContent, s.ownAlready("Herreklipp · fredag 13. november kl. 14:00"));
  assert.ok(!site.message().includes(s.tooShortPicked));
  assert.equal(site.summary(), "");
  assert.equal(site.server.bookings().length, 1);
});
