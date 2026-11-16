// Siden åpner alltid øverst: også når adressen har et #anker (f.eks. /#om) eller siden lastes på nytt
// midt på. Ankeret fjernes fra adressen, så «oppdater» og delte lenker også starter øverst.
// Unntak (START_AT): /#bestill, som lenkene «Bestill time» på personvernsiden og 404-siden går til, åpner ved
// bestillingsskjemaet, én gang; ankeret fjernes likevel, så «oppdater» starter øverst (runde 2, SPEC R31).
// Har besøkeren selv begynt å rulle før siden er ferdig lastet, lar vi det være.
(() => {
  const START_AT = ["bestill"];
  const id = location.hash.slice(1);
  const start = START_AT.indexOf(id) >= 0 ? document.getElementById(id) : null;
  if ("scrollRestoration" in history) history.scrollRestoration = "manual"; // Safari < 11 har det ikke: load-hoppet under tar det
  if (location.hash && history.replaceState) history.replaceState(null, "", location.pathname + location.search);
  let touched = false;
  const mark = () => { touched = true; };
  ["wheel", "touchstart", "keydown", "mousedown", "click"].forEach((ev) => window.addEventListener(ev, mark, { passive: true, once: true }));
  const toTop = () => {
    if (touched || (!start && !window.pageYOffset)) return;
    const root = document.documentElement;
    root.style.scrollBehavior = "auto"; // hopp rett dit, ikke myk rulling
    if (start) start.scrollIntoView(); // under menyen: scroll-padding-top (eller #bestill sin padding-top)
    else window.scrollTo(0, 0);
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

// Mobilmeny: åpnes med knappen (fokus går til første lenke), lukkes med en lenke, Esc eller et trykk utenfor
const toggle = document.querySelector(".nav-toggle");
const menu = document.getElementById("nav-menu");
const menuIsOpen = () => toggle.getAttribute("aria-expanded") === "true";
function setMenu(open) {
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", open ? I18N.s().menuClose : I18N.s().menuOpen);
  menu.classList.toggle("open", open);
}
function closeMenu(refocus) {
  if (!menuIsOpen()) return;
  setMenu(false);
  if (refocus) toggle.focus();
}
toggle.addEventListener("click", () => {
  const open = !menuIsOpen();
  setMenu(open);
  if (open) { const first = menu.querySelector("a"); if (first) first.focus(); }
});
menu.addEventListener("click", (e) => {
  if (e.target.closest("a")) closeMenu(false);
});
// KeyboardEvent.key mangler i Safari 10.0 og iOS < 10.3 (bare keyCode), og gamle Edge sier «Esc»
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" || e.key === "Esc" || e.keyCode === 27) closeMenu(true);
});
// Trykk utenfor menyen og knappen lukker. pointerdown finnes ikke i iOS < 13: der brukes touchstart og mousedown.
const outsideMenu = (e) => {
  if (menuIsOpen() && !menu.contains(e.target) && !toggle.contains(e.target)) closeMenu(false);
};
if (window.PointerEvent) document.addEventListener("pointerdown", outsideMenu);
else {
  document.addEventListener("touchstart", outsideMenu, { passive: true });
  document.addEventListener("mousedown", outsideMenu);
}

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

// Datoer som tekst (ÅÅÅÅ-MM-DD), regnet i UTC så sommertid ikke flytter dagen
const isoDate = (y, m, d) => y + "-" + (m < 10 ? "0" : "") + m + "-" + (d < 10 ? "0" : "") + d;
const dateParts = (s) => s.split("-").map(Number);
function addDaysTo(s, n) {
  const p = dateParts(s);
  const t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return isoDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
const weekdayOf = (s) => { const p = dateParts(s); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); };

// Siste svar fra /api/availability (booking.js sier fra): serverens dato og klokke, åpningstidene og dagene
// barberen har blokkert helt (eierens beslutning D4). Før første svar brukes HOURS og klokka i Norge.
let shopInfo = null;
function onAvailability(a) {
  const d = a && a.data;
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.today) || typeof d.nowMinutes !== "number" || typeof a.at !== "number") return;
  shopInfo = {
    today: d.today, nowMinutes: d.nowMinutes, at: a.at,
    hours: d.hours && typeof d.hours === "object" ? d.hours : null,
    closed: Array.isArray(d.closed) ? d.closed : [],
  };
  updateStatus();
}
if (!Array.isArray(window.bookingAvailabilityListeners)) window.bookingAvailabilityListeners = [];
window.bookingAvailabilityListeners.push(onAvailability);

function shopNow() {
  if (shopInfo) {
    const total = shopInfo.nowMinutes + Math.max(0, Math.floor((Date.now() - shopInfo.at) / 60000));
    const date = addDaysTo(shopInfo.today, Math.floor(total / 1440));
    return { date, day: weekdayOf(date), minutes: total % 1440 };
  }
  const o = osloNow();
  return { date: isoDate(o.y, o.m, o.d), day: o.day, minutes: o.minutes };
}
function hoursOn(day) {
  const h = shopInfo && shopInfo.hours ? shopInfo.hours[day] : HOURS[day];
  return Array.isArray(h) && h.length === 2 && typeof h[0] === "number" && typeof h[1] === "number" ? h : null;
}
const blockedDay = (date) => !!shopInfo && shopInfo.closed.indexOf(date) >= 0;

// Når åpner vi? (ikke «åpent nå») + marker dagens rad i tabellen
function updateStatus() {
  const now = shopNow();
  const blocked = blockedDay(now.date);
  const today = blocked ? null : hoursOn(now.day);
  const el = document.getElementById("open-status");
  const s = I18N.s();

  document.querySelectorAll("#hours-table tr").forEach((tr) => {
    tr.classList.toggle("today", tr.dataset.days.split(" ").includes(String(now.day)));
  });

  const openNow = !!(today && now.minutes >= today[0] && now.minutes < today[1]);
  el.classList.toggle("closed", !openNow); // rød så lenge det er stengt; beholder "anim"-klassen
  if (openNow) {
    el.textContent = s.hoursToday(s.time(today[0]), s.time(today[1]));
    return;
  }
  if (today && now.minutes < today[0]) {
    el.textContent = s.opensToday(s.time(today[0]));
    return;
  }
  // Neste dag med åpningstid som ikke er blokkert (en ferie kan vare lenge: se like langt frem som kalenderen)
  let next = "";
  for (let i = 1; i <= 62; i++) {
    const date = addDaysTo(now.date, i);
    const d = weekdayOf(date);
    const h = hoursOn(d);
    if (h && !blockedDay(date)) {
      const p = dateParts(date);
      const when = i === 1 ? s.tomorrow : i < 7 ? s.days[d] : s.onDate(s.days[d], p[2], p[1]);
      next = s.opensOn(when, s.time(h[0]));
      break;
    }
  }
  el.textContent = blocked ? s.closedToday(next) : next;
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
// Slipp det store bildet når boksen lukkes (knapp, Esc eller bakgrunn), så forrige bilde aldri blinker forbi
// neste gang. compat.js sender også «close» i nettlesere uten <dialog>.
lightboxDlg.addEventListener("close", () => { lightboxImg.removeAttribute("src"); lightboxImg.alt = ""; });
lightboxDlg.addEventListener("click", (e) => { if (e.target === lightboxDlg) lightboxDlg.close(); });

// Kartet: ingenting hentes fra Google før besøkeren trykker «Vis kart» (F47). Uten henvisningsadresse.
const mapBtn = document.getElementById("map-load");
if (mapBtn) mapBtn.addEventListener("click", () => {
  const frame = document.querySelector(".map-frame");
  const note = document.getElementById("map-note");
  frame.setAttribute("src", frame.getAttribute("data-src"));
  frame.hidden = false;
  mapBtn.hidden = true;
  if (note) note.hidden = true;
  frame.focus();
});

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

// Besøksteller uten informasjonskapsler: bare dato, side og hvilket nettsted besøket kom fra
// (f.eks. instagram.com). Ingen IP-adresse eller ID lagres, og ingenting lagres på besøkerens enhet.
(() => {
  try {
    const x = new XMLHttpRequest();
    x.open("POST", "/api/hit", true);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(JSON.stringify({ p: location.pathname, r: document.referrer ? (document.referrer.split("/")[2] || "") : "" }));
  } catch (e) { /* telleren er ikke viktig for siden */ }
})();
