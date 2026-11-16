// Etter hver publisering, kjøres for hånd (ikke i npm test, ikke av Netlify). Bare GET, ingenting skrives.
// Sjekker at det som ble publisert, er det repoet sier (DEPLOY.md del 2 og 3):
//   /                  200, ingen data-netlify (D2), ingen Google Fonts (F47), og:url = <origin>/ (F62)
//   /favicon.ico       samme sha256 som viggos-barbershop/favicon.ico (F63); /apple-touch-icon.png 200
//   /finnes-ikke-…     404 med vår egen side: «Viggo» og 409 63 911 (F75)
//   /README.md         404 (F58); /personvern.html 200 med lang="nb" (D6)
//   /api/availability  today, closed[] og «Herreklipp + skjeggtrim» = 30 min (D4, D7), og ingen ukjente felt
//   gamle permalenker  /api/admin/items svarer 410 eller 404, aldri 401 (F10, F2)
//   gammel adresse     https://boisterous-salamander-9c6b34.netlify.app/ svarer 301 til <origin>/ (D8), og
//                      apex-domenet sender til www
// Bruk: node scripts/smoke-live.mjs https://www.viggosbarbershop.no [<id>--boisterous-salamander-9c6b34.netlify.app …]
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const OLD_SITE_HOST = "boisterous-salamander-9c6b34.netlify.app";
const SITE = fileURLToPath(new URL("../viggos-barbershop/", import.meta.url));
const COMBO = "Herreklipp + skjeggtrim";
// Feltene /api/availability skal ha (netlify/lib/booking-core.mjs getAvailability), ikke flere
export const AVAILABILITY_KEYS = ["busy", "closed", "durations", "hours", "lastDate", "leadMin", "maxDays", "nowMinutes", "slotMin", "today"];
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// fetchFn(url, init) som global fetch; svarene trenger status, headers.get, text() og arrayBuffer()
export async function smoke({ origin, oldHosts = [], fetchFn = fetch, timeoutMs = 15000 }) {
  origin = String(origin).replace(/\/+$/, "");
  const results = [];
  const get = (url, manual) => {
    const init = { method: "GET", redirect: manual ? "manual" : "follow", headers: { "User-Agent": "viggos-smoke-check" } };
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) init.signal = AbortSignal.timeout(timeoutMs);
    return fetchFn(url, init);
  };
  async function check(name, fn) {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || "" });
    } catch (e) {
      results.push({ name, ok: false, detail: e && e.message ? e.message : String(e) });
    }
  }
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

  await check("forsiden", async () => {
    const res = await get(origin + "/");
    expect(res.status === 200, `status ${res.status}`);
    const html = await res.text();
    expect(!/data-netlify/.test(html), "har data-netlify (Netlify Forms)");
    expect(!/fonts\.(googleapis|gstatic)\.com/.test(html), "laster Google Fonts");
    const og = /<meta property="og:url" content="([^"]+)"/.exec(html);
    expect(og && og[1] === origin + "/", `og:url er ${og ? og[1] : "borte"}, ikke ${origin}/`);
    return "200, og:url " + og[1];
  });

  await check("favicon.ico", async () => {
    const res = await get(origin + "/favicon.ico");
    expect(res.status === 200, `status ${res.status}`);
    const got = sha256(Buffer.from(await res.arrayBuffer()));
    const want = sha256(readFileSync(SITE + "favicon.ico"));
    expect(got === want, `sha256 ${got.slice(0, 12)}… er ikke filen i repoet (${want.slice(0, 12)}…)`);
    return "samme fil som i repoet";
  });

  await check("apple-touch-icon.png", async () => {
    const res = await get(origin + "/apple-touch-icon.png");
    expect(res.status === 200, `status ${res.status}`);
  });

  await check("404-siden", async () => {
    const res = await get(origin + "/finnes-ikke-" + Date.now().toString(36));
    expect(res.status === 404, `status ${res.status}`);
    const html = await res.text();
    expect(html.includes("Viggo") && html.includes("409 63 911"), "ikke vår egen 404-side");
  });

  await check("README.md vises ikke", async () => {
    const res = await get(origin + "/README.md");
    expect(res.status === 404, `status ${res.status}`);
  });

  await check("personvern.html", async () => {
    const res = await get(origin + "/personvern.html");
    expect(res.status === 200, `status ${res.status}`);
    expect(/<html lang="nb">/.test(await res.text()), "mangler lang=\"nb\"");
  });

  await check("/api/availability", async () => {
    const res = await get(origin + "/api/availability");
    expect(res.status === 200, `status ${res.status}`);
    const data = JSON.parse(await res.text());
    expect(/^\d{4}-\d{2}-\d{2}$/.test(data.today), "mangler today");
    expect(Array.isArray(data.closed), "mangler closed[]");
    expect(data.durations && data.durations[COMBO] === 30, `${COMBO} er ${data.durations && data.durations[COMBO]} min, ikke 30`);
    const extra = Object.keys(data).filter((k) => !AVAILABILITY_KEYS.includes(k));
    expect(extra.length === 0, "ukjente felt: " + extra.join(", "));
    return `today ${data.today}, ${data.closed.length} stengte dager`;
  });

  for (const host of oldHosts) {
    await check(`gammel permalenke ${host}`, async () => {
      const res = await get(`https://${host}/api/admin/items`, true);
      expect(res.status === 410 || res.status === 404, `status ${res.status} (skal være 410 eller 404${res.status === 401 ? "; 401 betyr gammel kode med gammelt passord: slett utrullingen" : ""})`);
      return String(res.status);
    });
  }

  const host = new URL(origin).host;
  if (!/\.netlify\.app$/.test(host)) {
    await check(`${OLD_SITE_HOST} sender videre`, async () => {
      const res = await get(`https://${OLD_SITE_HOST}/`, true);
      const to = res.headers.get("location");
      expect(res.status === 301, `status ${res.status}`);
      expect(to === origin + "/", `sender til ${to}, ikke ${origin}/`);
      return "301 → " + to;
    });
  }
  if (/^www\./.test(host)) {
    await check(`${host.slice(4)} sender til www`, async () => {
      const res = await get(`https://${host.slice(4)}/`, true);
      const to = res.headers.get("location") || "";
      expect(res.status >= 301 && res.status <= 308, `status ${res.status}`);
      expect(to.indexOf(origin + "/") === 0, `sender til ${to || "ingenting"}`);
      return `${res.status} → ${to}`;
    });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [origin, ...oldHosts] = process.argv.slice(2);
  if (!origin || !/^https:\/\//.test(origin)) {
    console.error("Bruk: node scripts/smoke-live.mjs https://www.viggosbarbershop.no [<id>--" + OLD_SITE_HOST + " …]");
    process.exit(2);
  }
  const results = await smoke({ origin, oldHosts });
  for (const r of results) console.log(`${r.ok ? "OK  " : "FEIL"} ${r.name}${r.detail ? ": " + r.detail : ""}`);
  const bad = results.filter((r) => !r.ok).length;
  console.log(bad ? `${bad} av ${results.length} sjekker feilet.` : `Alle ${results.length} sjekker OK.`);
  process.exit(bad ? 1 : 0);
}
