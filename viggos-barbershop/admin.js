// Timebok for Viggo's Barbershop: se, legg inn, flytt, avlys og blokker timer.
// Snakker med /api/admin/* (netlify/functions/admin.mjs). Innloggingen lagres i nettleseren.
// «Oppsett» viser lenken til kalenderen på telefonen (/api/admin/calendar, se netlify/lib/calendar.mjs) og slår
// varsler om nye bestillinger av og på for denne enheten (/api/admin/push, admin-sw.js, netlify/lib/push.mjs).
// /admin?dag=ÅÅÅÅ-MM-DD åpner den dagen (lenken i varslene).
(() => {
  const $ = (id) => document.getElementById(id);
  const KEY = "viggo-admin-token";
  const WEEK_DAYS = 14;

  // ---------- Hjelpere ----------
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
  // «14:30», «14.30», «1430» og «14» godtas (eldre Safari har ikke tidsvelger og lar folk skrive fritt)
  const toMin = (t) => {
    const m = /^(\d{1,2})(?:[:.]?(\d{2}))?$/.exec(String(t).trim());
    if (!m || Number(m[2] || 0) > 59) return NaN;
    return Number(m[1]) * 60 + Number(m[2] || 0);
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (s, o) => new Intl.DateTimeFormat("nb-NO", o).format(parse(s));
  const todayIso = () => iso(new Date());
  // Datofelt blir vanlig tekst i nettlesere uten type=date: godta også «10.11.2026»
  const toIso = (v) => {
    v = String(v || "").trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) { const n = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(v); if (n) m = [v, n[3], pad(+n[2]), pad(+n[1])]; }
    if (!m) return null;
    const out = m[1] + "-" + m[2] + "-" + m[3];
    return iso(parse(out)) === out ? out : null;
  };
  const active = (i) => i.status !== "cancelled";

  // ---------- Innlogging ----------
  // Safari i privat modus kan ikke lagre noe; da huskes innloggingen så lenge siden er åpen
  let memToken = null;
  const getToken = () => { if (memToken) return memToken; try { return localStorage.getItem(KEY) || sessionStorage.getItem(KEY); } catch (e) { return null; } };
  function setToken(t, remember) {
    memToken = t || null;
    try {
      localStorage.removeItem(KEY); sessionStorage.removeItem(KEY);
      if (t) (remember ? localStorage : sessionStorage).setItem(KEY, t);
    } catch (e) { /* privat modus */ }
  }

  // Lukker åpne dialoger (f.eks. når innloggingen har gått ut mens «Oppsett» er åpen)
  const closeDialogs = () => Array.prototype.forEach.call(document.querySelectorAll("dialog"), (d) => { if (d.open) d.close(); });

  // kind: «ok» (grønn, f.eks. «Du er logget ut.»), «info» (nøytral) eller ingenting (rød: noe gikk galt)
  function loginMsg(text, kind) {
    $("login-msg").textContent = text || "";
    $("login-msg").className = "msg" + (kind ? " " + kind : "");
  }
  function showLogin(message = "", kind = "") {
    closeDialogs();
    $("app").hidden = true;
    $("login").hidden = false;
    loginMsg(message, kind);
    $("pw").focus();
    loginPushCheck();
  }
  function showApp() {
    loginPushHide();
    $("login").hidden = true;
    $("app").hidden = false;
  }

  // Innloggingssiden på en enhet som fortsatt har varsler om nye bestillinger slått på (innloggingen har gått ut,
  // fanen ble lukket, eller Viggo logget ut uten å slå dem av): det står der, med «Slå av varsler her». Knappen
  // trenger ingen innlogging: nettleseren avslutter abonnementet, push-tjenesten svarer 410 neste gang, og serveren
  // sletter enheten.
  let loginPushSeq = 0;
  let loginPushSub = null;
  function loginPushMsg(text, kind) {
    $("login-push-msg").textContent = text;
    $("login-push-msg").className = "msg" + (kind ? " " + kind : "");
  }
  function loginPushHide() {
    loginPushSeq++;
    loginPushSub = null;
    $("login-push").hidden = true;
  }
  function loginPushCheck() {
    loginPushHide();
    const seq = loginPushSeq;
    return thisDeviceSubscription().then((sub) => {
      if (seq !== loginPushSeq || !sub || $("login").hidden) return;
      loginPushSub = sub;
      loginPushMsg("Denne enheten har fortsatt varsler om nye bestillinger slått på.", "info");
      $("login-push-off").hidden = false;
      $("login-push-off").disabled = false;
      $("login-push").hidden = false;
    });
  }
  $("login-push-off").addEventListener("click", () => {
    const sub = loginPushSub;
    const btn = $("login-push-off");
    if (!sub || btn.disabled) return;
    const seq = loginPushSeq;
    btn.disabled = true;
    const stop = Promise.resolve().then(() => sub.unsubscribe()).then((ok) => ok === true, () => false);
    withinTime(stop, LOGOUT_WAIT_MS, "").catch(() => false).then((ok) => {
      btn.disabled = false;
      if (seq !== loginPushSeq) return;
      if (!ok) return loginPushMsg("Kunne ikke slå av varslene her. Slå av varsler for denne siden i nettleserens innstillinger.");
      loginPushSub = null;
      btn.hidden = true;
      loginPushMsg("Varsler om nye bestillinger er slått av på denne enheten.", "ok");
    });
  });

  $("pw-toggle").addEventListener("click", () => {
    const pw = $("pw");
    const show = pw.type === "password";
    pw.type = show ? "text" : "password";
    $("pw-toggle").textContent = show ? "Skjul" : "Vis";
    $("pw-toggle").setAttribute("aria-label", show ? "Skjul passord" : "Vis passord");
    pw.focus();
  });

  $("login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const btn = e.submitter || $("login-form").querySelector("button[type=submit]");
    btn.disabled = true;
    loginMsg("");
    fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("pw").value, remember: $("remember").checked }),
    }).then((res) => res.json().catch(() => ({})).then((data) => {
      if (!res.ok) throw new Error(data.error || (res.status === 404 ? "Timeboken er ikke publisert ennå." : "Kunne ikke logge inn."));
      setToken(data.token, $("remember").checked);
      $("pw").value = "";
      showApp();
      load();
      pushSync();
    })).catch((err) => {
      loginMsg(err.message);
      $("pw").select();
    }).then(() => {
      btn.disabled = false;
    });
  });

  // «Logg ut» står sammen med varslene lenger ned: får enheten varsler, spør den først om de skal slås av også.

  function api(path, opts = {}) {
    return fetch(path, Object.assign({}, opts, {
      headers: Object.assign({ "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` }, opts.headers || {}),
      cache: "no-store",
    })).then((res) => res.json().catch(() => ({})).then((data) => {
      if (res.status === 401) { setToken(null); showLogin("Logg inn på nytt.", "info"); throw Object.assign(new Error(data.error || "Logg inn"), { status: 401 }); }
      if (!res.ok) throw Object.assign(new Error(data.error || "Noe gikk galt."), { status: res.status });
      return data;
    }));
  }

  // ---------- Data ----------
  // /admin?dag=ÅÅÅÅ-MM-DD (fra et varsel) åpner den dagen
  const linkedDay = () => {
    const m = /[?&]dag=(\d{4}-\d{2}-\d{2})(?:&|$)/.exec((window.location && window.location.search) || "");
    return m && toIso(m[1]) === m[1] ? m[1] : null;
  };
  const state = { day: linkedDay() || todayIso(), items: [], week: [], config: null, editing: null };
  const hoursOn = (d) => { const h = state.config && state.config.hours; return h ? h[parse(d).getDay()] : null; };
  // Eiervalg D4: en dag der aktive blokkeringer til sammen (inntil hverandre eller overlappende) dekker hele
  // åpningstiden, er stengt. Samme regel som closedDays() på serveren og kundekalenderen (F91).
  function fullyBlocked(d, list) {
    const h = hoursOn(d);
    if (!h) return false;
    const spans = list.filter((x) => x.date === d && x.type === "block" && active(x)).sort((a, b) => a.start - b.start);
    let reached = h[0];
    for (let i = 0; i < spans.length; i++) {
      if (spans[i].start > reached) break;
      reached = Math.max(reached, spans[i].start + spans[i].dur);
    }
    return reached >= h[1];
  }

  let loadSeq = 0;
  function load() {
    const seq = ++loadSeq, d = state.day, today = todayIso();
    $("sync").textContent = "Henter …";
    return Promise.all([
      api(`/api/admin/items?from=${d}&to=${d}`),
      api(`/api/admin/items?from=${today}&to=${addDays(today, WEEK_DAYS - 1)}`),
    ]).then(([day, week]) => {
      // Et eldre svar (f.eks. etter rask bla-ing mellom dager) skal ikke overskrive et nyere
      if (seq !== loadSeq || d !== state.day) return;
      state.items = day.items;
      state.itemsDay = d;
      state.week = week.items;
      state.config = day.config;
      render();
      $("sync").textContent = `Oppdatert ${hhmm(new Date().getHours() * 60 + new Date().getMinutes())}`;
    }).catch((err) => {
      if (seq !== loadSeq) return; // et nyere svar er på vei
      if (err.status === 401) return;
      $("sync").textContent = "Ingen forbindelse";
      // Dagen på skjermen er ikke hentet: si det, i stedet for «Henter …» som aldri blir ferdig. Tidtakeren og
      // det å komme tilbake til fanen prøver igjen.
      if (state.itemsDay !== state.day) $("timeline").innerHTML = '<li class="empty">Kunne ikke hente avtaler – prøver igjen …</li>';
    });
  }

  // ---------- Visning ----------
  function render() {
    renderWeek();
    renderDay();
  }

  function renderWeek() {
    const today = todayIso();
    const html = [];
    for (let i = 0; i < WEEK_DAYS; i++) {
      const d = addDays(today, i);
      const n = state.week.filter((x) => x.date === d && active(x) && x.type === "booking").length;
      // Før åpningstidene er hentet (uten nett fra start) vet vi ikke hvilke dager som er stengt (F29)
      const closed = !!state.config && (!hoursOn(d) || fullyBlocked(d, state.week));
      const count = n ? `${n} ${n === 1 ? "time" : "timer"}` : "";
      const label = closed ? (count ? count + " · stengt" : "stengt") : count || "&nbsp;";
      html.push(`<button type="button" data-day="${d}" class="${d === state.day ? "is-active" : ""}${closed ? " is-closed" : ""}">
        <span>${esc(fmt(d, { weekday: "short" }).replace(".", ""))}</span><strong>${parse(d).getDate()}</strong>
        <span class="n">${label}</span></button>`);
    }
    $("week").innerHTML = html.join("");
  }

  function itemHtml(i, clash) {
    const cls = ["item", i.type === "block" ? "is-block" : "", i.status === "cancelled" ? "is-cancelled" : "", clash ? "is-clash" : ""].join(" ");
    const when = `${hhmm(i.start)}–${hhmm(i.start + i.dur)} · ${i.dur} min`;
    if (i.type === "block") {
      return `<button type="button" class="${cls}" data-id="${esc(i.id)}"><span class="when">${when}</span>
        <span class="what">Blokkert${i.note ? ` – ${esc(i.note)}` : ""}</span></button>`;
    }
    const tel = String(i.phone || "").replace(/[^\d+]/g, "");
    return `<div role="button" tabindex="0" class="${cls}" data-id="${esc(i.id)}">
      <span class="when">${when}${i.status === "cancelled" ? " · AVLYST" : ""}</span>
      <span class="what">${esc(i.service || "Avtale")}${i.addons && i.addons.length ? ` + ${esc(i.addons.join(", "))}` : ""}</span>
      <span class="who">${esc(i.name || "Uten navn")}${tel ? ` · <a href="tel:${esc(tel)}">${esc(i.phone)}</a>` : ""}</span>
      ${i.note ? `<span class="note">${esc(i.note)}</span>` : ""}
      ${i.source === "nettside" ? '<span class="tag">Bestilt på nett</span>' : ""}
    </div>`;
  }

  function renderDay() {
    const d = state.day;
    $("day").value = d;
    const title = fmt(d, { weekday: "long", day: "numeric", month: "long" });
    $("day-title").textContent = d === todayIso() ? `I dag, ${title}` : title;
    if (state.itemsDay !== d) {
      // Dagens avtaler er ikke hentet ennå (eller nettet er borte): ingen oppsummering fra en annen dags liste, og
      // ingenting vist som «ledig» før vi vet (F29). load() skriver «Kunne ikke hente …» hvis hentingen feiler.
      $("day-info").textContent = "";
      $("timeline").innerHTML = '<li class="empty">Henter avtaler …</li>';
      return;
    }
    const hours = hoursOn(d);
    // I starttidsrekkefølge (serveren sorterer, men et kort skal aldri havne feil om den ikke gjorde det)
    const items = state.items.filter((i) => i.date === d).sort((a, b) => a.start - b.start);
    const live = items.filter(active);
    const clashes = new Set();
    live.forEach((a) => live.forEach((b) => { if (a !== b && a.start < b.start + b.dur && b.start < a.start + a.dur) clashes.add(a.id); }));

    const bookings = live.filter((i) => i.type === "booking").length;
    const avtaler = `${bookings} ${bookings === 1 ? "avtale" : "avtaler"}`;
    $("day-info").textContent = hours && fullyBlocked(d, live)
      ? "Stengt – blokkert hele dagen (du kan likevel legge inn avtaler)." + (bookings ? ` ${avtaler} ligger fortsatt inne.` : "")
      : hours
        ? `Åpent ${hhmm(hours[0])}–${hhmm(hours[1])} · ${avtaler}${clashes.size ? " · ⚠ dobbeltbooking" : ""}`
        : "Stengt denne dagen (du kan likevel legge inn avtaler).";

    const rows = [];
    const shown = new Set();
    const row =(i) => `<li class="row"><time>${hhmm(i.start)}</time><div>${itemHtml(i, clashes.has(i.id))}</div></li>`;
    if (hours) {
      // En kunde før åpningstid (f.eks. 09:30) står først, i rekkefølge, ikke nederst etter dagen (F31)
      live.filter((i) => i.start < hours[0]).forEach((i) => { shown.add(i.id); rows.push(row(i)); });
      // Fast halvtimesrutenett. Alt som starter innenfor en rad (også skjeve tider og overlapp) vises i raden;
      // «Ledig» vises bare når ingenting starter der og ingen tidligere avtale fortsatt pågår.
      for (let t = hours[0]; t < hours[1]; t += 30) {
        const here = live.filter((i) => !shown.has(i.id) && i.start >= hours[0] && i.start < t + 30);
        const covering = live.some((i) => i.start < t && i.start + i.dur > t);
        if (here.length) {
          here.forEach((i) => shown.add(i.id));
          rows.push(`<li class="row"><time>${hhmm(here[0].start)}</time><div>${here.map((i) => itemHtml(i, clashes.has(i.id))).join("")}</div></li>`);
        } else if (!covering) {
          rows.push(`<li class="row"><time>${hhmm(t)}</time><button type="button" class="free" data-start="${t}">+ Ledig – legg inn avtale</button></li>`);
        }
      }
    }
    const rest = items.filter((i) => !shown.has(i.id));
    if (rest.length) {
      rows.push(`<li><h4 class="extra-h">${hours ? "Etter stengetid / avlyste" : "Avtaler"}</h4></li>`);
      rest.forEach((i) => rows.push(row(i)));
    }
    if (!rows.length) rows.push('<li class="empty">Ingen avtaler.</li>');
    $("timeline").innerHTML = rows.join("");
  }

  // ---------- Navigasjon ----------
  const go = (d) => { state.day = d; render(); load(); };
  $("prev").addEventListener("click", () => go(addDays(state.day, -1)));
  $("next").addEventListener("click", () => go(addDays(state.day, 1)));
  $("today").addEventListener("click", () => go(todayIso()));
  $("day").addEventListener("change", (e) => { const d = toIso(e.target.value); if (d) go(d); else e.target.value = state.day; });
  $("week").addEventListener("click", (e) => { const b = e.target.closest("[data-day]"); if (b) go(b.dataset.day); });

  $("timeline").addEventListener("click", (e) => {
    if (e.target.closest("a")) return; // ring-lenken
    const free = e.target.closest(".free");
    if (free) return openEditor(null, { type: "booking", start: Number(free.dataset.start) });
    const it = e.target.closest("[data-id]");
    if (it) openEditor(state.items.filter((i) => i.id === it.dataset.id)[0]);
  });
  $("timeline").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " " || e.keyCode === 13 || e.keyCode === 32) && e.target.matches("div[data-id]")) { e.preventDefault(); e.target.click(); }
  });
  $("add").addEventListener("click", () => openEditor(null, { type: "booking" }));
  $("block").addEventListener("click", () => {
    const h = hoursOn(state.day);
    openEditor(null, { type: "block", start: h ? h[0] : 600, dur: h ? h[1] - h[0] : 480 });
  });

  // ---------- Redigering ----------
  const dlg = $("editor");
  const f = $("edit-form");
  const E = f.elements; // f.name ville gitt skjemaets eget navn, så felt hentes via elements
  const services = () => Object.keys((state.config && state.config.durations) || {});

  function fillChoices() {
    E.service.innerHTML = '<option value="">Velg …</option>' + services().map((s) => `<option>${esc(s)}</option>`).join("");
    $("edit-addons").innerHTML = "<legend>Tillegg</legend>" +
      ((state.config && state.config.addons) || []).map((a) => `<label><input type="checkbox" name="addon" value="${esc(a)}"> ${esc(a)}</label>`).join("");
  }
  // Markerer valgt type med en klasse (fungerer også i nettlesere uten CSS :has)
  function syncType() {
    dlg.classList.toggle("is-block", E.type.value === "block");
    f.querySelectorAll(".seg label").forEach((l) => l.classList.toggle("is-on", l.querySelector("input").checked));
  }

  // Første ledige halvtime i dag (eller åpningstid)
  function firstFree() {
    const h = hoursOn(state.day) || [600, 1080];
    const live = state.items.filter((i) => i.date === state.day && active(i));
    for (let t = h[0]; t < h[1]; t += 30) if (!live.some((i) => i.start < t + 30 && t < i.start + i.dur)) return t;
    return h[0];
  }

  function openEditor(item, preset = {}) {
    fillChoices();
    state.editing = item || null;
    const v = item || Object.assign({ type: "booking", date: state.day, start: firstFree(), dur: 30, service: "", addons: [], name: "", phone: "", note: "", status: "confirmed" }, preset);
    $("edit-title").textContent = item ? (item.type === "block" ? "Endre blokkering" : "Endre avtale") : (v.type === "block" ? "Blokker tid" : "Ny avtale");
    dlg.classList.toggle("is-edit", !!item);
    E.type.value = v.type;
    E.date.value = v.date || state.day;
    E.start.value = hhmm(v.start != null ? v.start : 600);
    E.dur.value = v.dur != null ? v.dur : 30;
    if (v.service && !services().includes(v.service)) E.service.insertAdjacentHTML("beforeend", `<option>${esc(v.service)}</option>`);
    E.service.value = v.service || "";
    f.querySelectorAll("[name=addon]").forEach((c) => { c.checked = (v.addons || []).includes(c.value); });
    E.name.value = v.name || "";
    E.phone.value = v.phone || "";
    E.note.value = v.note || "";
    E.cancelled.checked = v.status === "cancelled";
    $("edit-msg").textContent = "";
    syncType();
    dlg.showModal();
    (item ? E.start : v.type === "block" ? E.dur : E.service).focus();
  }

  f.addEventListener("change", (e) => {
    if (e.target.name === "type") syncType();
    if (e.target.name === "service" && state.config && state.config.durations && state.config.durations[e.target.value]) E.dur.value = state.config.durations[e.target.value];
  });
  $("cancel-edit").addEventListener("click", () => dlg.close());

  function payload() {
    const isBlock = E.type.value === "block";
    return {
      type: E.type.value,
      date: toIso(E.date.value) || E.date.value,
      start: toMin(E.start.value),
      dur: Number(E.dur.value),
      service: isBlock ? "" : E.service.value,
      addons: isBlock ? [] : Array.prototype.map.call(f.querySelectorAll("[name=addon]:checked"), (c) => c.value),
      name: isBlock ? "" : E.name.value.trim(),
      phone: isBlock ? "" : E.phone.value.trim(),
      note: E.note.value.trim(),
      status: !isBlock && E.cancelled.checked ? "cancelled" : "confirmed",
    };
  }

  function save(force = false) {
    const body = payload();
    if (!body.date || Number.isNaN(body.start)) return ($("edit-msg").textContent = "Velg dato og tid.");
    if (body.type === "booking" && !body.service && !body.name) return ($("edit-msg").textContent = "Skriv inn tjeneste eller navn.");
    const q = force ? "?force=1" : "";
    $("save").disabled = true;
    const sent = state.editing
      ? api(`/api/admin/items/${encodeURIComponent(state.editing.id)}${q}`, { method: "PATCH", body: JSON.stringify(body) })
      : api(`/api/admin/items${q}`, { method: "POST", body: JSON.stringify(body) });
    return sent.then(() => {
      dlg.close();
      if (body.date !== state.day) state.day = body.date;
      return load();
    }).catch((err) => {
      if (err.status === 409 && !force) {
        if (confirm(`${err.message}\n\nVil du lagre likevel (dobbeltbooking)?`)) return save(true);
      }
      if (err.status !== 401) $("edit-msg").textContent = err.message;
    }).then(() => {
      $("save").disabled = false;
    });
  }
  f.addEventListener("submit", (e) => { e.preventDefault(); save(); });

  $("delete").addEventListener("click", () => {
    const it = state.editing;
    if (!it) return;
    const what = it.type === "block" ? "blokkeringen" : `avtalen med ${it.name || "kunden"}`;
    if (!confirm(`Slette ${what} ${fmt(it.date, { day: "numeric", month: "long" })} kl. ${hhmm(it.start)} for godt?\n\nTips: huk av «Avlyst» i stedet hvis du vil ha historikken.`)) return;
    api(`/api/admin/items/${encodeURIComponent(it.id)}`, { method: "DELETE" }).then(() => {
      dlg.close();
      return load();
    }).catch((err) => { if (err.status !== 401) $("edit-msg").textContent = err.message; });
  });

  // ---------- Oppsett: kalender på telefonen ----------
  // Lenken bærer en hemmelighet (kalenderapper kan ikke logge inn), så den hentes først når dialogen åpnes,
  // og tas bort fra siden igjen når den lukkes.
  const settings = $("settings");
  const offline = (err) => (err.status ? err.message : "Ingen forbindelse. Prøv igjen.");
  function calMsg(text, kind) {
    $("cal-msg").textContent = text || "";
    $("cal-msg").className = "msg" + (kind ? " " + kind : "");
  }
  function calShow(cal) {
    const on = !!(cal && cal.enabled && cal.links);
    $("cal-none").hidden = on || !cal;
    $("cal-ready").hidden = !on;
    $("cal-ios").href = on ? cal.links.webcal : "#";
    $("cal-google").href = on ? cal.links.google : "#";
    $("cal-url").value = on ? cal.links.https : "";
  }
  let calSeq = 0;
  function calLoad() {
    const seq = ++calSeq;
    calShow(null);
    calMsg("Henter …", "info");
    return api("/api/admin/calendar").then((cal) => {
      if (seq !== calSeq) return;
      calShow(cal);
      calMsg(cal.enabled ? "" : cal.expired
        ? "Passordet er byttet, så den gamle kalenderlenken virker ikke lenger. Lag en ny lenke, slett den gamle kalenderen på telefonen og legg til den nye."
        : "Du har ingen kalenderlenke ennå.", "info");
    }).catch((err) => { if (seq === calSeq && err.status !== 401) calMsg(offline(err)); });
  }
  function calMake(replace) {
    const btn = replace ? $("cal-renew") : $("cal-create");
    const seq = ++calSeq;
    btn.disabled = true;
    calMsg(replace ? "Lager ny lenke …" : "Lager lenke …", "info");
    return api("/api/admin/calendar", { method: "POST", body: JSON.stringify({ replace: !!replace }) }).then((cal) => {
      if (seq !== calSeq) return;
      calShow(cal);
      calMsg(replace
        ? "Ny lenke laget. Den gamle virker ikke lenger: slett den gamle kalenderen på telefonen og legg til den nye."
        : "Lenken er klar. Legg den til på telefonen.", "ok");
    }).catch((err) => { if (seq === calSeq && err.status !== 401) calMsg(offline(err)); }).then(() => {
      btn.disabled = false;
    });
  }
  function calClear() { calSeq++; calShow(null); calMsg(""); }

  // Fokus på «Lukk» (har autofocus i admin.html; satt her også for nettlesere som ikke følger det i en <dialog>):
  // ellers kunne fokus havne på «Logg ut», og ett Enter eller mellomrom logget Viggo ut
  $("settings-open").addEventListener("click", () => { settings.showModal(); $("settings-close").focus(); calLoad(); pushLoad(); });
  $("settings-close").addEventListener("click", () => { settings.close(); calClear(); pushClear(); });
  settings.addEventListener("close", () => { calClear(); pushClear(); }); // Esc i nettlesere med ekte <dialog>
  $("cal-create").addEventListener("click", () => calMake(false));
  $("cal-renew").addEventListener("click", () => {
    if (!confirm("Lage en ny kalenderlenke?\n\nDen gamle lenken slutter å virke med en gang. Kalenderen må legges til på nytt på alle telefoner og PC-er som bruker den.")) return;
    calMake(true);
  });

  // Kopier: utklippstavle-API-et der det finnes, ellers execCommand («copy») som også virker i Safari 10,
  // Chrome 60 og Firefox 55. Kan nettleseren ingen av delene, skjules knappen (lenken kan kopieres for hånd).
  const hasClipboard = () => !!(navigator.clipboard && navigator.clipboard.writeText);
  const canExecCopy = () => { try { return !!(document.queryCommandSupported && document.queryCommandSupported("copy")); } catch (e) { return false; } };
  function execCopy(input) {
    try {
      input.focus();
      input.select();
      if (input.setSelectionRange) input.setSelectionRange(0, input.value.length); // iPhone
      return document.execCommand("copy") === true;
    } catch (e) { return false; }
  }
  $("cal-copy").hidden = !(hasClipboard() || canExecCopy());
  $("cal-copy").addEventListener("click", () => {
    const input = $("cal-url");
    if (!input.value) return;
    const copied = () => calMsg("Lenken er kopiert.", "ok");
    const fallback = () => {
      if (execCopy(input)) return copied();
      input.select();
      calMsg("Kunne ikke kopiere. Hold fingeren på lenken og velg Kopier.");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(input.value).then(copied, fallback);
    else fallback();
  });
  $("cal-url").addEventListener("click", (e) => e.target.select());

  // ---------- Oppsett: varsler på denne enheten (Web Push) ----------
  // Krever service worker, PushManager og Notification: Chrome, Edge og Firefox på PC og Android, Safari 16+ på Mac,
  // og iPhone/iPad med iOS 16.4+ når Timebok er lagt til på Hjem-skjermen. Mangler noe, skjules knappene.
  // Serveren lager nøkkelparet selv; siden får bare den offentlige nøkkelen (GET /api/admin/push).
  const SW_URL = "/admin-sw.js";
  const SW_SCOPE = "/admin";
  const BLOCKED = "Varsler er blokkert for denne siden. Tillat varsler i nettleserens innstillinger (på iPhone: Innstillinger → Varslinger → Timebok), og trykk Prøv igjen.";
  // Svaret på «Prøv igjen» når varslene fortsatt er blokkert, så trykket aldri ser ut som om ingenting skjedde
  const STILL_BLOCKED = "Fortsatt blokkert. Åpne nettleserens innstillinger for denne siden (på iPhone: Innstillinger → Varslinger → Timebok), velg Tillat for varsler, og kom tilbake hit.";
  const sw = () => ("serviceWorker" in navigator && navigator.serviceWorker ? navigator.serviceWorker : null);
  const notif = () => ("Notification" in window ? Notification : null);
  const pushSupported = () => !!(sw() && sw().register && "PushManager" in window && notif());
  const permission = () => (notif() ? notif().permission : "denied");
  const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = () => navigator.standalone === true || !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  // others: hvor mange andre enheter som får varsler (da vises «Slå av varsler på alle andre enheter»)
  // lost: abonnementet her er fjernet fordi push-tjenesten sa at det var borte, så «av» sier at de må slås på igjen
  // limited: { mode, text } når denne nettleseren ikke kan få varsler (eller de er blokkert): panelet viser bare
  // teksten, eventuelt «Prøv igjen», og «Slå av varsler på alle andre enheter» når andre enheter får dem
  const pushState = { key: null, sub: null, reg: null, others: 0, lost: false, limited: null };
  let pushSeq = 0;

  function pushMsg(text, kind) {
    $("push-msg").textContent = text || "";
    $("push-msg").className = "msg" + (kind ? " " + kind : "");
  }
  // mode: «off» (Slå på), «on» (Send testvarsel, Slå av), «blocked» (Prøv igjen) eller null (ingen knapper).
  // «Slå av varsler på alle andre enheter» vises i alle tilstander når andre enheter får varsler, også i en nettleser
  // som ikke kan få varsler selv (en iPhone i Safari, en gammel PC): da kan en mistet telefon slås av derfra.
  // Knappene blir alltid trykkbare igjen her, så «Oppsett» lukket og åpnet på nytt aldri viser en knapp som henger
  // fra et tidligere trykk.
  const PUSH_BUTTONS = ["push-on", "push-test", "push-off", "push-retry", "push-reset"];
  function pushButtons(mode) {
    $("push-retry").hidden = mode !== "blocked";
    $("push-on").hidden = mode !== "off";
    $("push-test").hidden = mode !== "on";
    $("push-off").hidden = mode !== "on";
    $("push-reset").hidden = !(pushState.others > 0);
    PUSH_BUTTONS.forEach((id) => { $(id).disabled = false; });
  }
  // En knapp er grået ut mens trykket på den arbeider
  const pushBusy = () => PUSH_BUTTONS.some((id) => $(id).disabled);
  // Svarer ikke push-tjenesten (nettet er nede, eller den er sperret), blir subscribe() aldri ferdig. Da gir siden
  // beskjed etter SUBSCRIBE_WAIT_MS, i stedet for å henge på «Slår på …».
  const SUBSCRIBE_WAIT_MS = 20000;
  const NO_CONTACT = "Fikk ikke kontakt med varseltjenesten. Sjekk nettet og prøv igjen.";
  function withinTime(promise, ms, message) {
    let timer;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(message), { user: true, timeout: true })), ms);
    });
    return Promise.race([promise, late]).then((v) => { clearTimeout(timer); return v; }, (err) => { clearTimeout(timer); throw err; });
  }
  const others = (n) => (n > 0 ? ` ${n} ${n === 1 ? "annen enhet får" : "andre enheter får"} varsler.` : "");
  // Når en kort innlogging går ut (until fra serveren): «kl. 21:00», «i morgen kl. 09:00»
  function untilText(until) {
    const d = new Date(until);
    if (isNaN(d.getTime())) return "";
    const day = iso(d) === todayIso() ? "" : iso(d) === addDays(todayIso(), 1) ? "i morgen " : fmt(iso(d), { day: "numeric", month: "long" }) + " ";
    return day + "kl. " + hhmm(d.getHours() * 60 + d.getMinutes());
  }
  // devices: alle enhetene serveren sender til (med denne, når den er på). until: er Viggo logget inn uten «Hold meg
  // innlogget», får enheten varsler bare til den innloggingen går ut, og det står her.
  function pushShow(mode, devices, until) {
    const n = Number(devices) || 0;
    pushState.others = mode === "on" ? Math.max(0, n - 1) : n;
    pushButtons(mode);
    if (mode === "on") pushState.lost = false;
    const when = mode === "on" && until ? untilText(until) : "";
    if (when) pushMsg("Varsler er på til innloggingen her går ut, " + when + ". Logger du inn med «Hold meg innlogget», får du dem hele tiden." + others(pushState.others), "ok");
    else if (mode === "on") pushMsg("Varsler er på. Du får et varsel her hver gang en kunde bestiller time." + others(pushState.others), "ok");
    else pushMsg((pushState.lost ? "Varslene må slås på igjen på denne enheten." : "Varsler er av på denne enheten.") + others(pushState.others), "info");
  }
  function pushError(err) {
    if (err && (err.status || err.user)) return err.message;
    if (err && err.name === "NotAllowedError") return BLOCKED;
    if (err && err.name === "TypeError") return "Ingen forbindelse. Prøv igjen.";
    return "Kunne ikke slå på varsler på denne enheten. Prøv igjen.";
  }

  // Den offentlige nøkkelen (base64url) som bytes, slik pushManager.subscribe vil ha den
  function keyBytes(b64) {
    const s = String(b64 || "").replace(/-/g, "+").replace(/_/g, "/");
    const bin = window.atob(s + "===".slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Er abonnementet laget med serverens nøkkel? (Eldre nettlesere viser ikke nøkkelen: da antar vi ja.)
  function sameKey(sub, b64) {
    const k = sub.options && sub.options.applicationServerKey;
    if (!k) return true;
    const a = new Uint8Array(k), b = keyBytes(b64);
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  // JSON.stringify bruker PushSubscription.toJSON(): { endpoint, expirationTime, keys: { p256dh, auth } }
  const saveSub = (sub) => api("/api/admin/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub }) });
  function swRegistration() {
    const c = sw();
    if (!c) return Promise.reject(new Error("Denne nettleseren kan ikke vise varsler."));
    return c.register(SW_URL, { scope: SW_SCOPE }).then(() => c.ready);
  }

  // Denne nettleseren kan ikke få varsler, eller de er blokkert (mode «blocked»): vis text, og spør serveren hvor mange
  // andre enheter som får varsler (ingen service worker og ingen abonnement trengs for det).
  function pushLimited(seq, mode, text) {
    pushState.limited = { mode, text };
    pushButtons(mode);
    pushMsg(text, "info");
    return api("/api/admin/push").then((info) => {
      if (seq !== pushSeq) return;
      pushState.others = Math.max(0, Number(info.devices) || 0);
      pushButtons(mode);
      pushMsg((text + others(pushState.others)).trim(), "info");
    }).catch(() => {}); // 401 viser innloggingen; ellers står teksten uten antallet
  }

  // Når «Oppsett» åpnes: vis om denne enheten får varsler, og gi serveren abonnementet på nytt (nettleseren kan ha fornyet det)
  // retry: Viggo trykket «Prøv igjen» (er varslene fortsatt blokkert, sier panelet det med andre ord)
  function pushLoad(retry) {
    const seq = ++pushSeq;
    pushState.sub = null;
    pushState.reg = null;
    pushState.others = 0;
    pushState.limited = null;
    pushButtons(null);
    $("push-ios").hidden = true;
    if (!pushSupported()) {
      if (isIos() && isStandalone()) return pushLimited(seq, null, "Varsler på iPhone krever iOS 16.4 eller nyere. Oppdater under Innstillinger → Generelt → Programvareoppdatering.");
      if (isIos()) { $("push-ios").hidden = false; return pushLimited(seq, null, ""); }
      return pushLimited(seq, null, "Denne nettleseren kan ikke vise varsler. Bruk en nyere Chrome, Edge, Firefox eller Safari.");
    }
    if (permission() === "denied") return pushLimited(seq, "blocked", retry === true ? STILL_BLOCKED : BLOCKED);
    pushMsg("Henter …", "info");
    return Promise.all([api("/api/admin/push"), swRegistration().then((reg) => { pushState.reg = reg; return reg.pushManager.getSubscription(); })]).then((r) => {
      if (seq !== pushSeq) return;
      const info = r[0], sub = r[1];
      pushState.key = info.publicKey;
      if (!sub || permission() !== "granted") return pushShow("off", info.devices);
      // Laget med en nøkkel serveren ikke har lenger, eller push-tjenesten har sagt at det er borte (serveren svarer
      // 410; Chrome beholder et slikt dødt abonnement): det virker ikke, så det fjernes. «Slå på varsler» lager et nytt.
      const drop = () => sub.unsubscribe().catch(() => false).then(() => {
        pushState.lost = true;
        if (seq !== pushSeq) return;
        pushShow("off", info.devices);
      });
      if (!sameKey(sub, info.publicKey)) return drop();
      return saveSub(sub).then((res) => {
        if (seq !== pushSeq) return;
        pushState.sub = sub;
        pushShow("on", res.devices, res.until);
      }, (err) => {
        if (err.status === 410) return drop();
        throw err;
      });
    }).catch((err) => {
      if (seq !== pushSeq || err.status === 401) return;
      pushButtons(null);
      pushMsg(pushError(err));
    });
  }
  function pushClear() { pushSeq++; pushState.sub = null; pushState.reg = null; pushState.others = 0; pushState.limited = null; pushButtons(null); pushMsg(""); $("push-ios").hidden = true; }

  $("push-on").addEventListener("click", () => {
    const btn = $("push-on");
    const reg = pushState.reg;
    if (!reg || !pushState.key) return;
    const seq = ++pushSeq;
    btn.disabled = true;
    pushMsg("Slår på …", "info");
    // subscribe() kalles rett i trykket og spør selv om lov til å vise varsler. Safari (også på iPhone) godtar det
    // bare i selve trykket, så ingenting annet får vente først.
    let subscribing;
    try {
      subscribing = reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pushState.key) });
    } catch (e) {
      subscribing = Promise.reject(e);
    }
    // Blir abonnementet likevel ferdig etter tidsfristen, får serveren det, så enheten får varsler
    let timedOut = false;
    subscribing.then((sub) => {
      if (!timedOut) return;
      saveSub(sub).then((res) => {
        if (seq !== pushSeq) return;
        pushState.sub = sub;
        pushShow("on", res.devices, res.until);
      }, () => {});
    }, () => {});
    withinTime(subscribing, SUBSCRIBE_WAIT_MS, NO_CONTACT).catch((err) => {
      if (err && err.timeout) { timedOut = true; throw err; }
      const answer = permission();
      if (answer === "granted") throw err;
      if (answer === "denied") pushButtons("blocked");
      throw Object.assign(new Error(answer === "denied" ? BLOCKED : "Du må tillate varsler for å få dem. Trykk «Slå på varsler» og velg Tillat."), { user: true });
    })
      .then((sub) => saveSub(sub).then((res) => {
        if (seq !== pushSeq) return;
        pushState.sub = sub;
        pushShow("on", res.devices, res.until);
      }, (err) => {
        // Serveren godtar det ikke (400), eller det er borte hos push-tjenesten (410): ikke la det henge igjen
        if (err.status === 400 || err.status === 410) sub.unsubscribe().catch(() => false);
        throw err;
      }))
      .catch((err) => { if (seq === pushSeq && err.status !== 401) pushMsg(pushError(err)); })
      .then(() => { btn.disabled = false; });
  });

  $("push-test").addEventListener("click", () => {
    const sub = pushState.sub;
    if (!sub) return;
    const btn = $("push-test");
    btn.disabled = true;
    pushMsg("Sender …", "info");
    api("/api/admin/push/test", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) }).then(() => {
      pushMsg("Testvarsel sendt. Det kommer om noen sekunder. Kommer det ikke, sjekk at varsler er tillatt for nettleseren (eller Timebok) i innstillingene.", "ok");
    }).catch((err) => {
      if (err.status === 401) return;
      if (err.status === 404 || err.status === 410) {
        // Serveren eller push-tjenesten kjenner ikke enheten lenger: start på nytt med «Slå på varsler»
        pushState.sub = null;
        sub.unsubscribe().catch(() => false);
        pushButtons("off");
      }
      pushMsg(pushError(err));
    }).then(() => { btn.disabled = false; });
  });

  $("push-off").addEventListener("click", () => {
    const sub = pushState.sub;
    if (!sub) return;
    const btn = $("push-off");
    const seq = ++pushSeq;
    const endpoint = sub.endpoint;
    btn.disabled = true;
    pushMsg("Slår av …", "info");
    // Først i nettleseren (ellers kunne siden melde den på igjen neste gang), så på serveren
    sub.unsubscribe().catch(() => false).then((ok) => {
      if (!ok) throw Object.assign(new Error("Kunne ikke slå av varsler her. Prøv igjen."), { user: true });
      pushState.sub = null;
      return api("/api/admin/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) }).then((res) => {
        if (seq !== pushSeq) return;
        pushShow("off", res.devices);
        pushMsg("Varsler er slått av på denne enheten." + others(res.devices), "ok");
      }, (err) => {
        if (seq !== pushSeq || err.status === 401) return;
        pushButtons("off");
        pushMsg("Varsler er slått av her. Serveren fikk ikke beskjed nå, men det ordner seg av seg selv.", "info");
      });
    }).catch((err) => { if (seq === pushSeq) pushMsg(pushError(err)); }).then(() => { btn.disabled = false; });
  });

  // «Slå av varsler på alle andre enheter» (en mistet, solgt eller lånt telefon, eller noen som ikke skal ha varslene):
  // serveren glemmer alle enhetene, og får denne enheten varsler, meldes den på igjen med en gang.
  $("push-reset").addEventListener("click", () => {
    const n = pushState.others;
    const which = n === 1 ? "den andre enheten" : `de ${n} andre enhetene`;
    if (!confirm(`Slå av varsler på ${which}?\n\nDe får ikke flere varsler om nye bestillinger. En enhet som fortsatt er logget inn, slår dem på igjen neste gang timeboken åpnes der. Er en telefon mistet eller stjålet, bytt også admin-passordet: da blir den logget ut for godt.`)) return;
    const btn = $("push-reset");
    const seq = ++pushSeq;
    const sub = pushState.sub;
    btn.disabled = true;
    pushMsg("Slår av varsler på de andre enhetene …", "info");
    api("/api/admin/push/reset", { method: "POST", body: "{}" }).then(() => {
      if (!sub) {
        if (seq !== pushSeq) return;
        // Uten varsler her (av, blokkert eller ikke mulig i denne nettleseren): de samme knappene som før, uten
        // «Slå av varsler på alle andre enheter»
        const limited = pushState.limited;
        if (limited) { pushState.others = 0; pushButtons(limited.mode); } else pushShow("off", 0);
        pushMsg("Varsler er slått av på alle andre enheter.", "ok");
        return;
      }
      return saveSub(sub).then((res) => {
        if (seq !== pushSeq) return;
        pushShow("on", res.devices, res.until);
        pushMsg("Varsler er slått av på alle andre enheter. Denne enheten får fortsatt varsler.", "ok");
      }, (err) => {
        if (seq !== pushSeq || err.status === 401) return;
        if (err.status === 410) sub.unsubscribe().catch(() => false); // borte hos push-tjenesten
        pushShow("off", 0);
        pushMsg(err.status === 410
          ? "Varsler er slått av på alle andre enheter. Varslene må slås på igjen på denne enheten."
          : "Varsler er slått av på alle andre enheter, men denne enheten ble ikke slått på igjen. Lukk og åpne Oppsett for å prøve igjen.");
      });
    }).catch((err) => { if (seq === pushSeq && err.status !== 401) pushMsg(pushError(err)); }).then(() => { btn.disabled = false; });
  });

  // Ved oppstart: får denne enheten varsler, gi serveren abonnementet på nytt (nettleseren kan ha fornyet det).
  // Gjør ingenting (og registrerer ingen service worker) på en enhet som aldri har slått på varsler.
  function pushSync() {
    const c = sw();
    if (!pushSupported() || permission() !== "granted" || !c.getRegistration) return Promise.resolve();
    return c.getRegistration(SW_SCOPE).then((reg) => (reg ? reg.pushManager.getSubscription() : null)).then((sub) => {
      if (!sub) return null;
      return api("/api/admin/push").then((info) => (sameKey(sub, info.publicKey) ? saveSub(sub) : null)).catch((err) => {
        // Borte hos push-tjenesten: fjern det, så «Oppsett» viser «av» og «Slå på varsler» lager et nytt
        if (err && err.status === 410) { pushState.lost = true; return sub.unsubscribe(); }
      });
    }).catch(() => {});
  }

  // «Logg ut»: får denne enheten varsler om nye bestillinger (med kundens navn), spør siden først om de skal slås av
  // også, så en lånt eller delt telefon eller PC ikke fortsetter å vise dem. Ja (OK): slås av i nettleseren og på
  // serveren mens innloggingen ennå gjelder, og først da logges det ut. Nei: det står på innloggingssiden at enheten
  // fortsatt får varsler. Uten varsler (eller i en nettleser uten push) logges det ut med en gang.
  const LOOKUP_WAIT_MS = 3000;
  const LOGOUT_WAIT_MS = 8000;
  function thisDeviceSubscription() {
    const c = sw();
    if (!pushSupported() || permission() !== "granted" || !c.getRegistration) return Promise.resolve(null);
    const look = c.getRegistration(SW_SCOPE).then((reg) => (reg ? reg.pushManager.getSubscription() : null));
    return withinTime(look, LOOKUP_WAIT_MS, "").catch(() => null);
  }
  // Slår av i nettleseren og på serveren samtidig, og venter høyst LOGOUT_WAIT_MS. Svarer om minst én av dem lyktes
  // (da kommer det ikke flere varsler hit: push-tjenesten svarer 410 for et avsluttet abonnement, og serveren
  // sletter enheten).
  function turnOffHere(sub) {
    let browserOk = false, serverOk = false;
    const browser = Promise.resolve().then(() => sub.unsubscribe()).then((ok) => { browserOk = ok === true; }, () => {});
    const server = api("/api/admin/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) })
      .then(() => { serverOk = true; }, () => {});
    return withinTime(Promise.all([browser, server]), LOGOUT_WAIT_MS, "").catch(() => {}).then(() => browserOk || serverOk);
  }
  $("logout").addEventListener("click", () => {
    const btn = $("logout");
    if (btn.disabled) return;
    btn.disabled = true;
    // Svarer [tekst, stil] for innloggingssiden: å være logget ut er ingen feil, så bare det som må rettes er rødt
    const done = ["Du er logget ut.", "ok"];
    thisDeviceSubscription().then((sub) => {
      if (!sub) return done;
      const yes = confirm("Slå av varsler om nye bestillinger på denne enheten også?\n\nOK: varslene slås av her (lurt på en lånt eller delt telefon eller PC).\nAvbryt: du får fortsatt varsel om nye bestillinger her, også når du er logget ut.");
      if (!yes) return done; // innloggingssiden sier at varslene fortsatt er på, med «Slå av varsler her»
      return turnOffHere(sub).then((stopped) => (stopped
        ? ["Du er logget ut, og varsler om nye bestillinger er slått av på denne enheten.", "ok"]
        : ["Du er logget ut, men varslene på denne enheten kunne ikke slås av nå. Slå av varsler for denne siden i nettleserens innstillinger.", ""]));
    }).catch(() => done).then((msg) => {
      btn.disabled = false;
      setToken(null);
      showLogin(msg[0], msg[1]);
    });
  });

  // Har Viggo tillatt varsler i innstillingene, viser «Prøv igjen» (og det å komme tilbake til siden, eller at
  // nettleseren melder at tillatelsen er endret) panelet på nytt, så han slipper å lukke og åpne «Oppsett».
  $("push-retry").addEventListener("click", () => pushLoad(true));
  const pushRefresh = () => { if (settings.open && getToken() && !pushBusy()) pushLoad(); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pushRefresh(); });
  if (pushSupported() && navigator.permissions && typeof navigator.permissions.query === "function") {
    try {
      navigator.permissions.query({ name: "notifications" }).then((status) => {
        if (status && "onchange" in status) status.onchange = pushRefresh;
      }, () => {});
    } catch (e) { /* nettleseren kjenner ikke «notifications» her */ }
  }

  // Trykk på et varsel mens timeboken er åpen: admin-sw.js sier hvilken dag som skal vises
  if (sw() && sw().addEventListener) {
    sw().addEventListener("message", (e) => {
      const d = e.data;
      if (d && d.type === "open-day" && typeof d.date === "string" && toIso(d.date) === d.date && getToken()) go(d.date);
    });
  }

  // ---------- Oppstart ----------
  // Hold oversikten fersk (nye nettbestillinger dukker opp av seg selv)
  setInterval(() => { if (!document.hidden && !dlg.open && getToken() && !$("app").hidden) load(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && getToken() && !$("app").hidden) load(); });

  if (getToken()) { showApp(); load(); pushSync(); } else showLogin();
})();
