// Oversikt over alle bedriftene: logg inn, hent /api/overview, vis sammenligningstabell og ett kort per bedrift.
// ES2015 og XMLHttpRequest (virker også i Safari 10 uten fetch). Søylehøyder settes med element.style (ingen innebygde
// stil-attributter, så sidens sikkerhetsregler kan forby dem).
(function () {
  "use strict";
  var KEY = "oversikt-token";
  var DAYS = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
  var SHORT = ["søn", "man", "tir", "ons", "tor", "fre", "lør"];
  var SRC = { instagram: "Instagram", facebook: "Facebook", google: "Google", tiktok: "TikTok", snapchat: "Snapchat", qr: "QR-kode",
    sms: "SMS", epost: "E-post", visittkort: "Visittkort", direkte: "Direkte", annet: "Annet" };
  var state = { days: 30, data: null, sort: { key: "visits", dir: -1 } };
  var $ = function (id) { return document.getElementById(id); };

  function store(remember) { try { return remember ? localStorage : sessionStorage; } catch (e) { return null; } }
  function getToken() { try { return sessionStorage.getItem(KEY) || localStorage.getItem(KEY); } catch (e) { return null; } }
  function setToken(t, remember) {
    try { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); } catch (e) { /* privat modus */ }
    var s = store(remember); if (s && t) { try { s.setItem(KEY, t); } catch (e) { /* fullt */ } }
  }
  function request(method, url, body, token, cb) {
    var x = new XMLHttpRequest();
    x.open(method, url, true);
    x.setRequestHeader("Accept", "application/json");
    if (body) x.setRequestHeader("Content-Type", "application/json");
    if (token) x.setRequestHeader("Authorization", "Bearer " + token);
    x.timeout = 30000;
    x.onload = function () { var d = null; try { d = JSON.parse(x.responseText); } catch (e) { /* ikke JSON */ } cb(x.status, d); };
    x.onerror = x.ontimeout = function () { cb(0, null); };
    x.send(body ? JSON.stringify(body) : null);
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function num(n) { return n === null || n === undefined ? "–" : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
  function pct(a, b) { return b ? String(Math.round((a / b) * 1000) / 10).replace(".", ",") + " %" : "–"; }
  function dm(date) { return Number(date.slice(8, 10)) + "." + Number(date.slice(5, 7)) + "."; }
  function wd(date) { return new Date(date + "T12:00:00Z").getUTCDay(); }

  // ---------- tall per bedrift ----------
  function summary(site) {
    if (!site.ok) return { name: site.name, url: site.url, error: site.error };
    var d = site.data, b = d.bookings;
    var top = Object.keys(d.sources).filter(function (k) { return d.sources[k]; }).sort(function (x, y) { return d.sources[y] - d.sources[x]; })[0];
    var best = -1, bestN = 0;
    if (b) b.weekdays.forEach(function (n, i) { if (n > bestN) { bestN = n; best = i; } });
    var totalSrc = Object.keys(d.sources).reduce(function (a, k) { return a + (d.sources[k] || 0); }, 0);
    return {
      name: site.name, url: site.url, data: d,
      visits: d.visits, booked: b ? b.web + b.admin : null, web: b ? b.web : null, share: b && d.visits ? b.web / d.visits : null,
      cancelled: b ? b.cancelled : null, upcoming: b ? b.upcoming7 : null,
      source: top ? SRC[top] + " " + Math.round((d.sources[top] / totalSrc) * 100) + " %" : "–", sourceN: top ? d.sources[top] / totalSrc : null,
      busiest: best >= 0 ? DAYS[best] : "–", busiestN: best,
    };
  }
  var COLS = [
    { key: "name", label: "Bedrift" }, { key: "visits", label: "Besøk" }, { key: "booked", label: "Bookinger" },
    { key: "web", label: "Fra nettsiden" }, { key: "share", label: "Andel" }, { key: "cancelled", label: "Avlyst" },
    { key: "upcoming", label: "Neste 7 dager" }, { key: "sourceN", label: "Største kilde" }, { key: "busiestN", label: "Travleste dag" },
  ];
  function cell(r, key) {
    if (key === "share") return pct(r.web, r.visits);
    if (key === "sourceN") return esc(r.source);
    if (key === "busiestN") return esc(r.busiest);
    return num(r[key]);
  }
  function renderTable(rows) {
    var head = "<tr>" + COLS.map(function (c) {
      var on = state.sort.key === c.key;
      return '<th scope="col"><button type="button" data-sort="' + c.key + '"' + (on ? ' aria-sort="' + (state.sort.dir < 0 ? "descending" : "ascending") + '"' : "") + ">" +
        esc(c.label) + (on ? (state.sort.dir < 0 ? " ↓" : " ↑") : "") + "</button></th>";
    }).join("") + "</tr>";
    var k = state.sort.key, dir = state.sort.dir;
    var sorted = rows.slice().sort(function (a, b) {
      if (a.error || b.error) return a.error ? 1 : -1;
      var x = a[k], y = b[k];
      if (k === "name") return dir * String(x).localeCompare(String(y), "nb");
      return dir * ((x === null ? -1 : x) - (y === null ? -1 : y));
    });
    var body = sorted.map(function (r) {
      if (r.error) return '<tr><th scope="row">' + esc(r.name) + '</th><td class="err" colspan="' + (COLS.length - 1) + '">' + esc(r.error) + "</td></tr>";
      return '<tr><th scope="row"><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.name) + "</a></th>" +
        COLS.slice(1).map(function (c) { return "<td>" + cell(r, c.key) + "</td>"; }).join("") + "</tr>";
    }).join("");
    $("compare").querySelector("thead").innerHTML = head;
    $("compare").querySelector("tbody").innerHTML = body;
  }

  // ---------- søyler: én tallrekke, ingen forklaringsboks (tittelen sier hva den viser) ----------
  function chart(parent, title, days, valueAt, detailAt, max) {
    var h3 = document.createElement("h3"); h3.textContent = title; parent.appendChild(h3);
    var box = document.createElement("div"); box.className = "chart"; parent.appendChild(box);
    var read = document.createElement("p"); read.className = "read"; read.setAttribute("aria-live", "polite"); parent.appendChild(read);
    var every = Math.ceil(days.length / 10);
    days.forEach(function (x, i) {
      var v = valueAt(x) || 0;
      var text = SHORT[wd(x.date)] + " " + dm(x.date) + ": " + detailAt(x);
      var bar = document.createElement("div"); bar.className = "bar"; bar.tabIndex = 0;
      bar.setAttribute("role", "img"); bar.setAttribute("aria-label", text);
      var col = document.createElement("span");
      col.style.height = v ? Math.max(3, Math.round((v / max) * 100)) + "%" : "0";
      bar.appendChild(col);
      if ((days.length - 1 - i) % every === 0) { var s = document.createElement("small"); s.textContent = String(Number(x.date.slice(8, 10))); bar.appendChild(s); }
      var show = function () { read.textContent = text; };
      bar.addEventListener("mouseenter", show); bar.addEventListener("focus", show); bar.addEventListener("click", show);
      box.appendChild(bar);
    });
    var last = days[days.length - 1];
    if (last) read.textContent = SHORT[wd(last.date)] + " " + dm(last.date) + ": " + detailAt(last);
  }
  function renderCards(rows) {
    var cards = $("cards"); cards.innerHTML = "";
    var same = $("same").checked;
    var maxV = 1, maxB = 1;
    rows.forEach(function (r) { if (r.data) r.data.days.forEach(function (x) { maxV = Math.max(maxV, x.visits); maxB = Math.max(maxB, x.booked || 0); }); });
    rows.forEach(function (r) {
      var card = document.createElement("section"); card.className = "card site";
      if (r.error) { card.innerHTML = "<h2>" + esc(r.name) + '</h2><p class="err">' + esc(r.error) + "</p>"; cards.appendChild(card); return; }
      var d = r.data, b = d.bookings, days = d.days.slice().reverse();
      var ownV = 1, ownB = 1;
      days.forEach(function (x) { ownV = Math.max(ownV, x.visits); ownB = Math.max(ownB, x.booked || 0); });
      card.innerHTML = '<h2><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.name) + "</a></h2>" +
        '<div class="nums"><div><strong>' + num(r.visits) + "</strong><span>besøk</span></div>" +
        "<div><strong>" + num(r.booked) + "</strong><span>bookinger</span></div>" +
        "<div><strong>" + pct(r.web, r.visits) + "</strong><span>andel</span></div>" +
        "<div><strong>" + num(r.upcoming) + "</strong><span>neste 7 dager</span></div></div>";
      chart(card, "Besøk per dag", days, function (x) { return x.visits; }, function (x) { return x.visits + " besøk (" + x.views + " sidevisninger)"; }, same ? maxV : ownV);
      if (b) {
        chart(card, "Bookinger gjort per dag", days, function (x) { return x.booked; }, function (x) {
          return x.booked === null ? "ingen tall" : x.booked + " bookinger (" + x.web + " fra nettsiden" + (x.cancelled ? ", " + x.cancelled + " avlyst" : "") + ")";
        }, same ? maxB : ownB);
        var svc = Object.keys(b.services).sort(function (x, y) { return b.services[y] - b.services[x]; }).slice(0, 4);
        if (svc.length) {
          var h = document.createElement("h3"); h.textContent = "Mest booket"; card.appendChild(h);
          var ul = document.createElement("ul"); ul.className = "list";
          ul.innerHTML = svc.map(function (k) { return "<li>" + esc(k) + " <strong>" + b.services[k] + "</strong></li>"; }).join("");
          card.appendChild(ul);
        }
      }
      var src = Object.keys(SRC).filter(function (k) { return d.sources[k]; }).sort(function (x, y) { return d.sources[y] - d.sources[x]; });
      if (src.length) {
        var h2 = document.createElement("h3"); h2.textContent = "Besøkene kom fra"; card.appendChild(h2);
        var ul2 = document.createElement("ul"); ul2.className = "list";
        ul2.innerHTML = src.map(function (k) { return "<li>" + esc(SRC[k]) + " <strong>" + num(d.sources[k]) + "</strong></li>"; }).join("");
        card.appendChild(ul2);
      }
      cards.appendChild(card);
    });
  }
  function render() {
    if (!state.data) return;
    var rows = state.data.sites.map(summary);
    renderTable(rows);
    renderCards(rows);
  }

  // ---------- flyt ----------
  function showLogin(msg) { $("app").hidden = true; $("login").hidden = false; $("login-msg").textContent = msg || ""; try { $("pw").focus(); } catch (e) { /* gammel nettleser */ } }
  function load() {
    var t = getToken();
    if (!t) { showLogin(""); return; }
    $("app-msg").textContent = "Henter tall …";
    request("GET", "/api/overview?days=" + state.days, null, t, function (status, d) {
      if (status === 401) { setToken(null); showLogin("Logg inn på nytt."); return; }
      if (status !== 200 || !d) { $("app-msg").textContent = "Kunne ikke hente tallene (" + (status || "ingen forbindelse") + "). Trykk Oppdater."; return; }
      $("login").hidden = true; $("app").hidden = false; $("app-msg").textContent = "";
      state.data = d;
      var now = new Date();
      $("updated").textContent = "· oppdatert " + ("0" + now.getHours()).slice(-2) + ":" + ("0" + now.getMinutes()).slice(-2);
      render();
    });
  }
  function markDays() {
    var bs = document.querySelectorAll(".seg button");
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute("aria-pressed", String(Number(bs[i].getAttribute("data-days")) === state.days));
  }

  $("login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var pw = $("pw").value;
    if (!pw) { $("login-msg").textContent = "Skriv passordet."; return; }
    $("login-msg").textContent = "Logger inn …";
    request("POST", "/api/login", { password: pw }, null, function (status, d) {
      if (status === 200 && d && d.token) { $("pw").value = ""; setToken(d.token, $("remember").checked); $("login-msg").textContent = ""; load(); return; }
      $("login-msg").textContent = (d && d.error) || (status ? "Innloggingen feilet (" + status + ")." : "Ingen forbindelse. Prøv igjen.");
    });
  });
  document.querySelector(".seg").addEventListener("click", function (e) {
    var b = e.target; if (!b || !b.getAttribute || !b.getAttribute("data-days")) return;
    state.days = Number(b.getAttribute("data-days")); markDays(); load();
  });
  $("compare").addEventListener("click", function (e) {
    var b = e.target; while (b && b !== this && !(b.getAttribute && b.getAttribute("data-sort"))) b = b.parentNode;
    if (!b || b === this) return;
    var k = b.getAttribute("data-sort");
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === "name" ? 1 : -1) };
    render();
  });
  $("same").addEventListener("change", render);
  $("refresh").addEventListener("click", load);
  $("logout").addEventListener("click", function () { setToken(null); state.data = null; showLogin("Du er logget ut."); });
  markDays();
  load();
})();
