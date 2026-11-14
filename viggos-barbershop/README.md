# Viggo's Barbershop – nettside

Statisk nettside (HTML/CSS/JS, ingen avhengigheter). Åpne `index.html` i nettleseren for å se den lokalt.

## Publisering på Netlify
`netlify.toml` i roten av repoet peker Netlify til denne mappen (`publish = "viggos-barbershop"`).
Bestillinger lagres i Netlify Blobs (lageret `bookings`) via Netlify Functions, og sendes i tillegg som e-postvarsel via Netlify Forms (skjemaet `booking`).
**Viktig:** Netlify-siden må bygges fra dette GitHub-repoet (Site configuration → Build & deploy → Link repository), ellers blir verken funksjonene eller timeboken publisert.

## Bedriftsinfo (bekreftet)
- **Viggos Barbershop Kurti**, org.nr. 937 845 812, innehaver Vigan Kurti
- Violgata 22, 1776 Halden – telefon 409 63 911 – e-post kurtivigan1@gmail.com
- Instagram [@viggos.barbershop](https://www.instagram.com/viggos.barbershop/), TikTok [@viggos.barbershop1](https://www.tiktok.com/@viggos.barbershop1), [Facebook](https://www.facebook.com/share/19enEU6x6Q/) (lenkene står i `SOCIAL` i `script.js`)
- Kilder: Brønnøysund via Proff.no, Gule Sider og Halden Arbeiderblad

## Innhold som må holdes oppdatert
- **Priser og tjenester:** i `index.html` (prislisten og nedtrekkslisten i bestillingen) og engelsk tekst i `i18n.js`.
- **Åpningstider:** `CONFIG.hours` i `netlify/lib/booking-core.mjs` styrer kalenderen og hvilke tider som kan bestilles (nettsiden henter dem derfra). Oppdater også `HOURS` i `script.js` (reserve når serveren ikke svarer), tabellen og `openingHoursSpecification` i `index.html` og engelsk tekst (`hours.wk`, `hours.sat`) i `i18n.js`.
- **Varighet per tjeneste:** `CONFIG.durations` i `netlify/lib/booking-core.mjs` (Full service = 60 min, alle andre 30 min).
- **Bookingvarsler:** i Netlify går du til **Forms → booking → Form notifications** og legger inn kurtivigan1@gmail.com, så kommer timeforespørslene på e-post.

## Bestillingskalender
`booking.js`: kunden velger tjeneste (og eventuelle tillegg), dag og tid, og skriver navn og telefon.
- Kalenderen følger åpningstidene: søndager og passerte dager er stengt, tider deles i 30 minutter, i dag vises bare tider minst én time frem, og man kan bestille opptil 60 dager frem.
- **Opptatte tider vises i rødt med «Opptatt»**, dager med noen bookinger får en gull prikk, og fullbookede dager blir røde. Tider der valgt tjeneste ikke rekker før neste avtale eller stengetid er grået ut.
- Bestillingen lagres med en gang (`/api/bookings`). To kunder kan aldri få samme tid: den som kommer sist får beskjed om å velge en annen.
- I tillegg sendes et e-postvarsel via Netlify Forms (feltene `tjeneste`, `tillegg`, `dato`, `tid`, `navn`, `telefon`, alltid på norsk).
- **Bakoverkompatibelt:** svarer ikke bookingsystemet (f.eks. før funksjonene er publisert), virker kalenderen som før og sender en forespørsel via Netlify Forms.

## Timebok for admin (`/admin`)
Gå til **/admin** (lenke «Admin» nederst på siden), skriv passordet og trykk Enter. «Hold meg innlogget» er på som standard, så du slipper å logge inn igjen på 60 dager, og nettleseren kan huske passordet.
- **Engangsoppsett:** i Netlify → Site configuration → Environment variables, legg inn `ADMIN_PASSWORD` med et passord du velger. Bytter du passordet, blir alle logget ut.
- Dagsoversikt med alle tider: røde kort er avtaler (navn, tjeneste, telefon du kan trykke på for å ringe), grå stripete er blokkeringer, grønne er ledige – trykk på en ledig tid for å legge inn en avtale.
- Trykk på en avtale for å **flytte** (ny dato/tid), endre tjeneste/varighet/navn, **avlyse** (tiden blir ledig igjen) eller **slette**.
- **Blokker tid** for lunsj, ferie eller fridager – blokkert tid vises som opptatt for kundene.
- Admin kan legge inn timer utenom åpningstid. Kolliderer en endring med en annen avtale, spør siden om du vil dobbeltbooke.
- Oversikten oppdaterer seg selv hvert 30. sekund, så nye nettbestillinger dukker opp.

## Google-anmeldelser
Seksjonen «Hva kundene sier» viser snittkarakteren og 3–4 anmeldelser hentet automatisk fra Google (`/api/reviews`, mellomlagret i 12 timer).
Før den er satt opp, vises en henvisning til Google med lenken «Se alle anmeldelser på Google».

Oppsett (ca. 10 minutter):
1. Gå til console.cloud.google.com, lag et prosjekt og slå på **Places API (New)**.
2. Lag en **API-nøkkel** (APIs & Services → Credentials) og begrens den til Places API (New).
3. Legg den inn i **Netlify → Site configuration → Environment variables** som `GOOGLE_PLACES_API_KEY`.
4. Valgfritt: `GOOGLE_PLACE_ID` – ellers finner siden «Viggos Barbershop» i Violgata 22 automatisk.
5. Publiser på nytt. Google gir maks 5 anmeldelser per oppslag; siden viser de 4 første med tekst.

## Galleri
Galleriet under «Om oss» viser bildene i `<div class="gallery">` i `index.html`. Slik legger du til et bilde:
1. Legg bildet i `img/` som både `.webp` og `.jpg` med samme navn, ca. 1200 px bredt, og gjerne en mindre versjon på ca. 720 px. Eldre iPhone og Safari kan ikke vise WebP, så de får JPG-kopien.
2. Kopier en `<figure>`-blokk i galleriet og bytt `srcset` og `src` (liten versjon), `data-full` (stor versjon, `.webp`) og `alt` (beskrivelse).
Galleriet tilpasser seg antallet bilder automatisk, og bildene åpnes stort ved klikk. Kortene er stående (4:5); juster utsnittet med `style="object-position: …"` på bildet.

Portrettet i «Om oss» er `img/viggo-portrett-600` og `-1000` (webp og jpg).

## Språk (norsk / English)
Siden finnes på norsk og engelsk. Bryteren **English / Norsk** øverst i menyen bytter språk på hele siden, og valget huskes.
Besøkende med nettleser på norsk får norsk, alle andre får engelsk. Lenke direkte til en versjon med `?lang=en` eller `?lang=no`.

- Norsk tekst står i `index.html`. Engelsk tekst står i `EN` i `i18n.js` (samme nøkkel som `data-i18n` i HTML-en).
- Endrer du en tekst på norsk, oppdater den engelske også.
- Tekster som lages av JavaScript (åpent/stengt, kalenderen, skjemameldinger, anmeldelser) står i `STRINGS` i `i18n.js`. På engelsk vises klokkeslett med AM/PM.
- Bookingskjemaet sender alltid tjenestenavnet på norsk, så forespørslene i Netlify blir like uansett språk.

## Logo og profil
Logoen er laget i kode slik at den er skarp på alle skjermer: «Viggo's» i skriveskrift (Google-fonten Great Vibes),
«BARBERSHOP» i Cinzel, og ornamentlinjen med diamant som SVG (`--ornament` i `styles.css`). Fargene er dyp grønn og gull fra visittkortet.
Bildene av gullskiltet og visittkortet ligger i `img/` (webp i to størrelser).

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
`gold-snow.js` legger et stille snøfall av gullstøv over hele siden. Det tar ikke imot klikk og ligger under menyen.
Antall partikler tilpasses skjermstørrelsen, og ved «redusert bevegelse» i systeminnstillingene står støvet stille.
Juster mengden i `resize()` (tallet `20000` – lavere tall gir flere partikler) eller farten i `makeFlake()`.
