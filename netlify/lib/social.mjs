// Logikk for Instagram-feeden.
// Tokens og ferdig feed lagres i Netlify Blobs (store "social"), slik at tokens kan fornyes automatisk.
// Instagrams regler vi bygger på, og testen for hver: docs/contracts/instagram.md (test/lib/social.test.mjs).

export const PROFILES = {
  instagram: "https://www.instagram.com/viggos.barbershop/",
};

const POSTS = 6; // 2 per rad, 3 rader
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// F15: feiler Instagram, vises de forrige postene høyst så lenge etter siste vellykkede henting. Bildelenkene er
// signerte CDN-lenker som går ut etter noen dager, og en post som er slettet på Instagram skal bort fra siden.
export const KEEP_POSTS_MS = 2 * DAY;

// Lagrer bare hvis dokumentet er det samme som ble lest (etag), så et tregt kall aldri skriver over et nyere
const writeIfUnchanged = (store, key, doc, cur) => store.setJSON(key, doc, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });

// ---------- Instagram (Instagram API with Instagram Login) ----------

export async function getInstagramToken(store, env, fetchFn = fetch, { now = new Date() } = {}) {
  const t = now.getTime();
  const cur = await store.getWithMetadata("instagram-token", { type: "json" });
  let tok = cur && cur.data && typeof cur.data === "object" ? cur.data : null;
  const envTok = env.INSTAGRAM_ACCESS_TOKEN;
  // Startverdi fra miljøvariabel (langtidstoken generert i Meta-dashbordet). seed husker hvilken verdi det var,
  // så en ny verdi i miljøvariabelen tar over (F81). Et token fra koblingslenken har ingen seed og beholdes.
  if (envTok && (!tok || (tok.seed !== undefined && tok.seed !== envTok))) {
    tok = { access_token: envTok, seed: envTok, refreshed_at: 0 };
  }
  if (!tok) return null;

  // Langtidstokens varer 60 dager og kan fornyes når de er minst 24 timer gamle.
  // Vi fornyer ukentlig, så de aldri går ut.
  if (t - (tok.refreshed_at || 0) > 7 * DAY) {
    const url = new URL("https://graph.instagram.com/refresh_access_token");
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", tok.access_token);
    const res = await fetchFn(url);
    if (res.ok) {
      const data = await res.json();
      const next = { access_token: data.access_token, refreshed_at: t, expires_at: t + data.expires_in * 1000 };
      if (tok.seed !== undefined) next.seed = tok.seed;
      tok = next;
      await writeIfUnchanged(store, "instagram-token", tok, cur);
    } else if (!tok.refreshed_at) {
      // Ferskt seed-token kan være under 24 timer gammelt – bruk det som det er.
      await writeIfUnchanged(store, "instagram-token", { ...tok, refreshed_at: t - 6 * DAY }, cur);
    } else {
      console.warn("Instagram: kunne ikke fornye token", res.status);
    }
  }
  return tok.access_token;
}

export async function fetchInstagram(token, fetchFn = fetch) {
  const url = new URL("https://graph.instagram.com/me/media");
  url.searchParams.set("fields", "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp");
  url.searchParams.set("limit", String(POSTS));
  url.searchParams.set("access_token", token);
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Instagram ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const { data = [] } = await res.json();
  return data.slice(0, POSTS).map((m) => ({
    platform: "instagram",
    id: m.id,
    url: m.permalink,
    image: m.media_type === "VIDEO" ? m.thumbnail_url : m.media_url,
    video: m.media_type === "VIDEO",
    caption: (m.caption || "").trim(),
    date: m.timestamp ? new Date(m.timestamp).toISOString() : null,
  }));
}

// ---------- Feed ----------

// Henter ferske poster og lagrer feeden. Feiler Instagram, beholdes de forrige postene, men høyst KEEP_POSTS_MS
// etter siste vellykkede henting (fetched_at); deretter er feeden tom.
export async function buildFeed(store, env, fetchFn = fetch, { now = new Date() } = {}) {
  const t = now.getTime();
  const cur = await store.getWithMetadata("feed", { type: "json" });
  const previous = (cur && cur.data && typeof cur.data === "object" && cur.data) || {};
  const feed = { updated_at: now.toISOString(), fetched_at: null, profiles: PROFILES, instagram: [] };
  try {
    const token = await getInstagramToken(store, env, fetchFn, { now });
    if (token) {
      feed.instagram = await fetchInstagram(token, fetchFn);
      feed.fetched_at = feed.updated_at;
    }
  } catch (err) {
    console.error("Feed instagram:", err.message);
    const last = Date.parse(previous.fetched_at || "");
    if (Number.isFinite(last) && t - last < KEEP_POSTS_MS) {
      feed.instagram = previous.instagram || [];
      feed.fetched_at = previous.fetched_at;
    }
  }
  await writeIfUnchanged(store, "feed", feed, cur);
  return feed;
}

export const isStale = (feed, maxAgeMs = 2 * HOUR) =>
  !feed || Date.now() - new Date(feed.updated_at).getTime() > maxAgeMs;
