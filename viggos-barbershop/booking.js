// Bestillingskalender: velg tjeneste → dag → tid → navn og telefon.
// Opptatte tider, stengte dager, klokka og reglene (åpningstider, varighet, hvor langt frem) hentes fra
// /api/availability, og serverens svar vinner over enhetens klokke og verdiene under.
// Bestillingen sendes som JSON til /api/bookings, som låser tiden med en gang. Ingen kopi sendes noe annet sted.
// Bruker HOURS og osloNow fra script.js til serveren har svart.
(() => {
  // Reserveverdier til serveren har svart (se useServer)
  let SLOT_MIN = 30;       // en ny time hvert 30. minutt
  let LEAD_MIN = 60;       // i dag: tidligste time er minst én time frem i tid
  let MAX_DAYS = 60;       // hvor langt frem man kan bestille
  const SEND_TIMEOUT = 20000; // så lenge venter vi på svar på en bestilling før kunden får beskjed om å ringe
  const LOAD_TIMEOUT = 15000; // så lenge venter vi på ledige tider
  // Varighet per tjeneste (minutter). Serverens liste legges oppå denne.
  let DURATIONS = {
    "Full service": 60, "Herreklipp": 30, "Herreklipp + skjeggtrim": 60,
    "Knivbarbering": 30, "Skjegg & line-up": 30, "Barneklipp": 30,
  };
  let busy = {};           // { "ÅÅÅÅ-MM-DD": [[start, slutt], …] } – opptatte tidsrom
  let closed = {};         // { "ÅÅÅÅ-MM-DD": true } – dager barberen har blokkert helt (stengt)
  let clock = null;        // serverens klokke fra siste svar: { y, m, d, minutes, at }
  let online = false;      // true når bookingsystemet på serveren svarer

  const $ = (id) => document.getElementById(id);
  const focusOn = (el) => { if (el) el.focus(); };
  const form = $("booking-form");
  if (!form) return;
  const select = $("f-service");
  const grid = $("cal-grid");
  const monthLabel = $("cal-month");
  const prevBtn = $("cal-prev");
  const nextBtn = $("cal-next");
  const slotsEl = $("slots");
  const summaryEl = $("booking-summary");
  const msg = $("form-msg");
  const smsNote = $("sms-note");
  const nameEl = $("f-name");
  const phoneEl = $("f-phone");
  const btn = form.querySelector("button[type=submit]");
  // Feil som gjelder tjeneste, dag eller tid vises ved det steget (der fokuset havner), resten under knappen
  const boxes = { service: $("msg-service"), day: $("msg-day"), time: $("msg-time") };

  const sameDay = (a, b) => a && b && a.getTime() === b.getTime();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
  const fromIso = (s) => { const m = YMD.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  const state = { date: null, time: null, view: null };
  let userMoved = false;   // kunden har bladd i kalenderen selv: da blir måneden stående
  let sending = false;     // en bestilling er på vei: skjemaet er låst så det som sendes, er det som lagres

  // «Nå» i norsk tid: serverens klokke (talt videre fra da svaret kom) når serveren har svart,
  // ellers enhetens klokke (osloNow i script.js). Enhetsklokka kan gå feil; serveren avgjør.
  let devNow = null, devAt = 0;
  function now() {
    const t = Date.now();
    if (clock) {
      const min = clock.minutes + Math.floor(Math.max(0, t - clock.at) / 60000);
      return { y: clock.y, m: clock.m, d: clock.d + Math.floor(min / 1440), minutes: min % 1440 };
    }
    // Høyst én gang i sekundet: kalenderen spør hundrevis av ganger per tegning
    if (!devNow || t - devAt > 1000) { devNow = osloNow(); devAt = t; }
    return devNow;
  }
  const today = () => { const n = now(); return new Date(n.y, n.m - 1, n.d); }; // ny Date hver gang: kallerne endrer den
  const lastDay = () => { const d = today(); d.setDate(d.getDate() + MAX_DAYS); return d; };
  const isClosed = (d) => !HOURS[d.getDay()] || closed[iso(d)] === true;
  // Kan dagen bestilles i det hele tatt (åpen og innenfor bestillingsvinduet)?
  const dayOpen = (d) => d >= today() && d <= lastDay() && !isClosed(d);

  const duration = () => DURATIONS[select.value] || SLOT_MIN;
  const isBusy = (date, start, dur) =>
    (busy[iso(date)] || []).some(([a, b]) => start < b && a < start + dur);

  // Alle starttider en gitt dag (minutter etter midnatt) med status:
  // "free" = ledig, "taken" = noen har booket denne tiden, "short" = ledig, men valgt tjeneste rekker ikke før neste avtale/stenging
  function slotsFor(date) {
    if (!dayOpen(date)) return [];
    const hours = HOURS[date.getDay()];
    const dur = duration();
    const earliest = sameDay(date, today()) ? now().minutes + LEAD_MIN : -1;
    const out = [];
    for (let t = hours[0]; t + SLOT_MIN <= hours[1]; t += SLOT_MIN) {
      if (t < earliest) continue;
      let status = "free";
      if (isBusy(date, t, SLOT_MIN)) status = "taken";
      else if (t + dur > hours[1] || isBusy(date, t, dur)) status = "short";
      out.push({ t, status });
    }
    return out;
  }
  const isFree = (x) => x.status === "free";
  const isShort = (x) => x.status === "short";
  const bookable = (date) => slotsFor(date).some(isFree);

  const fmtCache = {};
  const dateLabel = (d, opts = { weekday: "long", day: "numeric", month: "long" }) => {
    const key = I18N.s().locale + JSON.stringify(opts);
    return (fmtCache[key] || (fmtCache[key] = new Intl.DateTimeFormat(I18N.s().locale, opts))).format(d);
  };

  // Kalenderen og tidene tegnes bare på nytt når innholdet faktisk er endret, så fokus og skjermleser blir i fred
  let gridHtml = null, slotsHtml = null;
  const setGrid = (h) => { if (h !== gridHtml) { grid.innerHTML = h; gridHtml = h; } };
  const setSlots = (h) => { if (h !== slotsHtml) { slotsEl.innerHTML = h; slotsHtml = h; } };

  function renderCalendar() {
    const s = I18N.s();
    const view = state.view;
    monthLabel.textContent = cap(dateLabel(view, { month: "long", year: "numeric" }));
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const offset = (first.getDay() + 6) % 7; // uken starter på mandag
    const t0 = today();

    const html = [];
    for (let i = 0; i < 7; i++) {
      const wd = new Date(2024, 0, 1 + i); // 1. januar 2024 var en mandag
      html.push(`<span class="cal-wd" aria-hidden="true">${dateLabel(wd, { weekday: "short" }).replace(".", "")}</span>`);
    }
    for (let i = 0; i < offset; i++) html.push('<span class="cal-blank"></span>');
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(view.getFullYear(), view.getMonth(), day);
      const shut = isClosed(d);
      const slots = slotsFor(d);
      const ok = slots.some(isFree);
      // Ingen ledig tid for valgt tjeneste, men kortere hull finnes: ikke «fullbooket»
      const noFit = !ok && slots.some(isShort);
      const full = !ok && !noFit && slots.length > 0;
      const cls = ["cal-day"];
      if (sameDay(d, t0)) cls.push("is-today");
      if (sameDay(d, state.date)) cls.push("is-selected");
      if (shut) cls.push("is-closed");
      if (full) cls.push("is-full");
      if (noFit) cls.push("is-nofit");
      const label = cap(dateLabel(d)) + (sameDay(d, t0) ? `, ${s.today.toLowerCase()}` : "") +
        (shut ? `, ${s.closedDay.toLowerCase()}` : "") + (full ? `, ${s.fullDay.toLowerCase()}` : "") +
        (noFit ? `, ${s.noFitDay.toLowerCase()}` : "");
      const tip = full ? s.fullDay : noFit ? s.noFitDay : "";
      html.push(`<button type="button" class="${cls.join(" ")}" data-date="${iso(d)}" aria-label="${label}" aria-pressed="${sameDay(d, state.date)}"${ok ? "" : " disabled"}${tip ? ` title="${tip}"` : ""}>${day}</button>`);
    }
    setGrid(html.join(""));

    const firstOfThisMonth = new Date(t0.getFullYear(), t0.getMonth(), 1);
    const firstOfLastMonth = new Date(lastDay().getFullYear(), lastDay().getMonth(), 1);
    prevBtn.disabled = view <= firstOfThisMonth;
    nextBtn.disabled = view >= firstOfLastMonth;
  }

  function renderSlots() {
    const s = I18N.s();
    if (!state.date) return setSlots(`<p class="slots-empty">${s.pickDayFirst}</p>`);
    const slots = slotsFor(state.date);
    // En valgt tid som ikke er ledig lenger (tatt av en annen, eller for kort for ny tjeneste) slippes – med beskjed om hvorfor
    if (state.time !== null && !sending && !slots.some((x) => x.t === state.time && isFree(x))) {
      const was = slots.filter((x) => x.t === state.time)[0];
      state.time = null;
      dropped.time = was && isShort(was) ? (t) => t.tooShortPicked : (t) => t.timeGone;
      setMsg("err", dropped.time, "time");
    }
    if (!slots.some(isFree)) {
      return setSlots(`<p class="slots-empty">${slots.some(isShort) ? s.dayNoFit : slots.length ? s.dayFull : s.noSlots}</p>`);
    }
    setSlots(slots.map(({ t, status }) => {
      if (status === "taken") {
        return `<button type="button" class="slot is-taken" disabled aria-label="${s.time(t)}, ${s.taken.toLowerCase()}"><span>${s.time(t)}</span><small>${s.taken}</small></button>`;
      }
      if (status === "short") {
        return `<button type="button" class="slot is-short" disabled title="${s.tooShort}" aria-label="${s.time(t)}, ${s.tooShort.toLowerCase()}"><span>${s.time(t)}</span><small>${s.shortTag}</small></button>`;
      }
      const sel = t === state.time;
      return `<button type="button" class="slot${sel ? " is-selected" : ""}" data-time="${t}" aria-pressed="${sel}"><span>${s.time(t)}</span></button>`;
    }).join(""));
  }

  function selectedServiceLabel() {
    const opt = select.options[select.selectedIndex];
    return select.value ? opt.textContent.trim() : "";
  }
  // Tjenestenavnet på gjeldende språk (option-teksten oversettes av i18n.js)
  function selectedServiceLabelFor(value) {
    const opt = Array.prototype.filter.call(select.options, (o) => o.value === value)[0];
    return opt ? opt.textContent.trim() : value;
  }
  function whenText() {
    const s = I18N.s();
    return s.summary(selectedServiceLabel(), dateLabel(state.date), s.time(state.time));
  }
  function renderSummary() {
    const ready = select.value && state.date && state.time !== null;
    summaryEl.textContent = ready ? whenText() : "";
    summaryEl.hidden = !ready;
  }
  const renderAll = () => {
    // En valgt dag som er passert, stengt eller utenfor bestillingsvinduet mens siden sto åpen, slippes – med beskjed
    if (state.date && !sending && !dayOpen(state.date)) {
      state.date = null;
      state.time = null;
      dropped.day = (t) => t.dayGone;
      setMsg("err", dropped.day, "day");
    }
    renderCalendar(); renderSlots(); renderSummary(); renderMsg();
  };
  // Tegner på nytt uten at tastaturfokuset i kalenderen eller tidene forsvinner
  function renderKeepFocus() {
    const a = document.activeElement;
    const inGrid = !!a && grid.contains(a) && a !== grid;
    const inSlots = !!a && slotsEl.contains(a) && a !== slotsEl;
    const key = inGrid ? a.getAttribute("data-date") : inSlots ? a.getAttribute("data-time") : null;
    renderAll();
    if ((!inGrid && !inSlots) || document.activeElement === a) return;
    const box = inGrid ? grid : slotsEl;
    const same = key !== null ? box.querySelector(`[data-${inGrid ? "date" : "time"}="${key}"]:not([disabled])`) : null;
    focusOn(same || box.querySelector(".is-selected") || box.querySelector("button:not([disabled])"));
  }

  // Første synlige måned: den første med en ledig dag
  function initView() {
    let d = today();
    const last = lastDay();
    while (!bookable(d) && d < last) d.setDate(d.getDate() + 1);
    if (!bookable(d)) d = today();
    state.view = new Date(d.getFullYear(), d.getMonth(), 1);
  }
  // Etter nye data fra serveren: velg måned på nytt hvis kunden ikke har bladd eller valgt dag selv
  function afterLoad() {
    const t0 = today();
    if (!state.view || (!userMoved && !state.date) || state.view < new Date(t0.getFullYear(), t0.getMonth(), 1)) initView();
    renderKeepFocus();
  }

  grid.addEventListener("click", (e) => {
    const b = e.target.closest(".cal-day");
    if (!b || b.disabled || sending) return;
    state.date = fromIso(b.getAttribute("data-date"));
    clearMsg();
    renderAll();
    focusOn(grid.querySelector(".is-selected"));
  });
  slotsEl.addEventListener("click", (e) => {
    const b = e.target.closest(".slot");
    if (!b || b.disabled || sending) return;
    state.time = Number(b.getAttribute("data-time"));
    clearMsg();
    renderSlots();
    renderSummary();
    focusOn(slotsEl.querySelector(".is-selected"));
  });
  prevBtn.addEventListener("click", () => { userMoved = true; state.view = new Date(state.view.getFullYear(), state.view.getMonth() - 1, 1); renderCalendar(); });
  nextBtn.addEventListener("click", () => { userMoved = true; state.view = new Date(state.view.getFullYear(), state.view.getMonth() + 1, 1); renderCalendar(); });
  // Ny tjeneste kan ha en annen varighet, så ledige tider tegnes på nytt
  select.addEventListener("change", () => { select.classList.remove("picked"); clearMsg(); renderAll(); });

  // Klikk på en tjeneste i prislisten: gå til kalenderen med tjenesten ferdig valgt
  document.querySelectorAll(".svc-link").forEach((link) => {
    link.addEventListener("click", () => {
      if (sending) return;
      select.value = link.dataset.service;
      select.classList.add("picked");
      form.classList.remove("flash");
      void form.offsetWidth; // start animasjonen på nytt
      form.classList.add("flash");
      clearMsg();
      renderAll();
    });
  });

  // Meldingen lagres som en funksjon av språket, så den oversettes når man bytter språk.
  // where: "service" | "day" | "time" viser den ved det steget, ellers under knappen.
  let lastMsg = null;
  let dropped = { day: null, time: null }; // hvorfor en valgt dag/tid ble sluppet (gjentas ved «Bestill time»)
  function setMsg(kind, textFn, where) { lastMsg = { kind, textFn, where: where || null }; renderMsg(); }
  function renderMsg() {
    const text = lastMsg ? lastMsg.textFn(I18N.s()) : "";
    const kind = lastMsg && lastMsg.kind ? " " + lastMsg.kind : "";
    const box = lastMsg && lastMsg.where ? boxes[lastMsg.where] : null;
    Object.keys(boxes).forEach((k) => {
      const b = boxes[k];
      if (!b) return;
      b.className = "step-msg" + (b === box ? kind : "");
      b.textContent = b === box ? text : "";
    });
    // Skjermlesere får meldingen alltid fra #form-msg (role=status); står den ved et steg, er den bare skjult for øyet her
    msg.className = "form-msg" + kind + (box ? " sr-only" : "");
    msg.textContent = text;
  }
  function clearMsg() { lastMsg = null; dropped = { day: null, time: null }; renderMsg(); }
  // Vis feilen og flytt fokus dit den gjelder. Meldingen ved steget rulles inn i bildet før fokus flyttes,
  // så telefonen ikke hopper til et felt langt oppe uten at kunden ser hvorfor.
  function fail(textFn, where, focusEl) {
    setMsg("err", typeof textFn === "function" ? textFn : () => textFn, where);
    const box = where ? boxes[where] : null;
    const root = document.documentElement;
    const smooth = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto"; // en myk rulling ville kjempe med fokus-rullingen
    if (box && box.getBoundingClientRect) {
      const top = box.getBoundingClientRect().top;
      const h = window.innerHeight || root.clientHeight || 0;
      if (top < 90 || top > h - 60) window.scrollBy(0, top - 90); // 90 px: under den faste menyen
    }
    focusOn(focusEl);
    root.style.scrollBehavior = smooth;
  }
  const firstFreeSlot = () => slotsEl.querySelector(".slot:not([disabled])");
  const firstOpenDay = () => grid.querySelector(".cal-day:not([disabled])");
  const nameOk = (v) => v.trim().length >= 2;
  // Samme regler som serveren: navn minst 2 tegn, telefon 8–15 sifre uansett skrivemåte
  const phoneOk = (v) => { const n = v.replace(/\D/g, "").length; return n >= 8 && n <= 15; };

  // Et løfte som gir opp etter ms millisekunder (AbortController finnes ikke i Safari < 12.1)
  const withTimeout = (p, ms) => new Promise((ok, no) => {
    const timer = setTimeout(() => no(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(timer); ok(v); }, (err) => { clearTimeout(timer); no(err); });
  });

  // Serverens svar vinner: klokke, stengte dager, åpningstider, varigheter og bestillingsregler
  function useServer(data) {
    busy = data.busy && typeof data.busy === "object" ? data.busy : {};
    // Slås sammen, ikke erstattes: en tjeneste serveren ikke lister lenger (f.eks. et gammelt navn i en fane
    // som har stått åpen) beholder sin kjente varighet i stedet for å falle tilbake til 30 minutter
    if (data.durations && typeof data.durations === "object") DURATIONS = Object.assign({}, DURATIONS, data.durations);
    if (smsNote) smsNote.hidden = !data.sms;
    // Åpningstidene kommer fra serveren, så kalenderen og bestillingsreglene alltid er like
    if (data.hours) for (let d = 0; d < 7; d++) if (d in data.hours) HOURS[d] = data.hours[d];
    const num = (v, lo, hi) => typeof v === "number" && v % 1 === 0 && v >= lo && v <= hi;
    if (num(data.slotMin, 5, 240)) SLOT_MIN = data.slotMin;
    if (num(data.leadMin, 0, 1440)) LEAD_MIN = data.leadMin;
    if (num(data.maxDays, 0, 400)) MAX_DAYS = data.maxDays;
    closed = {};
    if (Array.isArray(data.closed)) data.closed.forEach((d) => { if (typeof d === "string") closed[d] = true; });
    const m = YMD.exec(data.today || "");
    if (m && num(data.nowMinutes, 0, 1439)) clock = { y: +m[1], m: +m[2], d: +m[3], minutes: data.nowMinutes, at: Date.now() };
    // Siste svar fra serveren, til bruk for resten av siden (f.eks. stengte dager i statuslinjen)
    window.bookingAvailability = { data, at: Date.now() };
  }

  // Hent opptatte tider og regler fra serveren. Et eldre svar som kommer etter et nyere, brukes ikke.
  let loads = 0, applied = 0;
  function loadAvailability() {
    const n = ++loads;
    return withTimeout(fetch("/api/availability", { headers: { Accept: "application/json" }, cache: "no-store" })
      .then((res) => { if (!res.ok) throw new Error(res.status); return res.json(); }), LOAD_TIMEOUT)
      .then((data) => {
        if (n < applied || !data || typeof data !== "object") return;
        applied = n;
        useServer(data);
        online = true;
      })
      .catch(() => {
        online = false; // kalenderen virker fortsatt med det vi vet fra før
      });
  }

  // Samme bestilling sendt på nytt (etter tidsavbrudd eller nettfeil) får samme requestId, så serveren
  // lagrer den bare én gang og svarer med timen som allerede er lagret. En endret bestilling får en ny.
  let attempt = null; // { sig, id }
  function newRequestId() {
    let bytes = null;
    try { if (window.crypto && window.crypto.getRandomValues) bytes = window.crypto.getRandomValues(new Uint8Array(12)); } catch (e) { bytes = null; }
    let id = Date.now().toString(36) + "-";
    for (let i = 0; i < 12; i++) id += ((bytes ? bytes[i] : Math.floor(Math.random() * 256)) % 36).toString(36);
    return id;
  }

  function lock(on) {
    sending = on;
    btn.disabled = on;
    select.disabled = on;
    nameEl.readOnly = on;
    phoneEl.readOnly = on;
    Array.prototype.forEach.call(form.querySelectorAll(".addon-picks input"), (c) => { c.disabled = on; });
    form.setAttribute("aria-busy", on ? "true" : "false");
  }
  function done(textFn) {
    form.reset();
    select.classList.remove("picked");
    state.date = null;
    state.time = null;
    dropped = { day: null, time: null };
    lastMsg = { kind: "ok", textFn, where: null };
    renderAll();
  }

  let turns = 0; // løpenummer: svar på et eldre forsøk overstyrer aldri et nyere
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (sending) return;
    renderAll(); // dager og tider som ikke kan bestilles lenger, slippes nå – med grunnen
    if (!select.value) return fail((t) => t.needService, "service", select);
    if (!state.date) return fail(dropped.day || ((t) => t.needDay), "day", firstOpenDay());
    if (state.time === null) return fail(dropped.time || ((t) => t.needTime), "time", firstFreeSlot());
    if (!nameOk(nameEl.value)) return fail((t) => t.needName, null, nameEl);
    if (!phoneOk(phoneEl.value)) return fail((t) => t.needPhone, null, phoneEl);

    const addons = Array.prototype.map.call(form.querySelectorAll(".addon-picks input:checked"), (c) => c.value);
    const bot = form.querySelector("[name=bot-field]");
    const body = {
      service: select.value, date: iso(state.date), start: state.time, addons,
      name: nameEl.value.trim(), phone: phoneEl.value.trim(),
    };
    const sig = JSON.stringify([body.service, body.date, body.start, body.addons, body.name, body.phone]);
    if (!attempt || attempt.sig !== sig) attempt = { sig, id: newRequestId() };
    body.botField = bot ? bot.value : "";
    body.requestId = attempt.id;
    body.lang = I18N.lang === "en" ? "en" : "no";

    const svc0 = body.service, d0 = state.date, t0 = state.time;
    const turn = ++turns;
    const current = () => turn === turns;
    lock(true);
    setMsg("", (t) => t.sending);

    // Timen er lagret: bekreftelsen viser det serveren lagret, og venter ikke på oppdaterte ledige tider
    const booked = (data) => {
      const b = data.booking || {};
      const svc = typeof b.service === "string" ? b.service : svc0;
      const day = fromIso(b.date) || d0;
      const start = typeof b.start === "number" ? b.start : t0;
      attempt = null;
      lock(false);
      done((t) => t.booked(t.summary(selectedServiceLabelFor(svc), dateLabel(day), t.time(start))) + (data.sms === "sent" ? " " + t.smsSent : ""));
      loadAvailability().then(afterLoad);
    };
    // Vi vet ikke om timen ble lagret (ingen svar, nettfeil eller serverfeil etter at den kan ha blitt lagret)
    const uncertain = () => { lock(false); setMsg("err", (t) => t.uncertain); };
    // Serveren sa nei til tiden eller dagen: hent ledige tider på nytt, slipp valget og si hvorfor
    const rejected = (what, textFn) => loadAvailability().then(() => {
      lock(false);
      if (what === "day") state.date = null;
      state.time = null;
      renderAll();
      if (what === "day") fail(textFn, "day", firstOpenDay());
      else fail(textFn, "time", firstFreeSlot());
    });
    const answer = (r) => {
      const status = r.status, data = r.data || {};
      const code = data.code;
      if (status >= 200 && status < 300 && data.ok === true) return booked(data);
      if (status === 409 || code === "taken") return rejected("time", (t) => t.takenNow);
      if (status === 429 || code === "rate_limited") { lock(false); return setMsg("err", (t) => t.rateLimited); }
      if (status >= 500 || status < 400) return uncertain();
      if (code === "too_early" || code === "bad_time") return rejected("time", (t) => t.timeGone);
      if (code === "bad_date" || code === "closed") return rejected("day", (t) => t.dayGone);
      lock(false);
      if (code === "bad_service") return fail((t) => t.reloadPage, "service", select);
      if (code === "bad_name") return fail((t) => t.needName, null, nameEl);
      if (code === "bad_phone") return fail((t) => t.needPhone, null, phoneEl);
      setMsg("err", (t) => t.sendFailed); // f.eks. 404 eller 400: ingenting ble lagret
    };

    const reply = fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    }).then((res) => res.json().then((data) => ({ status: res.status, data }), () => ({ status: res.status, data: null })));
    withTimeout(reply, SEND_TIMEOUT).then((r) => { if (current()) return answer(r); }, () => {
      if (!current()) return;
      uncertain();
      // Kommer svaret likevel senere og timen ble lagret, får kunden vite det
      reply.then((r) => {
        if (current() && !sending && r.status >= 200 && r.status < 300 && r.data && r.data.ok === true) booked(r.data);
      }, () => {});
    }).catch(() => { if (current()) uncertain(); });
  });

  initView();
  renderAll();
  loadAvailability().then(afterLoad);
  I18N.onChange(renderAll);
  // Hold ledige tider oppdatert mens siden står åpen (fokus i kalenderen beholdes)
  setInterval(() => {
    if (!document.hidden) loadAvailability().then(afterLoad);
  }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadAvailability().then(afterLoad); });
})();
