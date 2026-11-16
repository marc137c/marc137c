// /admin: besøk på nettsiden (sidevisninger) i dag, siste 7 og 30 dager, en liten søyle per dag
// og hvor besøkene kom fra. Tallene kommer fra /api/stats (teller uten informasjonskapsler).
(function () {
  var KEY = "viggo-admin-token";
  var LABEL = { instagram: "Instagram", facebook: "Facebook", google: "Google", tiktok: "TikTok", direkte: "Direkte", annet: "Annet" };
  var section = null;
  function token() { try { return localStorage.getItem(KEY) || sessionStorage.getItem(KEY); } catch (e) { return null; } }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function render(d) {
    var app = document.getElementById("app");
    if (!app) return;
    if (!section) {
      section = document.createElement("section");
      section.className = "stats-panel";
      section.setAttribute("aria-label", "Besøk på nettsiden");
      app.appendChild(section);
    }
    var days = d.days.slice(0, 14).reverse();
    var max = 1;
    days.forEach(function (x) { if (x.views > max) max = x.views; });
    var bars = days.map(function (x) {
      var h = Math.round((x.views / max) * 100);
      var dd = x.date.slice(8, 10) + "." + x.date.slice(5, 7);
      return '<div class="sp-bar" title="' + esc(dd + ": " + x.views) + '"><span style="height:' + h + '%"></span><small>' + esc(x.date.slice(8, 10)) + "</small></div>";
    }).join("");
    var src = Object.keys(LABEL).filter(function (k) { return d.sources[k]; })
      .sort(function (a, b) { return d.sources[b] - d.sources[a]; })
      .map(function (k) { return "<li>" + esc(LABEL[k]) + " <strong>" + d.sources[k] + "</strong></li>"; }).join("");
    section.innerHTML =
      "<h2>Besøk på nettsiden</h2>" +
      '<div class="sp-nums"><div><strong>' + d.totals.today + "</strong><span>i dag</span></div>" +
      "<div><strong>" + d.totals.week + "</strong><span>siste 7 dager</span></div>" +
      "<div><strong>" + d.totals.month + "</strong><span>siste 30 dager</span></div></div>" +
      '<div class="sp-chart" aria-hidden="true">' + bars + "</div>" +
      (src ? '<p class="sp-sub">Kom fra (30 dager):</p><ul class="sp-src">' + src + "</ul>" : '<p class="sp-sub">Ingen besøk registrert ennå.</p>') +
      '<p class="sp-note">Sidevisninger på forsiden. Telles uten informasjonskapsler og uten IP-adresser; roboter telles ikke.</p>';
  }
  // Svarer ikke serveren innen WAIT_MS (dårlig nett), gis forsøket opp; neste tidtaker-tikk prøver igjen. Mens ett
  // forsøk venter, startes ikke et nytt (ellers hopet de seg opp bak tidtakeren).
  var WAIT_MS = 15000;
  var waiting = false;
  function withTimeout(promise, ms) {
    var timer;
    var late = new Promise(function (resolve, reject) { timer = setTimeout(function () { reject(new Error("timeout")); }, ms); });
    return Promise.race([promise, late]).then(function (v) { clearTimeout(timer); return v; }, function (err) { clearTimeout(timer); throw err; });
  }
  function load() {
    var t = token();
    var app = document.getElementById("app");
    if (!t || !app || app.hidden || document.hidden || waiting) return;
    waiting = true;
    withTimeout(fetch("/api/stats", { headers: { Authorization: "Bearer " + t, Accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; }), WAIT_MS)
      .then(function (d) { if (d && d.days) render(d); })
      .catch(function () {})
      .then(function () { waiting = false; });
  }
  setTimeout(load, 1200);
  setInterval(load, 60000);
  document.addEventListener("visibilitychange", load);
})();
