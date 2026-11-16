// Engangskobling av Instagram-kontoen (OAuth).
//   Start:    /api/connect/instagram?key=SOCIAL_ADMIN_KEY
//   Callback: /api/connect/instagram/callback   (registreres i appen hos Meta)
// Kun den som kjenner SOCIAL_ADMIN_KEY kan koble til en konto.
// Runde 2: en gammel permalenke (isRetiredDeploy) har den gamle nøkkelen og svarer 410 før noe annet, og en
// OAuth-state husker adressen (origin) som laget den: tilbakekallet godtar den bare på den samme adressen, så en
// state laget et annet sted aldri kobler en fremmed konto til forsiden.
import { timingSafeEqual, randomBytes } from "node:crypto";
import { buildFeed } from "../lib/social.mjs";
import { liveDeps, isRetiredDeploy } from "../lib/runtime.mjs";

const page = (status, title, text) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><body style="font:16px system-ui;background:#0b0f0d;color:#f2ece0;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center">
<div><h1 style="color:#cfa75e;font-weight:600">${title}</h1><p>${text}</p><p><a style="color:#cfa75e" href="/">Til forsiden</a></p></div>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );

const keyOk = (given, expected) => {
  if (!given || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring, miljø, klokke og fetch)
export async function handle(req, context, deps) {
  if (isRetiredDeploy(context)) return page(410, "Bruk hovedsiden", "Dette er en gammel utgave av nettsiden. Start koblingen fra hovedsiden.");
  const env = deps.env;
  const nowMs = () => deps.now().getTime();
  const platform = context && context.params && context.params.platform;
  if (platform !== "instagram") return page(404, "Ukjent plattform", "Kun Instagram støttes.");

  const url = new URL(req.url);
  const redirectUri = `${url.origin}/api/connect/${platform}/callback`;
  const store = deps.getStore("social");

  // Steg 1: send eieren til innlogging hos plattformen
  if (!url.pathname.endsWith("/callback")) {
    if (!keyOk(url.searchParams.get("key"), env.SOCIAL_ADMIN_KEY)) return page(403, "Ingen tilgang", "Feil eller manglende nøkkel.");
    const state = randomBytes(24).toString("hex");
    await store.setJSON(`oauth-state-${state}`, { platform, created_at: nowMs(), origin: url.origin }, { onlyIfNew: true }); // 24 tilfeldige byte: alltid en ny nøkkel

    const auth = new URL("https://www.instagram.com/oauth/authorize");
    auth.searchParams.set("client_id", env.INSTAGRAM_APP_ID);
    auth.searchParams.set("scope", "instagram_business_basic");
    auth.searchParams.set("enable_fb_login", "0");
    auth.searchParams.set("redirect_uri", redirectUri);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("state", state);
    return Response.redirect(auth.toString(), 302);
  }

  // Steg 2: plattformen sender oss tilbake med en kode
  const state = url.searchParams.get("state") || "";
  const saved = /^[a-f0-9]{48}$/.test(state) ? await store.get(`oauth-state-${state}`, { type: "json" }) : null;
  if (saved) await store.delete(`oauth-state-${state}`);
  if (!saved || saved.platform !== platform || saved.origin !== url.origin || nowMs() - saved.created_at > 15 * 60 * 1000) {
    return page(400, "Lenken er utløpt", "Start koblingen på nytt.");
  }
  const code = (url.searchParams.get("code") || "").replace(/#_$/, "");
  if (!code) return page(400, "Avbrutt", url.searchParams.get("error_description") || "Ingen kode mottatt.");

  try {
    const res = await deps.fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: env.INSTAGRAM_APP_ID,
        client_secret: env.INSTAGRAM_APP_SECRET,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      }),
    });
    const json = await res.json();
    const short = json.data?.[0]?.access_token || json.access_token;
    if (!short) throw new Error(json.error_message || "ingen token");

    const ll = new URL("https://graph.instagram.com/access_token");
    ll.searchParams.set("grant_type", "ig_exchange_token");
    ll.searchParams.set("client_secret", env.INSTAGRAM_APP_SECRET);
    ll.searchParams.set("access_token", short);
    const long = await (await deps.fetch(ll.toString())).json();
    if (!long.access_token) throw new Error(long.error?.message || "kunne ikke hente langtidstoken");
    // Eierens egen, nye kobling erstatter med vilje et lagret token (også et fra INSTAGRAM_ACCESS_TOKEN: uten seed tar
    // miljøvariabelen aldri over igjen, se netlify/lib/social.mjs).
    await store.setJSON("instagram-token", { // blind-write-ok: the owner's own new connection replaces the stored token on purpose
      access_token: long.access_token,
      refreshed_at: nowMs(),
      expires_at: nowMs() + long.expires_in * 1000,
    });
    const feed = await buildFeed(store, env, deps.fetch, { now: deps.now() });
    return page(200, "Instagram er koblet til ✓", `Fant ${feed.instagram.length} nye poster. Feeden på forsiden oppdateres nå automatisk hver time.`);
  } catch (err) {
    console.error("connect:", err);
    return page(500, "Noe gikk galt", "Koblingen feilet. Sjekk at app-nøklene i Netlify stemmer, og prøv igjen.");
  }
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { path: ["/api/connect/:platform", "/api/connect/:platform/callback"] };
