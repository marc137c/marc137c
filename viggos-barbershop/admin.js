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
  // Når en avtale ble bestilt (createdAt): «12.11. kl. 14:05»
  const created = (s) => {
    const d = new Date(s);
    return isNaN(d.getTime()) ? "" : `${d.getDate()}.${d.getMonth() + 1}. kl. ${hhmm(d.getHours() * 60 + d.getMinutes())}`;
  };

  // ---------- Innlogging ----------
  // Safari i privat modus kan ikke lagre noe; da huskes innloggingen så lenge siden er åpen
  let memToken = null;
  // Ligger innloggingen i localStorage («Hold meg innlogget»)? En ny billett for samme innlogging lagres samme sted.
  const tokenRemembered = () => { try { return !!localStorage.getItem(KEY); } catch (e) { return false; } };
  const getToken = () => { if (memToken) return memToken; try { return localStorage.getItem(KEY) || sessionStorage.getItem(KEY); } catch (e) { return null; } };
  function setToken(t, remember) {
    memToken = t || null;
    try {
      localStorage.removeItem(KEY); sessionStorage.removeItem(KEY);
      if (t) (remember ? localStorage : sessionStorage).setItem(KEY, t);
    } catch (e) { /* privat modus */ }
  }

  // Enhetsmerket fra serveren (F5): sendes med hver innlogging, så Viggos egen telefon kommer inn selv om fremmede har
  // fylt opp grensen for feil passord. Det er ingen innlogging, så det blir liggende ved «Logg ut». Privat modus
  // uten lagring: da logges det inn uten.
  const DEVICE_KEY = "viggo-admin-device";
  const getDevice = () => { try { return localStorage.getItem(DEVICE_KEY) || ""; } catch (e) { return ""; } };
  const setDevice = (m) => { try { if (typeof m === "string" && m) localStorage.setItem(DEVICE_KEY, m); } catch (e) { /* privat modus */ } };

  // Lukker åpne dialoger (f.eks. når innloggingen har gått ut mens «Oppsett» er åpen)
  const closeDialogs = () => Array.prototype.forEach.call(document.querySelectorAll("dialog"), (d) => { if (d.open) d.close(); });

  // kind: «ok» (grønn, f.eks. «Du er logget ut.»), «info» (nøytral) eller ingenting (rød: noe gikk galt)
  function loginMsg(text, kind) {
    $("login-msg").textContent = text || "";
    $("login-msg").className = "msg" + (kind ? " " + kind : "");
  }
  // Gikk innloggingen ut mens en avtale var åpen for redigering, kommer arket tilbake (med det som var skrevet) når
  // Viggo har logget inn igjen (F28). Bare redigeringsarket: «Oppsett» har kalenderhemmeligheten og forblir lukket.
  let resumeEdit = false;
  // Handlingen i arket som en utløpt innlogging (401) avbrøt, og det arket sier når det kommer tilbake (runde 2:
  // «trykk Lagre» etter en avbrutt Slett slettet ingenting)
  let resumeAction = null;
  const RESUME_TEXT = {
    save: "Du er logget inn igjen – trykk Lagre.",
    delete: "Du er logget inn igjen – trykk Slett for å slette avtalen.",
    "cancel-phone": "Du er logget inn igjen – trykk «Avlys alle nettbestillinger» for å avlyse dem.",
  };
  function showLogin(message = "", kind = "") {
    if ($("editor").open) resumeEdit = true;
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
    // Paneler i #app som tegnes av andre skript (admin-stats.js) får beskjed med en gang (runde 2, SPEC R29)
    const shown = Array.isArray(window.adminShownListeners) ? window.adminShownListeners.slice() : [];
    shown.forEach((fn) => { try { fn(); } catch (e) { /* en feil i et panel stopper ikke timeboken */ } });
  }

  // Innloggingssiden på en enhet som fortsatt har varsler om nye bestillinger slått på (innloggingen har gått ut,
  // fanen ble lukket, eller Viggo logget ut uten å slå dem av): det står der, med «Slå av varsler her». Knappen
  // trenger ingen innlogging: nettleseren avslutter abonnementet, push-tjenesten svarer 410 neste gang, og serveren
  // sletter enheten.
  // Det denne enheten husker om sine egne varsler (egen nøkkel i localStorage, alltid i try/catch):
  // { endpoint, until } når serveren har tatt imot abonnementet (until: når innloggingen det ble slått på med, går
  // ut), { endpoint, lost: true } når nettleseren eller push-tjenesten har mistet det. Fjernes når Viggo slår av
  // varslene her. Slik kan innloggingssiden og timeboken si sannheten om varslene på denne enheten.
  const NOTE_KEY = "viggo-push";
  function getNote() {
    try {
      const v = JSON.parse(localStorage.getItem(NOTE_KEY) || "null");
      return v && typeof v === "object" && typeof v.endpoint === "string" ? v : null;
    } catch (e) { return null; }
  }
  const putNote = (v) => { try { localStorage.setItem(NOTE_KEY, JSON.stringify(v)); } catch (e) { /* privat modus */ } };
  const clearNote = () => { try { localStorage.removeItem(NOTE_KEY); } catch (e) { /* privat modus */ } showLost(false); };
  // Linjen i timeboken: «Varsler om nye bestillinger er slått av på denne enheten.» med «Slå på varsler igjen»
  const LOST_TEXT = "Varsler om nye bestillinger er slått av på denne enheten.";
  const showLost = (on) => { $("push-lost-msg").textContent = on ? LOST_TEXT : ""; $("push-lost").hidden = !on; };
  // Nettleseren eller push-tjenesten har mistet abonnementet her (ikke Viggo): enheten husker det, timeboken sier
  // det, og serveren får beskjed om å glemme den døde adressen, så Oppsett ikke teller den som «en annen enhet»
  function markLost(endpoint) {
    putNote({ endpoint, lost: true });
    showLost(true);
    forgetLost(endpoint);
  }
  function forgetLost(endpoint) {
    return api("/api/admin/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) }).then(() => {
      const n = getNote();
      if (n && n.endpoint === endpoint && n.lost) putNote({ endpoint, lost: true, forgotten: true });
    }, () => {}); // prøves igjen neste gang (Oppsett eller oppstart)
  }
  // Er tiden varslene her gjaldt til, ute? (bare for dette abonnementet)
  function noteEnded(sub) {
    const n = getNote();
    const t = n && n.endpoint === sub.endpoint && n.until ? Date.parse(n.until) : NaN;
    return isNaN(t) || t > Date.now() ? null : n.until;
  }

  let loginPushSeq = 0;
  let loginPushSub = null;
  // Grunnen serveren ga for siste 401 (null: ingen 401, f.eks. fanen ble lukket). «revoked» (logget ut fra en annen
  // enhet, som også slo av varslene der) og «invalid» (nytt passord): serveren sender ikke lenger hit (runde 2).
  let logoutReason = null;
  const OFF_ELSEWHERE = "Varslene her er slått av (logget ut fra en annen enhet eller nytt passord). Logg inn igjen for å få dem.";
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
      // Innloggingen varslene ble slått på med, har gått ut: serveren sender ikke flere (bare ett siste varsel uten
      // kundedata), så siden sier at de har stoppet. «Slå av varsler her» står likevel, for å rydde i nettleseren.
      // Siden sier «fortsatt slått på» bare når serverens oppføring for enheten kan være gjeldende ennå.
      const ended = noteEnded(sub);
      // Grunnen huskes også i notatet (runde 2): 401-en fjernet billetten, så etter en omlasting finnes den bare der
      const n = getNote();
      const savedOff = !!n && !!n.off && n.endpoint === sub.endpoint;
      const removed = logoutReason === "revoked" || logoutReason === "invalid" || savedOff;
      loginPushMsg(removed ? OFF_ELSEWHERE : ended
        ? `Varslene her stoppet da innloggingen gikk ut (${untilText(ended)}). Logg inn igjen for å få dem.`
        : "Denne enheten har fortsatt varsler om nye bestillinger slått på.", "info");
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
    withTimeout(stop, LOGOUT_WAIT_MS, "").catch(() => false).then((ok) => {
      btn.disabled = false;
      if (seq !== loginPushSeq) return;
      if (!ok) return loginPushMsg("Kunne ikke slå av varslene her. Slå av varsler for denne siden i nettleserens innstillinger.");
      loginPushSub = null;
      clearNote();
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
    withTimeout(fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ password: $("pw").value, remember: $("remember").checked }, getDevice() ? { device: getDevice() } : {})),
    }).then((res) => res.json().catch(() => ({})).then((data) => ({ res, data }))), API_WAIT_MS, "")
      .then((r) => r, () => { throw Object.assign(new Error("Ingen forbindelse – prøv igjen."), { user: true, network: true }); })
      .then((r) => {
        const res = r.res, data = r.data || {};
        if (!res.ok) throw Object.assign(new Error(data.error || (res.status === 404 ? "Timeboken er ikke publisert ennå." : "Kunne ikke logge inn.")), { user: true });
        setToken(data.token, $("remember").checked);
        logoutReason = null;
        setDevice(data.device);
        $("pw").value = "";
        showApp();
        if (pendingDay) { state.day = pendingDay; pendingDay = null; } // et varsel trykket mens innloggingen sto fremme
        load();
        pushSync();
        if (resumeEdit) {
          // dialog.close() tømmer ikke skjemaet, og state.editing er den samme: bare vis arket igjen
          resumeEdit = false;
          $("edit-msg").textContent = RESUME_TEXT[resumeAction] || RESUME_TEXT.save;
          resumeAction = null;
          $("editor").showModal();
        } else openPushIfAsked();
      }).catch((err) => {
      loginMsg(errText(err));
      $("pw").select();
    }).then(() => {
      btn.disabled = false;
    });
  });

  // «Logg ut» står sammen med varslene lenger ned: får enheten varsler, spør den først om de skal slås av også.

  // Ingen forbindelse (nettet er borte, eller ikke noe svar innen API_WAIT_MS): en norsk tekst i stedet for
  // nettleserens egen («Load failed», «Failed to fetch»), med user: true så Oppsett viser den som den er (F30).
  // En endring av avtaler kan likevel ha kommet fram, så da står det at siden bør oppdateres.
  const API_WAIT_MS = 15000;
  const NO_NET = "Ingen forbindelse – sjekk nettet og prøv igjen.";
  const CHECK_SAVED = " Oppdater siden for å se om endringen ble lagret.";
  const isWrite = (path, opts) => (opts.method || "GET") !== "GET" && /^\/api\/admin\/(items|cancel-phone)/.test(path);
  // Svar med feilkode: serverens egen tekst, eller (en HTML-side fra plattformen, 502/504) en norsk tekst. Ved 5xx
  // på en endring vet vi ikke om den ble lagret, med mindre serveren sier nøyaktig hva som skjedde (code).
  function httpText(status, data, write) {
    const said = data && typeof data.error === "string" ? data.error : "";
    if (status < 500) return said || "Noe gikk galt.";
    if (said && data.code) return said;
    return (said || `Ingen forbindelse med serveren (feil ${status}) – prøv igjen.`) + (write ? CHECK_SAVED : "");
  }
  // Den eneste teksten en feil vises med: en kjent feil (svar fra serveren, eller laget her med user: true) viser
  // sin melding; alt annet (en uventet feil i nettleseren) får en norsk tekst, aldri nettleserens engelske
  function errText(err) {
    return err && (err.status || err.user) ? err.message : "Noe gikk galt. Prøv igjen.";
  }
  function api(path, opts = {}) {
    const write = isWrite(path, opts);
    return withTimeout(fetch(path, Object.assign({}, opts, {
      headers: Object.assign({ "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` }, opts.headers || {}),
      cache: "no-store",
    })).then((res) => res.json().catch(() => ({})).then((data) => ({ res, data }))), API_WAIT_MS, "")
      .then((r) => r, () => { throw Object.assign(new Error(write ? NO_NET + CHECK_SAVED : NO_NET), { user: true, network: true }); })
      .then((r) => {
        const res = r.res, data = r.data || {};
        if (res.status === 401) {
          // Hvorfor (expired, revoked, invalid): innloggingssiden sier ut fra det om varslene her kan være på fortsatt
          logoutReason = typeof data.code === "string" ? data.code : null;
          // «revoked»/«invalid»: serveren har fjernet denne enheten. Det lagres i notatet (uten «until»), så
          // innloggingssiden sier det samme etter en omlasting; neste vellykkede «Slå på varsler» (saveSub) skriver et
          // nytt notat, og «Slå av varsler» med vilje fjerner det (runde 2)
          if (logoutReason === "revoked" || logoutReason === "invalid") {
            const n = getNote();
            if (n && n.endpoint) putNote({ endpoint: n.endpoint, off: logoutReason });
          }
          setToken(null);
          showLogin("Logg inn på nytt.", "info");
          throw Object.assign(new Error(data.error || "Logg inn"), { status: 401, code: logoutReason });
        }
        if (!res.ok) throw Object.assign(new Error(httpText(res.status, data, write)), { status: res.status, code: data.code });
        return data;
      });
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

  // «I dag» følger klokken (F12): står timeboken åpen over natten, flytter visningen seg fra i går til i dag neste
  // gang den hentes (fanen kommer tilbake, tidtakeren, et trykk). En dag Viggo har valgt selv, blir stående.
  let lastToday = todayIso();
  function rollDay() {
    const t = todayIso();
    if (t === lastToday) return false;
    const moved = state.day === lastToday;
    if (moved) state.day = t;
    lastToday = t;
    return moved;
  }

  let loadSeq = 0;
  function load() {
    if (rollDay()) render();
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
      // Arket står åpent (fanen kom tilbake), og avtalen er endret eller borte på serveren siden det ble åpnet (X1.2)
      if (dlg.open && state.editing && state.editing.date === d) {
        const fresh = day.items.filter((i) => i.id === state.editing.id)[0];
        if (!fresh || fresh.updatedAt !== state.editing.updatedAt) $("edit-msg").textContent = "Avtalen er endret et annet sted – lukk og åpne den på nytt.";
      }
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
      html.push(`<button type="button" data-day="${d}"${d === state.day ? ' aria-current="date"' : ""} class="${d === state.day ? "is-active" : ""}${closed ? " is-closed" : ""}">
        <span>${esc(fmt(d, { weekday: "short" }).replace(".", ""))}</span><strong>${parse(d).getDate()}</strong>
        <span class="n">${label}</span></button>`);
    }
    $("week").innerHTML = html.join("");
  }

  function itemHtml(i, clash) {
    const cls = ["item", i.type === "block" ? "is-block" : "", i.status === "cancelled" ? "is-cancelled" : "", clash ? "is-clash" : ""].join(" ");
    const when = `${hhmm(i.start)}–${hhmm(i.start + i.dur)} · ${i.dur} min`;
    // Et kort er en div med en ekte <button> (åpner avtalen) og ringelenken ved siden av, aldri inni knappen (F72)
    if (i.type === "block") {
      return `<div class="${cls}" data-id="${esc(i.id)}"><button type="button" class="item-open"><span class="when">${when}</span>
        <span class="what">Blokkert${i.note ? ` – ${esc(i.note)}` : ""}</span></button></div>`;
    }
    const tel = String(i.phone || "").replace(/[^\d+]/g, "");
    return `<div class="${cls}" data-id="${esc(i.id)}"><button type="button" class="item-open">
      <span class="when">${when}${i.status === "cancelled" ? " · AVLYST" : ""}</span>
      <span class="what">${esc(i.service || "Avtale")}${i.addons && i.addons.length ? ` + ${esc(i.addons.join(", "))}` : ""}</span>
      <span class="who">${esc(i.name || "Uten navn")}</span>
      ${i.note ? `<span class="note">${esc(i.note)}</span>` : ""}
      ${i.source === "nettside" ? `<span class="tag">Bestilt på nett${i.createdAt && created(i.createdAt) ? " " + created(i.createdAt) : ""}</span>` : ""}
    </button>${tel ? `<a class="item-tel" href="tel:${esc(tel)}">${esc(i.phone)}</a>` : ""}</div>`;
  }

  function renderDay() {
    const d = state.day;
    $("day").value = d;
    const title = fmt(d, { weekday: "long", day: "numeric", month: "long" });
    // Bare første bokstav stor («I dag, torsdag 12. november», «Fredag 13. november»), ikke CSS capitalize (F92)
    const t = d === todayIso() ? `I dag, ${title}` : title;
    $("day-title").textContent = t.charAt(0).toUpperCase() + t.slice(1);
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
  // Etter midnatt uten at noe er hentet ennå: ny avtale eller blokkering gjelder likevel den nye dagen
  const freshDay = () => { if (rollDay()) { render(); load(); } };
  $("add").addEventListener("click", () => { freshDay(); openEditor(null, { type: "booking" }); });
  $("block").addEventListener("click", () => {
    freshDay();
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
    sheetSeq++;
    resumeAction = null;
    // en lagring, sletting eller avlysning fra et tidligere ark kan fortsatt være på vei: knappene her er dette arkets
    $("save").disabled = false;
    $("delete").disabled = false;
    $("cancel-phone").disabled = false;
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
    floodCheck(item);
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

  // Feltene som er endret siden arket ble åpnet (X1.2). Endrer to enheter hvert sitt felt, overskriver de ikke
  // hverandre: en avlysning på telefonen blir ikke angret av et notat skrevet på PC-en.
  function changedFields(was, body) {
    const out = {};
    Object.keys(body).forEach((k) => {
      const before = k === "status" ? (was.status === "cancelled" ? "cancelled" : "confirmed")
        : k === "addons" ? was.addons || [] : was[k] == null ? "" : was[k];
      if (JSON.stringify(body[k]) !== JSON.stringify(before)) out[k] = body[k];
    });
    return out;
  }
  // Avtalen er endret på en annen enhet siden arket ble åpnet (412 «stale», X1.1)
  const STALE_TEXT = "Avtalen er endret på en annen enhet, så endringen ble ikke lagret. Listen oppdateres nå.";
  const STALE_DELETE = "Avtalen er endret på en annen enhet, så den ble ikke slettet. Listen oppdateres nå.";
  // Avtalen er flyttet til en annen måned (ny id) eller slettet på en annen enhet (404, X1.3)
  const GONE_SAVE = "Avtalen er flyttet eller slettet fra en annen enhet, så endringen ble ikke lagret. Listen oppdateres nå.";
  const GONE_DELETE = "Avtalen er flyttet eller slettet fra en annen enhet, så den ble ikke slettet her. Listen oppdateres nå.";

  // Én forespørsel startet fra redigeringsarket: Lagre, Slett og «Avlys alle nettbestillinger» (F27, F28; runde 2,
  // SPEC R21). Den hører til arket den ble startet i (sheet): knappen er låst mens den venter, svaret skrives bare i
  // det arket, og er arket lukket eller et annet åpnet siden, kommer en feil som en alert som navngir avtalen (who).
  // En 401 (innloggingen gikk ut) huskes som den avbrutte handlingen når arket kommer tilbake etter ny innlogging;
  // ellers sies det fra med en gang.
  function sheetCall(action, button, who, verb, sheet = sheetSeq) {
    const own = () => sheetSeq === sheet;
    const call = {
      here: () => dlg.open && own(),
      lock() { if (call.here()) $(button).disabled = true; },
      unlock() { if (own()) $(button).disabled = false; },
      error(err) {
        if (err.status === 401) {
          if (own() && resumeEdit) resumeAction = action;
          else alert(`${verb} (${who}): innloggingen hadde gått ut. Logg inn og prøv igjen.`);
          return;
        }
        if (call.here()) $("edit-msg").textContent = errText(err);
        else alert(`${verb} (${who}): ${errText(err)}`);
      },
    };
    return call;
  }

  // Hver lagring holder fast det den gjelder fra trykket på Lagre (F27): målet (avtalen), det som sendes, og hvilket
  // ark det var (sheetSeq øker hver gang et ark åpnes). Et svar som kommer etter at arket er lukket og et annet er
  // åpnet, skriver aldri i det nye arket og lukker det aldri; en feil blir da et varsel som navngir avtalen.
  let sheetSeq = 0;
  // requestId for en ny avtale (SPEC R1): det samme arket lagret på nytt uten endringer (svaret gikk tapt) får
  // samme id, så serveren lagrer den bare én gang; en endret avtale eller et nytt ark får en ny
  let attempt = null; // { sheet, sig, id }
  function newRequestId() {
    let bytes = null;
    try { if (window.crypto && window.crypto.getRandomValues) bytes = window.crypto.getRandomValues(new Uint8Array(12)); } catch (e) { bytes = null; }
    let id = Date.now().toString(36) + "-";
    for (let i = 0; i < 12; i++) id += ((bytes ? bytes[i] : Math.floor(Math.random() * 256)) % 36).toString(36);
    return id;
  }

  // Aktive kundeavtaler som overlapper [start, end) den dagen (fra listen på skjermen, ellers hentet). null: ukjent.
  function bookingsUnder(date, start, end) {
    const pick = (list) => list.filter((i) => i.date === date && i.type === "booking" && active(i) && i.start < end && start < i.start + i.dur)
      .sort((a, b) => a.start - b.start);
    if (date === state.itemsDay) return Promise.resolve(pick(state.items));
    return api(`/api/admin/items?from=${date}&to=${date}`).then((r) => pick(r.items || []), () => null);
  }

  // ctx: { target, body, sheet } når en lagring prøves på nytt (409 → «lagre likevel»)
  function save(force = false, ctx) {
    const mine = ctx ? ctx.sheet : sheetSeq;
    const target = ctx ? ctx.target : state.editing;
    let body = ctx ? ctx.body : payload();
    if (!ctx) {
      if (!body.date || Number.isNaN(body.start)) return ($("edit-msg").textContent = "Velg dato og tid.");
      if (body.type === "booking" && !body.service && !body.name) return ($("edit-msg").textContent = "Skriv inn tjeneste eller navn.");
      if (target) {
        body = changedFields(target, body);
        if (!Object.keys(body).length) { dlg.close(); return Promise.resolve(); }
        // expect: avtalen slik denne enheten så den; serveren svarer 412 hvis den er endret et annet sted siden (R3)
        if (target.updatedAt) body.expect = target.updatedAt;
      } else {
        const sig = JSON.stringify(body);
        if (!attempt || attempt.sheet !== mine || attempt.sig !== sig) attempt = { sheet: mine, sig, id: newRequestId() };
        body.requestId = attempt.id;
      }
    }
    const was = (k) => (body[k] != null ? body[k] : target ? target[k] : null);
    const who = was("name") || was("service") || (was("type") === "block" ? "Blokkering" : "avtale");
    const call = sheetCall("save", "save", who, "Ble ikke lagret", mine);
    // Det samme arket er fortsatt åpent
    const here = call.here;
    const q = force ? "?force=1" : "";
    call.lock();
    const sent = target
      ? api(`/api/admin/items/${encodeURIComponent(target.id)}${q}`, { method: "PATCH", body: JSON.stringify(body) })
      : api(`/api/admin/items${q}`, { method: "POST", body: JSON.stringify(body) });
    return sent.then(() => {
      if (sheetSeq !== mine) return load(); // et annet ark er åpnet siden: la det være i fred
      if (dlg.open) dlg.close();
      if (body.date && body.date !== state.day) state.day = body.date;
      return load();
    }).catch((err) => {
      if (err.status === 401) return call.error(err); // innloggingen vises (og arket kommer tilbake etterpå, F28)
      if ((err.status === 412 || err.status === 404) && target) {
        // Aldri «lagre likevel» her: da ville endringen fra den andre enheten blitt overskrevet
        alert(err.status === 412 ? STALE_TEXT : GONE_SAVE);
        if (here()) dlg.close();
        return load();
      }
      if (err.status === 409 && !force && was("type") === "block") {
        // En blokkering over kunder (ferie, X2.3): si hvem, og at ingen av dem blir avlyst eller får beskjed
        const start = was("start"), end = start + Number(was("dur"));
        return bookingsUnder(was("date"), start, end).then((list) => {
          const head = list && list.length
            ? `${list.length === 1 ? "1 kunde har time her:" : `${list.length} kunder har time her:`}\n${list.map((i) => `${hhmm(i.start)} ${i.name || "Uten navn"} ${i.phone || ""}`.trim()).join("\n")}`
            : "Det ligger allerede noe i dette tidsrommet.";
          if (confirm(`${head}\n\nBlokkeringen avlyser dem ikke, og kundene får ingen beskjed. Ring dem og huk av «Avlyst». Lagre blokkeringen likevel?`)) return save(true, { target, body, sheet: mine });
          const no = "Ikke lagret – tiden kan fortsatt bestilles på nett.";
          if (here()) $("edit-msg").textContent = no;
          else alert(`Blokkeringen ${hhmm(start)}: ${no}`);
        });
      }
      if (err.status === 409 && !force) {
        if (confirm(`${who} ${hhmm(was("start"))}: ${err.message}\n\nVil du lagre likevel (dobbeltbooking)?`)) return save(true, { target, body, sheet: mine });
      }
      call.error(err);
    }).then(() => call.unlock());
  }
  f.addEventListener("submit", (e) => { e.preventDefault(); save(); });

  // ---------- Mange falske nettbestillinger fra ett nummer (X2.4) ----------
  // Et telefonnummer uansett skrivemåte, som phoneKey() på serveren: bare sifre, uten +47/0047 foran
  const phoneKey = (p) => {
    const d = String(p == null ? "" : p).replace(/\D/g, "");
    if (d.length === 12 && d.indexOf("0047") === 0) return d.slice(4);
    if (d.length === 10 && d.indexOf("47") === 0) return d.slice(2);
    return d;
  };
  // Nettbestillingene fra dette nummeret fra i dag og 92 dager frem (det samme som POST /api/admin/cancel-phone avlyser)
  let flood = null; // { sheet, phone, n }
  function floodCheck(it) {
    const btn = $("cancel-phone");
    btn.hidden = true;
    flood = null;
    if (!it || it.type !== "booking" || it.source !== "nettside" || phoneKey(it.phone).length < 8) return;
    const sheet = sheetSeq, key = phoneKey(it.phone), today = todayIso();
    api(`/api/admin/items?from=${today}&to=${addDays(today, 92)}`).then((r) => {
      if (sheet !== sheetSeq || !dlg.open) return;
      const n = (r.items || []).filter((i) => i.type === "booking" && i.source === "nettside" && active(i) && i.date >= today && phoneKey(i.phone) === key).length;
      if (n < 2) return;
      flood = { sheet, phone: it.phone, n };
      btn.textContent = `Avlys alle nettbestillinger fra ${it.phone} (${n})`;
      btn.hidden = false;
    }, () => {});
  }
  $("cancel-phone").addEventListener("click", () => {
    const fl = flood;
    const btn = $("cancel-phone");
    if (!fl || fl.sheet !== sheetSeq || btn.disabled) return;
    if (!confirm(`Avlyse alle ${fl.n} nettbestillingene fra ${fl.phone} fra i dag og fremover?\n\nDe blir merket «Avlyst», og tidene blir ledige igjen. Kundene får ingen beskjed.`)) return;
    const call = sheetCall("cancel-phone", "cancel-phone", fl.phone, "Ble ikke avlyst", fl.sheet);
    call.lock();
    const busy = "Avlyser …";
    $("edit-msg").textContent = busy;
    api("/api/admin/cancel-phone", { method: "POST", body: JSON.stringify({ phone: fl.phone }) }).then((r) => {
      const n = Number(r.cancelled) || 0;
      if (call.here()) dlg.close();
      alert(`${n} ${n === 1 ? "nettbestilling" : "nettbestillinger"} fra ${fl.phone} er avlyst. Kundene har ikke fått beskjed.`);
      return load();
    }).catch((err) => call.error(err)).then(() => {
      if (call.here() && $("edit-msg").textContent === busy) $("edit-msg").textContent = "";
      call.unlock();
    });
  });

  // ---------- Søk etter en kunde (X2.1) ----------
  // En kunde ringer for å avlyse: søk på telefonnummer (minst 4 sifre, uansett mellomrom eller +47) eller en del av
  // navnet, blant timene fra i dag og 92 dager frem. Et trykk på et treff åpner dagen og avtalen.
  let findSeq = 0;
  let hits = [];
  function hitHtml(i, n) {
    const off = i.status === "cancelled";
    return `<li><button type="button" class="item hit${off ? " is-cancelled" : ""}" data-hit="${n}">
      <span class="when">${esc(fmt(i.date, { weekday: "short", day: "numeric", month: "short" }))} kl. ${hhmm(i.start)}${off ? " · AVLYST" : ""}</span>
      <span class="what">${esc(i.service || "Avtale")}</span>
      <span class="who">${esc(i.name || "Uten navn")}${i.phone ? ` · ${esc(i.phone)}` : ""}</span>
      ${i.createdAt && created(i.createdAt) ? `<span class="note">bestilt ${created(i.createdAt)}</span>` : ""}
    </button></li>`;
  }
  const hitsMsg = (text) => { $("hits").innerHTML = text ? `<li class="empty">${esc(text)}</li>` : ""; };
  $("find").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = String($("q").value || "").trim();
    const seq = ++findSeq;
    hits = [];
    if (!q) return hitsMsg("");
    // Et nummer (bare sifre, mellomrom, +, (), punktum og bindestrek) søkes som telefon, alt annet som navn, på hvilket
    // som helst skriftsystem. +47/0047 foran tas bort også fra en del av et nummer («+47 911 22»), før sifrene (runde 2).
    const phoneLike = /^[\d\s+().-]+$/.test(q);
    const byName = !phoneLike, digits = phoneKey(q.replace(/^\s*(?:\+|00)\s*47/, ""));
    if (!byName && digits.length < 4) return hitsMsg("Skriv minst 4 sifre av telefonnummeret, eller en del av navnet.");
    hitsMsg("Søker …");
    const today = todayIso(), name = q.toLowerCase();
    api(`/api/admin/items?from=${today}&to=${addDays(today, 92)}`).then((r) => {
      if (seq !== findSeq) return;
      hits = (r.items || []).filter((i) => i.type === "booking" && (byName ? String(i.name || "").toLowerCase().indexOf(name) >= 0 : phoneKey(i.phone).indexOf(digits) >= 0))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start));
      if (!hits.length) return hitsMsg("Ingen treff fra i dag og tre måneder frem.");
      $("hits").innerHTML = hits.map(hitHtml).join("");
    }).catch((err) => { if (seq === findSeq && err.status !== 401) hitsMsg(errText(err)); });
  });
  $("q").addEventListener("input", () => { if (!String($("q").value || "").trim()) { findSeq++; hits = []; hitsMsg(""); } });
  $("hits").addEventListener("click", (e) => {
    const b = e.target.closest("[data-hit]");
    const hit = b && hits[Number(b.dataset.hit)];
    if (!hit) return;
    state.day = hit.date;
    render();
    Promise.resolve(load()).then(() => {
      const it = state.itemsDay === hit.date && state.items.filter((x) => x.id === hit.id)[0];
      if (it && state.day === hit.date && !dlg.open) openEditor(it);
    });
  });

  // Slettinger på vei (avtalens id): et nytt trykk på Slett for den samme avtalen mens den første venter, sender
  // ingenting (ellers fikk det andre 404 og en falsk «slettet fra en annen enhet»)
  const deleting = {};
  const DELETING = "Sletter …";
  $("delete").addEventListener("click", () => {
    const it = state.editing;
    if (!it || $("delete").disabled) return;
    if (deleting[it.id]) { $("edit-msg").textContent = DELETING; return; }
    const what = it.type === "block" ? "blokkeringen" : `avtalen med ${it.name || "kunden"}${it.phone ? ` (${it.phone})` : ""}`;
    if (!confirm(`Slette ${what} ${fmt(it.date, { day: "numeric", month: "long" })} kl. ${hhmm(it.start)} for godt?\n\nTips: huk av «Avlyst» i stedet hvis du vil ha historikken.`)) return;
    const who = `${it.type === "block" ? "blokkeringen" : it.name || "avtalen"} kl. ${hhmm(it.start)}`;
    const call = sheetCall("delete", "delete", who, "Ble ikke slettet");
    deleting[it.id] = true;
    call.lock();
    $("edit-msg").textContent = DELETING;
    // expect: avtalen slik denne enheten så den; er den endret et annet sted siden, svarer serveren 412 (R3)
    const q = it.updatedAt ? `?expect=${encodeURIComponent(it.updatedAt)}` : "";
    api(`/api/admin/items/${encodeURIComponent(it.id)}${q}`, { method: "DELETE" }).then(() => {
      if (call.here()) dlg.close();
      return load();
    }).catch((err) => {
      if (err.status === 412 || err.status === 404) {
        alert(err.status === 412 ? STALE_DELETE : GONE_DELETE);
        if (call.here()) dlg.close();
        return load();
      }
      call.error(err);
    }).then(() => {
      delete deleting[it.id];
      if (call.here() && $("edit-msg").textContent === DELETING) $("edit-msg").textContent = "";
      call.unlock();
    });
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
  // focusPush: åpnet fra påminnelsen eller linjen om mistede varsler: «Slå på varsler» får fokus når det vises
  function openSettings(focusPush) {
    if (settings.open) return;
    // Et åpent redigeringsark lukkes aldri av seg selv (det Viggo har skrevet, ville gått tapt): linjen om varslene
    // står i timeboken når han er ferdig
    if (dlg.open) { if (focusPush) showLost(true); return; }
    settings.showModal();
    $("settings-close").focus();
    calLoad();
    const loading = pushLoad();
    if (focusPush) Promise.resolve(loading).then(() => { if (settings.open && !$("push-on").hidden) $("push-on").focus(); });
  }
  $("settings-open").addEventListener("click", () => openSettings(false));
  $("push-lost-on").addEventListener("click", () => openSettings(true));
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
  // iOS-versjonen fra nettleserens brukeragent («OS 15_8» → [15, 8]), eller null (en iPad som melder seg som Mac)
  const iosVersion = () => { const m = /OS (\d+)_(\d+)/.exec(navigator.userAgent || ""); return m ? [Number(m[1]), Number(m[2])] : null; };
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
  function withTimeout(promise, ms, message) {
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
  // devices: alle enhetene serveren sender til (med denne, når den er på). until: enheten får varsler bare til
  // innloggingen den ble slått på med, går ut (12 timer, eller 60 dager med «Hold meg innlogget»), og det står her.
  // Hver ny innlogging forlenger dem (pushSync gir serveren abonnementet på nytt).
  function pushShow(mode, devices, until) {
    const n = Number(devices) || 0;
    pushState.others = mode === "on" ? Math.max(0, n - 1) : n;
    pushButtons(mode);
    if (mode === "on") pushState.lost = false;
    const when = mode === "on" && until ? untilText(until) : "";
    if (when) pushMsg("Varsler er på til innloggingen her går ut, " + when + ". Når du logger inn på nytt, varer de like lenge som den nye innloggingen." + others(pushState.others), "ok");
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
  // Serveren har tatt imot abonnementet: enheten husker adressen og hvor lenge det gjelder (until)
  // Gir serveren abonnementet. Husker enheten en annen adresse enn nettleserens (nettleseren byttet abonnement, og
  // fornyelsen i admin-sw.js nådde ikke serveren), er den gamle død: serveren får beskjed om å glemme den først, så
  // Oppsett aldri teller denne enheten som «en annen enhet» (runde 2, SPEC R24). Gikk det ikke, huskes den gamle
  // (stale) til neste gang, og res.devices regnes uten den.
  const saveSub = (sub) => {
    const n = getNote();
    const old = n && n.endpoint !== sub.endpoint ? n.endpoint : n && n.stale && n.stale !== sub.endpoint ? n.stale : null;
    const forget = old
      ? api("/api/admin/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: old }) }).then(() => true, () => false)
      : Promise.resolve(true);
    return forget.then((forgotten) => api("/api/admin/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub }) }).then((res) => {
      const note = res && res.until ? { endpoint: sub.endpoint, until: res.until } : { endpoint: sub.endpoint };
      if (!forgotten) note.stale = old;
      putNote(note);
      showLost(false);
      return !forgotten && res && Number(res.devices) > 1 ? Object.assign({}, res, { devices: Number(res.devices) - 1 }) : res;
    }));
  };
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
      // Instruksjonene velges ut fra iOS-versjonen (runde 2, SPEC R26): iOS 15 og eldre får ingen steg som ikke kan
      // virke der (iPhone SE 1. gen, 6s og 7 stopper på iOS 15), iOS 16.0–16.3 kan oppdatere.
      const v = isIos() ? iosVersion() : null;
      if (v && v[0] < 16) return pushLimited(seq, null, `Varsler på iPhone krever iOS 16.4 eller nyere, og denne har iOS ${v[0]}.${v[1]}. Bruk kalenderlenken over, eller slå på varsler på en annen telefon eller PC.`);
      if (isIos() && isStandalone()) return pushLimited(seq, null, "Varsler på iPhone krever iOS 16.4 eller nyere. Oppdater under Innstillinger → Generelt → Programvareoppdatering.");
      if (isIos()) { $("push-ios").hidden = false; return pushLimited(seq, null, ""); }
      return pushLimited(seq, null, "Denne nettleseren kan ikke vise varsler. Bruk en nyere Chrome, Edge, Firefox eller Safari.");
    }
    if (permission() === "denied") return pushLimited(seq, "blocked", retry === true ? STILL_BLOCKED : BLOCKED);
    pushMsg("Henter …", "info");
    // Husker enheten en egen adresse, spør serveren om den (thisDevice), så den ikke telles som en annen enhet
    const note = getNote();
    const info = note ? "/api/admin/push?endpoint=" + encodeURIComponent(note.endpoint) : "/api/admin/push";
    return Promise.all([api(info), swRegistration().then((reg) => { pushState.reg = reg; return reg.pushManager.getSubscription(); })]).then((r) => {
      if (seq !== pushSeq) return;
      const info = r[0], sub = r[1];
      pushState.key = info.publicKey;
      if (!sub || permission() !== "granted") {
        let n = Number(info.devices) || 0;
        if (note && info.thisDevice) {
          // Serveren har fortsatt den døde adressen herfra: tell den ikke, og be serveren glemme den
          n = Math.max(0, n - 1);
          forgetLost(note.endpoint);
        }
        if (note && (note.lost || info.thisDevice)) pushState.lost = true;
        return pushShow("off", n);
      }
      // Laget med en nøkkel serveren ikke har lenger, eller push-tjenesten har sagt at det er borte (serveren svarer
      // 410; Chrome beholder et slikt dødt abonnement): det virker ikke, så det fjernes. «Slå på varsler» lager et nytt.
      const drop = () => sub.unsubscribe().catch(() => false).then(() => {
        pushState.lost = true;
        markLost(sub.endpoint);
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
    withTimeout(subscribing, SUBSCRIBE_WAIT_MS, NO_CONTACT).catch((err) => {
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
      clearNote();
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
    if (!confirm(`Slå av varsler på ${which}, og logge ut alle andre enheter?\n\nDe får ikke flere varsler om nye bestillinger, og må logge inn igjen for å bruke timeboken. Denne enheten forblir innlogget.\n\nEr en telefon mistet eller stjålet, og du vil bytte admin-passordet også: Bytt passordet i Netlify, og publiser på nytt (Deploys → Trigger deploy → Deploy site). Først da gjelder det nye passordet.`)) return;
    const btn = $("push-reset");
    const seq = ++pushSeq;
    const sub = pushState.sub;
    btn.disabled = true;
    pushMsg("Slår av varsler på de andre enhetene …", "info");
    api("/api/admin/push/reset", { method: "POST", body: "{}" }).then((res) => {
      // Serveren har avsluttet alle innlogginger og gitt denne enheten en ny billett: ta vare på den, ellers ble
      // også Viggo logget ut ved neste henting
      if (res && typeof res.token === "string" && res.token) setToken(res.token, tokenRemembered());
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
      const note = getNote();
      if (!sub) {
        // Varslene var på her, men nettleseren har ikke abonnementet lenger (byttet ut uten at serveren fikk det nye,
        // eller fjernet): si det i timeboken, og la serveren glemme den døde adressen
        if (note && !note.lost) markLost(note.endpoint);
        else if (note && note.lost) { showLost(true); if (!note.forgotten) forgetLost(note.endpoint); }
        return null;
      }
      return api("/api/admin/push").then((info) => (sameKey(sub, info.publicKey) ? saveSub(sub) : null)).catch((err) => {
        // Borte hos push-tjenesten: fjern det, så «Oppsett» viser «av» og «Slå på varsler» lager et nytt
        if (err && err.status === 410) {
          pushState.lost = true;
          putNote({ endpoint: sub.endpoint, lost: true, forgotten: true }); // serveren har allerede fjernet den
          showLost(true);
          return sub.unsubscribe();
        }
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
    return withTimeout(look, LOOKUP_WAIT_MS, "").catch(() => null);
  }
  // Slår av i nettleseren og på serveren samtidig, og venter høyst LOGOUT_WAIT_MS. Svarer om minst én av dem lyktes
  // (da kommer det ikke flere varsler hit: push-tjenesten svarer 410 for et avsluttet abonnement, og serveren
  // sletter enheten).
  function turnOffHere(sub) {
    let browserOk = false, serverOk = false;
    const browser = Promise.resolve().then(() => sub.unsubscribe()).then((ok) => { browserOk = ok === true; }, () => {});
    const server = api("/api/admin/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) })
      .then(() => { serverOk = true; }, () => {});
    return withTimeout(Promise.all([browser, server]), LOGOUT_WAIT_MS, "").catch(() => {}).then(() => browserOk || serverOk);
  }
  $("logout").addEventListener("click", () => {
    const btn = $("logout");
    if (btn.disabled) return;
    btn.disabled = true;
    // Svarer [tekst, stil] for innloggingssiden: å være logget ut er ingen feil, så bare det som må rettes er rødt
    const done = ["Du er logget ut.", "ok"];
    thisDeviceSubscription().then((sub) => {
      if (!sub) return done;
      const yes = confirm("Slå av varsler om nye bestillinger på denne enheten også?\n\nOK: varslene slås av her (lurt på en lånt eller delt telefon eller PC).\nAvbryt: du får fortsatt varsel om nye bestillinger her, også når du er logget ut, til innloggingen ville gått ut.");
      if (!yes) return done; // innloggingssiden sier at varslene fortsatt er på, med «Slå av varsler her»
      return turnOffHere(sub).then((stopped) => { if (stopped) clearNote(); return stopped; }).then((stopped) => (stopped
        ? ["Du er logget ut, og varsler om nye bestillinger er slått av på denne enheten.", "ok"]
        : ["Du er logget ut, men varslene på denne enheten kunne ikke slås av nå. Slå av varsler for denne siden i nettleserens innstillinger.", ""]));
    }).catch(() => done).then((msg) => {
      btn.disabled = false;
      setToken(null);
      logoutReason = null; // logget ut her: varslene er som Viggo nettopp valgte
      showLogin(msg[0], msg[1]);
      resumeEdit = false; // logget ut med vilje: ingen avtale skal dukke opp for neste som logger inn
      resumeAction = null;
    });
  });

  // Har Viggo tillatt varsler i innstillingene, viser «Prøv igjen» (og det å komme tilbake til siden, eller at
  // nettleseren melder at tillatelsen er endret) panelet på nytt, så han slipper å lukke og åpne «Oppsett».
  // Hvert trykk svarer synlig, også når svaret er det samme som sist («Fortsatt blokkert»): først «Sjekker …» med
  // knappen grået ut, så svaret et øyeblikk etter (en tekst som byttes til den samme, ser ut som ingenting skjedde)
  const RETRY_SHOW_MS = 400;
  $("push-retry").addEventListener("click", () => {
    const btn = $("push-retry");
    if (btn.disabled) return;
    const seq = pushSeq;
    btn.disabled = true;
    pushMsg("Sjekker …", "info");
    setTimeout(() => {
      if (seq === pushSeq && settings.open) pushLoad(true);
      else btn.disabled = false;
    }, RETRY_SHOW_MS);
  });
  const pushRefresh = () => { if (settings.open && getToken() && !pushBusy()) pushLoad(); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pushRefresh(); });
  if (pushSupported() && navigator.permissions && typeof navigator.permissions.query === "function") {
    try {
      navigator.permissions.query({ name: "notifications" }).then((status) => {
        if (status && "onchange" in status) status.onchange = pushRefresh;
      }, () => {});
    } catch (e) { /* nettleseren kjenner ikke «notifications» her */ }
  }

  // Trykk på et varsel mens timeboken er åpen: admin-sw.js sier hvilken dag som skal vises (open-day) eller at
  // Oppsett skal åpnes (open-push). Står fanen på innloggingssiden, huskes det til Viggo har logget inn, som når
  // varselet åpner et nytt vindu med /admin?dag=… eller ?varsler=1 (runde 2, SPEC R23).
  let pendingDay = null;
  const loggedIn = () => !!getToken() && !$("app").hidden;
  if (sw() && sw().addEventListener) {
    sw().addEventListener("message", (e) => {
      const d = e.data;
      if (d && d.type === "open-day" && typeof d.date === "string" && toIso(d.date) === d.date) {
        if (loggedIn()) go(d.date); else pendingDay = d.date;
      }
      if (d && d.type === "open-push") {
        if (loggedIn()) openSettings(true); else pushAsked = true;
      }
    });
  }

  // /admin?varsler=1 (påminnelsen fra admin-sw.js når varslene her må slås på igjen): åpne Oppsett med «Slå på
  // varsler» klar, også etter en ny innlogging. Én gang: parameteren fjernes fra adressen.
  let pushAsked = /[?&]varsler=1(?:&|$)/.test((window.location && window.location.search) || "");
  function openPushIfAsked() {
    if (!pushAsked) return;
    pushAsked = false;
    try {
      if (window.history && history.replaceState) history.replaceState(history.state, "", location.pathname + location.search.replace(/([?&])varsler=1(&|$)/, "$1").replace(/[?&]$/, ""));
    } catch (e) { /* adressen blir stående */ }
    openSettings(true);
  }

  // ---------- Oppstart ----------
  // Hold oversikten fersk (nye nettbestillinger dukker opp av seg selv)
  setInterval(() => { if (!document.hidden && !dlg.open && getToken() && !$("app").hidden) load(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && getToken() && !$("app").hidden) load(); });

  if (getToken()) { showApp(); load(); pushSync(); openPushIfAsked(); } else showLogin();
})();
