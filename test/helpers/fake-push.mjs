// A fake Web Push service (RFC 8030) and fake browser subscriptions for tests. Nothing here uses the network:
// the push service is a fakeFetch (test/helpers/fake-fetch.mjs), so any other URL still throws.
//
//   const phone = makeDevice("apple");               // a browser's subscription: its own P-256 key pair + auth secret
//   phone.subscription                                // what PushSubscription.toJSON() gives: { endpoint, expirationTime, keys }
//   phone.decrypt(bytes)                              // RFC 8291 receiver: the plaintext Buffer (throws if anything is off)
//   const push = fakePushService({ devices: [phone], reply: (delivery) => 201 });
//   push.fetch                                        // answers the push hosts below; give it to testDeps({ fetch })
//   push.deliveries → [{ url, method, headers, bytes, device, payload, error, vapid }]
//                     payload: the decrypted JSON; error: why decrypting failed; vapid: verifyVapid(Authorization)
//   reply(delivery, call) returns a status (201 = accepted), a Response, or a promise of one (a hang).
//
// The receiver side (decryptPushMessage, verifyVapid) is written from the RFCs with plain HMAC, independently of
// netlify/lib/push.mjs, and checked against the worked example in RFC 8291 section 5 (fake-push.test.mjs).
import { createECDH, createHmac, createDecipheriv, createPublicKey, verify, randomBytes } from "node:crypto";
import { fakeFetch } from "./fake-fetch.mjs";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");

// RFC 8291 section 5: the example push message and every input to it (base64url, as printed in the RFC)
export const RFC8291_EXAMPLE = Object.freeze({
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivateKey: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublicKey: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivateKey: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublicKey: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  message: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
});

// HKDF (RFC 5869) with HMAC-SHA-256, for outputs of at most 32 octets: Extract, then one block of Expand
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const hkdf = (salt, ikm, info, length) => hmac(hmac(salt, ikm), Buffer.concat([Buffer.from(info), Buffer.from([1])])).subarray(0, length);

// The receiving browser's side of RFC 8291 (Message Encryption for Web Push) over RFC 8188 (aes128gcm).
// keys: { privateKey, publicKey, auth } of the subscription (Buffers). Returns the plaintext.
export function decryptPushMessage(body, { privateKey, publicKey, auth }) {
  const buf = Buffer.from(body || []);
  if (buf.length < 21) throw new Error("shorter than the aes128gcm header (RFC 8188 2.1)");
  const salt = buf.subarray(0, 16);
  const rs = buf.readUInt32BE(16);
  const idlen = buf[20];
  if (idlen !== 65) throw new Error(`keyid is ${idlen} octets; RFC 8291 3.1 requires the 65-octet uncompressed sender key`);
  const senderKey = buf.subarray(21, 86);
  if (senderKey[0] !== 4) throw new Error("keyid is not an uncompressed P-256 point");
  const record = buf.subarray(86);
  if (rs < 18) throw new Error(`record size ${rs} is below the minimum of 18`);
  if (record.length > rs) throw new Error(`more than one record (${record.length} > rs ${rs}); RFC 8291 4 allows one`);
  if (record.length < 17) throw new Error("record shorter than the tag plus a delimiter");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateKey);
  const shared = ecdh.computeSecret(senderKey);
  // RFC 8291 3.3/3.4: the auth secret mixes into the key, and both public keys are bound into the info
  const ikm = hkdf(auth, shared, Buffer.concat([Buffer.from("WebPush: info\0"), publicKey, senderKey]), 32);
  // RFC 8188 2.2/2.3
  const cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = hkdf(salt, ikm, "Content-Encoding: nonce\0", 12); // record 0: the nonce itself (XOR 0)
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== 2) throw new Error("the last record must end with the 0x02 delimiter (RFC 8188 2)");
  return padded.subarray(0, end);
}

// RFC 8292 (VAPID): «Authorization: vapid t=<JWT>, k=<public key>». Checks the ES256 signature with k.
// Returns { ok, why, header, claims, k }.
export function verifyVapid(authorization) {
  const m = /^vapid\s+(.+)$/i.exec(String(authorization || ""));
  if (!m) return { ok: false, why: "not a vapid Authorization header" };
  const params = {};
  for (const part of m[1].split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  if (!params.t || !params.k) return { ok: false, why: "t= or k= is missing" };
  const parts = params.t.split(".");
  if (parts.length !== 3) return { ok: false, why: "the JWT does not have three parts" };
  let header, claims;
  try {
    header = JSON.parse(unb64u(parts[0]).toString("utf8"));
    claims = JSON.parse(unb64u(parts[1]).toString("utf8"));
  } catch { return { ok: false, why: "the JWT header or claims are not JSON" }; }
  const raw = unb64u(params.k);
  if (raw.length !== 65 || raw[0] !== 4) return { ok: false, why: "k is not a 65-octet uncompressed P-256 key", header, claims };
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: "jwk" });
  const sig = unb64u(parts[2]);
  const ok = header.alg === "ES256" && sig.length === 64 &&
    verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: "ieee-p1363" }, sig);
  return { ok, why: ok ? "" : "the ES256 signature does not verify with k", header, claims, k: params.k };
}

// Realistic endpoint shapes of the four push services
const ENDPOINTS = {
  fcm: (t) => `https://fcm.googleapis.com/fcm/send/f${t.slice(0, 10)}:APA91b${t}`,
  mozilla: (t) => `https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB${t}`,
  apple: (t) => `https://web.push.apple.com/QG${t}`,
  wns: (t) => `https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB${t}`,
};
export const PUSH_HOST = /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)\//;

// A browser's push subscription: a fresh P-256 key pair and auth secret, and an endpoint on the given service
export function makeDevice(kind = "fcm") {
  if (!ENDPOINTS[kind]) throw new Error(`makeDevice: unknown push service ${kind}`);
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey(), auth: randomBytes(16) };
  const endpoint = ENDPOINTS[kind](randomBytes(24).toString("hex"));
  return {
    kind,
    endpoint,
    ...keys,
    subscription: { endpoint, expirationTime: null, keys: { p256dh: b64u(keys.publicKey), auth: b64u(keys.auth) } },
    decrypt: (bytes) => decryptPushMessage(bytes, keys),
  };
}

const lowerKeys = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));

export function fakePushService({ devices = [], reply = () => 201 } = {}) {
  const deliveries = [];
  const fetch = fakeFetch([[(url) => PUSH_HOST.test(url), async (call) => {
    const headers = lowerKeys(call.headers);
    const device = devices.find((d) => d.endpoint === call.url) || null;
    const delivery = { url: call.url, method: call.method, headers, bytes: call.bytes, device, signal: call.signal };
    try {
      if (!device) throw new Error("no such subscription at this push service");
      delivery.payload = JSON.parse(device.decrypt(call.bytes).toString("utf8"));
    } catch (err) { delivery.error = err.message; }
    delivery.vapid = verifyVapid(headers.authorization);
    deliveries.push(delivery);
    const r = await reply(delivery, call);
    return typeof r === "number" ? new Response(r === 201 ? null : `status ${r}`, { status: r }) : r;
  }]]);
  return { fetch, deliveries, devices };
}

// A push service that does not answer until the test opens the gate (then with the given status)
export function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { open: (status = 201) => open(status), reply: () => opened };
}
