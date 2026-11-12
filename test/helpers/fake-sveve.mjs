// A fake Sveve (https://sveve.no/SMS/SendMessage) for tests. It IS a fetch function, so it can be passed as
// deps.fetch (testDeps({ fetch: sveve })) or as sendSms's fetchFn. Any other URL throws: tests never use the
// network. It speaks the JSON API from the sveve.no docs:
//   request   POST JSON { user, passwd, to, msg, from, f: "json", test }
//   response  { response: { msgOkCount, stdSMSCount, ids, errors: [{ number, message }], fatalError } }
// and keeps a ledger of what a real Sveve would have put on someone's phone, so tests can state invariants
// over everything that was delivered ("no number gets more than N SMS per 24 h", "never at night"):
//   sveve.sent      every SMS that reached a phone: { at, to, msg, from, units, encoding, id }
//   sveve.dryRuns   accepted with test:true (Sveve sends nothing): same shape
//   sveve.calls     every HTTP attempt: { at, url, method, headers, body (parsed JSON), outcome }
//   sveve.to("40963911")            → sent to that number
//   sveve.maxPerNumber(24 * 3600e3) → { number, count }: the most SMS any number got inside any window that long
//
// Things the docs leave open are handled strictly (marked "fake assumption"), so code that passes here sends
// nothing a real Sveve could refuse: the sender must be 1–11 characters without æøå, and each recipient must
// be 8–15 digits with nothing else (the docs do not say which number formats Sveve accepts).
//
// Faults apply per HTTP attempt (like FakeBlobs.inject):
//   sveve.inject({ fault: "network-down" })            connection refused: nothing sent, fetch rejects
//   sveve.inject({ fault: "http", status: 503 })       HTTP error page: nothing sent
//   sveve.inject({ fault: "fatal" })                   { fatalError } (wrong password, no credit): nothing sent
//   sveve.inject({ fault: "rejected" })                errors[] for every number: nothing sent
//   sveve.inject({ fault: "lost-response" })           SENT, then the connection drops: fetch rejects
//   sveve.inject({ fault: "timeout", sent: true })     the caller's timer fires after latencyMs (default 8000 ms of
//                                                      virtual time): fetch rejects with an AbortError; sent says
//                                                      whether Sveve had already delivered the SMS
//   sveve.inject({ latencyMs: 7000 })                  slow but fine, on the virtual clock
// Rule fields: fault, status, message, sent, latencyMs, skip (let n matching attempts through first),
// times (default 1; Infinity = until cleared), match(call). inject() returns the rule; rule.hits counts hits.
// latencyMs (option or rule) moves the shared FakeClock, so a time budget measured on deps.now() sees it.
import { FakeClock } from "./clock.mjs";

export const SVEVE_URL = "https://sveve.no/SMS/SendMessage";
const FAULTS = new Set(["network-down", "http", "fatal", "rejected", "lost-response", "timeout"]);

// GSM 03.38: the basic set costs 1 septet, the extension set 2 (escape + char). Anything else makes the whole
// message UCS-2. One SMS = 160 GSM-7 septets or 70 UCS-2 chars; longer messages are split into parts of 153 / 67.
const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENSION = "^{}\\[~]|€\f";

export function smsUnits(msg) {
  let septets = 0;
  for (const ch of String(msg)) {
    if (GSM_BASIC.includes(ch)) septets += 1;
    else if (GSM_EXTENSION.includes(ch)) septets += 2;
    else {
      const len = String(msg).length; // UTF-16 code units
      return { encoding: "UCS-2", length: len, units: len <= 70 ? 1 : Math.ceil(len / 67) };
    }
  }
  return { encoding: "GSM-7", length: septets, units: septets <= 160 ? 1 : Math.ceil(septets / 153) };
}

const headerObject = (h) => {
  if (!h) return {};
  if (typeof h.forEach === "function" && !Array.isArray(h)) { const o = {}; h.forEach((v, k) => { o[k] = v; }); return o; }
  return Array.isArray(h) ? Object.fromEntries(h) : { ...h };
};

const abortError = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
const networkError = (message, code) => new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });

export function fakeSveve({ clock = new FakeClock(), user, passwd, latencyMs = 0 } = {}) {
  const sent = [];
  const dryRuns = [];
  const calls = [];
  let faults = [];
  let nextId = 42824000;

  const takeFault = (call) => {
    for (const r of faults) {
      if (r.hits >= r.times) continue;
      if (r.match && !r.match(call)) continue;
      if (r.skipped < r.skip) { r.skipped++; continue; }
      r.hits++;
      return r;
    }
    return undefined;
  };

  // What Sveve does with a well-formed request: validate, then deliver (or only pretend, with test:true).
  const serve = (body, call) => {
    if (!body || typeof body !== "object") return { fatalError: "Ugyldig forespørsel" };
    if (!body.user || !body.passwd || (user !== undefined && body.user !== user) || (passwd !== undefined && body.passwd !== passwd)) {
      return { fatalError: "Feil brukernavn/passord" };
    }
    if (typeof body.msg !== "string" || body.msg === "") return { fatalError: "Meldingen mangler" };
    if (body.from !== undefined && (typeof body.from !== "string" || body.from.length < 1 || body.from.length > 11 || /[æøåÆØÅ]/.test(body.from))) {
      return { fatalError: "Ugyldig avsender" }; // fake assumption: the docs only say max 11 chars, no æøå
    }
    const numbers = String(body.to ?? "").split(",").map((n) => n.trim()).filter(Boolean);
    if (!numbers.length) return { fatalError: "Mottaker mangler" };
    const errors = [];
    const ids = [];
    const { units, encoding } = smsUnits(body.msg);
    const dry = body.test === true || String(body.test).toLowerCase() === "true";
    for (const number of numbers) {
      if (!/^\d{8,15}$/.test(number)) { errors.push({ number, message: "Ugyldig mottakernummer" }); continue; } // fake assumption
      const id = ++nextId;
      ids.push(id);
      (dry ? dryRuns : sent).push({ at: clock.now(), to: number, msg: body.msg, from: body.from, units, encoding, id });
    }
    call.delivered = dry ? 0 : ids.length;
    const r = { msgOkCount: ids.length, stdSMSCount: ids.length * units, ids };
    if (errors.length) r.errors = errors;
    return r;
  };

  const fetch = async (input, init = {}) => {
    const url = String(input && typeof input === "object" && "url" in input && !(input instanceof URL) ? input.url : input);
    if (url.split("?")[0] !== SVEVE_URL) throw new TypeError(`fetch failed: ${url} is not the fake Sveve (tests never use the network)`);
    const text = init.body == null ? "" : typeof init.body === "string" ? init.body : Buffer.from(init.body).toString();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    const call = { at: clock.now(), url, method: String(init.method || "GET").toUpperCase(), headers: headerObject(init.headers), body, delivered: 0 };
    calls.push(call);
    const fault = takeFault(call);
    const wait = (fault?.fault === "timeout" ? fault.latencyMs ?? 8000 : fault?.latencyMs ?? 0) + latencyMs;
    if (wait > 0) await clock.sleep(wait);
    if (init.signal?.aborted) { call.outcome = "aborted"; throw abortError(); }
    switch (fault?.fault) {
      case "network-down":
        call.outcome = "network-down";
        throw networkError("connect ECONNREFUSED", "ECONNREFUSED");
      case "http":
        call.outcome = `http_${fault.status ?? 500}`;
        return new Response(fault.message ?? "Service Unavailable", { status: fault.status ?? 500 });
      case "fatal":
        call.outcome = "fatal";
        return Response.json({ response: { fatalError: fault.message ?? "Feil brukernavn/passord" } });
      case "rejected": {
        call.outcome = "rejected";
        const numbers = String(body?.to ?? "").split(",").filter(Boolean);
        return Response.json({ response: { msgOkCount: 0, stdSMSCount: 0, errors: numbers.map((number) => ({ number, message: fault.message ?? "Ugyldig nummer" })) } });
      }
      case "lost-response":
        serve(body, call);
        call.outcome = "lost-response";
        throw networkError("read ECONNRESET", "ECONNRESET");
      case "timeout":
        if (fault.sent) serve(body, call);
        call.outcome = "timeout";
        throw abortError();
      default: {
        if (call.method !== "POST") { call.outcome = "http_405"; return new Response("Method Not Allowed", { status: 405 }); }
        if (body?.f !== "json") { call.outcome = "not-json"; return new Response("<response>use f=json</response>", { headers: { "content-type": "text/xml" } }); }
        const response = serve(body, call);
        call.outcome = response.fatalError ? "fatal" : response.msgOkCount ? "ok" : "rejected";
        return Response.json({ response });
      }
    }
  };

  fetch.sent = sent;
  fetch.dryRuns = dryRuns;
  fetch.calls = calls;
  fetch.clock = clock;
  fetch.to = (number) => sent.filter((s) => s.to === number);
  fetch.inject = (rule) => {
    if (rule.fault !== undefined && !FAULTS.has(rule.fault)) throw new Error(`fakeSveve.inject: unknown fault ${rule.fault}`);
    if (rule.fault === undefined && !rule.latencyMs) throw new Error("fakeSveve.inject: give a fault or latencyMs");
    const r = { times: 1, skip: 0, ...rule, hits: 0, skipped: 0 };
    faults.push(r);
    return r;
  };
  fetch.clearFaults = () => { faults = []; };
  fetch.maxPerNumber = (windowMs = 24 * 60 * 60 * 1000) => {
    let best = { number: null, count: 0 };
    const byNumber = new Map();
    for (const s of sent) byNumber.set(s.to, [...(byNumber.get(s.to) || []), s.at]);
    for (const [number, times] of byNumber) {
      times.sort((a, b) => a - b);
      for (let i = 0, j = 0; j < times.length; j++) {
        while (times[j] - times[i] >= windowMs) i++;
        if (j - i + 1 > best.count) best = { number, count: j - i + 1 };
      }
    }
    return best;
  };
  return fetch;
}
