// Åpningstider: [åpner, stenger] i minutter etter midnatt. 0 = søndag.
// Hold i sync med tabellen i index.html.
const HOURS = {
  0: null,
  1: [600, 1080],
  2: [600, 1080],
  3: [600, 1080],
  4: [600, 1200],
  5: [600, 1080],
  6: [600, 960],
};
const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// Sosiale medier: lim inn lenkene her, så dukker ikonene opp på siden.
// Tom streng = ikonet skjules.
const SOCIAL = {
  instagram: "https://www.instagram.com/viggos.barbershop/",
  tiktok: "https://www.tiktok.com/@viggos.barbershop1",
  facebook: "https://www.facebook.com/share/19enEU6x6Q/",
};
document.querySelectorAll("[data-social]").forEach((a) => {
  const url = SOCIAL[a.dataset.social];
  if (url) { a.href = url; a.hidden = false; }
});
document.querySelectorAll("[data-socials-wrap]").forEach((w) => {
  w.hidden = !w.querySelector("[data-social]:not([hidden])");
});

// Lyst / mørkt tema (valget huskes)
const themeBtn = document.getElementById("theme-toggle");
const themeMeta = document.querySelector('meta[name="theme-color"]');
const isLight = () => document.documentElement.dataset.theme === "light";
function setThemeLabel() {
  themeBtn.setAttribute("aria-label", isLight() ? I18N.s().toDark : I18N.s().toLight);
  themeBtn.setAttribute("aria-pressed", String(isLight()));
}
themeBtn.addEventListener("click", () => {
  const light = !isLight();
  if (light) document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  themeMeta.content = light ? "#f7f2e8" : "#0b0f0d";
  try { localStorage.setItem("theme", light ? "light" : "dark"); } catch { /* privat modus */ }
  setThemeLabel();
  window.dispatchEvent(new Event("themechange"));
});
setThemeLabel();
I18N.onChange(setThemeLabel);

// Mobilmeny
const toggle = document.querySelector(".nav-toggle");
const menu = document.getElementById("nav-menu");
toggle.addEventListener("click", () => {
  const open = toggle.getAttribute("aria-expanded") === "true";
  toggle.setAttribute("aria-expanded", String(!open));
  toggle.setAttribute("aria-label", open ? I18N.s().menuOpen : I18N.s().menuClose);
  menu.classList.toggle("open", !open);
});
menu.addEventListener("click", (e) => {
  if (e.target.closest("a")) {
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", I18N.s().menuOpen);
    menu.classList.remove("open");
  }
});

// Kantlinje på header ved scroll
const header = document.querySelector(".site-header");
const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 10);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

// Åpent nå? + marker dagens rad
function updateStatus() {
  const now = new Date();
  const day = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const today = HOURS[day];
  const el = document.getElementById("open-status");
  const s = I18N.s();

  document.querySelectorAll("#hours-table tr").forEach((tr) => {
    tr.classList.toggle("today", Number(tr.dataset.day) === day);
  });

  if (today && minutes >= today[0] && minutes < today[1]) {
    el.className = "status open";
    el.textContent = s.openNow(fmt(today[1]));
    return;
  }
  el.className = "status closed";
  if (today && minutes < today[0]) {
    el.textContent = s.opensToday(fmt(today[0]));
    return;
  }
  for (let i = 1; i <= 7; i++) {
    const d = (day + i) % 7;
    if (HOURS[d]) {
      el.textContent = s.opensOn(i === 1 ? s.tomorrow : s.days[d], fmt(HOURS[d][0]));
      return;
    }
  }
}
updateStatus();
setInterval(updateStatus, 60_000);
toggle.setAttribute("aria-label", I18N.s().menuOpen);
I18N.onChange(() => {
  updateStatus();
  toggle.setAttribute("aria-label", toggle.getAttribute("aria-expanded") === "true" ? I18N.s().menuClose : I18N.s().menuOpen);
});

// Filtrering av tjenester
const tabs = document.querySelectorAll(".tabs button");
const items = document.querySelectorAll(".price-list li");
tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    const f = tab.dataset.filter;
    items.forEach((li) => { li.hidden = f !== "alle" && li.dataset.cat !== f; });
  });
});

// Klikk på en tjeneste i prislisten: gå til bookingskjemaet med tjenesten ferdig valgt
document.querySelectorAll(".svc-link").forEach((link) => {
  link.addEventListener("click", () => {
    const form = document.getElementById("booking-form");
    const select = form.querySelector('select[name="tjeneste"]');
    select.value = link.dataset.service;
    select.classList.add("picked");
    const card = document.getElementById("bestill");
    card.classList.remove("flash");
    void card.offsetWidth; // start animasjonen på nytt
    card.classList.add("flash");
    // Neste felt som mangler, får fokus når rullingen er ferdig
    setTimeout(() => {
      const next = [...form.querySelectorAll("input:not([type=hidden]):not([name=bot-field])")].find((i) => !i.value);
      next?.focus({ preventScroll: true });
    }, 700);
  });
});
document.querySelector('select[name="tjeneste"]').addEventListener("change", (e) => e.target.classList.remove("picked"));

// Bookingskjema: ingen datoer i fortiden, ingen søndager, innsending via Netlify Forms
const dateInput = document.getElementById("booking-date");
const toISO = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
dateInput.min = toISO(new Date());

const form = document.getElementById("booking-form");
const msg = document.getElementById("form-msg");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  msg.className = "form-msg";

  const [y, m, d] = form.dato.value.split("-").map(Number);
  const day = new Date(y, m - 1, d).getDay();
  const hours = HOURS[day];
  if (!hours) {
    msg.className = "form-msg err";
    msg.textContent = I18N.s().sundayClosed;
    return;
  }
  const [hh, mm] = form.tid.value.split(":").map(Number);
  const t = hh * 60 + mm;
  if (t < hours[0] || t >= hours[1]) {
    msg.className = "form-msg err";
    msg.textContent = I18N.s().openBetween(fmt(hours[0]), fmt(hours[1]));
    return;
  }

  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  msg.textContent = I18N.s().sending;
  try {
    const res = await fetch("/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(new FormData(form)).toString(),
    });
    if (!res.ok) throw new Error(res.status);
    form.reset();
    msg.className = "form-msg ok";
    msg.textContent = I18N.s().sent;
  } catch {
    msg.className = "form-msg err";
    msg.textContent = I18N.s().sendFailed;
  } finally {
    btn.disabled = false;
  }
});

// Animasjon når seksjoner kommer til syne
if ("IntersectionObserver" in window) {
  const targets = document.querySelectorAll(".section-head, .highlight, .price-list, .about > *, .review, .split > *, .contact > *");
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) {
        en.target.classList.add("in");
        io.unobserve(en.target);
      }
    });
  }, { threshold: 0.12 });
  targets.forEach((t) => { t.classList.add("reveal"); io.observe(t); });
}

document.getElementById("year").textContent = new Date().getFullYear();
