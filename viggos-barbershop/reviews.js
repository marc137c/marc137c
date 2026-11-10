// Google-anmeldelser: snittkarakter + 3–4 anmeldelser som kort.
// Dataene kommer fra /api/reviews (Places API, mellomlagret på serveren).
(() => {
  const list = document.getElementById("reviews");
  if (!list) return;
  const summary = document.getElementById("rating-summary");
  const link = document.getElementById("reviews-link");
  const heroRating = document.getElementById("hero-rating"); // stjernene øverst på siden
  const MAX_CARDS = 4;
  let data = null;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const safeUrl = (u) => (/^https:\/\//.test(u || "") ? u : null);
  const G_LOGO = '<svg class="g-logo" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1z"/><path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z"/></svg>';

  // Fem stjerner der fyllingen viser karakteren (f.eks. 4,7 → 94 % fylt)
  function stars(rating, cls = "") {
    const pct = Math.max(0, Math.min(100, (rating / 5) * 100));
    const row = '<svg viewBox="0 0 120 24" aria-hidden="true">' +
      [0, 1, 2, 3, 4].map((i) => `<path transform="translate(${i * 24} 0)" d="M12 1.8l3.1 6.3 7 1-5 4.9 1.2 6.9L12 17.6l-6.3 3.3 1.2-6.9-5-4.9 7-1z"/>`).join("") +
      "</svg>";
    return `<span class="stars-row ${cls}" role="img" aria-label="${esc(I18N.s().ratingOf(String(rating).replace(".", I18N.lang === "en" ? "." : ",")))}"><span class="stars-bg">${row}</span><span class="stars-fg" style="width:${pct}%">${row}</span></span>`;
  }

  // «for 2 måneder siden» / «2 months ago» på valgt språk, regnet ut fra datoen
  function ago(r) {
    const t = Date.parse(r.date || "");
    if (!t || typeof Intl.RelativeTimeFormat !== "function") return r.when || "";
    const rtf = new Intl.RelativeTimeFormat(I18N.s().locale, { numeric: "auto" });
    const days = Math.round((t - Date.now()) / 86400000);
    if (Math.abs(days) < 7) return rtf.format(days, "day");
    if (Math.abs(days) < 30) return rtf.format(Math.round(days / 7), "week");
    if (Math.abs(days) < 365) return rtf.format(Math.round(days / 30), "month");
    return rtf.format(Math.round(days / 365), "year");
  }

  function card(r) {
    const author = r.authorUrl && safeUrl(r.authorUrl)
      ? `<a href="${esc(r.authorUrl)}" target="_blank" rel="noopener">${esc(r.author)}</a>`
      : esc(r.author);
    const avatar = safeUrl(r.photo)
      ? `<img class="review-avatar" src="${esc(r.photo)}" alt="" width="40" height="40" loading="lazy" referrerpolicy="no-referrer">`
      : `<span class="review-avatar review-avatar--initial" aria-hidden="true">${esc((r.author || "?").charAt(0).toUpperCase())}</span>`;
    return `<figure class="review">
      <div class="review-top">${stars(r.rating)}${G_LOGO}</div>
      <blockquote>${esc(r.text)}</blockquote>
      <figcaption>${avatar}<span><strong>${author}</strong><small>${esc(ago(r))}</small></span></figcaption>
    </figure>`;
  }

  function render() {
    if (!data) return;
    const s = I18N.s();
    const href = safeUrl(data.url);
    if (href) link.href = href;

    const withText = (data.reviews || []).filter((r) => r.text).slice(0, MAX_CARDS);
    if (data.rating && data.count) {
      const r = data.rating.toFixed(1).replace(".", I18N.lang === "en" ? "." : ",");
      summary.innerHTML = `${G_LOGO}<strong class="rating-num">${r}</strong>${stars(data.rating, "stars-lg")}<span class="rating-count">${esc(s.basedOn(data.count))}</span>`;
      summary.hidden = false;
      if (heroRating) { heroRating.innerHTML = `${stars(data.rating)}<span>${esc(s.heroRating(r, data.count))}</span>`; heroRating.hidden = false; }
    } else {
      summary.hidden = true;
      if (heroRating) heroRating.hidden = true;
    }

    if (withText.length) {
      list.innerHTML = withText.map(card).join("");
      list.classList.remove("reviews--single");
    } else {
      // Ikke koblet til Google ennå (eller ingen tekst-anmeldelser): pen henvisning til Google
      list.innerHTML = `<div class="review review--cta">${G_LOGO}<p>${esc(s.reviewsFallback)}</p></div>`;
      list.classList.add("reviews--single");
    }
    list.setAttribute("aria-busy", "false");
  }

  function load() {
    fetch("/api/reviews", { headers: { Accept: "application/json" } })
      .then((res) => { if (!res.ok) throw new Error(res.status); return res.json(); })
      .catch(() => ({ reviews: [] }))
      .then((d) => { data = d; render(); });
  }

  I18N.onChange(render);
  load();
})();
