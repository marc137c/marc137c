// MIDLERTIDIG bookingvarsel for Viggo (til de ekte push-varslene på fix/server er publisert – slett da denne og
// .github/workflows/booking-alarm.yml). Kjøres av GitHub Actions hvert 5. minutt.
// Leser den OFFENTLIGE ledighetslisten (/api/availability: bare opptatte tidsrom, aldri navn eller telefon),
// sammenligner med forrige kjøring og sender «Ny booking: lørdag 21.11 kl. 14:30» til ntfy-appen på Viggos telefon.
// Kanalen (NTFY_TOPIC) er en GitHub-hemmelighet, så ingen andre kan lese eller sende varsler til den.
// En ny opptatt tid kan også være tid Viggo selv har blokkert i /admin – teksten sier derfor «booking eller blokkert tid».
import fs from "node:fs";

const SITE = "https://www.viggosbarbershop.no";
const STATE = ".alarm/state.json";
const DAYS = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
const hm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const label = (date, s, e) => `${DAYS[new Date(date + "T12:00:00Z").getUTCDay()]} ${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}. kl. ${hm(s)}–${hm(e)}`;

export function newSlots(prevKeys, busy) {
  const now = [];
  for (const date of Object.keys(busy || {})) for (const [s, e] of busy[date]) now.push(`${date} ${s} ${e}`);
  if (!prevKeys) return { now, fresh: null }; // første kjøring: bare husk, ikke varsle
  const before = new Set(prevKeys);
  return { now, fresh: now.filter((k) => !before.has(k)).sort() };
}

async function notify(topic, title, body) {
  const r = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: "POST", body,
    headers: { Title: title, Tags: "scissors", Priority: "high", Click: `${SITE}/admin` },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) console.log("ntfy svarte", r.status);
}

async function main() {
  const topic = process.env.NTFY_TOPIC;
  // Mangler kanalen, skal kjøringen bli RØD (ikke «vellykket» uten å varsle noen)
  if (!topic) { console.error("NTFY_TOPIC mangler – legg den inn som GitHub-hemmelighet (Settings → Secrets and variables → Actions). Ingen varsler sendt."); process.exitCode = 1; return; }
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(STATE, "utf8")).busy; } catch { /* første kjøring */ }
  let a;
  try {
    const r = await fetch(`${SITE}/api/availability`, { headers: { Accept: "application/json", "User-Agent": "viggo-booking-alarm (GitHub Actions)" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) { console.log("Ledighetslisten svarte", r.status, "– prøver igjen neste gang (forrige tilstand beholdes)."); return; }
    a = await r.json();
  } catch (err) { console.log("Fikk ikke kontakt med nettsiden:", err.message); return; }
  const { now, fresh } = newSlots(prev, a.busy);
  fs.mkdirSync(".alarm", { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ at: new Date().toISOString(), busy: now }));
  if (fresh === null) { console.log("Første kjøring: husker", now.length, "opptatte tider. Ingen varsel."); return; }
  console.log("Nye opptatte tider:", fresh.length);
  for (const k of fresh.slice(0, 5)) {
    const [date, s, e] = k.split(" ");
    await notify(topic, "Ny booking", `${label(date, Number(s), Number(e))}\nNy booking (eller tid du har blokkert). Trykk for å se den i Timeboka.`);
  }
  if (fresh.length > 5) await notify(topic, "Flere nye bookinger", `${fresh.length} nye opptatte tider. Se Timeboka.`);
}

if (process.argv[1] && process.argv[1].endsWith("booking-alarm.mjs")) await main();
