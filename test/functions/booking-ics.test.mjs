// NEW-confirm-volatile (server half): after booking, the customer can put the appointment in their own calendar.
// GET /api/bookings/<id>.ics (the page builds the URL from booking.id in the 201 reply, which does not change).
// Invariants:
//   1. 200 text/calendar, never cached (no-store), valid RFC 5545 (test/helpers/ical.mjs, an independent reader);
//   2. exactly one VEVENT at the booked Oslo time (DTSTART;TZID=Europe/Oslo) with the booked length (DURATION);
//      SUMMARY names the service and Viggo's Barbershop, LOCATION is the shop's address, and DESCRIPTION says to
//      call 409 63 911 to change or cancel;
//   3. no customer name or phone anywhere in it (the id is all a caller needs, so it reveals nothing personal);
//   4. a cancelled booking, a block, an admin-entered booking, an unknown id or a malformed path is 404 with the
//      same body, and reads at most one month document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, PRODUCTION } from "../helpers/deps.mjs";
import { item, seedItems } from "../helpers/bookings.mjs";
import { parseCalendar, components, prop, text, rfc5545Problems, parseDuration } from "../helpers/ical.mjs";
import * as ics from "../../netlify/functions/booking-ics.mjs";

const NOW = "2026-11-12T09:00:00Z";
const get = (d, path, method = "GET") => ics.handle(request(path, { method }), PRODUCTION, d).then(read);

function site() {
  const d = testDeps({ now: NOW });
  const [b, cancelled, block, byAdmin] = seedItems(d.blobs, [
    item({ date: "2026-11-13", start: 840, dur: 30, service: "Herreklipp", addons: ["Styling"], name: "Kari Hemmelig", phone: "912 34 567" }),
    item({ date: "2026-11-13", start: 900, status: "cancelled", name: "Avlyst Kunde" }),
    item({ date: "2026-11-14", start: 600, type: "block", source: "admin", name: "", phone: "" }),
    item({ date: "2026-11-16", start: 600, source: "admin", name: "Telefonkunde" }),
  ]);
  return { d, b, cancelled, block, byAdmin };
}

test("booking ics: path", () => {
  assert.deepEqual(ics.config, { path: "/api/bookings/:file" });
});

test("booking ics: one VEVENT at the booked Oslo time and length, with the service, the shop, its address and the phone to call", async () => {
  const { d, b } = site();
  const res = await get(d, `/api/bookings/${b.id}.ics`);
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /^text\/calendar; charset=utf-8$/);
  assert.match(res.headers["cache-control"], /no-store/);
  assert.deepEqual(rfc5545Problems(res.body), []);
  const cal = parseCalendar(res.body);
  const events = components(cal, "VEVENT");
  assert.equal(events.length, 1);
  const ev = events[0];
  const start = prop(ev, "DTSTART");
  assert.equal(start.params.TZID, "Europe/Oslo");
  assert.equal(start.value, "20261113T140000");
  assert.equal(res.body.includes("DTSTART;TZID=Europe/Oslo:20261113T140000"), true);
  assert.equal(parseDuration(prop(ev, "DURATION").value).exactMs, 30 * 60e3);
  assert.equal(text(ev, "SUMMARY"), "Herreklipp + Styling – Viggo's Barbershop");
  assert.equal(text(ev, "LOCATION"), "Violgata 22, 1776 Halden");
  assert.match(text(ev, "DESCRIPTION"), /Ring 409 63 911 for å endre eller avlyse/);
  assert.ok(!res.body.includes("Kari") && !res.body.includes("Hemmelig"), "no customer name");
  assert.ok(!/912\s?34\s?567|91234567/.test(res.body), "no customer phone");
});

test("booking ics: HEAD answers the headers without a body", async () => {
  const { d, b } = site();
  const res = await get(d, `/api/bookings/${b.id}.ics`, "HEAD");
  assert.equal(res.status, 200);
  assert.equal(res.body, "");
});

test("booking ics: cancelled, block, admin-entered, unknown and malformed ids are all the same 404", async () => {
  const { d, cancelled, block, byAdmin } = site();
  const paths = [
    `/api/bookings/${cancelled.id}.ics`, `/api/bookings/${block.id}.ics`, `/api/bookings/${byAdmin.id}.ics`,
    "/api/bookings/2026-11-13_0000000000.ics", "/api/bookings/2026-11-31_abcdef0123.ics", "/api/bookings/x.ics",
    "/api/bookings/2026-11-13_..%2F..%2Fm%2F2026-11.ics", "/api/bookings/2026-11-13_abc", "/api/bookings/constructor.ics",
  ];
  const bodies = new Set();
  for (const p of paths) {
    const before = d.blobs.log.length;
    const res = await get(d, p);
    assert.equal(res.status, 404, p);
    assert.match(res.headers["cache-control"], /no-store/);
    bodies.add(JSON.stringify(res.body));
    assert.ok(d.blobs.log.length - before <= 1, `${p} reads at most one month`);
  }
  assert.equal(bodies.size, 1, "one 404 body for every case");
});

test("booking ics: only GET and HEAD", async () => {
  const { d, b } = site();
  const res = await ics.handle(request(`/api/bookings/${b.id}.ics`, { method: "POST", json: {} }), PRODUCTION, d).then(read);
  assert.equal(res.status, 405);
});
