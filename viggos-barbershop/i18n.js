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
    "nav.about": "About",
    "nav.hours": "Opening hours",
    "nav.contact": "Contact",
    "cta.book": "Book now",
    "cta.prices": "See prices",

    // 1. Hero
    "hero.badge": "Newly opened in Halden · Violgata 22",
    "hero.tag": "Your style. <em>Our craft.</em>",
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
    "s.combo": "Men's haircut + beard trim (clippers)",
    "s.combo.d": "Haircut and clipper beard trim.",
    "s.shave": "Straight razor shave",
    "s.shave.d": "Traditional razor shave with hot towels and balm.",
    "s.beard": "Beard &amp; line-up",
    "s.beard.d": "Shaping, trim and sharp lines.",
    "s.kids": "Kids' haircut",
    "s.kids.d": "For boys up to and including 12 years. From age 13, regular price applies.",
    "addons.title": "Add-ons",
    "a.washShort": "Wash, short hair",
    "a.washLong": "Wash, long hair",
    "a.styling": "Styling",

    // 3. Booking calendar
    "book.eyebrow": "Booking",
    "book.title": "Book an appointment",
    "book.lead": "Choose your service, day and time.",
    "book.s1": "Choose a service",
    "book.s2": "Choose a day",
    "book.s3": "Choose a time",
    "book.s4": "Your details",
    "book.addons": "Add-ons (optional)",
    "book.call": "Prefer to call?",
    "cal.prev": "Previous month",
    "cal.next": "Next month",
    "f.choose": "Choose a service",
    "f.name": "Name",
    "f.phone": "Phone",
    "f.submit": "Book appointment",
    "book.free": "Available",
    "book.taken": "Booked",
    "book.some": "Partly booked",
    "hours.note": "Walk-ins are welcome when we have a free chair, but we recommend booking.",

    // 4. Google reviews
    "rev.eyebrow": "Google reviews",
    "rev.title": "What our customers say",
    "rev.all": "See all reviews on Google",

    // 5. Why Viggo's
    "why.title": "Why Viggo's",
    "hl.1t": "Experienced barber",
    "hl.1p": "Over 20 years in the industry, in Norway, the USA, Sweden and Kosovo.",
    "hl.2t": "No stress",
    "hl.2p": "We set aside plenty of time for every customer. Come in, have a chat and relax.",
    "hl.3t": "Quality products",
    "hl.3p": "We use professional hair and beard products.",

    // 6. About us
    "about.eyebrow": "About us",
    "about.title": "A place for good conversations and sharp lines",
    "about.p1": "Viggo's Barbershop opened in 2026 in Halden. Behind the chair is Vigan Kurti, with over 20 years of experience in the industry in Norway, the USA, Sweden and Kosovo. The goal is a place where people can drop in, have a chat and feel at home.",
    "about.p2": "Whether you want a clean classic cut, a modern fade or just your beard in shape, we take the time to find the style that suits you.",
    "stat.opened": "opened in Halden",
    "stat.walkin": "Walk-ins",
    "stat.dropin": "and booking",
    "g.sign": "Viggo's Barbershop gold sign on the window",
    "g.card": "Viggo's Barbershop business card with clippers, shaving brush and razor",
    "g.close": "Close",

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

    // 8. Social media
    "soc.eyebrow": "Social media",
    "soc.title": "Fresh from the chair",
    "soc.lead": "Our latest cuts from Instagram.",

    // 9. Footer
    "foot.tel": "Tel",
    "totop": "Back to top ↑",
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
      openNow: (t) => `Åpent nå, stenger kl. ${t}`,
      opensToday: (t) => `Stengt nå, åpner i dag kl. ${t}`,
      opensOn: (when, t) => `Stengt nå, åpner ${when} kl. ${t}`,
      price: (n) => `fra ${n},-`,
      menuOpen: "Åpne meny",
      menuClose: "Lukk meny",
      switchTo: "Switch to English",
      toLight: "Bytt til lyst tema",
      toDark: "Bytt til mørkt tema",
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
      sent: (when) => `Takk! Vi har mottatt forespørselen din for ${when}. Vi bekrefter timen så fort vi kan.`,
      sendFailed: "Noe gikk galt. Prøv igjen, eller ring oss på 409 63 911.",
      taken: "Opptatt",
      tooShort: "Ikke nok tid til valgt tjeneste",
      fullDay: "Fullbooket",
      someBooked: "Noen tider er opptatt",
      dayFull: "Alle tider er booket denne dagen. Velg en annen dag.",
      takenNow: "Beklager, noen rakk å booke den tiden akkurat nå. Velg en annen tid.",
      booked: (when) => `Timen er booket: ${when}. Velkommen! Må du endre eller avlyse, ring oss på 409 63 911.`,
      // Anmeldelser
      basedOn: (n) => `basert på ${n} anmeldelser på Google`,
      ratingOf: (r) => `${r} av 5 stjerner`,
      reviewsFallback: "Les hva kundene våre sier om oss på Google.",
      // Instagram
      followOn: (n) => `Følg oss på ${n}`,
      openPost: (n) => `Åpne innlegget på ${n}`,
    },
    en: {
      locale: "en-GB",
      time: time12,
      days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
      tomorrow: "tomorrow",
      openNow: (t) => `Open now, closes at ${t}`,
      opensToday: (t) => `Closed now, opens today at ${t}`,
      opensOn: (when, t) => `Closed now, opens ${when} at ${t}`,
      price: (n) => `from ${n} NOK`,
      menuOpen: "Open menu",
      menuClose: "Close menu",
      switchTo: "Bytt til norsk",
      toLight: "Switch to light mode",
      toDark: "Switch to dark mode",
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
      sent: (when) => `Thanks! We've received your request for ${when}. We'll confirm your appointment as soon as we can.`,
      sendFailed: "Something went wrong. Please try again, or call us on 409 63 911.",
      taken: "Booked",
      tooShort: "Not enough time for the selected service",
      fullDay: "Fully booked",
      someBooked: "Some times are booked",
      dayFull: "Every time is booked this day. Please choose another day.",
      takenNow: "Sorry, someone just booked that time. Please choose another time.",
      booked: (when) => `You're booked: ${when}. See you then! To change or cancel, call us on 409 63 911.`,
      // Reviews
      basedOn: (n) => `based on ${n} reviews on Google`,
      ratingOf: (r) => `${r} out of 5 stars`,
      reviewsFallback: "Read what our customers say about us on Google.",
      // Instagram
      followOn: (n) => `Follow us on ${n}`,
      openPost: (n) => `Open the post on ${n}`,
    },
  };

  const NO = {}; // originalteksten fra HTML-en, fanges opp første gang
  const listeners = [];
  const store = {
    get() { try { return localStorage.getItem("lang"); } catch { return null; } },
    set(v) { try { localStorage.setItem("lang", v); } catch { /* privat modus */ } },
  };

  function detect() {
    const param = new URLSearchParams(location.search).get("lang");
    if (param === "en" || param === "no") return param;
    const saved = store.get();
    if (saved === "en" || saved === "no") return saved;
    const langs = navigator.languages || [navigator.language || ""];
    return langs.some((l) => /^(nb|nn|no)\b/i.test(l)) ? "no" : "en";
  }

  function apply(lang) {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.dataset.i18n;
      if (!(key in NO)) NO[key] = el.innerHTML;
      el.innerHTML = lang === "en" ? EN[key] ?? NO[key] : NO[key];
    });
    document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
      el.dataset.i18nAttr.split(";").forEach((pair) => {
        const [attr, key] = pair.split(":");
        const id = `${key}@${attr}`;
        if (!(id in NO)) NO[id] = el.getAttribute(attr);
        el.setAttribute(attr, lang === "en" ? EN[key] ?? NO[id] : NO[id]);
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
    set(lang) { store.set(lang); apply(lang); },
  };
  window.I18N = I18N;

  apply(detect());
  document.getElementById("lang-toggle")?.addEventListener("click", () => {
    I18N.set(I18N.lang === "en" ? "no" : "en");
  });
})();
