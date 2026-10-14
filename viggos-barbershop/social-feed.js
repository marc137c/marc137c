// Viser de 3 nyeste postene fra Instagram og TikTok (2 per rad, 3 rader).
// Dataene kommer fra /api/social, som oppdateres automatisk hver time på serveren.
(() => {
  const grid = document.getElementById("social-feed");
  if (!grid) return;

  const ICONS = {
    instagram: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.3" cy="6.7" r="1.2" fill="currentColor"/></svg>',
    tiktok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.6 3c.4 2.3 1.9 3.9 4.2 4.1v3.3c-1.5.1-2.9-.3-4.2-1.1v6.1c0 3.8-3.1 6.3-6.4 5.6-2.7-.5-4.4-3-4-5.7.5-2.9 3.2-4.7 6.1-4.2v3.4c-.4-.1-.8-.2-1.2-.1-1.2.2-1.9 1.3-1.6 2.4.2.9 1.1 1.5 2 1.4 1-.1 1.7-.9 1.7-2V3h3.4z"/></svg>',
  };
  const NAMES = { instagram: "Instagram", tiktok: "TikTok" };
  const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13l11-6.5z"/></svg>';
  let feed = null;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const safeUrl = (u) => (/^https:\/\//.test(u || "") ? u : "#");

  function ago(iso) {
    if (!iso) return "";
    const lang = I18N.lang === "en" ? "en" : "nb";
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
    const s = (new Date(iso) - Date.now()) / 1000;
    for (const [unit, sec] of [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
      if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), unit);
    }
    return rtf.format(0, "minute");
  }

  function postCard(p) {
    const name = NAMES[p.platform];
    const caption = p.caption ? esc(p.caption) : "";
    return `<a class="post post--${p.platform}" href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener"
        aria-label="${esc(I18N.s().openPost(name))}${p.caption ? ": " + caption.slice(0, 80) : ""}">
      <img src="${esc(safeUrl(p.image))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">
      <span class="post-badge" title="${name}">${ICONS[p.platform]}</span>
      ${p.video ? `<span class="post-play">${PLAY}</span>` : ""}
      <span class="post-meta">
        ${caption ? `<span class="post-caption">${caption}</span>` : ""}
        <span class="post-date">${name} · ${esc(ago(p.date))}</span>
      </span>
    </a>`;
  }

  function followCard(platform) {
    const url = feed?.profiles?.[platform] || "#";
    const handle = url.replace(/\/$/, "").split("/").pop().replace(/^@?/, "@");
    return `<a class="post post--follow post--${platform}" href="${esc(safeUrl(url))}" target="_blank" rel="noopener">
      <span class="post-badge post-badge--big">${ICONS[platform]}</span>
      <span class="post-follow-text">${esc(I18N.s().followOn(NAMES[platform]))}</span>
      <span class="post-handle">${esc(handle)}</span>
    </a>`;
  }

  function render() {
    if (!feed) return;
    const cols = ["instagram", "tiktok"];
    const html = [];
    for (let row = 0; row < 3; row++) {
      for (const p of cols) {
        const post = feed[p]?.[row];
        if (post) html.push(postCard(post));
        // Tomt felt: vis «Følg oss»-kort én gang per plattform
        else if (!html.some((h) => h.includes(`post--follow post--${p}`))) html.push(followCard(p));
      }
    }
    grid.innerHTML = html.join("");
    grid.setAttribute("aria-busy", "false");
    grid.querySelectorAll("img").forEach((img) => {
      // Utløpte bilde-lenker: vis merkevare-bakgrunn i stedet for et ødelagt bilde
      img.addEventListener("error", () => img.remove(), { once: true });
    });
  }

  async function load() {
    try {
      const res = await fetch("/api/social", { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(res.status);
      feed = await res.json();
    } catch {
      feed = { profiles: { instagram: "https://www.instagram.com/viggos.barbershop/", tiktok: "https://www.tiktok.com/@viggos.barbershop1" }, instagram: [], tiktok: [] };
    }
    render();
  }

  I18N.onChange(render);
  load();
})();
