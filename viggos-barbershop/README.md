# Viggo's Barbershop – nettside

Statisk nettside (HTML/CSS/JS, ingen avhengigheter). Åpne `index.html` i nettleseren for å se den lokalt.

## Publisering på Netlify
`netlify.toml` i roten av repoet peker Netlify til denne mappen (`publish = "viggos-barbershop"`).
Bookingskjemaet bruker Netlify Forms – forespørsler dukker opp under **Forms** i Netlify-dashbordet.

## Bedriftsinfo (bekreftet)
- **Viggos Barbershop Kurti**, org.nr. 937 845 812, innehaver Vigan Kurti
- Svenskegata 2, 1776 Halden – telefon 409 63 911 – e-post kurtivigan1@gmail.com
- Instagram [@viggos.barbershop](https://www.instagram.com/viggos.barbershop/), TikTok [@viggos.barbershop1](https://www.tiktok.com/@viggos.barbershop1), [Facebook](https://www.facebook.com/share/19enEU6x6Q/) (lenkene står i `SOCIAL` i `script.js`)
- Kilder: Brønnøysund via Proff.no, Gule Sider og Halden Arbeiderblad

## Må bekreftes / fylles inn
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
Siden finnes på norsk og engelsk. Bryteren **English / Norsk** øverst i menyen bytter språk på hele siden, og valget huskes.
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

## Instagram-feed (oppdateres automatisk)
Seksjonen «Ferskt fra stolen» viser de 6 nyeste Instagram-postene (2 per rad, 3 rader).

Slik fungerer det:
- `netlify/functions/social-refresh.mjs` kjører **hver time**. Den henter nye poster, fornyer tilgangsnøkkelen automatisk og lagrer feeden i Netlify Blobs.
- `/api/social` (`netlify/functions/social.mjs`) leverer feeden til siden (`social-feed.js`).
- Før kontoen er koblet til, vises et «Følg oss på Instagram»-kort.

### Engangsoppsett (ca. 15 minutter)
Instagram-kontoen må være en **profesjonell konto** (Bedrift eller Innholdsskaper). Det er gratis å bytte i Instagram-appen under Innstillinger → Kontotype.

1. Gå til developers.facebook.com → **Create app** → velg «Other» → app-type **Business**.
2. Legg til produktet **Instagram** → «API setup with Instagram login».
3. Under «Set up Instagram business login» legger du inn **Redirect URL**:
   `https://<din-side>/api/connect/instagram/callback`
4. Under **Roles → Instagram testers** legger du til `viggos.barbershop`. Godta invitasjonen i Instagram (Innstillinger → Apper og nettsteder → Testerinvitasjoner).
5. I **Netlify → Site configuration → Environment variables** legger du inn:
   | Variabel | Verdi |
   |---|---|
   | `INSTAGRAM_APP_ID` | Instagram app ID (fra steg 2) |
   | `INSTAGRAM_APP_SECRET` | Instagram app secret (fra steg 2) |
   | `SOCIAL_ADMIN_KEY` | Et langt, hemmelig passord du finner på selv. Beskytter koblingslenken. |
6. Publiser siden på nytt, og åpne `https://<din-side>/api/connect/instagram?key=<SOCIAL_ADMIN_KEY>`.
   Logg inn med @viggos.barbershop og godkjenn. Siden bekrefter når kontoen er koblet, og postene vises med en gang.

`<din-side>` må være den samme adressen som er registrert i steg 3, for eksempel `viggos-barbershop.netlify.app`.

## Lyst og mørkt tema
Sol/måne-knappen øverst i menyen bytter mellom mørkt tema (standard) og lyst tema, og valget huskes.
Fargene for begge temaene står som variabler øverst i `styles.css` (`:root` og `:root[data-theme="light"]`).
Den animerte bakgrunnen i toppen bytter farger mykt sammen med temaet.

## Gyllent partikkel-snøfall
`gold-snow.js` legger et stille snøfall av gullstøv over hele siden. Det tar ikke imot klikk og ligger under menyen og chatten.
Antall partikler tilpasses skjermstørrelsen, og ved «redusert bevegelse» i systeminnstillingene står støvet stille.
Juster mengden i `resize()` (tallet `20000` – lavere tall gir flere partikler) eller farten i `makeFlake()`.
