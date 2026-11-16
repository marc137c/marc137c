// Språkstøtte (norsk/engelsk). Norsk står direkte i index.html; her ligger engelsk
// for elementer merket med data-i18n / data-i18n-attr, og tekster som lages i JS.
(() => {
  const EN = {
    "meta.title": "Viggo's Barbershop – Barber in Halden",
    "meta.desc": "Viggo's Barbershop at Violgata 22 in Halden, Norway. Classic scissor cuts, fades, beard trims and straight razor shaves. Book online or call +47 409 63 911.",
    "skip": "Skip to content",
    "brand.label": "Viggo's Barbershop – back to top",
    "nav.label": "Main menu",
    "nav.services": "Services",
    "nav.social": "Follow us",
    "nav.about": "About",
    "nav.hours": "Opening hours",
    "nav.contact": "Contact",
    "cta.book": "Book now",
    "cta.prices": "See prices",

    // 1. Hero
    "hero.tag": "Welcome to <em>Viggo's Barbershop</em>",
    "hero.lead": "Classic barbering with modern precision. Come in for a classic scissor cut, fade, a beard trim or a hot towel shave, and leave a better version of yourself.",

    // 2. Services and prices
    "svc.eyebrow": "Services &amp; prices",
    "svc.title": "What can we do for you?",
    "svc.hint": "Tap a service to book.",
    "svc.popular": "Most popular",
    "s.full": "Full service",
    "s.full.d": "Haircut, shave, wash and styling. The complete package.",
    "s.cut": "Men's haircut",
    "s.cut.d": "Cut with scissors and/or clippers.",
    "s.combo": "Men's haircut + beard trim",
    "s.combo.d": "Haircut and clipper beard trim (same length on the whole beard, no shaping or lines).",
    "dur.30": "30 min",
    "dur.60": "1 hour",
    "s.shave": "Straight razor shave",
    "s.shave.d": "Traditional straight razor shave with hot and cold towels and selected face products.",
    "s.beard": "Beard &amp; line-up",
    "s.beard.d": "Shaping, trim and sharp lines.",
    "s.kids": "Kids' haircut",
    "s.kids.d": "For boys up to and including 12 years. From age 13, regular price applies.",
    "addons.title": "Add-ons",
    "a.washShort": "Wash, short hair",
    "a.washLong": "Wash, long hair",
    "a.styling": "Styling",

    // 3. Booking calendar
    "book.title": "Book an appointment",
    "book.s1": "Choose a service",
    "book.s2": "Choose a day",
    "book.s3": "Choose a time",
    "book.s4": "Your details",
    "book.addons": "Add-ons (optional)",
    "book.call": "Prefer to call?",
    "book.privacy": "We only use your name and phone number for your appointment. Read more in our <a href=\"/personvern.html\" hreflang=\"nb\">privacy notice</a> (in Norwegian).",
    "cal.prev": "Previous month",
    "cal.next": "Next month",
    "f.choose": "– Choose –",
    "f.name": "Name",
    "f.phone": "Phone",
    "f.submit": "Book appointment",
    "book.free": "Available",
    "book.taken": "Booked",
    "book.short": "Too short for the chosen service",
    "hours.note": "Walk-ins are welcome when we have a free chair, but we recommend booking.",

    // 4. Google reviews
    "rev.eyebrow": "Google reviews",
    "rev.title": "What our customers say",
    "rev.all": "See all reviews on Google",

    // 5. Why Viggo's
    "why.title": "Why Viggo's",
    "hl.1t": "Experienced barber",
    "hl.1p": "Over 20 years in the industry, in Norway, New York, Stockholm and Kosovo.",
    "hl.2t": "No stress",
    "hl.2p": "We set aside plenty of time for every customer. Come in, have a chat and relax.",
    "hl.3t": "Quality products",
    "hl.3p": "We use professional hair and beard products.",

    // 6. About us
    "about.eyebrow": "About us",
    "about.title": "A place for good conversations and sharp lines",
    "about.p1": "Viggo's Barbershop opened in 2026 in Halden. Behind the chair is Vigan Kurti, with over 20 years of experience in the industry in Norway, New York, Stockholm and Kosovo. The goal is a professional barbershop that delivers top quality and service.",
    "about.p2": "Whether you want a clean classic cut, a modern fade or just your beard in shape, we take the time to find the style that suits you.",
    "stat.opened": "opened in Halden",
    "stat.walkin": "Walk-ins",
    "stat.dropin": "and booking",
    "g.sign": "Viggo's Barbershop gold sign on the window",
    "g.card": "Viggo's Barbershop business card with clippers, shaving brush and razor",
    "g.close": "Close",
    "g.p1": "Viggo cutting a customer's hair with clippers",
    "g.p2": "Straight-razor shave along the beard line",
    "g.p4": "Viggo giving a boy a fade",
    "g.p5": "Scissors and comb in Viggo's hands",
    "g.p6": "Viggo in a vest and tie by a barber pole",
    "g.p7": "Viggo sitting in a leather chair in the shop",
    "about.photo": "Portrait of Vigan “Viggo” Kurti",

    // 7. Opening hours
    "hours.eyebrow": "Opening hours",
    "hours.title": "When can you come?",
    "hours.weekdays": "Monday–Friday",
    "hours.wk": "10:00 AM–6:00 PM",
    "hours.sat": "10:00 AM–5:00 PM",
    "day.6": "Saturday",
    "day.0": "Sunday",
    "closed": "Closed",
    "c.address": "Address",
    "c.map": "Get directions →",
    "c.maptitle": "Map: Violgata 22, 1776 Halden",
    "c.mapload": "Show map (Google Maps)",
    "c.mapnote": "The map loads from Google only when you tap.",

    // 8. Social media
    "soc.eyebrow": "Social media",
    "soc.title": "Fresh from the chair",
    "soc.lead": "Our latest cuts from Instagram.",
    "soc.follow": "Follow us",

    // 9. Footer
    "foot.tel": "Tel",
    "totop": "Back to top ↑",
    "foot.privacy": "Privacy",
    "foot.org": "Org. no.",
  };

  // 24-timers klokke på norsk, 12-timers (AM/PM) på engelsk
  const time24 = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  const time12 = (min) => {
    const h = Math.floor(min / 60), m = min % 60;
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  };

  // Tekster som brukes fra script.js, booking.js, reviews.js og social-feed.js
  const STRINGS = {
    no: {
      locale: "nb-NO",
      time: time24,
      days: ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"],
      tomorrow: "i morgen",
      hoursToday: (a, b) => `I dag kl. ${a}–${b}`,
      opensToday: (t) => `Åpner i dag kl. ${t}`,
      opensOn: (when, t) => `Åpner ${when} kl. ${t}`,
      // En dag barberen har blokkert helt i timeboken (eierens beslutning D4)
      closedToday: (next) => (next ? `Stengt i dag · ${next}` : "Stengt i dag"),
      // «Åpner …» en uke eller mer frem: med dato
      onDate: (dayName, d, m) => `${dayName} ${d}. ${["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"][m - 1]}`,
      price: (n) => `fra ${n},-`,
      menuOpen: "Åpne meny",
      menuClose: "Lukk meny",
      switchTo: "Switch to English",
      // Booking
      pickDayFirst: "Velg en dag i kalenderen først.",
      noSlots: "Ingen ledige tider denne dagen. Velg en annen dag.",
      closedDay: "Stengt",
      today: "I dag",
      summary: (svc, date, t) => `${svc} · ${date} kl. ${t}`,
      needService: "Velg en tjeneste.",
      needDay: "Velg en dag.",
      needTime: "Velg et tidspunkt.",
      needName: "Skriv inn navnet ditt.",
      needPhone: "Skriv inn et gyldig telefonnummer.",
      sending: "Sender …",
      // Bestillingen: et svar vi ikke kan stole på er «uncertain», et sikkert nei er «notSaved» (eierens beslutning D3)
      uncertain: "Vi fikk ikke svar fra bookingsystemet, så vi vet ikke om timen ble lagret. Ring oss på 409 63 911 før du prøver igjen.",
      notSaved: "Timen ble ikke lagret. Ring oss på 409 63 911.",
      rateLimited: "For mange bestillinger fra dette nummeret akkurat nå. Ring oss på 409 63 911.",
      taken: "Opptatt",
      tooShort: "Ikke nok tid til valgt tjeneste",
      shortTag: "For kort",
      fullDay: "Fullbooket",
      noFitDay: "Ikke ledig for valgt tjeneste",
      dayFull: "Alle tider er booket denne dagen. Velg en annen dag.",
      dayNoFit: "Valgt tjeneste rekker ikke på noen ledig tid denne dagen. Velg en kortere tjeneste eller en annen dag.",
      takenNow: "Beklager, noen rakk å booke den tiden akkurat nå. Velg en annen tid.",
      dayFullNow: "Beklager, noen rakk å booke den siste ledige tiden denne dagen. Velg en annen dag.",
      timeGone: "Tiden du valgte er ikke ledig lenger. Velg en annen tid.",
      tooShortPicked: "Valgt tjeneste rekker ikke før neste avtale eller stengetid. Velg en annen tid.",
      dayGone: "Dagen du valgte kan ikke bestilles lenger. Velg en annen dag.",
      reloadPage: "Siden er oppdatert. Last inn siden på nytt og prøv igjen.",
      booked: (when) => `Timen er booket: ${when}. Velkommen! Må du endre eller avlyse, ring oss på 409 63 911.`,
      // Linjen som blir stående over skjemaet etter hver bestilling, med lenke til timen som kalenderfil
      bookedLine: (when) => `Timen er booket: ${when}`,
      addToCalendar: "Legg i kalenderen",
      // Anmeldelser
      // Data fra Google (Places API) merkes «Google Maps» (Googles krav); reviews.js hindrer at navnet oversettes
      basedOn: (n) => `basert på ${n} ${n === 1 ? "anmeldelse" : "anmeldelser"} på Google Maps`,
      ratingOf: (r) => `${r} av 5 stjerner`,
      heroRating: (r, n) => `${r} på Google Maps · ${n} ${n === 1 ? "anmeldelse" : "anmeldelser"}`,
      readOnGoogle: "Les hele på Google",
      reviewsNote: "Et utvalg av anmeldelsene med tekst, i den rekkefølgen Google Maps viser dem (mest relevante først).",
      onGoogle: "på Google",
      googleReview: "Google-anmeldelse",
      // Instagram
      followOn: (n) => `Følg oss på ${n}`,
      openPost: (n) => `Åpne innlegget på ${n}`,
    },
    en: {
      locale: "en-GB",
      time: time12,
      days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
      tomorrow: "tomorrow",
      hoursToday: (a, b) => `Today ${a}–${b}`,
      opensToday: (t) => `Opens today at ${t}`,
      opensOn: (when, t) => `Opens ${when} at ${t}`,
      closedToday: (next) => (next ? `Closed today · ${next}` : "Closed today"),
      onDate: (dayName, d, m) => `${dayName} ${d} ${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]}`,
      price: (n) => `from ${n} NOK`,
      menuOpen: "Open menu",
      menuClose: "Close menu",
      switchTo: "Bytt til norsk",
      // Booking
      pickDayFirst: "Choose a day in the calendar first.",
      noSlots: "No available times this day. Please choose another day.",
      closedDay: "Closed",
      today: "Today",
      summary: (svc, date, t) => `${svc} · ${date} at ${t}`,
      needService: "Please choose a service.",
      needDay: "Please choose a day.",
      needTime: "Please choose a time.",
      needName: "Please enter your name.",
      needPhone: "Please enter a valid phone number.",
      sending: "Sending …",
      uncertain: "We didn't get an answer from the booking system, so we don't know if your appointment was booked. Please call us on 409 63 911 before you try again.",
      notSaved: "Your appointment was not booked. Please call us on 409 63 911.",
      rateLimited: "Too many bookings from this number right now. Please call us on 409 63 911.",
      taken: "Booked",
      tooShort: "Not enough time for the selected service",
      shortTag: "Too short",
      fullDay: "Fully booked",
      noFitDay: "Not available for the selected service",
      dayFull: "Every time is booked this day. Please choose another day.",
      dayNoFit: "The selected service doesn't fit in any free time this day. Please choose a shorter service or another day.",
      takenNow: "Sorry, someone just booked that time. Please choose another time.",
      dayFullNow: "Sorry, someone just booked the last free time this day. Please choose another day.",
      timeGone: "The time you chose is no longer available. Please choose another time.",
      tooShortPicked: "The selected service doesn't fit before the next appointment or closing time. Please choose another time.",
      dayGone: "The day you chose can no longer be booked. Please choose another day.",
      reloadPage: "This page has been updated. Please reload it and try again.",
      booked: (when) => `You're booked: ${when}. See you then! To change or cancel, call us on 409 63 911.`,
      bookedLine: (when) => `You're booked: ${when}`,
      addToCalendar: "Add to calendar",
      // Reviews
      basedOn: (n) => `based on ${n} ${n === 1 ? "review" : "reviews"} on Google Maps`,
      ratingOf: (r) => `${r} out of 5 stars`,
      heroRating: (r, n) => `${r} on Google Maps · ${n} ${n === 1 ? "review" : "reviews"}`,
      readOnGoogle: "Read on Google",
      reviewsNote: "A selection of the reviews with text, in the order Google Maps shows them (most relevant first).",
      onGoogle: "on Google",
      googleReview: "Google review",
      // Instagram
      followOn: (n) => `Follow us on ${n}`,
      openPost: (n) => `Open the post on ${n}`,
    },
  };

  const NO = {}; // originalteksten fra HTML-en, fanges opp første gang
  const listeners = [];
  const store = {
    get() { try { return localStorage.getItem("lang"); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem("lang", v); } catch (e) { /* privat modus */ } },
  };

  // Norsk for alle (eierens beslutning D5), også for nettlesere på engelsk eller svensk. Engelsk bare når
  // besøkeren har valgt det: ?lang=en i adressen, eller bryteren (valget huskes).
  function detect() {
    const param = /[?&]lang=(en|no)(?=&|$)/.exec(location.search);
    if (param) return param[1];
    return store.get() === "en" ? "en" : "no";
  }

  // Kom besøkeren med ?lang=… og bytter språk, skrives parameteren om, så «last inn på nytt» gir det nye valget
  function rewriteParam(lang) {
    try {
      if (/[?&]lang=(en|no)(?=&|$)/.test(location.search) && history.replaceState) {
        history.replaceState(history.state, "", location.pathname + location.search.replace(/([?&]lang=)(en|no)(?=&|$)/, "$1" + lang) + location.hash);
      }
    } catch (e) { /* adressen er ikke viktig nok til å stoppe språkbyttet */ }
  }

  function apply(lang) {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.dataset.i18n;
      if (!(key in NO)) NO[key] = el.innerHTML;
      el.innerHTML = lang === "en" && EN[key] != null ? EN[key] : NO[key];
    });
    document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
      el.dataset.i18nAttr.split(";").forEach((pair) => {
        const [attr, key] = pair.split(":");
        const id = `${key}@${attr}`;
        if (!(id in NO)) NO[id] = el.getAttribute(attr);
        el.setAttribute(attr, lang === "en" && EN[key] != null ? EN[key] : NO[id]);
      });
    });
    const s = STRINGS[lang];
    document.querySelectorAll("[data-price]").forEach((el) => { el.textContent = s.price(el.dataset.price); });

    const btn = document.getElementById("lang-toggle");
    if (btn) {
      // Bryteren viser språket du bytter TIL: «English» på norsk side, «Norsk» på engelsk side
      const label = btn.querySelector(".lang-label");
      label.textContent = lang === "en" ? "Norsk" : "English";
      label.lang = lang === "en" ? "no" : "en";
      btn.classList.toggle("is-en", lang === "en");
      btn.setAttribute("aria-label", s.switchTo);
    }
    I18N.lang = lang;
    listeners.forEach((fn) => fn(lang));
  }

  const I18N = {
    lang: "no",
    s: () => STRINGS[I18N.lang],
    onChange: (fn) => listeners.push(fn),
    set(lang) { store.set(lang); apply(lang); rewriteParam(lang); },
  };
  window.I18N = I18N;

  apply(detect());
  const langBtn = document.getElementById("lang-toggle");
  if (langBtn) langBtn.addEventListener("click", () => {
    I18N.set(I18N.lang === "en" ? "no" : "en");
  });
})();
