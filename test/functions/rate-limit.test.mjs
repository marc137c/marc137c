// Audit finding F2: a booking flood must not fill the calendar with fake bookings.
// POST /api/bookings counts every validated request per client (IPv4 address, or IPv6 /64: 5/h, 10/24 h), per
// phone number (6/24 h, whatever the formatting; owner to confirm) and in total (20/h, 40/24 h), atomically in
// Netlify Blobs, and answers 429 { error, code: "rate_limited" } when a limit is reached. Cross-site and non-JSON
// posts are refused first. NEW-lockout / NEW-429 / NEW-pii-keys (SPEC R5, R4):
//   - all three counters are checked before any is written, and a refused attempt is refunded, so a full global
//     counter never burns a customer's own phone or IP counter;
//   - an attempt on a taken slot (409) keeps only its IP hit: 409 spam costs nothing globally;
//   - the barber gets one push the first time the global cap refuses in a window;
//   - counter keys are keyed hashes: no store key holds a phone number or an IP address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { oslo } from "../helpers/clock.mjs";
import { item, seedItems, storedItems, counterHits } from "../helpers/bookings.mjs";
import { makeDevice, fakePushService } from "../helpers/fake-push.mjs";
import { addDays, dayOfWeek, CONFIG } from "../../netlify/lib/booking-core.mjs";
import { BOOKING_LIMITS, phoneKey, clientKey, counterRef, limiterSecret, ALL_KEY } from "../../netlify/lib/limits.mjs";
import { vapidKeys, saveSubscription, parseSubscription, pushGen } from "../../netlify/lib/push.mjs";
import { handle } from "../../netlify/functions/bookings.mjs";

const NOW = oslo("2026-11-12", 10, 0); // Thursday 10:00 in Oslo
const HOUR = 3600e3;
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
const live = (d) => d.getStore({ name: "bookings", consistency: "strong" });
// A counter, as limits.mjs finds it: its bucket and its name there (a keyed hash of the value); or a shared key
const keyOf = async (d, kind, value) => counterRef(await limiterSecret(live(d)), kind, value);
const hits = (d, ref) => counterHits(d.blobs, ref).length;
// Every hit in the buckets of one kind (round 3: rl/b/<kind>/<0-f>, a fixed set of documents)
const kindHits = (d, kind) => d.blobs.keys("bookings").filter((k) => k.startsWith(`rl/b/${kind}/`)).flatMap((k) => d.blobs.json("bookings", k).hits);

test("rate limit: the limits are the documented ones", () => {
  assert.deepEqual(BOOKING_LIMITS, {
    ip: [{ max: 5, windowMs: HOUR }, { max: 10, windowMs: 24 * HOUR }],
    phone: [{ max: 6, windowMs: 24 * HOUR }],
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

test("rate limit: one phone number gets at most 6 bookings per 24 h, whatever the formatting and the client", async () => {
  const d = testDeps({ now: NOW });
  const formats = ["+47 912 34 567", "91234567", "0047 912 34 567", "912-34-567", "912 34 567", "+47 91234567", "0047-912-34-567", "912.34.567"];
  const rs = await flood(d, formats.length, { phone: (i) => formats[i], slots: allSlots() });
  assert.deepEqual(rs.map((r) => r.status), [201, 201, 201, 201, 201, 201, 429, 429]);
  assert.equal(storedItems(d.blobs).length, 6);
});

test("rate limit: the phone counter key ignores formatting and the +47/0047 prefix, landlines too", () => {
  for (const [given, key] of [
    ["912 34 567", "91234567"], ["+47 912 34 567", "91234567"], ["0047 91234567", "91234567"], ["47 912-34-567", "91234567"],
    ["22 33 44 55", "22334455"], ["+47 22 33 44 55", "22334455"], ["(0047) 22.33.44.55", "22334455"],
    ["+46 70 123 45 67", "46701234567"], ["4791234567890", "4791234567890"], ["", ""], [undefined, ""],
  ]) assert.equal(phoneKey(given), key, String(given));
});

test("rate limit: a landline written with and without +47 shares one counter", async () => {
  const d = testDeps({ now: NOW });
  const formats = ["+47 69 17 00 00", "69170000", "0047 69 17 00 00", "69 17 00 00", "+4769170000", "0047 69170000", "69-17-00-00"];
  const rs = await flood(d, formats.length, { phone: (i) => formats[i], slots: allSlots() });
  assert.deepEqual(rs.map((r) => r.status), [201, 201, 201, 201, 201, 201, 429]);
  const ref = await keyOf(d, "phone", "69170000");
  assert.deepEqual([...new Set(kindHits(d, "phone").map((h) => `${h.k}`))], [ref.name], "one name in the phone buckets");
  assert.equal(hits(d, ref), 6);
});

test("rate limit: a flood from rotating clients and numbers stores at most 20 per hour and 40 per 24 h", async (t) => {
  quiet(t);
  const d = testDeps({ now: NOW });
  const slots = allSlots();
  let i = 0;
  const wave = async (n) => {
    const rs = [];
    for (let k = 0; k < n; k++, i++) {
      const phone = mobile(i);
      const r = await read(await handle(post(body(slots.next().value, phone)), from(`2001:db8:${i.toString(16)}::1`), d));
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
  const refused = all.filter((r) => r.status === 429);
  assert.equal(refused.length, all.length - 40);
  assert.ok(refused.every((r) => r.body.code === "rate_limited"));
  const stored = new Set(storedItems(d.blobs).map((i) => i.phone));
  assert.ok(refused.every((r) => !stored.has(r.phone)), "a refused booking stores nothing");
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
  const rule = d.blobs.inject({ method: "PUT", key: /^rl\/b\/ip\//, fault: "lost-response" });
  const res = await read(await handle(post(body({ date: "2026-11-13", start: 600 }, mobile(1))), from("198.51.100.5"), d));
  assert.equal(res.status, 201);
  assert.equal(rule.hits, 1, "the fault hit the client's bucket write");
  const ref = await keyOf(d, "ip", "198.51.100.5");
  assert.equal(d.blobs.json("bookings-preview", ref.key), undefined);
  assert.equal(hits(d, ref), 1);
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

// ---------- clients: IPv6 per /64, IPv4-mapped as IPv4 (NEW-lockout) ----------
test("rate limit: clientKey keys IPv4 by address, IPv6 by its /64, and anything else as 'ukjent'", () => {
  for (const [given, key] of [
    ["198.51.100.5", "198.51.100.5"], ["198.51.100.5:443", "198.51.100.5"], [" 198.51.100.5 ", "198.51.100.5"],
    ["::ffff:198.51.100.5", "198.51.100.5"], ["::FFFF:198.51.100.5", "198.51.100.5"], ["::ffff:c633:6405", "198.51.100.5"],
    ["[::ffff:198.51.100.5]:8080", "198.51.100.5"], ["0:0:0:0:0:ffff:198.51.100.5", "198.51.100.5"],
    ["2a01:79c:cebd:1000::1", "2a01:79c:cebd:1000::/64"], ["2a01:79c:cebd:1000::28", "2a01:79c:cebd:1000::/64"],
    ["2a01:079c:cebd:1000:aaaa:bbbb:cccc:dddd", "2a01:79c:cebd:1000::/64"], ["2A01:79C:CEBD:1000::1", "2a01:79c:cebd:1000::/64"],
    ["[2a01:79c:cebd:1000::1]:443", "2a01:79c:cebd:1000::/64"], ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["2001:db8::", "2001:db8:0:0::/64"], ["::1", "0:0:0:0::/64"], ["::", "0:0:0:0::/64"], ["64:ff9b::198.51.100.5", "64:ff9b:0:0::/64"],
    ["2a01:79c:cebd:1001::1", "2a01:79c:cebd:1001::/64"],
  ]) assert.equal(clientKey(given), key, String(given));
  for (const bad of ["", "ukjent", undefined, null, "999.1.1.1", "1.2.3", "1.2.3.4.5", "01.2.3.4.5", "2001:db8:::1", "1::2::3",
    "2001:db8:0:0:0:0:0:0:1", "1:2:3:4:5:6:7", "g::1", "2001:db8::12345", "::ffff:999.1.1.1", ":1::", "<script>", "a".repeat(100)]) {
    assert.equal(clientKey(bad), "ukjent", String(bad));
  }
});

test("rate limit: 12 bookings from 12 addresses in one IPv6 /64 give 5 x 201, then 429", async () => {
  const d = testDeps({ now: NOW });
  const rs = await flood(d, 12, { ip: (i) => `2a01:79c:cebd:1000::${(i + 1).toString(16)}`, slots: allSlots() });
  assert.deepEqual(rs.map((r) => r.status), [201, 201, 201, 201, 201, 429, 429, 429, 429, 429, 429, 429]);
  assert.equal(storedItems(d.blobs).length, 5);
});

test("rate limit: ::ffff:198.51.100.5 and 198.51.100.5 are one client", async () => {
  const d = testDeps({ now: NOW });
  const rs = await flood(d, 7, { ip: (i) => (i % 2 ? "::ffff:198.51.100.5" : "198.51.100.5"), slots: allSlots() });
  assert.deepEqual(rs.map((r) => r.status), [201, 201, 201, 201, 201, 429, 429]);
  assert.equal(new Set(kindHits(d, "ip").map((h) => h.k)).size, 1, "one client name in the IP buckets");
});

// ---------- the lockout demo (audit/ready/server/demo-lockout.mjs) ----------
const phoneHits = (d) => kindHits(d, "phone").length;

test("rate limit: 40 attempts on a taken slot from one /64 stop at the client cap, cost the global counter nothing, and a real customer still books", async () => {
  const d = testDeps({ now: oslo("2026-11-16", 9, 0) }); // Monday 09:00
  const at = (start) => ({ date: "2026-11-20", start });
  const real = await read(await handle(post(body(at(720), "41234567")), from("84.210.1.1"), d));
  assert.equal(real.status, 201);
  const attack = async (from0) => {
    const out = [];
    for (let i = from0; i < from0 + 20; i++) {
      out.push(await read(await handle(post(body(at(720), "9" + String(2000000 + i))), from(`2a01:79c:cebd:1000::${(i + 1).toString(16)}`), d)));
    }
    return out;
  };
  const first = await attack(0);
  d.clock.advance(HOUR + 1000);
  const second = await attack(20);
  assert.deepEqual(statuses(first), { 409: 5, 429: 15 }, "the /64 is one client: 5 per hour");
  assert.deepEqual(statuses(second), { 409: 5, 429: 15 }, "and 10 per 24 h");
  assert.equal(hits(d, ALL_KEY), 1, "only the real booking is in the global counter");
  assert.equal(phoneHits(d), 1, "no attacker phone kept a hit");
  const customer = await read(await handle(post(body(at(600), "98765432")), from("62.249.1.7"), d));
  assert.equal(customer.status, 201, JSON.stringify(customer.body));
  assert.equal(storedItems(d.blobs).length, 2);
});

test("rate limit: with the global counter full, refused tries leave the customer's IP and phone counters unchanged", async (t) => {
  quiet(t);
  const d = testDeps({ now: NOW });
  const full = Array.from({ length: 40 }, (_, i) => ({ t: NOW.getTime() - 60e3 - i, id: "seed" + i }));
  d.blobs.seed("bookings", ALL_KEY, { hits: full });
  for (let k = 0; k < 3; k++) {
    const r = await read(await handle(post(body({ date: "2026-11-13", start: 600 + 30 * k }, "98765432")), from("62.249.1.7"), d));
    assert.deepEqual([r.status, r.body.code], [429, "rate_limited"]);
    assert.match(r.body.error, /409 63 911/);
  }
  assert.equal(hits(d, await keyOf(d, "phone", "98765432")), 0);
  assert.equal(hits(d, await keyOf(d, "ip", "62.249.1.7")), 0);
  assert.equal(hits(d, ALL_KEY), 40);
  // A day later the global counter has room again, and the same customer books at once
  d.clock.advance(24 * HOUR);
  const later = await read(await handle(post(body({ date: "2026-11-16", start: 630 }, "98765432")), from("62.249.1.8"), d));
  assert.equal(later.status, 201, JSON.stringify(later.body));
});

test("rate limit: a refused phone attempt leaves the IP counter unchanged, and a refused IP attempt the phone counter", async () => {
  const d = testDeps({ now: NOW });
  const slots = allSlots();
  // 6 bookings from one phone on 6 different clients fill the phone counter
  await flood(d, 6, { ip: (i) => `198.51.100.${20 + i}`, phone: () => "41234567", slots });
  const r = await read(await handle(post(body(slots.next().value, "41234567")), from("198.51.100.40"), d));
  assert.equal(r.status, 429);
  assert.equal(hits(d, await keyOf(d, "ip", "198.51.100.40")), 0, "the refused phone attempt took no IP hit");
  assert.equal(hits(d, ALL_KEY), 6);
  // 5 bookings from one client fill its IP counter; the 6th, from a new phone, does not count for that phone
  await flood(d, 5, { ip: () => "198.51.100.50", phone: (i) => mobile(100 + i), slots });
  const r2 = await read(await handle(post(body(slots.next().value, "47111222")), from("198.51.100.50"), d));
  assert.equal(r2.status, 429);
  assert.equal(hits(d, await keyOf(d, "phone", "47111222")), 0);
  assert.equal(hits(d, ALL_KEY), 11);
});

test("rate limit: three 409s and then a free slot from the same phone give 201", async () => {
  const d = testDeps({ now: NOW });
  seedItems(d.blobs, [600, 630, 660].map((start) => item({ date: "2026-11-13", start, name: "Tatt" })));
  for (const start of [600, 630, 660]) {
    const r = await read(await handle(post(body({ date: "2026-11-13", start }, "91234567")), from("62.249.1.7"), d));
    assert.deepEqual([r.status, r.body.code], [409, "taken"]);
  }
  assert.equal(hits(d, await keyOf(d, "phone", "91234567")), 0, "a taken slot costs the phone nothing");
  assert.equal(hits(d, ALL_KEY), 0, "nor the global counter");
  assert.equal(hits(d, await keyOf(d, "ip", "62.249.1.7")), 3, "the client counter keeps them (spam from one client is still capped)");
  const ok = await read(await handle(post(body({ date: "2026-11-13", start: 690 }, "91234567")), from("62.249.1.7"), d));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test("rate limit: the barber gets exactly one push the first time the global cap refuses in a window", async (t) => {
  quiet(t);
  const phone = makeDevice("apple");
  const push = fakePushService({ devices: [phone] });
  const PASSWORD = "fake-admin-password";
  const d = testDeps({ now: NOW, env: { ADMIN_PASSWORD: PASSWORD }, fetch: push.fetch });
  await vapidKeys(live(d), { now: d.now() });
  const sub = parseSubscription(phone.subscription).value;
  assert.equal((await saveSubscription(live(d), sub, { now: d.now(), gen: pushGen(PASSWORD), until: new Date(NOW.getTime() + 30 * 24 * HOUR) })).ok, true);
  const paused = () => push.deliveries.filter((x) => x.payload && x.payload.title !== "Ny time");
  const slots = allSlots();
  const rs = await flood(d, 25, { ip: (i) => `198.51.${i}.1`, slots });
  assert.deepEqual(statuses(rs), { 201: 20, 429: 5 });
  assert.equal(paused().length, 1, JSON.stringify(push.deliveries.map((x) => x.payload)));
  const [msg] = paused();
  assert.equal(msg.error, undefined, msg.error);
  assert.equal(msg.payload.title, "Nettbestilling er satt på pause");
  assert.match(msg.payload.body, /^For mange bestillinger siste døgn\./);
  assert.match(msg.payload.body, /409 63 911/);
  assert.equal(msg.payload.url, "/admin");
  assert.ok(!/Flom|910\d{5}/.test(JSON.stringify(msg.payload)), "no customer data");
  // later refusals in the same window send nothing more
  d.clock.advance(HOUR + 1000);
  const more = await flood(d, 25, { ip: (i) => `198.52.${i}.1`, slots });
  assert.deepEqual(statuses(more), { 201: 20, 429: 5 });
  assert.equal(paused().length, 1);
  d.clock.advance(HOUR);
  assert.deepEqual(statuses(await flood(d, 3, { ip: (i) => `198.53.${i}.1`, slots })), { 429: 3 });
  assert.equal(paused().length, 1, "still the same 24 h window");
  assert.equal(push.deliveries.filter((x) => x.payload && x.payload.title === "Ny time").length, 40);
});

test("rate limit: no key in any store holds the customer's phone number or IP address", async () => {
  const d = testDeps({ now: NOW });
  const slots = allSlots();
  for (const [ip, phone] of [["62.249.1.7", "987 65 432"], ["2a01:79c:cebd:1000::7", "+47 41 23 45 67"], ["::ffff:84.210.9.9", "0047 22 33 44 55"]]) {
    assert.equal((await read(await handle(post(body(slots.next().value, phone)), from(ip), d))).status, 201);
  }
  const keys = [...d.blobs.stores.keys()].flatMap((s) => d.blobs.keys(s));
  assert.ok(keys.some((k) => k.startsWith("rl/b/ip/")) && keys.some((k) => k.startsWith("rl/b/phone/")), keys.join(" "));
  for (const k of keys) {
    for (const secret of ["98765432", "41234567", "22334455", "62.249", "2a01", "cebd", "84.210"]) assert.ok(!k.includes(secret), `${k} holds ${secret}`);
    assert.doesNotMatch(k, /\d{8}|\d{1,3}\.\d{1,3}\.\d{1,3}/, k);
  }
  // round 3: the name inside a bucket is the keyed hash too, so no counter document holds the number or the address
  for (const k of d.blobs.keys("bookings").filter((x) => x.startsWith("rl/b/"))) {
    const text = d.blobs.text("bookings", k);
    for (const secret of ["98765432", "41234567", "22334455", "62.249", "2a01", "cebd", "84.210"]) assert.ok(!text.includes(secret), `${k} holds ${secret}`);
  }
  // the keyed hash is the same for the same value, differs per kind, and is never the value itself
  const secret = await limiterSecret(live(d));
  assert.deepEqual(counterRef(secret, "phone", "98765432"), counterRef(secret, "phone", "98765432"));
  assert.notEqual(counterRef(secret, "phone", "98765432").name, counterRef(secret, "ip", "98765432").name);
  assert.match(counterRef(secret, "phone", "98765432").key, /^rl\/b\/phone\/[0-9a-f]$/);
  assert.match(counterRef(secret, "phone", "98765432").name, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(d.blobs.json("bookings", "rl/secret").k, secret);
});

// ---------- Round 2: a client-chosen requestId is only a replay of the request it was made for ----------
// Guard rule (SPEC R5): an idempotency key from the client counts as a replay only when the server's fingerprint
// of the request (requestId + date + start + phone) matches. Reused with another fingerprint it is a new, counted
// attempt. Test rule: for every per-client cap, an adversarial loop varies each client-controlled field one at a
// time while the others stay fixed, and at most 5 bookings per hour are ever stored from one client.
const RID = "AAAAAAAAAAAA";
const webItems = (d) => storedItems(d.blobs).filter((x) => x.source === "nettside");

test("rate limit: one requestId reused for 100 different slots from one client stops at the client cap (5 counted, then 429)", async () => {
  const d = testDeps({ now: NOW });
  const slots = allSlots();
  const out = [];
  for (let i = 0; i < 100; i++) {
    out.push(await read(await handle(post({ ...body(slots.next().value, "40000000"), requestId: RID }), from("198.51.100.9"), d)));
  }
  // The first is stored; a reuse in the same month is refused (409 request_reused), and every attempt is counted
  assert.deepEqual(statuses(out), { 201: 1, 409: 4, 429: 95 });
  assert.ok(out.filter((r) => r.status === 409).every((r) => r.body.code === "request_reused"), JSON.stringify(out.map((r) => r.body.code)));
  assert.equal(webItems(d).length, 1);
  assert.equal(hits(d, await keyOf(d, "ip", "198.51.100.9")), 5);
});

test("rate limit: adversarial loop - varying one client-controlled field at a time never stores more than 5 per hour from one client", async () => {
  // Each variant: what changes from one request to the next. The slot always changes (a new booking needs one).
  const variants = {
    "same requestId, same phone/name/service": (i) => ({ requestId: RID }),
    "same requestId, new phone each time": (i) => ({ requestId: RID, phone: mobile(i) }),
    "same requestId, new service each time": (i) => ({ requestId: RID, service: i % 2 ? "Herreklipp" : "Barneklipp" }),
    "same requestId, new name each time": (i) => ({ requestId: RID, name: "Flom " + i }),
    "new requestId each time": (i) => ({ requestId: "rq_flood_" + String(i).padStart(4, "0") }),
    "no requestId": () => ({}),
  };
  for (const [label, vary] of Object.entries(variants)) {
    const d = testDeps({ now: NOW });
    const slots = allSlots();
    const out = [];
    for (let i = 0; i < 30; i++) {
      out.push(await read(await handle(post({ ...body(slots.next().value, "40000000"), ...vary(i) }), from("198.51.100.9"), d)));
    }
    assert.ok(webItems(d).length <= 5, `${label}: ${webItems(d).length} stored`);
    assert.ok((statuses(out)[201] || 0) <= 5, `${label}: ${JSON.stringify(statuses(out))}`);
  }
});

test("rate limit: the same requestId on a taken slot after a stored booking leaves that booking's phone and global hits in place", async () => {
  const d = testDeps({ now: NOW });
  seedItems(d.blobs, [item({ date: "2026-11-13", start: 660, name: "Tatt" })]);
  const first = await read(await handle(post({ ...body({ date: "2026-11-13", start: 600 }, "40000000"), requestId: RID }), from("198.51.100.9"), d));
  assert.equal(first.status, 201);
  const phoneKeyOf = await keyOf(d, "phone", "40000000");
  assert.deepEqual([hits(d, phoneKeyOf), hits(d, ALL_KEY)], [1, 1]);
  const taken = await read(await handle(post({ ...body({ date: "2026-11-13", start: 660 }, "40000000"), requestId: RID }), from("198.51.100.9"), d));
  assert.equal(taken.status, 409);
  assert.deepEqual([hits(d, phoneKeyOf), hits(d, ALL_KEY)], [1, 1], "the stored booking still counts");
});

test("rate limit: an honest replay (the same body twice) is still 201, 201 with one booking and one hit", async () => {
  const d = testDeps({ now: NOW });
  const b = { ...body({ date: "2026-11-13", start: 600 }, "40000000"), requestId: RID };
  const a1 = await read(await handle(post(b), from("198.51.100.9"), d));
  const a2 = await read(await handle(post(b), from("198.51.100.9"), d));
  assert.deepEqual([a1.status, a2.status], [201, 201]);
  assert.equal(a2.body.booking.id, a1.body.booking.id);
  assert.equal(webItems(d).length, 1);
  assert.equal(hits(d, await keyOf(d, "ip", "198.51.100.9")), 1);
  assert.equal(hits(d, await keyOf(d, "phone", "40000000")), 1);
  assert.equal(hits(d, ALL_KEY), 1);
});

// Fix-up round 2 (taken-slot-same-reqid.mjs): with one fixed requestId, a taken slot could be retried without limit
// (300 x 409, never 429), each try writing rl/all twice: the kept IP hit carried the requestId-derived token, so every
// identical try was «already counted». Rule: only a request whose earlier attempt may have stored a booking is exempt
// from counting; a taken slot re-keys the kept hit, so the next identical try counts as a new attempt.
test("rate limit: 300 identical requests (same body and requestId) on a taken slot from one address stop at the client cap, with rl/all writes bounded", async () => {
  const d = testDeps({ now: NOW });
  seedItems(d.blobs, [item({ date: "2026-11-13", start: 600, name: "Tatt" })]);
  const b = { ...body({ date: "2026-11-13", start: 600 }, "40000001"), requestId: RID };
  const from0 = d.blobs.log.length;
  const rs = [];
  for (let i = 0; i < 300; i++) rs.push(await read(await handle(post(b), from("198.51.100.66"), d)));
  assert.deepEqual(statuses(rs), { 409: 5, 429: 295 });
  const allWrites = d.blobs.log.slice(from0).filter((e) => e.key === ALL_KEY && (e.method === "PUT" || e.method === "DELETE")).length;
  assert.ok(allWrites <= 10, `${allWrites} writes to rl/all`);
  assert.equal(hits(d, await keyOf(d, "ip", "198.51.100.66")), 5, "five counted attempts, each with its own id");
});

// Fix-up round 2, abuse-suite rule (SPEC R34): a refused request (any 429) leaves zero new keys and writes nothing,
// also now that a refused request with a requestId looks for a stored replay first (a read only).
test("rate limit: a 429 (the client cap) with or without a requestId writes nothing and leaves zero new keys", async () => {
  const d = testDeps({ now: NOW });
  const slots = allSlots();
  const ip = "198.51.100.77";
  for (let i = 0; i < 5; i++) assert.equal((await read(await handle(post(body(slots.next().value, mobile(i))), from(ip), d))).status, 201);
  const keys = JSON.stringify(d.blobs.keys("bookings"));
  const from0 = d.blobs.log.length;
  for (const extra of [{}, { requestId: "refused-req-01" }]) {
    const r = await read(await handle(post({ ...body(slots.next().value, mobile(50)), ...extra }), from(ip), d));
    assert.equal(r.status, 429);
  }
  assert.deepEqual(d.blobs.log.slice(from0).filter((e) => e.method === "PUT" || e.method === "DELETE"), []);
  assert.equal(JSON.stringify(d.blobs.keys("bookings")), keys);
});
