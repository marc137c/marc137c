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
const DAY_NAMES = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];

const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// Mobilmeny
const toggle = document.querySelector(".nav-toggle");
const menu = document.getElementById("nav-menu");
toggle.addEventListener("click", () => {
  const open = toggle.getAttribute("aria-expanded") === "true";
  toggle.setAttribute("aria-expanded", String(!open));
  toggle.setAttribute("aria-label", open ? "Åpne meny" : "Lukk meny");
  menu.classList.toggle("open", !open);
});
menu.addEventListener("click", (e) => {
  if (e.target.closest("a")) {
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Åpne meny");
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

  document.querySelectorAll("#hours-table tr").forEach((tr) => {
    tr.classList.toggle("today", Number(tr.dataset.day) === day);
  });

  if (today && minutes >= today[0] && minutes < today[1]) {
    el.className = "status open";
    el.textContent = `Åpent nå – stenger kl. ${fmt(today[1])}`;
    return;
  }
  el.className = "status closed";
  if (today && minutes < today[0]) {
    el.textContent = `Stengt nå – åpner i dag kl. ${fmt(today[0])}`;
    return;
  }
  for (let i = 1; i <= 7; i++) {
    const d = (day + i) % 7;
    if (HOURS[d]) {
      const when = i === 1 ? "i morgen" : DAY_NAMES[d];
      el.textContent = `Stengt nå – åpner ${when} kl. ${fmt(HOURS[d][0])}`;
      return;
    }
  }
}
updateStatus();
setInterval(updateStatus, 60_000);

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
    msg.textContent = "Vi har stengt på søndager. Velg en annen dag.";
    return;
  }
  const [hh, mm] = form.tid.value.split(":").map(Number);
  const t = hh * 60 + mm;
  if (t < hours[0] || t >= hours[1]) {
    msg.className = "form-msg err";
    msg.textContent = `Den dagen har vi åpent ${fmt(hours[0])}–${fmt(hours[1])}.`;
    return;
  }

  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  msg.textContent = "Sender …";
  try {
    const res = await fetch("/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(new FormData(form)).toString(),
    });
    if (!res.ok) throw new Error(res.status);
    form.reset();
    msg.className = "form-msg ok";
    msg.textContent = "Takk! Vi tar kontakt for å bekrefte timen.";
  } catch {
    msg.className = "form-msg err";
    msg.textContent = "Noe gikk galt. Ring oss gjerne i stedet.";
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

// AI-stilrådgiver: samtalen sendes til /api/chat (Netlify Function) – API-nøkkelen ligger kun på serveren.
const chat = {
  open: document.getElementById("chat-open"),
  close: document.getElementById("chat-close"),
  panel: document.getElementById("chat-panel"),
  log: document.getElementById("chat-log"),
  form: document.getElementById("chat-form"),
  input: document.getElementById("chat-input"),
  chips: document.getElementById("chat-chips"),
};
const history = [];
const MAX_HISTORY = 11; // serveren godtar maks 12 meldinger; siste må være fra brukeren

function setChatOpen(open) {
  chat.panel.hidden = !open;
  chat.open.setAttribute("aria-expanded", String(open));
  if (open) chat.input.focus();
  else chat.open.focus();
}
chat.open.addEventListener("click", () => setChatOpen(true));
chat.close.addEventListener("click", () => setChatOpen(false));
document.querySelectorAll("[data-open-chat]").forEach((b) => b.addEventListener("click", () => setChatOpen(true)));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !chat.panel.hidden) setChatOpen(false);
});

function addMsg(text, cls) {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.textContent = text;
  chat.log.appendChild(div);
  chat.log.scrollTop = chat.log.scrollHeight;
  return div;
}

async function ask(text) {
  text = text.trim();
  if (!text) return;
  chat.chips.hidden = true;
  addMsg(text, "user");
  history.push({ role: "user", content: text });
  while (history.length > MAX_HISTORY) history.splice(0, 2); // dropp eldste spørsmål/svar-par

  const btn = chat.form.querySelector("button");
  btn.disabled = chat.input.disabled = true;
  const typing = addMsg("Tenker", "bot typing");
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.reply) throw new Error(data.error || "Noe gikk galt.");
    typing.remove();
    addMsg(data.reply, "bot");
    history.push({ role: "assistant", content: data.reply });
  } catch (err) {
    typing.remove();
    history.pop(); // fjern spørsmålet så samtalen fortsatt veksler bruker/assistent
    addMsg(err.message || "Noe gikk galt. Prøv igjen.", "bot err");
  } finally {
    btn.disabled = chat.input.disabled = false;
    chat.input.focus();
  }
}

chat.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chat.input.value;
  chat.input.value = "";
  ask(text);
});
chat.chips.addEventListener("click", (e) => {
  if (e.target.tagName === "BUTTON") ask(e.target.textContent);
});
