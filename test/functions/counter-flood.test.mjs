// Round 3 (audit round 2: counter-flood-retention.mjs, counter-flood.mjs, counter-48h.test.mjs, retention-flood.mjs).
// personvern.html promises that every attempt the abuse counters store is deleted «senest etter 48 timer». Before
// round 3 every counted attempt from a new client (a wrong login, a 409 on a taken slot) left one document, so the
// number of documents was up to the attacker: 9 600 wrong logins a day from 9 600 IPv6 /64s (the shared cap is 100
// per 15 min) outgrew what the 20-s nightly clean-up could delete, counters lived for days, and a customer's phone
// counter (rl/phone/* sorts last) was always the one left behind.
//
// Guard rule (SPEC R44): every retention period a page states holds under the worst case the public endpoints allow.
// The counter documents are a fixed set by construction (2 shared + BUCKETS per kind, at most BUCKET_MAX_HITS hits
// each), so the clean-up's work does not depend on traffic. This file drives the real handlers at the most the
// limits let through, from distinct /64s, for three simulated days, runs the real clean-up at midnight UTC with every
// Blobs call taking 50 ms on the virtual clock (concurrent calls add up: the pessimistic case), and requires after
// every run: no stored hit older than 24 h, nothing left for the next night, the run inside the budget, and the
// documents still the fixed set. Collisions in a bucket never block a real customer: clients and numbers are counted
// apart by their keyed hash, and a bucket that is full drops its oldest hits (fewer refusals, never more).
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDeps, request, read, quiet, PRODUCTION } from "../helpers/deps.mjs";
import { FakeBlobs } from "../helpers/fake-blobs.mjs";
import { FakeClock, oslo } from "../helpers/clock.mjs";
import { storedItems, counterHits } from "../helpers/bookings.mjs";
import { COUNTER_MAX_AGE_MS } from "../../netlify/lib/store-keys.mjs";
import {
  BUCKETS, BUCKET_MAX_HITS, LOGIN_LIMITS, BOOKING_LIMITS, counterRef, clientKey, phoneKey, limiterSecret, bookingToken, take,
} from "../../netlify/lib/limits.mjs";
import * as admin from "../../netlify/functions/admin.mjs";
import * as bookings from "../../netlify/functions/bookings.mjs";
import * as retention from "../../netlify/functions/retention.mjs";

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const PASSWORD = "fake-admin-password";
const live = (d) => d.getStore({ name: "bookings", consistency: "strong" });
const rlDocs = (blobs) => blobs.keys("bookings").filter((k) => k.startsWith("rl/") && k !== "rl/secret");
const allHits = (blobs) => rlDocs(blobs).flatMap((k) => ((blobs.json("bookings", k) || {}).hits || []).map((h) => ({ ...h, key: k })));
// The fixed set: one shared document each for web bookings and logins, and BUCKETS documents per counted kind
const MAX_DOCS = 2 + 3 * BUCKETS;
const book = (d, json, ip) => bookings.handle(request("/api/bookings", { method: "POST", json }), { ...PRODUCTION, ip }, d).then(read);
const login = (d, password, ip) => admin.handle(request("/api/admin/login", { method: "POST", json: { password } }), { ...PRODUCTION, ip }, d).then(read);
const runRetention = (d) => retention.handle(request("/.netlify/functions/retention", { method: "POST", json: {} }), PRODUCTION, d).then(read);

test("counter flood: three days of the most wrong logins the limits allow and 5 000 taken-slot 409s, each from a new /64: after every nightly run at 50 ms per call no hit is older than 24 h, nothing is left over, and the documents stay a fixed set", async (t) => {
  const out = quiet(t);
  const lat = { ms: 0 };
  const clock = new FakeClock("2026-11-16T00:00:00Z"); // Monday; @daily runs at midnight UTC
  const blobs = new FakeBlobs({ clock, latencyMs: () => lat.ms });
  const d = testDeps({ clock, blobs, env: { ADMIN_PASSWORD: PASSWORD } });
  const start = clock.now();

  // A real customer books on Monday 09:00 (Oslo) before the flood
  clock.set(oslo("2026-11-16", 9, 0).getTime());
  const kari = { service: "Herreklipp", date: "2026-11-18", start: 600, addons: [], name: "Kari", phone: "912 34 567", requestId: "kari-request-01" };
  assert.equal((await book(d, kari, "84.210.20.30")).status, 201);
  const kariToken = bookingToken(await limiterSecret(live(d)), kari);
  const kariHits = () => allHits(blobs).filter((h) => h.id === kariToken);
  assert.equal(kariHits().length, 3, "her client, phone and the shared counter each hold her hit");

  const runs = [];
  let logins = 0, n409 = 0;
  for (let day = 0; day < 3; day++) {
    const dayStart = start + day * DAY;
    // The shared login cap is 100 per 15 min: one wrong password every 9 s, each from a new /64, all day long
    for (let i = 0; i < DAY / 9000; i++) {
      clock.set(dayStart + i * 9000);
      const r = await login(d, "gjett" + logins, `2001:db8:${(logins >> 16).toString(16)}:${(logins & 0xffff).toString(16)}::1`);
      assert.equal(r.status, 401, `login ${logins}: ${JSON.stringify(r.body)}`);
      logins++;
      // On Monday at 12:00 (Oslo) a cheap one-off flood: 5 000 posts on Kari's taken time from 5 000 /64s
      if (day === 0 && dayStart + i * 9000 === oslo("2026-11-16", 12, 0).getTime()) {
        for (let k = 0; k < 5000; k++) {
          const r2 = await book(d, { ...kari, name: "Flom", phone: "4" + String(1000000 + k), requestId: undefined }, `2a01:79c:${k.toString(16)}:1::1`);
          assert.equal(r2.status, 409, `409 ${k}: ${JSON.stringify(r2.body)}`);
          n409++;
        }
      }
    }
    blobs.log.length = 0; // keep memory flat over the three days
    // Midnight UTC: the daily clean-up, every Blobs call 50 ms on the virtual clock
    clock.set(dayStart + DAY);
    const runAt = clock.now();
    lat.ms = 50;
    const res = await runRetention(d);
    const took = clock.now() - runAt;
    lat.ms = 0;
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const old = allHits(blobs).filter((h) => runAt - h.t > COUNTER_MAX_AGE_MS);
    runs.push({ day, took, unfinished: res.body.unfinished, docs: rlDocs(blobs).length, hits: allHits(blobs).length, old: old.length });
    assert.equal(res.body.unfinished, 0, `night ${day + 1}: nothing left for the next night: ${JSON.stringify(runs)}`);
    assert.ok(took < retention.BUDGET_MS, `night ${day + 1} took ${took / 1000} s`);
    assert.deepEqual(old, [], `night ${day + 1}: no hit more than 24 h old`);
    assert.ok(rlDocs(blobs).length <= MAX_DOCS, `night ${day + 1}: ${rlDocs(blobs).length} counter documents (fixed set: ${MAX_DOCS})`);
    if (day === 0) assert.equal(kariHits().length, 3, "16 h after her booking her hits are still counted");
    if (day === 1) assert.deepEqual(kariHits(), [], "40 h after her booking every hit of hers is gone (stated: at the latest 48 h)");
  }
  assert.equal(logins, 3 * 9600);
  assert.equal(n409, 5000);
  assert.equal(storedItems(blobs).length, 1, "only Kari's booking is stored");
  assert.ok(!out.log.some((a) => /stoppet/i.test(String(a[0]))), "no run says it stopped early");
});

// Clients and numbers that land in the same bucket are still counted apart: one client's cap never refuses another.
test("counter flood: two clients in the same bucket each get their own 5 per hour, and two phones in one bucket their own 6 per 24 h", async () => {
  const d = testDeps({ now: oslo("2026-11-16", 9, 0) });
  const secret = await limiterSecret(live(d));
  const sameBucket = (kind, make, key) => {
    const first = make(0);
    for (let i = 1; i < 10000; i++) if (counterRef(secret, kind, key(make(i))).key === counterRef(secret, kind, key(first)).key) return [first, make(i)];
    throw new Error("no pair");
  };
  const [ipA, ipB] = sameBucket("ip", (i) => `203.0.${i >> 8}.${i & 255}`, clientKey);
  const slots = [];
  for (let day = 17; day <= 21; day++) for (let start = 600; start < 900; start += 30) slots.push({ date: `2026-11-${day}`, start });
  let s = 0;
  const one = (ip, phone) => book(d, { service: "Herreklipp", ...slots[s++], addons: [], name: "Kunde", phone }, ip);
  const a = [];
  for (let i = 0; i < 6; i++) a.push((await one(ipA, "9" + String(1000000 + i))).status);
  assert.deepEqual(a, [201, 201, 201, 201, 201, 429], "client A: 5 per hour");
  const b = [];
  for (let i = 0; i < 6; i++) b.push((await one(ipB, "9" + String(2000000 + i))).status);
  assert.deepEqual(b, [201, 201, 201, 201, 201, 429], "client B in A's bucket: its own 5 per hour");

  const d2 = testDeps({ now: oslo("2026-11-16", 9, 0) });
  const secret2 = await limiterSecret(live(d2));
  let p = null;
  for (let i = 1; i < 10000 && !p; i++) {
    const x = "4" + String(1000000 + i);
    if (counterRef(secret2, "phone", phoneKey(x)).key === counterRef(secret2, "phone", phoneKey("41000000")).key) p = x;
  }
  s = 0;
  const two = (phone, i) => book(d2, { service: "Herreklipp", ...slots[s++], addons: [], name: "Kunde", phone }, `198.51.${i}.1`);
  const pa = [], pb = [];
  for (let i = 0; i < 7; i++) pa.push((await two("41000000", i)).status);
  for (let i = 0; i < 7; i++) pb.push((await two(p, 100 + i)).status);
  assert.deepEqual(pa, [201, 201, 201, 201, 201, 201, 429], "phone A: 6 per 24 h");
  assert.deepEqual(pb, [201, 201, 201, 201, 201, 201, 429], "phone B in A's bucket: its own 6 per 24 h");
});

// A shared bucket means concurrent writers on one document (ETag retries). It must not block real customers more than
// one document per client did: every booking already writes the one shared document rl/all, so a bucket (1/16 of the
// clients) is never the hotter document. 12 customers on 12 addresses in one bucket, all at once, all get 201.
test("counter flood: 12 customers on 12 addresses that share one bucket book at the same moment and all get 201", async (t) => {
  quiet(t);
  const clock = new FakeClock(oslo("2026-11-16", 9, 0).toISOString());
  const blobs = new FakeBlobs({ clock, latencyMs: 30 });
  const d = testDeps({ clock, blobs });
  const secret = await limiterSecret(live(d));
  const target = counterRef(secret, "ip", "203.0.0.0").key;
  const ips = [];
  for (let i = 0; ips.length < 12; i++) if (counterRef(secret, "ip", clientKey(`203.0.${i >> 8}.${i & 255}`)).key === target) ips.push(`203.0.${i >> 8}.${i & 255}`);
  const rs = await Promise.all(ips.map((ip, i) => book(d, { service: "Herreklipp", date: "2026-11-18", start: 600 + 30 * i, addons: [], name: "Kunde", phone: "9" + String(1000000 + i) }, ip)));
  assert.deepEqual(rs.map((r) => r.status), Array(12).fill(201), JSON.stringify(rs.map((r) => r.body)));
  assert.equal(new Set(counterHits(blobs, target).map((h) => h.k)).size, 12, "one bucket, twelve clients counted apart");
});

// A bucket holds at most BUCKET_MAX_HITS hits. When a flood fills it, the oldest hits go first: a looping client's
// recent hits stay (its cap still holds), and nobody is ever refused because of the cap on the document.
test("counter flood: a full bucket drops its oldest hits first, keeps the newest client's, and never refuses a new client", async () => {
  const d = testDeps({ now: "2026-11-16T12:00:00Z" });
  const store = live(d);
  const secret = await limiterSecret(store);
  const nowMs = d.clock.now();
  const ref = counterRef(secret, "ip", "198.51.100.200");
  const filler = Array.from({ length: BUCKET_MAX_HITS }, (_, i) => ({ t: nowMs - HOUR + i, id: "f" + i, k: "x" + String(i).padStart(21, "0") }));
  d.blobs.seed("bookings", ref.key, { hits: filler });
  for (let i = 0; i < 5; i++) assert.equal((await take(store, ref, BOOKING_LIMITS.ip, { nowMs: nowMs + i, token: "own" + i })).ok, true, `attempt ${i}`);
  const r6 = await take(store, ref, BOOKING_LIMITS.ip, { nowMs: nowMs + 10, token: "own5" });
  assert.deepEqual([r6.ok, r6.limited], [false, true], "the looping client's own cap still holds in a full bucket");
  const doc = d.blobs.json("bookings", ref.key);
  assert.equal(doc.hits.length, BUCKET_MAX_HITS, "never more than the cap");
  assert.deepEqual(doc.hits.slice(-5).map((h) => h.id), ["own0", "own1", "own2", "own3", "own4"]);
  assert.deepEqual(doc.hits.slice(0, 2).map((h) => h.id), ["f5", "f6"], "the five oldest went");
  // A login flood can never fill a login bucket: pruned to the 15-min window, the shared cap lets 100 through
  assert.equal(LOGIN_LIMITS.all[0].max, 100);
  assert.ok(BUCKET_MAX_HITS > 10 * LOGIN_LIMITS.all[0].max);
});
