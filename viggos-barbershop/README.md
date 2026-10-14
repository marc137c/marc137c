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

## Instagram- og TikTok-feed (oppdateres automatisk)
Seksjonen «Ferskt fra stolen» viser de 3 nyeste postene fra Instagram og de 3 nyeste fra TikTok (2 per rad, 3 rader).

Slik fungerer det:
- `netlify/functions/social-refresh.mjs` kjører **hver time**. Den henter nye poster, fornyer tilgangsnøklene automatisk og lagrer feeden i Netlify Blobs.
- `/api/social` (`netlify/functions/social.mjs`) leverer feeden til siden (`social-feed.js`).
- Før kontoene er koblet til, vises «Følg oss»-kort med lenke til profilene.

### Engangsoppsett (ca. 20 minutter)
**1. Netlify → Site configuration → Environment variables:**
| Variabel | Verdi |
|---|---|
| `SOCIAL_ADMIN_KEY` | Et langt, hemmelig passord du finner på selv. Beskytter koblingslenkene. |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | Fra Meta-appen (steg 2) |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | Fra TikTok-appen (steg 3) |

**2. Instagram** (kontoen må være en *profesjonell konto*: Bedrift eller Innholdsskaper)
1. Opprett en app på developers.facebook.com → produktet **Instagram** → «API setup with Instagram login».
2. Legg inn **Valid OAuth Redirect URI**: `https://<din-side>/api/connect/instagram/callback`
3. Legg til @viggos.barbershop som Instagram-tester og godta invitasjonen i Instagram-appen.
4. Kopier Instagram App ID og App Secret til Netlify.

**3. TikTok**
1. Opprett en app på developers.tiktok.com med **Login Kit** og **Display API** (scopes `user.info.basic` og `video.list`).
2. Legg inn **Redirect URI**: `https://<din-side>/api/connect/tiktok/callback`
3. Mens appen er i sandbox: legg @viggos.barbershop1 til som «target user».
4. Kopier Client key og Client secret til Netlify.

**4. Koble til kontoene** (etter at siden er publisert med variablene over):
- `https://<din-side>/api/connect/instagram?key=<SOCIAL_ADMIN_KEY>`
- `https://<din-side>/api/connect/tiktok?key=<SOCIAL_ADMIN_KEY>`

Logg inn og godkjenn. Siden bekrefter når kontoen er koblet, og postene vises med en gang. Deretter går alt av seg selv.
`<din-side>` må være den samme adressen som er registrert i appene, for eksempel `viggos-barbershop.netlify.app`.
