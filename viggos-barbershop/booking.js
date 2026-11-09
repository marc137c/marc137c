// Bestillingskalender: velg tjeneste → dag → tid → navn og telefon.
// Sendes som forespørsel via Netlify Forms (skjemaet «booking»), og bekreftes av barbershopen.
// Bruker HOURS fra script.js, så kalenderen alltid følger åpningstidene.
(() => {
  const SLOT_MIN = 30;     // en ny time hvert 30. minutt
  const LEAD_MIN = 60;     // i dag: tidligste time er minst én time frem i tid
  const MAX_DAYS = 60;     // hvor langt frem man kan bestille

  const $ = (id) => document.getElementById(id);
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

  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const sameDay = (a, b) => a && b && a.getTime() === b.getTime();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  const state = { date: null, time: null, view: null };

  const today = () => startOfDay(new Date());
  const lastDay = () => { const d = today(); d.setDate(d.getDate() + MAX_DAYS); return d; };

  // Ledige starttider en gitt dag (minutter etter midnatt)
  function slotsFor(date) {
    const hours = HOURS[date.getDay()];
    if (!hours) return [];
    const out = [];
    for (let t = hours[0]; t + SLOT_MIN <= hours[1]; t += SLOT_MIN) out.push(t);
    if (sameDay(date, today())) {
      const now = new Date();
      const earliest = now.getHours() * 60 + now.getMinutes() + LEAD_MIN;
      return out.filter((t) => t >= earliest);
    }
    return out;
  }
  const bookable = (date) => date >= today() && date <= lastDay() && slotsFor(date).length > 0;

  const dateLabel = (d, opts = { weekday: "long", day: "numeric", month: "long" }) =>
    new Intl.DateTimeFormat(I18N.s().locale, opts).format(d);

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
      const cls = ["cal-day"];
      if (sameDay(d, today())) cls.push("is-today");
      if (sameDay(d, state.date)) cls.push("is-selected");
      if (!HOURS[d.getDay()]) cls.push("is-closed");
      const label = cap(dateLabel(d)) + (sameDay(d, today()) ? `, ${s.today.toLowerCase()}` : "") + (!HOURS[d.getDay()] ? `, ${s.closedDay.toLowerCase()}` : "");
      html.push(`<button type="button" class="${cls.join(" ")}" data-date="${iso(d)}" aria-label="${label}" aria-pressed="${sameDay(d, state.date)}"${ok ? "" : " disabled"}>${day}</button>`);
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
    if (state.time !== null && !slots.includes(state.time)) state.time = null;
    if (!slots.length) {
      slotsEl.innerHTML = `<p class="slots-empty">${s.noSlots}</p>`;
      return;
    }
    slotsEl.innerHTML = slots
      .map((t) => `<button type="button" class="slot${t === state.time ? " is-selected" : ""}" data-time="${t}" aria-pressed="${t === state.time}">${s.time(t)}</button>`)
      .join("");
  }

  function selectedServiceLabel() {
    const opt = select.options[select.selectedIndex];
    return select.value ? opt.textContent.trim() : "";
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
  const renderAll = () => { renderCalendar(); renderSlots(); renderSummary(); };

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
    grid.querySelector(".is-selected")?.focus();
  });
  slotsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".slot");
    if (!btn) return;
    state.time = Number(btn.dataset.time);
    clearMsg();
    renderSlots();
    renderSummary();
    slotsEl.querySelector(".is-selected")?.focus();
  });
  prevBtn.addEventListener("click", () => { state.view = new Date(state.view.getFullYear(), state.view.getMonth() - 1, 1); renderCalendar(); });
  nextBtn.addEventListener("click", () => { state.view = new Date(state.view.getFullYear(), state.view.getMonth() + 1, 1); renderCalendar(); });
  select.addEventListener("change", () => { select.classList.remove("picked"); clearMsg(); renderSummary(); });

  // Klikk på en tjeneste i prislisten: gå til kalenderen med tjenesten ferdig valgt
  document.querySelectorAll(".svc-link").forEach((link) => {
    link.addEventListener("click", () => {
      select.value = link.dataset.service;
      select.classList.add("picked");
      form.classList.remove("flash");
      void form.offsetWidth; // start animasjonen på nytt
      form.classList.add("flash");
      clearMsg();
      renderSummary();
    });
  });

  function clearMsg() { msg.className = "form-msg"; msg.textContent = ""; }
  function fail(text, focusEl) {
    msg.className = "form-msg err";
    msg.textContent = text;
    focusEl?.focus();
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const s = I18N.s();
    const name = $("f-name");
    const phone = $("f-phone");
    if (!select.value) return fail(s.needService, select);
    if (!state.date) return fail(s.needDay, grid.querySelector(".cal-day:not([disabled])"));
    if (state.time === null || !slotsFor(state.date).includes(state.time)) {
      state.time = null; renderSlots(); renderSummary();
      return fail(s.needTime, slotsEl.querySelector(".slot"));
    }
    if (!name.value.trim()) return fail(s.needName, name);
    if (phone.value.replace(/\D/g, "").length < 8) return fail(s.needPhone, phone);

    // Det barbershopen ser i Netlify: dato (ÅÅÅÅ-MM-DD), tid (24 t), tjeneste og tillegg på norsk
    $("f-dato").value = iso(state.date);
    $("f-tid").value = hhmm(state.time);
    $("f-tillegg").value = [...form.querySelectorAll(".addon-picks input:checked")].map((c) => c.value).join(", ");

    const when = whenText();
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    msg.className = "form-msg";
    msg.textContent = s.sending;
    try {
      const res = await fetch("/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(new FormData(form)).toString(),
      });
      if (!res.ok) throw new Error(res.status);
      form.reset();
      state.date = null;
      state.time = null;
      renderAll();
      msg.className = "form-msg ok";
      msg.textContent = s.sent(when);
    } catch {
      msg.className = "form-msg err";
      msg.textContent = s.sendFailed;
    } finally {
      btn.disabled = false;
    }
  });

  initView();
  renderAll();
  I18N.onChange(renderAll);
  // Hold dagens ledige tider oppdatert mens siden står åpen
  // (ikke mens noen bruker kalenderen med tastaturet, så fokus ikke forsvinner)
  setInterval(() => {
    if (grid.contains(document.activeElement) || slotsEl.contains(document.activeElement)) return;
    renderAll();
  }, 60_000);
})();
