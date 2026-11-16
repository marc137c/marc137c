// Round 2: what the booking page does between an uncertain outcome and the customer's next step.
// Two rules met here: F49 «drop a stale choice and say why» and F1/D3 «after an uncertain outcome keep the choice and
// retry with the same requestId». The drop rule assumed every busy interval was someone else's, which is false right
// after an uncertain outcome: the busy time can be the customer's own, possibly stored, booking.
// Rule (booking.js, `pending`): a code path that drops a choice or overwrites the message may not override a pending
// uncertain attempt for that choice; the next «Bestill time» sends the same requestId and the server decides
// (201 replay if it was ours, 409 if it was someone else's).
// Also: every 2xx from POST /api/bookings becomes one line in #booking-done, whatever order the replies arrive in;
// and a 409 for a day that just closed or filled up puts the message at the day step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, later, FRIDAY } from "./booking-harness.mjs";

// Every way the first POST can end uncertain. stored: whether the server stored it before the answer went wrong.
const UNCERTAIN = {
  "a network error": { answer: { network: true }, wait: 1000 },
  "no answer within 20 s": { answer: { hang: true }, wait: 20000 },
  "a 500": { answer: { status: 500, body: { error: "Noe gikk galt. Ring oss gjerne." } }, wait: 1000 },
  "a 2xx that is not JSON": { answer: { status: 200, body: "<html><body>OK</body></html>" }, wait: 1000 },
};
// Background events that can happen while the customer is away calling
const EVENTS = {
  "the 30-s refresh": (site) => site.poll(),
  "leaving the tab and coming back after 60 s": async (site) => { await site.hide(); await site.advance(60000); await site.show(); },
  "a language switch and back": async (site) => { site.I18N.set("en"); await site.flush(); site.I18N.set("no"); await site.flush(); },
  "a late availability reply": async (site) => {
    const gate = later();
    site.server.when((r) => r.url === "/api/availability", (req, srv) => gate.then(() => ({ status: 200, body: srv.availability() })), 1);
    await site.hide(); await site.show();
    await site.advance(2000);
    gate.resolve();
    await site.advance(100);
  },
};
const doneLines = (site) => site.$("booking-done").querySelectorAll(".booking-done-line").map((p) => p.textContent);

for (const [uLabel, u] of Object.entries(UNCERTAIN)) {
  for (const stored of [true, false]) {
    for (const [eLabel, event] of Object.entries(EVENTS)) {
      test(`pending: ${uLabel} (${stored ? "stored" : "not stored"}), then ${eLabel}: the choice and the uncertain text stay, and the retry ends with one booking`, async () => {
        const site = await boot({ setup: (s) => s.when((r) => r.url === "/api/bookings", (req, srv) => { if (stored) srv.book(req); return u.answer; }, 1) });
        await site.pick(FRIDAY);
        await site.book();
        await site.advance(u.wait);
        assert.equal(site.message(), site.s().uncertain);
        await event(site);
        await site.advance(500);
        const s = site.s();
        assert.notEqual(site.message(), s.timeGone, "never «no longer available» for the customer's own booking");
        assert.notEqual(site.message(), s.takenNow);
        assert.equal(site.message(), s.uncertain, "the uncertain text stays");
        assert.match(site.summary(), /fredag 13\. november kl\. 14:00/, "the choice is kept");
        await site.book();
        await site.advance(1000);
        const posts = site.bookingPosts();
        assert.equal(posts.length, 2, "the retry was sent");
        assert.equal(posts[1].json.requestId, posts[0].json.requestId, "with the same requestId");
        assert.equal(site.server.bookings().length, 1, "exactly one stored booking");
        assert.match(site.message(), /^Timen er booket: Herreklipp · fredag 13\. november kl\. 14:00\./);
        assert.equal(doneLines(site).length, 1);
      });
    }
  }
}

test("pending: after an uncertain outcome, someone else's booking at that time still gives 409 «takenNow» on the retry", async () => {
  const site = await boot({ setup: (s) => s.when((r) => r.url === "/api/bookings", { network: true }, 1) });
  await site.pick(FRIDAY);
  await site.book();
  await site.advance(1000);
  site.server.add({ date: FRIDAY.date, start: FRIDAY.time, dur: 30, name: "Annen" });
  await site.poll();
  assert.equal(site.message(), site.s().uncertain);
  await site.book();
  await site.advance(1000);
  assert.equal(site.message(), site.s().takenNow);
  assert.equal(site.server.bookings().length, 1, "only the other customer's");
});

// ---------- every 2xx ends up in #booking-done, in any arrival order (p2-late-reply.mjs) ----------
test("late reply: the first 201 arriving after the retry failed confirms the booking and lists it once", async () => {
  const gate = later();
  let n = 0;
  const site = await boot({ setup: (s) => s.when((r) => r.url === "/api/bookings", (req, srv) => {
    n++;
    if (n === 1) { const res = srv.book(req); return gate.then(() => res); }
    return { network: true };
  }) });
  await site.pick(FRIDAY);
  await site.book();
  await site.advance(20000);
  assert.equal(site.message(), site.s().uncertain);
  await site.book();
  await site.advance(1000);
  assert.equal(site.message(), site.s().uncertain, "the retry failed too");
  gate.resolve();
  await site.advance(100);
  assert.match(site.message(), /^Timen er booket: Herreklipp · fredag 13\. november kl\. 14:00\./);
  assert.equal(doneLines(site).length, 1);
  assert.equal(site.server.bookings().length, 1);
});

test("late reply: a 201 for 14:00 arriving after the customer booked 15:00 adds its own line to #booking-done", async () => {
  const gate = later();
  let n = 0;
  const site = await boot({ setup: (s) => s.when((r) => r.url === "/api/bookings", (req, srv) => {
    n++;
    if (n === 1) { const res = srv.book(req); return gate.then(() => res); }
    return undefined; // the real fake server
  }) });
  await site.pick(FRIDAY);
  await site.book();
  await site.advance(20000);
  assert.equal(site.message(), site.s().uncertain);
  await site.pick({ time: 900 });
  await site.book();
  await site.advance(1000);
  assert.match(site.message(), /^Timen er booket: Herreklipp · fredag 13\. november kl\. 15:00\./);
  gate.resolve();
  await site.advance(100);
  const lines = doneLines(site);
  assert.equal(lines.length, 2, lines.join(" | "));
  assert.ok(lines.some((l) => /14:00/.test(l)) && lines.some((l) => /15:00/.test(l)), lines.join(" | "));
  assert.match(site.message(), /15:00/, "the message about the newer booking stays");
  assert.equal(site.server.bookings().length, 2);
});

test("late reply: the same booking confirmed twice (late reply and replay) is listed once", async () => {
  const gate = later();
  let n = 0;
  const site = await boot({ setup: (s) => s.when((r) => r.url === "/api/bookings", (req, srv) => {
    n++;
    if (n === 1) { const res = srv.book(req); return gate.then(() => res); }
    return undefined;
  }) });
  await site.pick(FRIDAY);
  await site.book();
  await site.advance(20000);
  await site.book();
  await site.advance(1000);
  assert.match(site.message(), /^Timen er booket/);
  gate.resolve();
  await site.advance(100);
  assert.equal(doneLines(site).length, 1);
});

// ---------- a 409 for a day that just closed or filled up (p3-409-blocked-day.mjs, p3b-409-last-slot.mjs) ----------
function oneMessageAt(site, boxId, text) {
  const shown = site.visibleMessages();
  assert.deepEqual(shown.map((el) => [el.id, el.textContent]), [[boxId, text]], "exactly one visible message, in #" + boxId);
  const step = site.$(boxId).closest(".step");
  assert.ok(step && step.contains(site.focused), "focus is inside that step: " + (site.focused && site.focused.outerHTML.slice(0, 80)));
}

test("409 on a day the barber has just blocked completely: «dayGone» at the day step, focus on an open day", async () => {
  const site = await boot();
  await site.pick(FRIDAY);
  site.server.blockDay(FRIDAY.date);
  await site.book();
  await site.advance(1000);
  oneMessageAt(site, "msg-day", site.s().dayGone);
  assert.ok(site.focused.classList.contains("cal-day") && !site.focused.disabled);
});

test("409 that took the last free time of the day: the day-full text at the day step, focus on an open day", async () => {
  const site = await boot({ setup: (s) => {
    // Friday: everything but 14:00 is booked
    for (let t = 600; t < 1080; t += 30) if (t !== 840) s.add({ date: FRIDAY.date, start: t, dur: 30 });
  } });
  await site.pick(FRIDAY);
  site.server.add({ date: FRIDAY.date, start: 840, dur: 30, name: "Rakk det" });
  await site.book();
  await site.advance(1000);
  oneMessageAt(site, "msg-day", site.s().dayFullNow);
  assert.ok(site.focused.classList.contains("cal-day") && !site.focused.disabled);
});

test("409 on a day that still has free times: «takenNow» at the time step, as before", async () => {
  const site = await boot();
  await site.pick(FRIDAY);
  site.server.add({ date: FRIDAY.date, start: FRIDAY.time, dur: 30 });
  await site.book();
  await site.advance(1000);
  oneMessageAt(site, "msg-time", site.s().takenNow);
});

// ---------- Fix-up round 2: the clock passes a rule between the uncertain attempt and the retry ----------
// s2-too-early-retry.mjs: today 11:00 booked at 10:00:40, stored, reply lost; the retry at 10:01:23 (same requestId)
// got 400 too_early because validation ran before the replay lookup, and the page said «Tiden du valgte er ikke ledig
// lenger». The server (and this harness's FakeServer, which mirrors it) now answers the replay first; and the page
// never turns a clock-rule «no» to an uncertain attempt's slot into a «gone» or «taken» text.
const TODAY_11 = { service: "Herreklipp", date: "2026-11-12", time: 660, name: "Kari Nordmann", phone: "409 63 955" };
test("pending: a stored same-day booking retried after the lead time has passed is confirmed (201 replay), and only one is stored", async () => {
  const site = await boot({ now: "2026-11-12T10:00:40+01:00", setup: (s) => s.when((r) => r.url === "/api/bookings", (req, srv) => { srv.book(req); return { network: true }; }, 1) });
  await site.pick(TODAY_11);
  await site.book();
  await site.advance(1000);
  assert.equal(site.message(), site.s().uncertain);
  await site.advance(42000); // 10:01:23: 11:00 is now inside the lead time
  await site.book();
  await site.advance(1000);
  assert.equal(site.bookingPosts()[1].json.requestId, site.bookingPosts()[0].json.requestId);
  assert.match(site.message(), /^Timen er booket: Herreklipp · torsdag 12\. november kl\. 11:00\./);
  assert.equal(site.server.bookings().length, 1);
  assert.equal(doneLines(site).length, 1);
});
for (const code of ["too_early", "bad_time", "bad_date", "closed"]) {
  test(`pending: a ${code} answer to the retry of an uncertain attempt keeps it uncertain («ring oss»), never «gone»`, async () => {
    const site = await boot({ setup: (s) => {
      s.when((r) => r.url === "/api/bookings", (req, srv) => { srv.book(req); return { network: true }; }, 1);
    } });
    await site.pick(FRIDAY);
    await site.book();
    await site.advance(1000);
    // an older server: validates the clock rules before it looks for the replay
    site.server.when((r) => r.url === "/api/bookings", { status: 400, body: { error: code, code } }, 1);
    await site.book();
    await site.advance(1000);
    const s = site.s();
    for (const no of [s.timeGone, s.takenNow, s.dayGone]) assert.ok(!site.message().includes(no), site.message());
    assert.equal(site.message(), s.uncertainStill);
    assert.match(site.summary(), /fredag 13\. november kl\. 14:00/, "the choice is kept");
    assert.equal(site.server.bookings().length, 1);
  });
}

// ---------- Fix-up round 2: a customer edit between the uncertain outcome and the retry ----------
// s3-edit-after-uncertain.mjs, s3b-service-change.mjs, s4-real-checks.mjs: the uncertainty belonged to the request,
// so any edit made a new attempt without it, and the customer's own possibly-stored 14:00 became «someone else's».
// Rule: the uncertainty belongs to the slot (requestId, date, start, dur) until a definite answer for that requestId.
const EDITS = {
  "the phone formatting": async (site) => { site.type(site.$("f-phone"), "40963955"); },
  "a typo fixed in the name": async (site) => { site.type(site.$("f-name"), "Kari Nordman"); },
  "an add-on ticked": async (site) => { site.click(site.qsa(".addon-picks input")[2]); await site.flush(); },
  "the service changed to Barneklipp (also 30 min), then the 30-s refresh": async (site) => { site.choose(site.select, "Barneklipp"); await site.flush(); await site.poll(); },
};
for (const [label, edit] of Object.entries(EDITS)) {
  test(`pending: after an uncertain outcome (stored), ${label}, then «Bestill time»: never «someone else» or «gone», one booking`, async () => {
    const site = await boot({ setup: (s) => s.when((r) => r.url === "/api/bookings", (req, srv) => { srv.book(req); return { network: true }; }, 1) });
    await site.pick(FRIDAY);
    await site.book();
    await site.advance(1000);
    await edit(site);
    const s = site.s();
    assert.notEqual(site.message(), s.timeGone, "the edit does not drop the customer's own time");
    assert.match(site.summary(), /kl\. 14:00/, "the time is kept");
    await site.book();
    await site.advance(1000);
    for (const no of [s.timeGone, s.takenNow]) assert.ok(!site.message().includes(no), site.message());
    const booked = /^Timen er booket/.test(site.message());
    assert.ok(booked || site.message() === s.uncertainStill || site.message() === s.uncertain, site.message());
    assert.equal(site.server.bookings().length, 1, "at most one booking for the customer");
  });
}
test("pending: Full service uncertain at 14:00 keeps 13:30 and 14:30 busy (they overlap 14:00–15:00); only 14:00 itself stays the customer's", async () => {
  const site = await boot({ setup: (s) => s.when((r) => r.url === "/api/bookings", (req, srv) => { srv.book(req); return { network: true }; }, 1) });
  await site.pick({ ...FRIDAY, service: "Full service" });
  await site.book();
  await site.advance(1000);
  await site.poll();
  const at = (t) => site.slots().filter((x) => x.t === t || (x.t === null && x.text.indexOf(site.s().time(t)) === 0))[0];
  assert.ok(site.slot(840), "14:00 is still the customer's choice");
  for (const t of [810, 870]) assert.ok(site.slot(t) === null, `${t / 60} h: not offered as free (${JSON.stringify(at(t) && at(t).cls)})`);
});
