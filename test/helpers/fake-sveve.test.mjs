// The fake Sveve answers in the documented shapes, keeps an honest ledger of what reached phones (including
// SMS that went out although the caller saw an error), and its faults and latency run on the virtual clock.
import "./no-network.mjs";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeSveve, smsUnits, SVEVE_URL } from "./fake-sveve.mjs";
import { FakeClock } from "./clock.mjs";

const post = (sveve, body, init = {}) => sveve(SVEVE_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=UTF-8" },
  body: JSON.stringify({ user: "u", passwd: "p", from: "Viggos", f: "json", ...body }),
  ...init,
});
const response = async (res) => (await res.json()).response;

describe("fakeSveve", () => {
  test("delivers and answers { msgOkCount, stdSMSCount, ids }", async () => {
    const clock = new FakeClock("2026-11-12T09:00:00Z");
    const sveve = fakeSveve({ clock });
    const r = await response(await post(sveve, { to: "40963911", msg: "Hei" }));
    assert.equal(r.msgOkCount, 1);
    assert.equal(r.stdSMSCount, 1);
    assert.equal(r.ids.length, 1);
    assert.equal(r.fatalError, undefined);
    assert.deepEqual(sveve.sent.map(({ at, to, msg, from, units, encoding }) => ({ at, to, msg, from, units, encoding })),
      [{ at: clock.now(), to: "40963911", msg: "Hei", from: "Viggos", units: 1, encoding: "GSM-7" }]);
    assert.equal(sveve.to("40963911").length, 1);
    assert.equal(sveve.calls[0].outcome, "ok");
  });

  test("test:true is accepted but reaches no phone", async () => {
    const sveve = fakeSveve();
    const r = await response(await post(sveve, { to: "40963911", msg: "Hei", test: true }));
    assert.equal(r.msgOkCount, 1);
    assert.deepEqual([sveve.sent.length, sveve.dryRuns.length], [0, 1]);
  });

  test("bad credentials, bad sender, bad number, empty message and non-JSON are refused", async () => {
    const sveve = fakeSveve({ user: "u", passwd: "p" });
    assert.match((await response(await post(sveve, { to: "40963911", msg: "x", passwd: "nope" }))).fatalError, /passord/);
    assert.ok((await response(await post(sveve, { to: "40963911", msg: "x", from: "Viggos Barber" }))).fatalError, "12 chars");
    assert.ok((await response(await post(sveve, { to: "40963911", msg: "x", from: "Viggø" }))).fatalError, "æøå");
    assert.ok((await response(await post(sveve, { to: "40963911", msg: "" }))).fatalError);
    const bad = await response(await post(sveve, { to: "+47 409 63 911", msg: "x" }));
    assert.deepEqual([bad.msgOkCount, bad.errors.length], [0, 1]);
    const res = await post(sveve, { to: "40963911", msg: "x", f: "xml" });
    await assert.rejects(res.clone().json());
    assert.equal(sveve.sent.length, 0);
  });

  test("units: GSM-7 160/153, extension chars count 2, anything else is UCS-2 70/67", () => {
    assert.deepEqual(smsUnits("æøå ÆØÅ".repeat(20)), { encoding: "GSM-7", length: 140, units: 1 });
    assert.equal(smsUnits("a".repeat(160)).units, 1);
    assert.equal(smsUnits("a".repeat(161)).units, 2);
    assert.equal(smsUnits("a".repeat(306)).units, 2);
    assert.equal(smsUnits("€".repeat(80)).units, 1);
    assert.equal(smsUnits("€".repeat(81)).units, 2);
    assert.deepEqual(smsUnits("Hei «Ola»"), { encoding: "UCS-2", length: 9, units: 1 });
    assert.equal(smsUnits("x".repeat(70) + "’").units, 2);
  });

  test("faults: nothing sent for network-down, http, fatal, rejected", async () => {
    const sveve = fakeSveve();
    sveve.inject({ fault: "network-down" });
    await assert.rejects(post(sveve, { to: "40963911", msg: "x" }), TypeError);
    sveve.inject({ fault: "http", status: 503 });
    assert.equal((await post(sveve, { to: "40963911", msg: "x" })).status, 503);
    sveve.inject({ fault: "fatal" });
    assert.ok((await response(await post(sveve, { to: "40963911", msg: "x" }))).fatalError);
    sveve.inject({ fault: "rejected" });
    const r = await response(await post(sveve, { to: "40963911", msg: "x" }));
    assert.deepEqual([r.msgOkCount, r.errors[0].number], [0, "40963911"]);
    assert.equal(sveve.sent.length, 0);
    assert.deepEqual(sveve.calls.map((c) => c.outcome), ["network-down", "http_503", "fatal", "rejected"]);
  });

  test("faults: lost-response and timeout{sent:true} deliver although the caller sees an error", async () => {
    const clock = new FakeClock();
    const sveve = fakeSveve({ clock });
    sveve.inject({ fault: "lost-response" });
    await assert.rejects(post(sveve, { to: "40963911", msg: "a" }), TypeError);
    const t0 = clock.now();
    sveve.inject({ fault: "timeout", sent: true });
    await assert.rejects(post(sveve, { to: "40963911", msg: "b" }), { name: "AbortError" });
    assert.equal(clock.now() - t0, 8000, "the caller's 8 s timer, in virtual time");
    sveve.inject({ fault: "timeout", sent: false, latencyMs: 3000 });
    await assert.rejects(post(sveve, { to: "40963911", msg: "c" }), { name: "AbortError" });
    assert.deepEqual(sveve.sent.map((s) => s.msg), ["a", "b"]);
  });

  test("latency, skip, times and match select attempts; other URLs throw", async () => {
    const clock = new FakeClock();
    const sveve = fakeSveve({ clock, latencyMs: 100 });
    const slow = sveve.inject({ latencyMs: 5000, skip: 1, times: 1, match: (c) => c.body.to === "40963911" });
    const t0 = clock.now();
    await post(sveve, { to: "40963911", msg: "1" });
    await post(sveve, { to: "99999999", msg: "2" });
    await post(sveve, { to: "40963911", msg: "3" });
    await post(sveve, { to: "40963911", msg: "4" });
    assert.equal(clock.now() - t0, 4 * 100 + 5000);
    assert.equal(slow.hits, 1);
    await assert.rejects(sveve("https://sveve.no/SMS/Other", { method: "POST" }), /not the fake Sveve/);
    assert.throws(() => sveve.inject({ fault: "explode" }), /unknown fault/);
  });

  test("maxPerNumber counts the busiest sliding window", async () => {
    const clock = new FakeClock("2026-11-12T09:00:00Z");
    const sveve = fakeSveve({ clock });
    const H = 3600e3;
    for (const gap of [0, 2 * H, 2 * H, 21 * H, 1 * H]) { clock.advance(gap); await post(sveve, { to: "40963911", msg: "x" }); }
    await post(sveve, { to: "99999999", msg: "x" });
    assert.deepEqual(sveve.maxPerNumber(24 * H), { number: "40963911", count: 3 });
    assert.deepEqual(sveve.maxPerNumber(30 * H), { number: "40963911", count: 5 });
  });
});
