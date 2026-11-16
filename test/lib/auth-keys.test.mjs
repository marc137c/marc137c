// F34: nothing the server issues or stores may be a fast hash of ADMIN_PASSWORD. A token, a stored push/calendar
// "gen" or a device mark that is HMAC/SHA-256 of the password itself lets anyone who sees one (a log, a copied
// store, a screenshot of the calendar link's doc) test password guesses offline at billions per second.
// Invariants:
//   1. every key comes from one slow master key: scrypt(password, "viggos-admin-token-v1", N=16384, r=8, p=1),
//      with a separate HMAC subkey per purpose (tokens, device marks, gens);
//   2. a token verifies, but HMAC with SHA-256("viggos-admin:" + password), the old key, does not reproduce its
//      signature, and an old-style token is refused;
//   3. passwordGen differs from the old SHA-256("viggos-<purpose>:" + password) and is stable across calls;
//   4. tokens carry { exp, iat }; doc auth/epoch revokes every token issued before it: POST /api/admin/push/reset
//      bumps it, so a token issued earlier gets 401, and the reset reply carries a fresh token for the caller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, scryptSync } from "node:crypto";
import { testDeps, request, read, PRODUCTION } from "../helpers/deps.mjs";
import { makeDevice } from "../helpers/fake-push.mjs";
import {
  makeToken, readToken, verifyToken, passwordGen, masterKey, subkey, makeDeviceMark, verifyDeviceMark, EPOCH_KEY,
} from "../../netlify/lib/booking-core.mjs";
import * as admin from "../../netlify/functions/admin.mjs";

const PW = "fake-admin-password";
const NOW = Date.parse("2026-11-12T09:00:00Z");

test("auth keys: the master key is scrypt(password, 'viggos-admin-token-v1', N=16384, r=8, p=1), cached, with one subkey per purpose", () => {
  const expected = scryptSync(PW, "viggos-admin-token-v1", 32, { N: 16384, r: 8, p: 1 });
  assert.deepEqual(masterKey(PW), expected);
  assert.equal(masterKey(PW), masterKey(PW), "cached per password (the same Buffer)");
  assert.deepEqual(subkey(PW, "token"), createHmac("sha256", expected).update("token").digest());
  assert.notDeepEqual(subkey(PW, "token"), subkey(PW, "device"));
  assert.notDeepEqual(masterKey(PW), masterKey(PW + "x"));
});

test("auth keys: a token verifies, but the old SHA-256 key does not reproduce its signature", () => {
  const token = makeToken(PW, NOW, 3600e3);
  assert.equal(verifyToken(token, PW, NOW + 1), true);
  assert.deepEqual(readToken(token, PW, NOW + 1), { exp: NOW + 3600e3, iat: NOW });
  const [payload, sig] = token.split(".");
  const oldKey = createHash("sha256").update("viggos-admin:" + PW).digest();
  assert.notEqual(createHmac("sha256", oldKey).update(payload).digest("base64url"), sig);
  assert.equal(createHmac("sha256", subkey(PW, "token")).update(payload).digest("base64url"), sig);
  // An old-style token (signed with the fast key) is refused
  const old = `${payload}.${createHmac("sha256", oldKey).update(payload).digest("base64url")}`;
  assert.equal(verifyToken(old, PW, NOW + 1), false);
});

test("auth keys: a token without iat is refused, even with a valid signature", () => {
  const payload = Buffer.from(JSON.stringify({ exp: NOW + 3600e3 })).toString("base64url");
  const signed = `${payload}.${createHmac("sha256", subkey(PW, "token")).update(payload).digest("base64url")}`;
  assert.equal(readToken(signed, PW, NOW), null);
});

test("auth keys: passwordGen is not the old fast hash, differs per purpose and is stable", () => {
  for (const purpose of ["push", "calendar"]) {
    const gen = passwordGen(PW, purpose);
    assert.match(gen, /^[A-Za-z0-9_-]{16}$/);
    assert.notEqual(gen, createHash("sha256").update(`viggos-${purpose}:` + PW).digest("base64url").slice(0, 16));
    assert.equal(gen, createHmac("sha256", masterKey(PW)).update("gen:" + purpose).digest("base64url").slice(0, 16));
    assert.equal(passwordGen(PW, purpose), gen, "stable across calls");
    assert.notEqual(passwordGen(PW + "2", purpose), gen);
  }
  assert.notEqual(passwordGen(PW, "push"), passwordGen(PW, "calendar"));
  assert.equal(passwordGen("", "push"), null);
});

test("auth keys: a device mark uses its own subkey, so a token is not a device mark and back", () => {
  const mark = makeDeviceMark(PW, NOW);
  const token = makeToken(PW, NOW, 3600e3);
  assert.equal(verifyDeviceMark(mark, PW, NOW + 1), true);
  assert.equal(verifyDeviceMark(token, PW, NOW + 1), false, "a token is no device mark");
  assert.equal(verifyToken(mark, PW, NOW + 1), false, "a device mark is no token");
  const [payload, sig] = mark.split(".");
  assert.equal(createHmac("sha256", subkey(PW, "device")).update(payload).digest("base64url"), sig);
});

test("auth keys: after POST /api/admin/push/reset a token issued earlier gets 401, and the reset reply carries a fresh token", async () => {
  const d = testDeps({ now: "2026-11-12T09:00:00Z", env: { ADMIN_PASSWORD: PW } });
  const call = (path, token, json, method = "POST") =>
    admin.handle(request(path, { method, json, headers: { Authorization: "Bearer " + token } }), PRODUCTION, d).then(read);
  const login = (remember) => admin.handle(request("/api/admin/login", { method: "POST", json: { password: PW, remember } }), PRODUCTION, d).then(read);
  const other = (await login(true)).body.token;     // another device, logged in earlier
  d.clock.advance(60e3);
  const mine = (await login(false)).body.token;     // the barber's device, 12 h
  d.clock.advance(60e3);
  const reset = await call("/api/admin/push/reset", mine, {});
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.body.ok, true);
  assert.equal(reset.body.devices, 0);
  assert.equal(typeof reset.body.token, "string");
  const fresh = readToken(reset.body.token, PW, d.clock.now());
  assert.equal(fresh.iat, d.clock.now());
  assert.equal(fresh.exp, readToken(mine, PW, d.clock.now()).exp, "the fresh token ends when the caller's login would have");
  assert.deepEqual(d.blobs.json("bookings", EPOCH_KEY), { t: d.clock.now() });
  d.clock.advance(1);
  const sub = { subscription: makeDevice("apple").subscription };
  assert.equal((await call("/api/admin/push", other, undefined, "GET")).status, 401);
  assert.equal((await call("/api/admin/push/subscribe", other, sub)).status, 401, "the other device's token is revoked");
  assert.equal((await call("/api/admin/push/subscribe", mine, sub)).status, 401, "the caller's old token too");
  assert.equal((await call("/api/admin/push", reset.body.token, undefined, "GET")).status, 200);
  assert.equal((await call("/api/admin/push/subscribe", reset.body.token, sub)).status, 201, "the fresh token works");
  // A new login after the reset works as usual
  assert.equal((await call("/api/admin/items", (await login(true)).body.token, undefined, "GET")).status, 200);
});
