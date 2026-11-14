// Bestillingskalender: velg tjeneste → dag → tid → navn og telefon.
// Opptatte tider hentes fra /api/availability og vises som «Opptatt». Bestillingen lagres i
// /api/bookings (tiden låses med en gang), og sendes i tillegg til Netlify Forms som e-postvarsel.
// Bruker HOURS fra script.js, så kalenderen alltid følger åpningstidene.
(() => {
  const SLOT_MIN = 30;     // en ny time hvert 30. minutt
  const LEAD_MIN = 60;     // i dag: tidligste time er minst én time frem i tid
  const MAX_DAYS = 60;     // hvor langt frem man kan bestille
  // Varighet per tjeneste (minutter). Overskrives av serveren hvis den svarer.
  let DURATIONS = {
    "Full service": 60, "Herreklipp": 30, "Herreklipp + skjeggtrim": 30,
    "Knivbarbering": 30, "Skjegg & line-up": 30, "Barneklipp": 30,
  };
  let busy = {};           // { "ÅÅÅÅ-MM-DD": [[start, slutt], …] } – opptatte tidsrom
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

  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const sameDay = (a, b) => a && b && a.getTime() === b.getTime();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  const state = { date: null, time: null, view: null };

  // «I dag» og klokka følger norsk tid (osloNow i script.js), ikke besøkerens tidssone
  // Regnes ut høyst én gang i sekundet (kalenderen spør hundrevis av ganger per tegning)
  let todayYmd = null, todayAt = 0;
  const today = () => {
    const now = Date.now();
    if (!todayYmd || now - todayAt > 1000) { const o = osloNow(); todayYmd = [o.y, o.m - 1, o.d]; todayAt = now; }
    return new Date(todayYmd[0], todayYmd[1], todayYmd[2]); // ny Date hver gang: kallerne endrer den
  };
  const lastDay = () => { const d = today(); d.setDate(d.getDate() + MAX_DAYS); return d; };

  const duration = () => DURATIONS[select.value] || SLOT_MIN;
  const isBusy = (date, start, dur) =>
    (busy[iso(date)] || []).some(([a, b]) => start < b && a < start + dur);

  // Alle starttider en gitt dag (minutter etter midnatt) med status:
  // "free" = ledig, "taken" = noen har booket denne tiden, "short" = ledig, men valgt tjeneste rekker ikke før neste avtale/stenging
  function slotsFor(date) {
    const hours = HOURS[date.getDay()];
    if (!hours) return [];
    const dur = duration();
    let earliest = -1;
    if (date < today() || date > lastDay()) return [];
    if (sameDay(date, today())) earliest = osloNow().minutes + LEAD_MIN;
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
  const freeSlots = (date) => slotsFor(date).filter((x) => x.status === "free").map((x) => x.t);
  const hasAnySlot = (date) => slotsFor(date).length > 0;
  const bookable = (date) => date >= today() && date <= lastDay() && freeSlots(date).length > 0;

  const fmtCache = {};
  const dateLabel = (d, opts = { weekday: "long", day: "numeric", month: "long" }) => {
    const key = I18N.s().locale + JSON.stringify(opts);
    return (fmtCache[key] || (fmtCache[key] = new Intl.DateTimeFormat(I18N.s().locale, opts))).format(d);
  };

  function renderCalendar() {
    const s = I18N.s();
    const view = state.view;
    monthLabel.textContent = cap(dateLabel(view, { month: "long", year: "numeric" }));
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const offset = (first.getDay() + 6) % 7; // uken starter på mandag

    const html = [];
    for (let i = 0; i < 7; i++) {
      const wd = new Date(2024, 0, 1 + i); // 1. januar 2024 var en mandag
      html.push(`<span class="cal-wd" aria-hidden="true">${dateLabel(wd, { weekday: "short" }).replace(".", "")}</span>`);
    }
    for (let i = 0; i < offset; i++) html.push('<span class="cal-blank"></span>');
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(view.getFullYear(), view.getMonth(), day);
      const ok = bookable(d);
      const full = !ok && HOURS[d.getDay()] && d >= today() && d <= lastDay() && hasAnySlot(d);
      const cls = ["cal-day"];
      if (sameDay(d, today())) cls.push("is-today");
      if (sameDay(d, state.date)) cls.push("is-selected");
      if (!HOURS[d.getDay()]) cls.push("is-closed");
      if (full) cls.push("is-full");
      const label = cap(dateLabel(d)) + (sameDay(d, today()) ? `, ${s.today.toLowerCase()}` : "") +
        (!HOURS[d.getDay()] ? `, ${s.closedDay.toLowerCase()}` : "") + (full ? `, ${s.fullDay.toLowerCase()}` : "");
      html.push(`<button type="button" class="${cls.join(" ")}" data-date="${iso(d)}" aria-label="${label}" aria-pressed="${sameDay(d, state.date)}"${ok ? "" : " disabled"}${full ? ` title="${s.fullDay}"` : ""}>${day}</button>`);
    }
    grid.innerHTML = html.join("");

    const firstOfThisMonth = new Date(today().getFullYear(), today().getMonth(), 1);
    const firstOfLastMonth = new Date(lastDay().getFullYear(), lastDay().getMonth(), 1);
    prevBtn.disabled = view <= firstOfThisMonth;
    nextBtn.disabled = view >= firstOfLastMonth;
  }

  function renderSlots() {
    const s = I18N.s();
    if (!state.date) {
      slotsEl.innerHTML = `<p class="slots-empty">${s.pickDayFirst}</p>`;
      return;
    }
    const slots = slotsFor(state.date);
    if (state.time !== null && !freeSlots(state.date).includes(state.time)) state.time = null;
    if (!slots.some((x) => x.status === "free")) {
      slotsEl.innerHTML = `<p class="slots-empty">${slots.length ? s.dayFull : s.noSlots}</p>`;
      return;
    }
    slotsEl.innerHTML = slots.map(({ t, status }) => {
      if (status === "taken") {
        return `<button type="button" class="slot is-taken" disabled aria-label="${s.time(t)}, ${s.taken.toLowerCase()}"><span>${s.time(t)}</span><small>${s.taken}</small></button>`;
      }
      if (status === "short") {
        return `<button type="button" class="slot is-short" disabled title="${s.tooShort}" aria-label="${s.time(t)}, ${s.tooShort.toLowerCase()}"><span>${s.time(t)}</span></button>`;
      }
      const sel = t === state.time;
      return `<button type="button" class="slot${sel ? " is-selected" : ""}" data-time="${t}" aria-pressed="${sel}"><span>${s.time(t)}</span></button>`;
    }).join("");
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
    // En valgt dag som er blitt passert mens siden sto åpen, nullstilles
    if (state.date && (state.date < today() || state.date > lastDay())) { state.date = null; state.time = null; }
    renderCalendar(); renderSlots(); renderSummary(); renderMsg();
  };

  // Første synlige måned: den første med en ledig dag
  function initView() {
    const d = today();
    while (!bookable(d) && d < lastDay()) d.setDate(d.getDate() + 1);
    state.view = new Date(d.getFullYear(), d.getMonth(), 1);
  }

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest(".cal-day");
    if (!btn || btn.disabled) return;
    const [y, m, d] = btn.dataset.date.split("-").map(Number);
    state.date = new Date(y, m - 1, d);
    clearMsg();
    renderAll();
    focusOn(grid.querySelector(".is-selected"));
  });
  slotsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".slot");
    if (!btn || btn.disabled) return;
    state.time = Number(btn.dataset.time);
    clearMsg();
    renderSlots();
    renderSummary();
    focusOn(slotsEl.querySelector(".is-selected"));
  });
  prevBtn.addEventListener("click", () => { state.view = new Date(state.view.getFullYear(), state.view.getMonth() - 1, 1); renderCalendar(); });
  nextBtn.addEventListener("click", () => { state.view = new Date(state.view.getFullYear(), state.view.getMonth() + 1, 1); renderCalendar(); });
  // Ny tjeneste kan ha en annen varighet, så ledige tider tegnes på nytt
  select.addEventListener("change", () => { select.classList.remove("picked"); clearMsg(); renderAll(); });

  // Klikk på en tjeneste i prislisten: gå til kalenderen med tjenesten ferdig valgt
  document.querySelectorAll(".svc-link").forEach((link) => {
    link.addEventListener("click", () => {
      select.value = link.dataset.service;
      select.classList.add("picked");
      form.classList.remove("flash");
      void form.offsetWidth; // start animasjonen på nytt
      form.classList.add("flash");
      clearMsg();
      renderAll();
    });
  });

  // Meldingen lagres som en funksjon av språket, så den oversettes når man bytter språk
  let lastMsg = null;
  function setMsg(kind, textFn) { lastMsg = { kind, textFn }; renderMsg(); }
  function renderMsg() {
    msg.className = "form-msg" + (lastMsg && lastMsg.kind ? " " + lastMsg.kind : "");
    msg.textContent = lastMsg ? lastMsg.textFn(I18N.s()) : "";
  }
  function clearMsg() { setMsg("", () => ""); lastMsg = null; }
  function fail(textFn, focusEl) {
    setMsg("err", typeof textFn === "function" ? textFn : () => textFn);
    focusOn(focusEl);
  }
  // Feilkoder fra serveren → tekst på riktig språk
  const ERR = {
    bad_service: (s) => s.needService, bad_date: (s) => s.needDay, closed: (s) => s.needDay,
    bad_time: (s) => s.needTime, too_early: (s) => s.needTime, bad_name: (s) => s.needName,
    bad_phone: (s) => s.needPhone, taken: (s) => s.takenNow,
  };
  const nameOk = (v) => v.trim().length >= 2;
  // Samme regler som serveren: navn minst 2 tegn, telefon 8–15 sifre uansett skrivemåte
  const phoneOk = (v) => { const n = v.replace(/\D/g, "").length; return n >= 8 && n <= 15; };

  // Hent opptatte tider fra serveren
  function loadAvailability() {
    return fetch("/api/availability", { headers: { Accept: "application/json" }, cache: "no-store" })
      .then((res) => { if (!res.ok) throw new Error(res.status); return res.json(); })
      .then((data) => {
        busy = data.busy || {};
        if (data.durations) DURATIONS = data.durations;
        if (smsNote) smsNote.hidden = !data.sms;
        // Åpningstidene kommer fra serveren, så kalenderen og bestillingsreglene alltid er like
        if (data.hours) for (let d = 0; d < 7; d++) if (d in data.hours) HOURS[d] = data.hours[d];
        online = true;
      })
      .catch(() => {
        online = false; // kalenderen virker fortsatt; bestillingen sendes da som forespørsel
      });
  }
  const refresh = () => loadAvailability().then(() => { if (!state.view) initView(); renderAll(); });

  // Skjemaet som tekst til Netlify Forms. Samme regler som FormData, men uten å kreve at FormData
  // kan itereres (det kan den ikke i Safari før 11.1) eller at URLSearchParams finnes (Safari før 10.1).
  const enc = (v) => { try { return encodeURIComponent(v); } catch (e) { return encodeURIComponent(String(v).replace(/[\uD800-\uDFFF]/g, "\uFFFD")); } };
  const encodeForm = (f) => Array.prototype.slice.call(f.elements)
    .filter((el) => el.name && !el.disabled && !/^(submit|button|reset|file)$/.test(el.type) &&
      (!/^(checkbox|radio)$/.test(el.type) || el.checked))
    .map((el) => (enc(el.name) + "=" + enc(el.value)).replace(/%20/g, "+"))
    .join("&");

  // E-postvarsel til barbershopen via Netlify Forms (skjemaet «booking»)
  const notify = () => fetch("/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: encodeForm(form),
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const s = I18N.s();
    const name = $("f-name");
    const phone = $("f-phone");
    if (!select.value) return fail((t) => t.needService, select);
    if (!state.date) return fail((t) => t.needDay, grid.querySelector(".cal-day:not([disabled])"));
    if (state.time === null || !freeSlots(state.date).includes(state.time)) {
      state.time = null; renderSlots(); renderSummary();
      return fail((t) => t.needTime, slotsEl.querySelector(".slot:not([disabled])"));
    }
    if (!nameOk(name.value)) return fail((t) => t.needName, name);
    if (!phoneOk(phone.value)) return fail((t) => t.needPhone, phone);

    // Det barbershopen ser i e-posten: dato (ÅÅÅÅ-MM-DD), tid (24 t), tjeneste og tillegg på norsk
    const addons = Array.prototype.map.call(form.querySelectorAll(".addon-picks input:checked"), (c) => c.value);
    $("f-dato").value = iso(state.date);
    $("f-tid").value = hhmm(state.time);
    $("f-tillegg").value = addons.join(", ");

    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    const d0 = state.date, svcValue = select.value, t0 = state.time;
    const whenFor = (t) => t.summary(selectedServiceLabelFor(svcValue), dateLabel(d0), t.time(t0));
    setMsg("", (t) => t.sending);
    const done = (textFn) => {
      form.reset();
      select.classList.remove("picked");
      state.date = null;
      state.time = null;
      lastMsg = { kind: "ok", textFn };
      renderAll();
    };
    const bot = form.querySelector("[name=bot-field]");
    fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        service: select.value, date: iso(state.date), start: state.time, addons,
        name: name.value.trim(), phone: phone.value.trim(), botField: bot ? bot.value : "",
      }),
    }).catch(() => null).then((res) => {
      if (res && res.ok) {
        return res.json().catch(() => ({})).then((data) => {
          // E-posten sier tydelig at timen allerede er lagret i timeboken
          $("f-status").value = "BOOKET – lagret i timeboken" + (data.booking && data.booking.id ? ` (id ${data.booking.id})` : "");
          notify().catch(() => {});
          return loadAvailability().then(() => data);
        }).then((data) => { done((t) => t.booked(whenFor(t)) + (data.sms === "sent" ? " " + t.smsSent : "")); });
      }
      if (res && res.status === 409) {
        // Noen andre rakk å ta tiden: vis oppdatert kalender
        return loadAvailability().then(() => {
          state.time = null;
          renderAll();
          fail((t) => t.takenNow, slotsEl.querySelector(".slot:not([disabled])"));
        });
      }
      if (res && res.status >= 400 && res.status < 500 && res.status !== 404) {
        return res.json().catch(() => ({})).then((data) => { fail(ERR[data.code] || ((t) => t.sendFailed)); });
      }
      // Bookingsystemet svarer ikke: send som forespørsel på e-post i stedet
      $("f-status").value = "FORESPØRSEL – IKKE lagret. Legg den inn i /admin og bekreft med kunden.";
      return notify().then((r) => {
        if (!r.ok) throw new Error(r.status);
        done((t) => t.sent(whenFor(t)));
      });
    }).catch(() => {
      setMsg("err", (t) => t.sendFailed);
    }).then(() => {
      btn.disabled = false;
    });
  });

  initView();
  renderAll();
  refresh();
  I18N.onChange(renderAll);
  // Hold ledige tider oppdatert mens siden står åpen
  // (ikke mens noen bruker kalenderen med tastaturet, så fokus ikke forsvinner)
  setInterval(() => {
    if (document.hidden) return;
    loadAvailability().then(() => {
      if (grid.contains(document.activeElement) || slotsEl.contains(document.activeElement)) return;
      renderAll();
    });
  }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
})();
