// RC5 (client copies drift, deploys change the server under open tabs): a page loaded from the last published
// client (test/fixtures/published-client.json) must keep working against this server. Invariants: every service
// value it can send validates with the same duration it shows, /api/availability publishes that duration under the
// same name, and every old name the server still accepts (SERVICE_ALIASES) is published with its new duration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { testDeps, request, read, PRODUCTION } from "../helpers/deps.mjs";
import { validateCustomer, SERVICE_ALIASES, CONFIG } from "../../netlify/lib/booking-core.mjs";
import { handle } from "../../netlify/functions/availability.mjs";

const published = JSON.parse(readFileSync(new URL("../fixtures/published-client.json", import.meta.url), "utf8"));
const NOW = new Date("2026-11-12T09:00:00Z"); // Thursday 10:00 in Oslo
const base = { date: "2026-11-13", start: 600, name: "Ola Nordmann", phone: "409 63 911" };

test("deploy compat: the fixture is the published client: every option has a duration", () => {
  assert.ok(published.options.length >= 6);
  assert.deepEqual([...published.options].sort(), Object.keys(published.durations).sort());
});

test("deploy compat: every service value the published page can send validates with the duration that page shows", () => {
  for (const value of published.options) {
    const v = validateCustomer({ ...base, service: value }, NOW);
    assert.equal(v.error, undefined, `${value}: ${v.error}`);
    assert.equal(v.value.dur, published.durations[value], value);
  }
});

test("deploy compat: /api/availability gives the published page the same durations, and old names their new one", async () => {
  const { durations } = (await read(await handle(request("/api/availability"), PRODUCTION, testDeps({ now: NOW.toISOString() })))).body;
  for (const value of published.options) assert.equal(durations[value], published.durations[value], value);
  for (const [old, now] of Object.entries(SERVICE_ALIASES)) {
    assert.equal(durations[old], CONFIG.durations[now], old);
    assert.equal(validateCustomer({ ...base, service: old }, NOW).value.dur, CONFIG.durations[now], old);
  }
});
