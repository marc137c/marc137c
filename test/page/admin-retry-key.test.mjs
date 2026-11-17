// Guard (round 3, SPEC R1), the /admin side: Slett and «Avlys alle nettbestillinger» send an idempotency key, and a
// second tap after a reply that never came (no network, 15 s without an answer, the platform's 5xx page) sends the
// same key, so the server answers the first request's result: «slettet», not 404 and «slettet fra en annen enhet»;
// the first call's count, not «0 nettbestillinger … er avlyst». A new key only once the server has given a definite
// answer (2xx, or a 4xx other than 401), or for another booking, another version of it or another number.
// The server side: test/functions/admin-retry-key.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin, itemsRoute, netFail, hang } from "../helpers/admin-page.mjs";
import { item } from "../fixtures/admin-days.mjs";

const DAY = "2026-11-19";
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/; // REQUEST_ID_RE in netlify/lib/booking-core.mjs
const web = (start, phone, extra = {}) => item(DAY, start, 30, { name: "Falsk", phone, source: "nettside", ...extra });
const reqOf = (c) => new URL(c.url, "https://x").searchParams.get("req");
const settle = async (page) => { await page.flush(); await page.advance(15000); await page.flush(); };

// answers: what each call gets in turn ("net": a network failure, "hang": no answer, else a route answer)
function sequence(answers) {
  let n = 0;
  return (call) => {
    const a = answers[Math.min(n++, answers.length - 1)];
    if (a === "net") return netFail("Load failed")(call);
    if (a === "hang") return hang()(call);
    return typeof a === "function" ? a(call) : a;
  };
}

for (const [label, firstAnswer] of [["no network", "net"], ["no answer in 15 s", "hang"], ["a 502 page from the platform", { status: 502, body: "<html>Bad gateway</html>" }]]) {
  test(`retry key: Slett after ${label}: the second tap sends the same req and expect, and the booking counts as deleted here`, async () => {
    const list = [web(660, "912 34 567"), web(720, "400 11 222")];
    const [a, b] = list;
    const page = await loadAdmin({ now: DAY + "T09:00", routes: {
      "GET /api/admin/items": itemsRoute(() => list),
      [`DELETE /api/admin/items/${encodeURIComponent(a.id)}`]: sequence([firstAnswer, () => { list.splice(list.indexOf(a), 1); return { ok: true }; }]),
      [`DELETE /api/admin/items/${encodeURIComponent(b.id)}`]: () => ({ ok: true }),
    } });
    page.tap("timeline", `[data-id="${a.id}"] button.item-open`);
    page.$("delete").click();
    await settle(page);
    assert.match(page.$("edit-msg").textContent, /^Ingen forbindelse/);
    assert.equal(page.$("editor").open, true);
    page.$("delete").click();
    await settle(page);
    const dels = page.calls.filter((c) => c.method === "DELETE" && c.path === `/api/admin/items/${encodeURIComponent(a.id)}`);
    assert.equal(dels.length, 2);
    assert.match(reqOf(dels[0]), KEY_RE);
    assert.equal(reqOf(dels[1]), reqOf(dels[0]), "the same key for the same tap's retry");
    for (const c of dels) assert.equal(new URL(c.url, "https://x").searchParams.get("expect"), a.updatedAt);
    assert.deepEqual(page.alerts, [], "no «flyttet eller slettet fra en annen enhet»");
    assert.equal(page.$("editor").open, false);
    // another booking: another key
    page.tap("timeline", `[data-id="${b.id}"] button.item-open`);
    page.$("delete").click();
    await page.flush();
    const other = page.calls.filter((c) => c.method === "DELETE" && c.path === `/api/admin/items/${encodeURIComponent(b.id)}`);
    assert.equal(other.length, 1);
    assert.match(reqOf(other[0]), KEY_RE);
    assert.notEqual(reqOf(other[0]), reqOf(dels[0]));
  });
}

test("retry key: Slett after a definite answer (412) gets a new key on the next tap", async () => {
  const list = [web(660, "912 34 567")];
  const [a] = list;
  const page = await loadAdmin({ now: DAY + "T09:00", routes: {
    "GET /api/admin/items": itemsRoute(() => list),
    [`DELETE /api/admin/items/${encodeURIComponent(a.id)}`]: sequence([{ status: 412, body: { error: "Avtalen er endret på en annen enhet. Lukk og åpne den på nytt.", code: "stale" } }, { ok: true }]),
  } });
  page.tap("timeline", `[data-id="${a.id}"] button.item-open`);
  page.$("delete").click();
  await page.flush();
  assert.equal(page.$("editor").open, false, "the 412 closes the sheet");
  page.tap("timeline", `[data-id="${a.id}"] button.item-open`);
  page.$("delete").click();
  await page.flush();
  const dels = page.calls.filter((c) => c.method === "DELETE");
  assert.equal(dels.length, 2);
  assert.notEqual(reqOf(dels[1]), reqOf(dels[0]));
});

test("retry key: «Avlys alle nettbestillinger» after a lost reply sends the same requestId and shows the server's count; after a success the next tap has a new one", async () => {
  const list = [web(600, "400 00 000"), web(630, "+47 400 00 000"), web(700, "40000000")];
  const page = await loadAdmin({ now: DAY + "T09:00", routes: {
    "GET /api/admin/items": itemsRoute(() => list),
    "POST /api/admin/cancel-phone": sequence(["hang", { ok: true, cancelled: 3 }, { ok: true, cancelled: 0 }]),
  } });
  page.tap("timeline", `[data-id="${list[0].id}"] button.item-open`);
  await page.flush();
  page.$("cancel-phone").click();
  await settle(page);
  assert.match(page.$("edit-msg").textContent, /^Ingen forbindelse/);
  page.$("cancel-phone").click();
  await settle(page);
  assert.deepEqual(page.alerts, ["3 nettbestillinger fra 400 00 000 er avlyst. Kundene har ikke fått beskjed."]);
  const posts = page.calls.filter((c) => c.path === "/api/admin/cancel-phone");
  assert.equal(posts.length, 2);
  assert.match(posts[0].body.requestId, KEY_RE);
  assert.deepEqual(posts[1].body, posts[0].body, "the same phone and the same requestId");
  // a later tap (the server answered): a new request
  page.tap("timeline", `[data-id="${list[1].id}"] button.item-open`);
  await page.flush();
  page.$("cancel-phone").click();
  await page.flush();
  const third = page.calls.filter((c) => c.path === "/api/admin/cancel-phone")[2];
  assert.ok(third, "a third request");
  assert.match(third.body.requestId, KEY_RE);
  assert.notEqual(third.body.requestId, posts[0].body.requestId);
});
