// The fake push service's receiver side must be right on its own, or the push tests prove nothing. Invariants:
//   1. decryptPushMessage turns the RFC 8291 section 5 example message into its plaintext, and refuses a message
//      that was changed anywhere, or opened with the wrong private key or auth secret;
//   2. verifyVapid accepts a correct ES256 VAPID JWT and refuses one signed with another key, with alg «none»,
//      or in a malformed header;
//   3. the fake service answers only the four push hosts; every other URL still fails like a dead network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { RFC8291_EXAMPLE as X, decryptPushMessage, verifyVapid, makeDevice, fakePushService, PUSH_HOST } from "./fake-push.mjs";

const unb64u = (s) => Buffer.from(s, "base64url");
const b64u = (b) => Buffer.from(b).toString("base64url");
const exampleKeys = () => ({ privateKey: unb64u(X.uaPrivateKey), publicKey: unb64u(X.uaPublicKey), auth: unb64u(X.authSecret) });

test("fake push: decrypts the RFC 8291 example message to its plaintext", () => {
  assert.equal(decryptPushMessage(unb64u(X.message), exampleKeys()).toString("utf8"), X.plaintext);
});

test("fake push: a changed byte, the wrong private key or the wrong auth secret is refused", () => {
  const msg = unb64u(X.message);
  for (const at of [0, 15, 21, 40, 86, 100, msg.length - 1]) {
    const bad = Buffer.from(msg);
    bad[at] ^= 0x01;
    assert.throws(() => decryptPushMessage(bad, exampleKeys()), undefined, `byte ${at}`);
  }
  const other = makeDevice();
  assert.throws(() => decryptPushMessage(msg, { ...exampleKeys(), privateKey: other.privateKey, publicKey: other.publicKey }));
  assert.throws(() => decryptPushMessage(msg, { ...exampleKeys(), auth: Buffer.alloc(16, 7) }));
  assert.throws(() => decryptPushMessage(msg.subarray(0, 50), exampleKeys()), /keyid|shorter|record/);
});

const vapidKey = () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  return { privateKey, k: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])) };
};
const jwt = (privateKey, header = { typ: "JWT", alg: "ES256" }, claims = { aud: "https://fcm.googleapis.com", exp: 1_800_000_000, sub: "https://viggos.test" }) => {
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  return `${input}.${b64u(sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }))}`;
};

test("fake push: verifyVapid accepts a correct ES256 VAPID header and refuses forgeries", () => {
  const a = vapidKey(), b = vapidKey();
  const good = verifyVapid(`vapid t=${jwt(a.privateKey)}, k=${a.k}`);
  assert.equal(good.ok, true, good.why);
  assert.equal(good.claims.aud, "https://fcm.googleapis.com");
  assert.equal(good.k, a.k);
  assert.equal(verifyVapid(`vapid t=${jwt(a.privateKey)}, k=${b.k}`).ok, false, "signed with another key");
  const none = `${b64u(JSON.stringify({ typ: "JWT", alg: "none" }))}.${b64u(JSON.stringify({ aud: "x" }))}.`;
  assert.equal(verifyVapid(`vapid t=${none}, k=${a.k}`).ok, false, "alg none");
  for (const h of [undefined, "", "Bearer abc", `vapid t=${jwt(a.privateKey)}`, `vapid k=${a.k}`, "vapid t=a.b, k=" + a.k, `WebPush ${jwt(a.privateKey)}`]) {
    assert.equal(verifyVapid(h).ok, false, String(h));
  }
});

test("fake push: answers only the push hosts; anything else fails like a dead network", async () => {
  const devices = ["fcm", "mozilla", "apple", "wns"].map(makeDevice);
  for (const d of devices) assert.match(d.endpoint, PUSH_HOST, d.kind);
  const push = fakePushService({ devices });
  const res = await push.fetch(devices[0].endpoint, { method: "POST", body: Buffer.from("x") });
  assert.equal(res.status, 201);
  assert.match(push.deliveries[0].error, /aes128gcm header/, "a body that is not a push message is recorded as such");
  for (const url of ["https://example.com/", "https://fcm.googleapis.com.evil.test/x", "http://fcm.googleapis.com/fcm/send/x"]) {
    await assert.rejects(push.fetch(url, { method: "POST" }), /no fake route/, url);
  }
});
