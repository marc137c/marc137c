// Felles logikk for Instagram- og TikTok-feeden.
// Tokens og ferdig feed lagres i Netlify Blobs (store "social"), slik at tokens kan fornyes automatisk.

export const PROFILES = {
  instagram: "https://www.instagram.com/viggos.barbershop/",
  tiktok: "https://www.tiktok.com/@viggos.barbershop1",
};

const POSTS_PER_PLATFORM = 3;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ---------- Instagram (Instagram API with Instagram Login) ----------

export async function getInstagramToken(store, env, fetchFn = fetch) {
  let tok = await store.get("instagram-token", { type: "json" });
  if (!tok && env.INSTAGRAM_ACCESS_TOKEN) {
    // Startverdi fra miljøvariabel (langtidstoken generert i Meta-dashbordet)
    tok = { access_token: env.INSTAGRAM_ACCESS_TOKEN, refreshed_at: 0 };
  }
  if (!tok) return null;

  // Langtidstokens varer 60 dager og kan fornyes når de er minst 24 timer gamle.
  // Vi fornyer ukentlig, så de aldri går ut.
  if (Date.now() - (tok.refreshed_at || 0) > 7 * DAY) {
    const url = new URL("https://graph.instagram.com/refresh_access_token");
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", tok.access_token);
    const res = await fetchFn(url);
    if (res.ok) {
      const data = await res.json();
      tok = { access_token: data.access_token, refreshed_at: Date.now(), expires_at: Date.now() + data.expires_in * 1000 };
      await store.setJSON("instagram-token", tok);
    } else if (!tok.refreshed_at) {
      // Ferskt seed-token kan være under 24 timer gammelt – bruk det som det er.
      await store.setJSON("instagram-token", { ...tok, refreshed_at: Date.now() - 6 * DAY });
    } else {
      console.warn("Instagram: kunne ikke fornye token", res.status);
    }
  }
  return tok.access_token;
}

export async function fetchInstagram(token, fetchFn = fetch) {
  const url = new URL("https://graph.instagram.com/me/media");
  url.searchParams.set("fields", "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp");
  url.searchParams.set("limit", String(POSTS_PER_PLATFORM));
  url.searchParams.set("access_token", token);
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Instagram ${res.status}: ${await res.text()}`);
  const { data = [] } = await res.json();
  return data.slice(0, POSTS_PER_PLATFORM).map((m) => ({
    platform: "instagram",
    id: m.id,
    url: m.permalink,
    image: m.media_type === "VIDEO" ? m.thumbnail_url : m.media_url,
    video: m.media_type === "VIDEO",
    caption: (m.caption || "").trim(),
    date: m.timestamp ? new Date(m.timestamp).toISOString() : null,
  }));
}

// ---------- TikTok (Login Kit + Display API v2) ----------

async function tiktokTokenRequest(params, fetchFn) {
  const res = await fetchFn("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await res.json();
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(`TikTok token: ${data.error || res.status} ${data.error_description || ""}`.trim());
  }
  return {
    access_token: data.access_token,
    access_expires_at: Date.now() + data.expires_in * 1000,
    refresh_token: data.refresh_token,
    refresh_expires_at: Date.now() + data.refresh_expires_in * 1000,
  };
}

export const exchangeTiktokCode = (env, code, redirectUri, fetchFn = fetch) =>
  tiktokTokenRequest({
    client_key: env.TIKTOK_CLIENT_KEY,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  }, fetchFn);

export async function getTiktokToken(store, env, fetchFn = fetch) {
  let tok = await store.get("tiktok-token", { type: "json" });
  if (!tok) return null;
  // Tilgangstoken varer 24 timer; fornyes med refresh-token (gyldig i et år, byttes ved fornying).
  if (Date.now() > tok.access_expires_at - 15 * 60 * 1000) {
    tok = await tiktokTokenRequest({
      client_key: env.TIKTOK_CLIENT_KEY,
      client_secret: env.TIKTOK_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: tok.refresh_token,
    }, fetchFn);
    await store.setJSON("tiktok-token", tok);
  }
  return tok.access_token;
}

export async function fetchTiktok(token, fetchFn = fetch) {
  const url = "https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,cover_image_url,share_url,create_time";
  const res = await fetchFn(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ max_count: POSTS_PER_PLATFORM }),
  });
  const body = await res.json();
  if (!res.ok || (body.error && body.error.code !== "ok")) {
    throw new Error(`TikTok ${res.status}: ${body.error?.code} ${body.error?.message || ""}`.trim());
  }
  return (body.data?.videos || []).slice(0, POSTS_PER_PLATFORM).map((v) => ({
    platform: "tiktok",
    id: v.id,
    url: v.share_url || `${PROFILES.tiktok}/video/${v.id}`,
    image: v.cover_image_url,
    video: true,
    caption: (v.title || v.video_description || "").trim(),
    date: v.create_time ? new Date(v.create_time * 1000).toISOString() : null,
  }));
}

// ---------- Feed ----------

// Henter ferske poster fra begge plattformene og lagrer feeden.
// Feiler én plattform, beholdes de forrige postene derfra.
export async function buildFeed(store, env, fetchFn = fetch) {
  const previous = (await store.get("feed", { type: "json" })) || {};
  const feed = { updated_at: new Date().toISOString(), profiles: PROFILES, instagram: [], tiktok: [] };

  const sources = {
    instagram: async () => {
      const t = await getInstagramToken(store, env, fetchFn);
      return t ? fetchInstagram(t, fetchFn) : [];
    },
    tiktok: async () => {
      const t = await getTiktokToken(store, env, fetchFn);
      return t ? fetchTiktok(t, fetchFn) : [];
    },
  };
  for (const [platform, load] of Object.entries(sources)) {
    try {
      feed[platform] = await load();
    } catch (err) {
      console.error(`Feed ${platform}:`, err.message);
      feed[platform] = previous[platform] || [];
    }
  }
  await store.setJSON("feed", feed);
  return feed;
}

export const isStale = (feed, maxAgeMs = 2 * HOUR) =>
  !feed || Date.now() - new Date(feed.updated_at).getTime() > maxAgeMs;
