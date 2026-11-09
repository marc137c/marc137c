// Åpningstider: [åpner, stenger] i minutter etter midnatt. 0 = søndag.
// Hold i sync med tabellen i index.html (og engelsk tekst i i18n.js).
const HOURS = {
  0: null,
  1: [600, 1080],
  2: [600, 1080],
  3: [600, 1080],
  4: [600, 1080],
  5: [600, 1080],
  6: [600, 1020],
};

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
  try { localStorage.setItem("theme", light ? "light" : "dark"); } catch (e) { /* privat modus */ }
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

// Klokka i Norge, uansett hvilken tidssone besøkeren er i (åpningstidene gjelder norsk tid)
function osloNow() {
  try {
    const p = {};
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit",
      // hour12:false, ikke hourCycle: eldre nettlesere overser hourCycle og gir 12-timersklokke (15:00 blir 3).
      // Noen svarer «24» ved midnatt, derfor % 24 under.
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
    const y = +p.year, m = +p.month, d = +p.day;
    return { y, m, d, day: new Date(y, m - 1, d).getDay(), minutes: (+p.hour % 24) * 60 + +p.minute };
  } catch (e) {
    const n = new Date(); // svært gamle nettlesere: bruk enhetens klokke
    return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate(), day: n.getDay(), minutes: n.getHours() * 60 + n.getMinutes() };
  }
}

// Åpent nå? + marker dagens rad i tabellen
function updateStatus() {
  const { day, minutes } = osloNow();
  const today = HOURS[day];
  const el = document.getElementById("open-status");
  const s = I18N.s();

  document.querySelectorAll("#hours-table tr").forEach((tr) => {
    tr.classList.toggle("today", tr.dataset.days.split(" ").includes(String(day)));
  });

  if (today && minutes >= today[0] && minutes < today[1]) {
    el.className = "status open";
    el.textContent = s.openNow(s.time(today[1]));
    return;
  }
  el.className = "status closed";
  if (today && minutes < today[0]) {
    el.textContent = s.opensToday(s.time(today[0]));
    return;
  }
  for (let i = 1; i <= 7; i++) {
    const d = (day + i) % 7;
    if (HOURS[d]) {
      el.textContent = s.opensOn(i === 1 ? s.tomorrow : s.days[d], s.time(HOURS[d][0]));
      return;
    }
  }
}
updateStatus();
setInterval(updateStatus, 60000);
toggle.setAttribute("aria-label", I18N.s().menuOpen);
I18N.onChange(() => {
  updateStatus();
  toggle.setAttribute("aria-label", toggle.getAttribute("aria-expanded") === "true" ? I18N.s().menuClose : I18N.s().menuOpen);
});

// Galleri: klikk for å se bildet stort
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
document.querySelectorAll(".gallery-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const img = btn.querySelector("img");
    // Nettlesere uten WebP viser JPG-kopien i <picture>, så de får JPG i stort format også
    const shown = img.currentSrc || img.src;
    const full = btn.dataset.full || shown;
    lightboxImg.src = /\.jpg$/i.test(shown) ? full.replace(/\.webp$/i, ".jpg") : full;
    lightboxImg.alt = img.alt;
    lightbox.showModal();
  });
});
document.getElementById("lightbox-close").addEventListener("click", () => lightbox.close());
lightbox.addEventListener("click", (e) => { if (e.target === lightbox) lightbox.close(); });

// Animasjon når seksjoner kommer til syne
if ("IntersectionObserver" in window) {
  const targets = document.querySelectorAll(".section-head, .highlight, .price-list, .addons, .booking, .about, .gallery figure, .hours-grid > *");
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
