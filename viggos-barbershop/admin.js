// Timebok for Viggo's Barbershop: se, legg inn, flytt, avlys og blokker timer.
// Snakker med /api/admin/* (netlify/functions/admin.mjs). Innloggingen lagres i nettleseren.
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

  function showLogin(message = "") {
    $("app").hidden = true;
    $("login").hidden = false;
    $("login-msg").textContent = message;
    $("pw").focus();
  }
  function showApp() {
    $("login").hidden = true;
    $("app").hidden = false;
  }

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
    $("login-msg").textContent = "";
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
    })).catch((err) => {
      $("login-msg").textContent = err.message;
      $("pw").select();
    }).then(() => {
      btn.disabled = false;
    });
  });

  $("logout").addEventListener("click", () => { setToken(null); showLogin("Du er logget ut."); });

  function api(path, opts = {}) {
    return fetch(path, Object.assign({}, opts, {
      headers: Object.assign({ "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` }, opts.headers || {}),
      cache: "no-store",
    })).then((res) => res.json().catch(() => ({})).then((data) => {
      if (res.status === 401) { setToken(null); showLogin("Logg inn på nytt."); throw Object.assign(new Error(data.error || "Logg inn"), { status: 401 }); }
      if (!res.ok) throw Object.assign(new Error(data.error || "Noe gikk galt."), { status: res.status });
      return data;
    }));
  }

  // ---------- Data ----------
  const state = { day: todayIso(), items: [], week: [], config: null, editing: null };
  const hoursOn = (d) => { const h = state.config && state.config.hours; return h ? h[parse(d).getDay()] : null; };

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
      if (err.status !== 401) $("sync").textContent = "Ingen forbindelse";
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
      const closed = !hoursOn(d);
      html.push(`<button type="button" data-day="${d}" class="${d === state.day ? "is-active" : ""}${closed ? " is-closed" : ""}">
        <span>${esc(fmt(d, { weekday: "short" }).replace(".", ""))}</span><strong>${parse(d).getDate()}</strong>
        <span class="n">${n ? `${n} ${n === 1 ? "time" : "timer"}` : closed ? "stengt" : "&nbsp;"}</span></button>`);
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
    const hours = hoursOn(d);
    const items = state.items.filter((i) => i.date === d);
    const live = items.filter(active);
    const clashes = new Set();
    live.forEach((a) => live.forEach((b) => { if (a !== b && a.start < b.start + b.dur && b.start < a.start + a.dur) clashes.add(a.id); }));

    const bookings = live.filter((i) => i.type === "booking").length;
    $("day-info").textContent = hours
      ? `Åpent ${hhmm(hours[0])}–${hhmm(hours[1])} · ${bookings} ${bookings === 1 ? "avtale" : "avtaler"}${clashes.size ? " · ⚠ dobbeltbooking" : ""}`
      : "Stengt denne dagen (du kan likevel legge inn avtaler).";

    const rows = [];
    const shown = new Set();
    if (state.itemsDay !== d) {
      // Dagens avtaler er ikke hentet ennå: ikke vis noe som «ledig» før vi vet
      $("timeline").innerHTML = '<li class="empty">Henter avtaler …</li>';
      return;
    }
    if (hours) {
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
      rows.push(`<li><h4 class="extra-h">${hours ? "Utenfor åpningstid / avlyste" : "Avtaler"}</h4></li>`);
      rest.forEach((i) => rows.push(`<li class="row"><time>${hhmm(i.start)}</time><div>${itemHtml(i, clashes.has(i.id))}</div></li>`));
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

  // ---------- Oppstart ----------
  // Hold oversikten fersk (nye nettbestillinger dukker opp av seg selv)
  setInterval(() => { if (!document.hidden && !dlg.open && getToken() && !$("app").hidden) load(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && getToken() && !$("app").hidden) load(); });

  if (getToken()) { showApp(); load(); } else showLogin();
})();
