// Samme-dags-grensen må være lik på siden (booking.js) og serveren (CONFIG.leadMin). Er de ulike, viser siden tider
// som serveren avviser (eller skjuler tider som er lov).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONFIG, validateCustomer } from "../netlify/lib/booking-core.mjs";

test("LEAD_MIN i booking.js er lik CONFIG.leadMin, og eierens valg er 15 minutter", () => {
  // fix/server: LEAD_MIN is a fallback («let») that /api/availability overrides (F19); config-sync.test.mjs checks it too
  const m = /(?:const|let) LEAD_MIN = (\d+);/.exec(readFileSync(new URL("../viggos-barbershop/booking.js", import.meta.url), "utf8"));
  assert.ok(m, "fant ikke LEAD_MIN i booking.js");
  assert.equal(Number(m[1]), CONFIG.leadMin);
  assert.equal(CONFIG.leadMin, 15);
});

test("serveren: 15:30 kan bestilles kl. 15:15 (15 min frem), men ikke kl. 15:16", () => {
  const base = { service: "Herreklipp", name: "Test", phone: "40000000", addons: [], date: "2026-11-18", start: 15 * 60 + 30 };
  assert.equal(validateCustomer(base, new Date("2026-11-18T14:15:00Z")).error, undefined); // 15:15 norsk tid
  assert.ok(validateCustomer(base, new Date("2026-11-18T14:16:00Z")).error, "15:16 → for tidlig");
});
