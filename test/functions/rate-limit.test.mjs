// Audit finding F2 and owner decision (e): a booking flood must neither fill the calendar nor text strangers at
// the shop's cost. POST /api/bookings counts every validated request per client IP (5/h, 10/24 h), per phone
// number (3/24 h, whatever the formatting) and in total (20/h, 40/24 h), atomically in Netlify Blobs, and answers
// 429 { error, code: "rate_limited" } when a limit is reached. Cross-site and non-JSON posts are refused first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { oslo } from "../helpers/clock.mjs";
import { storedItems, SHOP_MOBILE } from "../helpers/bookings.mjs";
import { addDays, dayOfWeek, CONFIG } from "../../netlify/lib/booking-core.mjs";
import { BOOKING_LIMITS } from "../../netlify/lib/limits.mjs";
import { handle } from "../../netlify/functions/bookings.mjs";

const NOW = oslo("2026-11-12", 10, 0); // Thursday 10:00 in Oslo
const HOUR = 3600e3;
const SVEVE_ENV = { SVEVE_USER: "u", SVEVE_PASSWD: "p" };
const from = (ip) => ({ ...PRODUCTION, ip });

// Every free 30-minute slot from tomorrow on, in order, so each request in a flood is a valid, different booking
function* allSlots() {
  for (let i = 1; i <= CONFIG.maxDays; i++) {
    const date = addDays("2026-11-12", i);
    const hours = CONFIG.hours[dayOfWeek(date)];
    if (!hours) continue;
    for (let start = hours[0]; start + 30 <= hours[1]; start += 30) yield { date, start };
  }
}
const mobile = (i) => "9" + String(1000000 + i).padStart(7, "0"); // a different Norwegian mobile per request
const body = (slot, phone) => ({ service: "Herreklipp", ...slot, addons: [], name: "Flom", phone });
const post = (json, headers) => request("/api/bookings", { method: "POST", json, headers });

async function flood(d, n, { ip = (i) => `203.0.113.${i % 250}`, phone = mobile, slots } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const res = await read(await handle(post(body(slots.next().value, phone(i))), from(ip(i)), d));
    out.push(res);
  }
  return out;
}
const statuses = (rs) => rs.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});

test("rate limit: the limits are the documented ones", () => {
  assert.deepEqual(BOOKING_LIMITS, {
    ip: [{ max: 5, windowMs: HOUR }, { max: 10, windowMs: 24 * HOUR }],
    phone: [{ max: 3, windowMs: 24 * HOUR }],
    all: [{ max: 20, windowMs: HOUR }, { max: 40, windowMs: 24 * HOUR }],
  });
});

test("rate limit: one client gets at most 5 bookings per hour and 10 per 24 h; the rest are 429 and store nothing", async () => {
  const d = testDeps({ now: NOW });
  const slots = allSlots();
  const one = () => "198.51.100.9";
  let rs = await flood(d, 8, { ip: one, slots });
  assert.deepEqual(statuses(rs), { 201: 5, 429: 3 });
  for (const r of rs.filter((x) => x.status === 429)) {
    assert.equal(r.body.code, "rate_limited");
    assert.match(r.body.error, /409 63 911/);
  }
  assert.equal(storedItems(d.blobs).length, 5);
  d.clock.advance(HOUR);
  rs = await flood(d, 8, { ip: one, slots });
  assert.deepEqual(statuses(rs), { 201: 5, 429: 3 });
  d.clock.advance(2 * HOUR);
  assert.deepEqual(statuses(await flood(d, 3, { ip: one, slots })), { 429: 3 }, "10 in 24 h");
  d.clock.advance(21 * HOUR + 1);
  assert.deepEqual(statuses(await flood(d, 1, { ip: one, slots })), { 201: 1 }, "a day later the client may book again");
  assert.equal(storedItems(d.blobs).length, 11);
});

test("rate limit: one phone number gets at most 3 bookings per 24 h, whatever the formatting and the client", async () => {
  const d = testDeps({ now: NOW });
  const formats = ["+47 912 34 567", "91234567", "0047 912 34 567", "912-34-567", "912 34 567"];
  const rs = await flood(d, formats.length, { phone: (i) => formats[i], slots: allSlots() });
  assert.deepEqual(rs.map((r) => r.status), [201, 201, 201, 429, 429]);
  assert.equal(storedItems(d.blobs).length, 3);
});

test("rate limit: a flood from rotating clients and numbers stores at most 20 per hour and 40 per 24 h, and refused bookings get no SMS", async (t) => {
  quiet(t);
  const d = testDeps({ now: NOW, env: SVEVE_ENV, sveve: true });
  const slots = allSlots();
  let i = 0;
  const wave = async (n) => {
    const rs = [];
    for (let k = 0; k < n; k++, i++) {
      const phone = mobile(i);
      const r = await read(await handle(post(body(slots.next().value, phone)), from(`2001:db8::${i}`), d));
      rs.push({ ...r, phone });
    }
    return rs;
  };
  const all = [];
  all.push(...await wave(60));
  assert.equal(storedItems(d.blobs).length, 20, "20 in the first hour");
  d.clock.advance(HOUR);
  all.push(...await wave(60));
  assert.equal(storedItems(d.blobs).length, 40, "40 in 24 h");
  for (const h of [1, 5, 10, 20]) {
    d.clock.set(NOW.getTime() + (1 + h) * HOUR);
    all.push(...await wave(20));
  }
  assert.equal(storedItems(d.blobs).length, 40, "nothing more until the first ones are 24 h old");
  const refused = new Set(all.filter((r) => r.status === 429).map((r) => r.phone));
  assert.equal(refused.size, all.length - 40);
  assert.ok(all.filter((r) => r.status === 429).every((r) => r.body.code === "rate_limited"));
  const customers = d.sveve.sent.filter((s) => s.to !== SHOP_MOBILE);
  assert.ok(customers.every((s) => !refused.has(s.to)), "a refused booking never texts anyone");
  assert.ok(customers.length <= 40);
  d.clock.set(NOW.getTime() + 24 * HOUR + 1);
  assert.equal((await wave(1))[0].status, 201, "the next day web bookings work again");
});

test("rate limit: concurrent requests from one client are counted atomically (never more than 5 stored)", async (t) => {
  quiet(t);
  const d = testDeps({ now: NOW });
  const slots = [...allSlots()].slice(0, 12);
  const rs = await Promise.all(slots.map(async (slot, i) =>
    read(await handle(post(body(slot, mobile(i))), from("198.51.100.77"), d))));
  const st = statuses(rs);
  assert.ok((st[201] || 0) >= 1 && (st[201] || 0) <= 5, JSON.stringify(st));
  assert.ok(Object.keys(st).every((s) => ["201", "429", "503"].includes(s)), JSON.stringify(st));
  assert.equal(storedItems(d.blobs).length, st[201]);
});

test("rate limit: a lost reply on a counter write is not counted twice", async () => {
  const d = testDeps({ now: NOW });
  d.blobs.inject({ method: "PUT", key: /^rl\/ip\//, fault: "lost-response" });
  const res = await read(await handle(post(body({ date: "2026-11-13", start: 600 }, mobile(1))), from("198.51.100.5"), d));
  assert.equal(res.status, 201);
  assert.equal(d.blobs.json("bookings-preview", "rl/ip/198.51.100.5"), undefined);
  assert.equal(d.blobs.json("bookings", "rl/ip/198.51.100.5").hits.length, 1);
});

test("rate limit: cross-site and non-JSON posts are refused before anything is counted or stored", async () => {
  const d = testDeps({ now: NOW });
  const json = JSON.stringify(body({ date: "2026-11-13", start: 600 }, mobile(1)));
  const raw = (headers) => request("/api/bookings", { method: "POST", body: json, headers });
  for (const [headers, status] of [
    [{ "Content-Type": "text/plain" }, 415],                         // <form enctype="text/plain"> on another site
    [{ "Content-Type": "application/x-www-form-urlencoded" }, 415],
    [{}, 415],
    [{ "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }, 403],
    [{ "Content-Type": "application/json", "Sec-Fetch-Site": "same-site" }, 403],
  ]) {
    assert.equal((await handle(raw(headers), from("198.51.100.6"), d)).status, status, JSON.stringify(headers));
  }
  assert.equal(d.blobs.log.length, 0, "nothing read, counted or stored");
  assert.equal((await handle(raw({ "Content-Type": "application/json; charset=utf-8", "Sec-Fetch-Site": "same-origin" }), from("198.51.100.6"), d)).status, 201);
});

test("rate limit: honeypot and invalid requests write nothing", async () => {
  const d = testDeps({ now: NOW });
  for (let i = 0; i < 30; i++) {
    await handle(post({ ...body({ date: "2026-11-13", start: 600 }, mobile(i)), botField: "spam" }), from("198.51.100.8"), d);
    await handle(post(body({ date: "2026-11-13", start: 601 }, mobile(i))), from("198.51.100.8"), d);
  }
  assert.equal(d.blobs.requests({ method: "PUT" }).length, 0);
  assert.equal((await handle(post(body({ date: "2026-11-13", start: 600 }, mobile(1))), from("198.51.100.8"), d)).status, 201);
});
