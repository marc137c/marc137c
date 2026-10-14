# Viggo's Barbershop – nettside

Statisk nettside (HTML/CSS/JS, ingen avhengigheter). Åpne `index.html` i nettleseren for å se den lokalt.

## Publisering på Netlify
`netlify.toml` i roten av repoet peker Netlify til denne mappen (`publish = "viggos-barbershop"`).
Bookingskjemaet bruker Netlify Forms – forespørsler dukker opp under **Forms** i Netlify-dashbordet.

## Bedriftsinfo (bekreftet)
- **Viggos Barbershop Kurti**, org.nr. 937 845 812, innehaver Vigan Kurti
- Svenskegata 2, 1776 Halden – telefon 409 63 911 – e-post kurtivigan1@gmail.com
- Kilder: Brønnøysund via Proff.no, Gule Sider og Halden Arbeiderblad

## Må bekreftes / fylles inn
- **Sosiale medier:** lim inn lenkene i `SOCIAL` øverst i `script.js`. Ikonene vises først når en lenke er lagt inn.
- **Priser og tjenester:** står i `index.html` og i `SYSTEM` i `netlify/functions/chat.mjs`.
- **Åpningstider:** står i tabellen i `index.html`, i `HOURS` øverst i `script.js` og i `chat.mjs`.
- **Bookingvarsler:** i Netlify går du til **Forms → booking → Form notifications** og legger inn kurtivigan1@gmail.com, så kommer timeforespørslene på e-post.
- **Omtaler:** seksjonen er fjernet til ekte omtaler finnes, for eksempel fra Google.

## AI-stilrådgiver (Claude)
Chat-knappen nede til høyre sender spørsmål til `/api/chat`, en Netlify Function (`netlify/functions/chat.mjs`)
som kaller Claude via Anthropic sitt offisielle SDK. API-nøkkelen ligger kun på serveren – aldri i nettleseren.

Oppsett i Netlify → **Site configuration → Environment variables**:
- `ANTHROPIC_API_KEY` – nøkkel fra https://platform.claude.com (påkrevd)
- `CLAUDE_MODEL` – valgfri, standard er `claude-fable-5-1`. Sett f.eks. `claude-haiku-5-5` for en mye billigere modell.

Priser, åpningstider og regler for assistenten står i `SYSTEM`-teksten øverst i `chat.mjs` – oppdater den sammen med nettsiden.

## Språk (norsk / English)
Siden finnes på norsk og engelsk. Knappen **EN/NO** i menyen bytter språk, og valget huskes.
Besøkende med nettleser på norsk får norsk, alle andre får engelsk. Lenke direkte til en versjon med `?lang=en` eller `?lang=no`.

- Norsk tekst står i `index.html`. Engelsk tekst står i `EN` i `i18n.js` (samme nøkkel som `data-i18n` i HTML-en).
- Endrer du en tekst på norsk, oppdater den engelske også.
- Tekster som lages av JavaScript (åpent/stengt, skjemameldinger, chat) står i `STRINGS` i `i18n.js`.
- Bookingskjemaet sender alltid tjenestenavnet på norsk, så forespørslene i Netlify blir like uansett språk.
- AI-stilrådgiveren svarer på samme språk som kunden skriver på.

## Logo og profil
Logoen er laget i kode slik at den er skarp på alle skjermer: «Viggo's» i skriveskrift (Google-fonten Great Vibes),
«BARBERSHOP» i Cinzel, og ornamentlinjen med diamant som SVG (`--ornament` i `styles.css`). Fargene er dyp grønn og gull fra visittkortet.
Bildet av gullskiltet ligger i `img/` (webp i to størrelser).
