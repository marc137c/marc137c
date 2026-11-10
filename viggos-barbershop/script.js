// Siden åpner alltid øverst: også når adressen har et #anker (f.eks. /#om) eller siden lastes på nytt
// midt på. Ankeret fjernes fra adressen, så «oppdater» og delte lenker også starter øverst.
// Har besøkeren selv begynt å rulle før siden er ferdig lastet, lar vi det være.
(() => {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual"; // Safari < 11 har det ikke: load-hoppet under tar det
  if (location.hash && history.replaceState) history.replaceState(null, "", location.pathname + location.search);
  let touched = false;
  const mark = () => { touched = true; };
  ["wheel", "touchstart", "keydown", "mousedown", "click"].forEach((ev) => window.addEventListener(ev, mark, { passive: true, once: true }));
  const toTop = () => {
    if (touched || !window.pageYOffset) return;
    const root = document.documentElement;
    root.style.scrollBehavior = "auto"; // hopp rett opp, ikke myk rulling
    window.scrollTo(0, 0);
    root.style.scrollBehavior = "";
  };
  toTop();
  // Firefox hopper til ankeret på nytt etter at siden er lastet: rull tilbake i 1,5 s etter load,
  // men bare så lenge besøkeren ikke har rørt siden selv
  window.addEventListener("load", () => {
    toTop();
    const end = Date.now() + 1500;
    const guard = () => { if (touched || Date.now() > end) window.removeEventListener("scroll", guard); else toTop(); };
    window.addEventListener("scroll", guard);
    setTimeout(toTop, 0);
    // Etterpå: vanlig Tilbake/Frem mellom ankrene på siden (Tilbake ruller dit man var før)
    setTimeout(() => { if ("scrollRestoration" in history) history.scrollRestoration = "auto"; }, 1600);
  });
  // Last på nytt eller gå bort: da starter siden øverst igjen neste gang
  window.addEventListener("pagehide", () => { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; });
  window.addEventListener("pageshow", (e) => { if (e.persisted && "scrollRestoration" in history) history.scrollRestoration = "auto"; });
})();

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
// Formaterne lages én gang: nye Intl-formatere er trege på gamle iPhoner
const OSLO_FMT = {};
function osloNow() {
  try {
    const p = {};
    const fmt = OSLO_FMT.all || (OSLO_FMT.all = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit",
      // hour12:false, ikke hourCycle: eldre nettlesere overser hourCycle og gir 12-timersklokke (15:00 blir 3).
      // Noen svarer «24» ved midnatt, derfor % 24 under.
      hour: "2-digit", minute: "2-digit", hour12: false,
    }));
    const now = new Date();
    if (typeof fmt.formatToParts === "function") fmt.formatToParts(now).forEach((x) => { p[x.type] = x.value; });
    else {
      // Safari 10 mangler formatToParts: hent hvert felt for seg, fortsatt i norsk tid
      ["year", "month", "day", "hour", "minute"].forEach((k) => {
        if (!OSLO_FMT[k]) { const o = { timeZone: "Europe/Oslo", hour12: false }; o[k] = "numeric"; OSLO_FMT[k] = new Intl.DateTimeFormat("en-US", o); }
        p[k] = OSLO_FMT[k].format(now).replace(/\D/g, "");
      });
    }
    const y = +p.year, m = +p.month, d = +p.day;
    return { y, m, d, day: new Date(y, m - 1, d).getDay(), minutes: (+p.hour % 24) * 60 + +p.minute };
  } catch (e) {
    const n = new Date(); // svært gamle nettlesere: bruk enhetens klokke
    return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate(), day: n.getDay(), minutes: n.getHours() * 60 + n.getMinutes() };
  }
}

// Når åpner vi? (ikke «åpent nå») + marker dagens rad i tabellen
function updateStatus() {
  const { day, minutes } = osloNow();
  const today = HOURS[day];
  const el = document.getElementById("open-status");
  const s = I18N.s();

  document.querySelectorAll("#hours-table tr").forEach((tr) => {
    tr.classList.toggle("today", tr.dataset.days.split(" ").includes(String(day)));
  });

  if (today && minutes >= today[0] && minutes < today[1]) {
    el.textContent = s.hoursToday(s.time(today[0]), s.time(today[1]));
    return;
  }
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
const lightboxDlg = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
document.querySelectorAll(".gallery-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const img = btn.querySelector("img");
    // Nettlesere uten WebP viser JPG-kopien i <picture>, så de får JPG i stort format også
    const shown = img.currentSrc || img.src;
    const full = btn.dataset.full || shown;
    lightboxImg.src = /\.jpg$/i.test(shown) ? full.replace(/\.webp$/i, ".jpg") : full;
    lightboxImg.alt = img.alt;
    lightboxDlg.showModal();
  });
});
document.getElementById("lightbox-close").addEventListener("click", () => lightboxDlg.close());
lightboxDlg.addEventListener("click", (e) => { if (e.target === lightboxDlg) lightboxDlg.close(); });

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
