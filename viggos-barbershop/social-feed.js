// Viser de 6 nyeste Instagram-postene (2 per rad, 3 rader).
// Dataene kommer fra /api/social, som oppdateres automatisk hver time på serveren.
(() => {
  const grid = document.getElementById("social-feed");
  if (!grid) return;

  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.3" cy="6.7" r="1.2" fill="currentColor"/></svg>';
  const PROFILE = "https://www.instagram.com/viggos.barbershop/";
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
    const name = "Instagram";
    const caption = p.caption ? esc(p.caption) : "";
    return `<a class="post post--instagram" href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener"
        aria-label="${esc(I18N.s().openPost(name))}${p.caption ? ": " + caption.slice(0, 80) : ""}">
      <img src="${esc(safeUrl(p.image))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">
      <span class="post-badge" title="${name}">${ICON}</span>
      ${p.video ? `<span class="post-play">${PLAY}</span>` : ""}
      <span class="post-meta">
        ${caption ? `<span class="post-caption">${caption}</span>` : ""}
        <span class="post-date">${esc(ago(p.date))}</span>
      </span>
    </a>`;
  }

  function followCard() {
    const url = feed?.profiles?.instagram || PROFILE;
    return `<a class="post post--follow post--instagram" href="${esc(safeUrl(url))}" target="_blank" rel="noopener">
      <span class="post-badge post-badge--big">${ICON}</span>
      <span class="post-follow-text">${esc(I18N.s().followOn("Instagram"))}</span>
      <span class="post-handle">@viggos.barbershop</span>
    </a>`;
  }

  function render() {
    if (!feed) return;
    const posts = (feed.instagram || []).slice(0, 6);
    // Færre enn 6 poster (eller ikke koblet til ennå): avslutt med et «Følg oss»-kort
    const html = posts.map(postCard);
    if (posts.length < 6) html.push(followCard());
    grid.innerHTML = html.join("");
    grid.classList.toggle("social-feed--single", html.length === 1);
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
      feed = { profiles: { instagram: PROFILE }, instagram: [] };
    }
    render();
  }

  I18N.onChange(render);
  load();
})();
