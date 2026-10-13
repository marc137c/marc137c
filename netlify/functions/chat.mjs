// AI-stilrådgiver for Viggo's Barbershop.
// Kjører som Netlify Function slik at ANTHROPIC_API_KEY aldri sendes til nettleseren.
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // leser ANTHROPIC_API_KEY fra miljøvariabler i Netlify

const MODEL = process.env.CLAUDE_MODEL || "claude-fable-5-1";
const MAX_MESSAGES = 12;
const MAX_CHARS = 1000;

// Holdes uendret mellom forespørsler. Oppdater når ekte priser/adresse er på plass.
const SYSTEM = `Du er stilrådgiveren på nettsiden til Viggo's Barbershop, en herrefrisør.
Svar alltid på norsk, kort og vennlig (maks 4–5 setninger), som en erfaren barberer ville gjort.
Hjelp kunden å finne en klipp eller skjeggstil som passer ansiktsform, hårtype og livsstil, og anbefal en konkret tjeneste fra listen.
Avslutt gjerne med å foreslå at de bestiller time via skjemaet på siden eller ringer.
Hold deg til hår, skjegg, stell og barbershopen. Er spørsmålet utenfor dette, si høflig at du bare kan hjelpe med det.
Ikke finn på informasjon som ikke står her (for eksempel ledige timer, tilbud eller ansattnavn).

Tjenester og priser:
- Herreklipp 450,- (saks og/eller maskin, vask og styling)
- Skin fade 500,-
- Barneklipp (under 12 år) 300,-
- Maskinklipp 250,-
- Skjeggtrim 300,-
- Varm håndklebarbering 400,-
- Klipp + skjegg 700,-
- Viggo's Deluxe 950,- (klipp, skjegg, varmt håndkle, ansiktsmaske, styling)

Åpningstider: man–ons og fre 10–18, tor 10–20, lør 10–16, søndag stengt. Drop-in når det er ledig.`;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function validate(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return false;
  return messages.every(
    (m, i) =>
      m &&
      m.role === (i % 2 === 0 ? "user" : "assistant") &&
      typeof m.content === "string" &&
      m.content.trim().length > 0 &&
      m.content.length <= MAX_CHARS,
  ) && messages.length % 2 === 1; // siste melding må være fra brukeren
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Bruk POST." });

  let messages;
  try {
    ({ messages } = await req.json());
  } catch {
    return json(400, { error: "Ugyldig forespørsel." });
  }
  if (!validate(messages)) return json(400, { error: "Ugyldig samtale." });

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      messages: messages.map(({ role, content }) => ({ role, content })),
      output_config: { effort: "low" },
      // Hvis modellen avslår, kjøres forespørselen automatisk på en anbefalt reservemodell.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    if (response.stop_reason === "refusal") {
      return json(200, { reply: "Det kan jeg dessverre ikke hjelpe med. Spør meg gjerne om klipp, skjegg eller stell!" });
    }

    const reply = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    return json(200, { reply: reply || "Beklager, jeg fikk ikke til å svare. Prøv igjen?" });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return json(429, { error: "Mange spør nå – prøv igjen om litt." });
    }
    if (error instanceof Anthropic.AuthenticationError) {
      console.error("Ugyldig eller manglende ANTHROPIC_API_KEY");
    } else if (error instanceof Anthropic.APIError) {
      console.error(`Claude API-feil ${error.status}:`, error.message);
    } else {
      console.error(error);
    }
    return json(502, { error: "Stilrådgiveren er utilgjengelig akkurat nå." });
  }
};

export const config = { path: "/api/chat" };
