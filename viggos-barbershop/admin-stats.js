// /admin: statistikk for nettsiden – besøk (i dag, 7 og 30 dager), bookinger (fra nettsiden og lagt inn her),
// avlysninger, timer de neste 7 dagene, mest bookede tjenester, travleste ukedag og hvor besøkene kom fra.
// Tallene kommer fra /api/stats (uten informasjonskapsler; bare tall, aldri navn eller telefon).
(function () {
  var KEY = "viggo-admin-token";
  var LABEL = { instagram: "Instagram", facebook: "Facebook", google: "Google", tiktok: "TikTok", direkte: "Direkte", annet: "Annet" };
  var DAYS = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
  var SHORT = ["søn", "man", "tir", "ons", "tor", "fre", "lør"];
  var section = null;
  function token() { try { return localStorage.getItem(KEY) || sessionStorage.getItem(KEY); } catch (e) { return null; } }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function weekday(date) { return new Date(date + "T12:00:00Z").getUTCDay(); }
  function dm(date) { return Number(date.slice(8, 10)) + "." + Number(date.slice(5, 7)) + "."; }

  // Søyler for én tallrekke. Pek/trykk på en søyle → teksten under viser tallet for den dagen.
  function columns(list, amountOf, detailOf, title) {
    var max = 1;
    list.forEach(function (x) { if (amountOf(x) > max) max = amountOf(x); });
    var bars = list.map(function (x, i) {
      var v = amountOf(x), h = v ? Math.max(4, Math.round((v / max) * 100)) : 0;
      var text = SHORT[weekday(x.date)] + " " + dm(x.date) + ": " + detailOf(x);
      return '<div class="sp-bar" tabindex="0" role="img" aria-label="' + esc(text) + '" data-i="' + i + '" data-text="' + esc(text) + '">' +
        '<span style="height:' + h + '%"></span><small>' + esc(String(Number(x.date.slice(8, 10)))) + "</small></div>";
    }).join("");
    var last = list[list.length - 1];
    return '<h3 class="sp-title">' + esc(title) + "</h3>" +
      '<div class="sp-chart">' + bars + "</div>" +
      '<p class="sp-read" aria-live="polite">' + esc(SHORT[weekday(last.date)] + " " + dm(last.date) + ": " + detailOf(last)) + "</p>";
  }
  function onPoint(e) {
    var bar = e.target && e.target.closest ? e.target.closest(".sp-bar") : null;
    if (!bar) { var t = e.target; while (t && t !== section && !(t.className && String(t.className).indexOf("sp-bar") >= 0)) t = t.parentNode; bar = t && t !== section ? t : null; }
    if (!bar) return;
    var block = bar.parentNode; while (block && block.className !== "sp-block") block = block.parentNode;
    var read = block ? block.querySelector(".sp-read") : null;
    if (read) read.textContent = bar.getAttribute("data-text");
  }

  function render(d) {
    var app = document.getElementById("app");
    if (!app) return;
    if (!section) {
      section = document.createElement("section");
      section.className = "stats-panel";
      section.setAttribute("aria-label", "Statistikk for nettsiden");
      section.addEventListener("mouseover", onPoint);
      section.addEventListener("focusin", onPoint);
      section.addEventListener("click", onPoint);
      app.appendChild(section);
    }
    var days = d.days.slice(0, 14).reverse(); // eldste til venstre
    var t = d.totals, b = d.bookings;
    var visitsOf = function (x) { return x.visits; };
    var bookedOf = function (x) { return x.bookings ? x.bookings.web + x.bookings.admin : 0; };
    var src = Object.keys(LABEL).filter(function (k) { return d.sources[k]; })
      .sort(function (a, c) { return d.sources[c] - d.sources[a]; })
      .map(function (k) { return "<li>" + esc(LABEL[k]) + " <strong>" + d.sources[k] + "</strong></li>"; }).join("");
    var html = "<h2>Statistikk</h2>" +
      '<div class="sp-block"><div class="sp-nums">' +
      "<div><strong>" + days[days.length - 1].visits + "</strong><span>besøk i dag</span></div>" +
      "<div><strong>" + d.days.slice(0, 7).reduce(function (a, x) { return a + x.visits; }, 0) + "</strong><span>besøk 7 dager</span></div>" +
      "<div><strong>" + t.visits + "</strong><span>besøk 30 dager</span></div></div>" +
      columns(days, visitsOf, function (x) { return x.visits + " besøk (" + x.views + " sidevisninger)"; }, "Besøk per dag") + "</div>";
    if (b) {
      var made = b.web + b.admin;
      var top = Object.keys(b.services).sort(function (a, c) { return b.services[c] - b.services[a]; }).slice(0, 3)
        .map(function (k) { return esc(k) + " <strong>" + b.services[k] + "</strong>"; }).join(" · ");
      var best = -1, bestN = 0;
      b.weekdays.forEach(function (n, i) { if (n > bestN) { bestN = n; best = i; } });
      html += '<div class="sp-block"><div class="sp-nums">' +
        "<div><strong>" + made + "</strong><span>bookinger 30 dager</span></div>" +
        "<div><strong>" + b.web + "</strong><span>fra nettsiden</span></div>" +
        "<div><strong>" + b.admin + "</strong><span>lagt inn av deg</span></div>" +
        "<div><strong>" + b.cancelled + "</strong><span>avlyst</span></div>" +
        "<div><strong>" + b.upcoming7 + "</strong><span>timer neste 7 dager</span></div></div>" +
        columns(days, bookedOf, function (x) { return x.bookings ? (x.bookings.web + x.bookings.admin) + " bookinger (" + x.bookings.web + " fra nettsiden, " + x.bookings.admin + " fra deg" + (x.bookings.cancelled ? ", " + x.bookings.cancelled + " avlyst" : "") + ")" : "ingen tall"; }, "Bookinger gjort per dag") +
        (top ? '<p class="sp-sub">Mest booket (30 dager): ' + top + "</p>" : "") +
        (best >= 0 ? '<p class="sp-sub">Travleste dag: <strong>' + DAYS[best] + "</strong></p>" : "") +
        (made && t.visits ? '<p class="sp-sub">Andel besøk som booket på nettsiden: <strong>' + String(Math.round((b.web / t.visits) * 1000) / 10).replace(".", ",") + " %</strong></p>" : "") +
        "</div>";
    }
    html += (src ? '<p class="sp-sub">Besøkene kom fra (30 dager):</p><ul class="sp-src">' + src + "</ul>" : '<p class="sp-sub">Ingen besøk registrert ennå.</p>') +
      '<p class="sp-note">Et besøk er når noen kommer inn på siden utenfra. Telles uten informasjonskapsler og uten IP-adresser; roboter telles ikke. Bookinger telles etter dagen de ble gjort.</p>';
    section.innerHTML = html;
  }
  function load() {
    var t = token();
    var app = document.getElementById("app");
    if (!t || !app || app.hidden || document.hidden) return;
    fetch("/api/stats?days=30", { headers: { Authorization: "Bearer " + t, Accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.days) render(d); })
      .catch(function () {});
  }
  setTimeout(load, 1200);
  setInterval(load, 60000);
  document.addEventListener("visibilitychange", load);
})();
