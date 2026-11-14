// GET /api/calendar/<token>.ics (netlify/functions/calendar.mjs), owner decision 2a. Invariants:
//   1. a wrong or old token, a malformed one, or any token before a link exists gets the same 404 and no data:
//      not a name, not a time, and the month documents are not even read;
//   2. the right token gets the whole feed, RFC 5545-valid, and it is never stored by a shared cache
//      (Cache-Control private, no-store, also for Netlify's CDN), for every status;
//   3. re-creating the link makes the old one 404 at once (strong consistency);
//   4. the feed follows the timebook: a web booking appears, a move moves it, a cancel or delete removes it;
//   5. a deploy preview has its own store and its own link (F10);
//   6. the token is never written to the log, also when the store fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION, PREVIEW } from "../helpers/deps.mjs";
import { oslo } from "../helpers/clock.mjs";
import { item, seedItems, CUSTOMER_PHONE } from "../helpers/bookings.mjs";
import { rfc5545Problems, parseCalendar, components, prop, text, toUtcMs } from "../helpers/ical.mjs";
import { makeToken } from "../../netlify/lib/booking-core.mjs";
import { createFeed, newFeedToken } from "../../netlify/lib/calendar.mjs";
import { handle, config } from "../../netlify/functions/calendar.mjs";
import * as bookings from "../../netlify/functions/bookings.mjs";
import * as admin from "../../netlify/functions/admin.mjs";

const NOW = oslo("2026-11-16", 9, 0); // Monday 09:00 in Oslo
const PASSWORD = "fake-admin-password";
const NOT_FOUND = "Fant ikke kalenderen.\n";

const storeOf = (d, name = "bookings") => d.blobs.getStore({ name, consistency: "strong" });
const feed = (d, path, ctx = PRODUCTION, method = "GET") => handle(request(path, { method }), ctx, d).then(read);
const uids = (ics) => components(parseCalendar(ics), "VEVENT").map((e) => prop(e, "UID").value);
const eventFor = (ics, id) => components(parseCalendar(ics), "VEVENT").find((e) => prop(e, "UID").value === `${id}@viggos-timebok`);
const monthReads = (d) => d.blobs.log.filter((e) => /^m\//.test(e.key || ""));
const noStore = (res) => {
  assert.match(res.headers["cache-control"], /\bprivate\b/);
  assert.match(res.headers["cache-control"], /\bno-store\b/);
  assert.equal(res.headers["cdn-cache-control"], "no-store");
  assert.equal(res.headers["netlify-cdn-cache-control"], "no-store");
};
const strip = (h) => { const { date, ...rest } = h; return rest; };

async function withFeed(items = []) {
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PASSWORD } });
  seedItems(d.blobs, items);
  const { feed: f } = await createFeed(storeOf(d), { now: NOW });
  return { d, token: f.token, path: `/api/calendar/${f.token}.ics` };
}

test("calendar feed: path", () => {
  assert.deepEqual(config, { path: "/api/calendar/:file" });
});

test("calendar feed: the right token gets the RFC 5545 feed of the bookings, never cached", async () => {
  const b = item({ date: "2026-11-18", start: 600, name: "Ola Nordmann" });
  const { d, path } = await withFeed([b, item({ date: "2026-11-18", start: 660, status: "cancelled", name: "Avlyst Kunde" })]);
  const res = await feed(d, path);
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/calendar; charset=utf-8");
  assert.match(res.headers["content-disposition"], /filename="viggos-timebok\.ics"/);
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.match(res.headers["x-robots-tag"], /noindex/);
  noStore(res);
  assert.deepEqual(rfc5545Problems(res.body), []);
  assert.deepEqual(uids(res.body), [`${b.id}@viggos-timebok`]);
  assert.doesNotMatch(res.body, /Avlyst Kunde/);
  assert.deepEqual(d.blobs.opened.map((o) => o.consistency), ["strong", "strong"], "always the strong store");
  assert.equal(d.fetch.calls.length, 0);
  // Without .ics works too (some apps drop it)
  assert.equal((await feed(d, path.replace(/\.ics$/, ""))).status, 200);
});

test("calendar feed: a wrong, old, malformed or missing token gets the same 404 and no data", async () => {
  const { d, token, path } = await withFeed([item({ date: "2026-11-18", name: "Hemmelig Kunde", phone: CUSTOMER_PHONE })]);
  const flip = (t, i) => t.slice(0, i) + (t[i] === "A" ? "B" : "A") + t.slice(i + 1);
  const { feed: renewed } = await createFeed(storeOf(d), { replace: true, now: NOW });
  const reference = await feed(testDeps({ now: NOW }), `/api/calendar/${newFeedToken()}.ics`); // no link exists at all
  assert.equal(reference.status, 404);
  const wrong = [
    ["the old token after a new link was made", path],
    ["another random token", `/api/calendar/${newFeedToken()}.ics`],
    ["the first character changed", `/api/calendar/${flip(renewed.token, 0)}.ics`],
    ["the last character changed", `/api/calendar/${flip(renewed.token, 42)}.ics`],
    ["one character short", `/api/calendar/${renewed.token.slice(1)}.ics`],
    ["one character extra", `/api/calendar/${renewed.token}x.ics`],
    ["in the query instead of the path", `/api/calendar/feed.ics?token=${renewed.token}`],
    ["with a sub-path", `/api/calendar/${renewed.token}/x.ics`],
    ["empty", "/api/calendar/.ics"],
    ["percent-encoded junk", `/api/calendar/%2e%2e%2f${renewed.token}.ics`],
    ["the old token with no .ics", `/api/calendar/${token}`],
  ];
  const before = monthReads(d).length;
  for (const [label, p] of wrong) {
    const res = await feed(d, p);
    assert.equal(res.status, 404, label);
    assert.equal(res.body, NOT_FOUND, label);
    assert.deepEqual(strip(res.headers), strip(reference.headers), `${label}: same headers as when no link exists`);
    assert.doesNotMatch(res.body, /Hemmelig|912|VCALENDAR/, label);
    noStore(res);
  }
  assert.equal(monthReads(d).length, before, "a wrong token never reads a single booking");
  assert.equal((await feed(d, `/api/calendar/${renewed.token}.ics`)).status, 200, "the new link works");
});

test("calendar feed: re-creating the link stops the old one at once", async () => {
  const { d, path } = await withFeed([item({ date: "2026-11-18" })]);
  assert.equal((await feed(d, path)).status, 200);
  const { feed: f } = await createFeed(storeOf(d), { replace: true, now: NOW });
  assert.equal((await feed(d, path)).status, 404);
  assert.equal((await feed(d, `/api/calendar/${f.token}.ics`)).status, 200);
});

test("calendar feed: HEAD answers headers only; other methods are refused without data", async () => {
  const { d, path } = await withFeed([item({ date: "2026-11-18", name: "Ola Nordmann" })]);
  const head = await feed(d, path, PRODUCTION, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  noStore(head);
  assert.equal((await feed(d, `/api/calendar/${newFeedToken()}.ics`, PRODUCTION, "HEAD")).status, 404);
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await feed(d, path, PRODUCTION, method);
    assert.equal(res.status, 405, method);
    assert.doesNotMatch(res.body, /Ola/);
    noStore(res);
  }
});

test("calendar feed: follows the timebook – a web booking appears, a move moves it, cancel and delete remove it", async () => {
  const { d, path } = await withFeed();
  const auth = { Authorization: "Bearer " + makeToken(PASSWORD, d.clock.now()) };
  const booked = await read(await bookings.handle(request("/api/bookings", { method: "POST", json: {
    service: "Herreklipp", date: "2026-11-18", start: 600, addons: ["Styling"], name: "Kari Nordmann", phone: CUSTOMER_PHONE,
  } }), PRODUCTION, d));
  assert.equal(booked.status, 201);
  const id = booked.body.booking.id;
  let ics = (await feed(d, path)).body;
  let ev = eventFor(ics, id);
  assert.equal(text(ev, "SUMMARY"), "Herreklipp + Styling – Kari Nordmann");
  assert.match(text(ev, "DESCRIPTION"), new RegExp(`Telefon: ${CUSTOMER_PHONE}`));
  assert.equal(toUtcMs(prop(ev, "DTSTART"), parseCalendar(ics)), oslo("2026-11-18", 10, 0).getTime());

  // Moved within the month: same event (same UID), new time
  const patch = (itemId, json) => admin.handle(request(`/api/admin/items/${itemId}`, { method: "PATCH", headers: auth, json }), { ...PRODUCTION, params: { id: itemId } }, d).then(read);
  d.clock.advance(60e3);
  assert.equal((await patch(id, { start: 840 })).status, 200);
  ics = (await feed(d, path)).body;
  ev = eventFor(ics, id);
  assert.deepEqual(uids(ics), [`${id}@viggos-timebok`]);
  assert.equal(toUtcMs(prop(ev, "DTSTART"), parseCalendar(ics)), oslo("2026-11-18", 14, 0).getTime());

  // Moved to December (and into the same wall-clock time): the old event goes, the new one is there once
  const moved = await patch(id, { date: "2026-12-02", start: 840 });
  const newId = moved.body.item.id;
  ics = (await feed(d, path)).body;
  assert.deepEqual(uids(ics), [`${newId}@viggos-timebok`]);
  assert.equal(toUtcMs(prop(eventFor(ics, newId), "DTSTART"), parseCalendar(ics)), oslo("2026-12-02", 14, 0).getTime());

  // Cancelled: gone. Un-cancelled: back. Deleted: gone.
  await patch(newId, { status: "cancelled" });
  assert.deepEqual(uids((await feed(d, path)).body), []);
  await patch(newId, { status: "confirmed" });
  assert.deepEqual(uids((await feed(d, path)).body), [`${newId}@viggos-timebok`]);
  await admin.handle(request(`/api/admin/items/${newId}`, { method: "DELETE", headers: auth }), { ...PRODUCTION, params: { id: newId } }, d);
  ics = (await feed(d, path)).body;
  assert.deepEqual(uids(ics), []);
  assert.deepEqual(rfc5545Problems(ics), []);
});

test("calendar feed: a deploy preview has its own link and its own bookings (F10)", async () => {
  const { d, token, path } = await withFeed([item({ date: "2026-11-18", name: "Ekte kunde" })]);
  assert.equal((await feed(d, path, PREVIEW)).status, 404, "the live link does not open the preview");
  const { feed: pf } = await createFeed(storeOf(d, "bookings-preview"), { now: NOW });
  seedItems(d.blobs, []);
  d.blobs.seed("bookings-preview", "m/2026-11", { items: [item({ date: "2026-11-18", name: "Test i forhåndsvisning" })] });
  const preview = await feed(d, `/api/calendar/${pf.token}.ics`, PREVIEW);
  assert.equal(preview.status, 200);
  assert.match(preview.body, /Test i forhåndsvisning/);
  assert.doesNotMatch(preview.body, /Ekte kunde/);
  assert.equal((await feed(d, `/api/calendar/${pf.token}.ics`, PRODUCTION)).status, 404, "the preview link does not open the live feed");
  assert.notEqual(pf.token, token);
});

test("calendar feed: when the store fails it answers 503 with no data and never logs the token", async (t) => {
  const out = quiet(t);
  const { d, token, path } = await withFeed([item({ date: "2026-11-18", name: "Ola Nordmann" })]);
  d.blobs.inject({ method: "GET", fault: "fail-before", status: 500, times: Infinity });
  const res = await feed(d, path);
  assert.equal(res.status, 503);
  assert.doesNotMatch(res.body, /Ola|VCALENDAR/);
  noStore(res);
  assert.ok(out.error.length >= 1);
  const logged = JSON.stringify([out.log, out.error, out.warn].map((l) => l.map((args) => args.map(String))));
  assert.equal(logged.includes(token), false, "the token is not in the log");
});
