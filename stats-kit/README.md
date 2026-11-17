# Statistikk-sett for nye nettsider

Teller besøk uten informasjonskapsler på en ny bedrifts nettside og viser tallene **bare i eierens oversikt**
(aldri for bedriften selv). Virker i gamle nettlesere (Safari/iOS 10+, Chrome 60+, Firefox 55+, Samsung 8+).

## Én gang først: publiser oversikten med bedriftslisten
Den publiserte oversikten må være fra commit a10db3f eller nyere (den leser bedriftslisten «oversikt-sites»).
Den gamle oversikten (6bf757a) ser ikke bedrifter lagt til med `add-site.sh`. Det koster **én** produksjonspublisering
av oversikten (se `oversikt/README.md`). Etter det trenger oversikten ikke publiseres på nytt når en bedrift kommer til.
**Rekkefølge:** publiser oversikten FØR Viggo's side publiseres med de nye kildene (QR, SMS, …). Ellers viser den gamle
oversikten «undefined 60 %» som største kilde og mister de nye kildene i lista.

## Legg til på en ny nettside (Netlify)
1. Kopier `netlify/functions/stats.mjs` inn i nettsidens `netlify/functions/`. Nettsidens package.json må ha
   `"@netlify/blobs": "^11.1.4"` (samme som her). Eldre versjoner (før 10) kan ikke skrive betinget; da nekter
   funksjonen å telle i stedet for å telle hvert besøk flere ganger.
2. Kopier `public/stats-beacon.js` inn i mappen som publiseres, og legg denne linjen nederst i `<body>` på hver side:
   `<script src="/stats-beacon.js" defer></script>`
3. Koble siden til oversikten (fra `viggos-work`):
   `bash tools/add-site.sh <nettsidens Netlify-mappe> <id> "<Navn>" https://<endelig adresse>`
   - Mappen må selv være koblet med `netlify link` (ha sin egen `.netlify/state.json`); det samme gjelder `~/oversikt-netlify`.
   - Bruk den endelige adressen (den siden ikke videresender fra), f.eks. `https://www.bedrift.no`. Oversikten følger
     ikke videresendinger (nøkkelen skal aldri sendes videre) og viser da «Siden videresender».
   - Skriptet sjekker navn og adresse med oversiktens egne regler før noe lagres, lager en hemmelig lesenøkkel,
     lagrer den på nettsiden og så i oversiktens bedriftsliste, og sjekker etterpå at begge ble lagret.
4. Publiser nettsiden én gang (så funksjonen får nøkkelen): med Git, eller med CLI-en etter `npm install`
   (ikke dra-og-slipp – da mangler `@netlify/blobs`). Sjekk så `https://<adresse>/api/stats` uten nøkkel:
   **401** er riktig, **502** betyr at pakken mangler. Bedriften dukker opp i oversikten ved neste oppdatering.

Fjerne en bedrift fra oversikten: `bash tools/remove-site.sh <id>` (sjekker at id-en finnes, og at den er borte etterpå).

## Merkede lenker (se hvor besøkene kommer fra)
Apper som Instagram, Facebook, SMS og WhatsApp sender ofte ikke hvor besøket kom fra (da står det «Direkte»).
Bruk merkede lenker, så telles de riktig:
- Instagram-bio: `https://<adresse>/?fra=instagram`
- Facebook: `?fra=facebook` · TikTok: `?fra=tiktok` · Snapchat: `?fra=snapchat`
- QR-kode på plakat/disk: `?fra=qr` · Visittkort: `?fra=visittkort` · SMS: `?fra=sms` · E-post: `?fra=epost`
Ukjente merker telles som «Annet».

## Hva lagres, og hvor lenge
Per dag: antall sidevisninger, besøk (kom utenfra), hvilke sider (høyst 30 ulike navn per dag, resten som «annen»)
og kilder. Ingen IP-adresse, ingen ID, ingen informasjonskapsel, ingenting på besøkerens enhet. Roboter og
forhåndsvisninger telles ikke. Tallene lagres i nettsidens Netlify Blobs og **slettes etter 400 dager**
(første besøk hver dag rydder bort eldre dager).

Ferdig avsnitt til bedriftens personvernerklæring:

> **Besøksstatistikk.** Når du besøker nettsiden, telles besøket uten informasjonskapsler. Vi lagrer bare antall
> sidevisninger og besøk per dag, hvilken side som ble vist, og hvor besøket kom fra (Instagram, Facebook, Google,
> TikTok, Snapchat, QR-kode, SMS, e-post, visittkort, direkte eller annet). Vi lagrer ikke IP-adressen din, ingen ID
> og ingenting på enheten din, så tallene kan ikke knyttes til deg. Tallene lagres hos Netlify (serverfunksjoner og
> Netlify Blobs) og slettes etter 400 dager.

## Kostnad
Hver sidevisning er ett kall til en serverfunksjon. Det bruker Netlify-credits fra **samme pott som alle sidene på
kontoen** (forespørsler + regnetid). Går potten tom, setter Netlify alle prosjektene på kontoen på pause. «Ingen ny
publisering av oversikten» betyr altså ikke «gratis»: slå på automatisk påfylling, eller legg kundenes sider i
kundens egen Netlify-konto/team.

## Bookingtall
Settet teller besøk. Har nettsiden timebestilling som Viggo's (netlify/lib/booking-core.mjs), bruk Viggo's
`netlify/functions/stats.mjs` + `netlify/lib/stats-bookings.mjs` i stedet – da kommer bookingtallene med.
