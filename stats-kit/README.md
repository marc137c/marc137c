# Statistikk-sett for nye nettsider

Teller besøk uten informasjonskapsler på en ny bedrifts nettside og viser tallene **bare i eierens oversikt**
(aldri for bedriften selv). Virker i gamle nettlesere (Safari/iOS 10+, Chrome 60+, Firefox 55+, Samsung 8+).

## Legg til på en ny nettside (Netlify)
1. Kopier `netlify/functions/stats.mjs` inn i nettsidens `netlify/functions/` (trenger `@netlify/blobs` i package.json).
2. Kopier `public/stats-beacon.js` inn i mappen som publiseres, og legg denne linjen nederst i `<body>` på hver side:
   `<script src="/stats-beacon.js" defer></script>`
3. Koble siden til oversikten (fra `viggos-work`):
   `bash tools/add-site.sh <nettsidens Netlify-mappe> <id> "<Navn>" https://<adresse>`
   – lager en hemmelig lesenøkkel, lagrer den på nettsiden og i oversikten. Oversikten trenger IKKE publiseres på nytt.
4. Publiser nettsiden én gang (så funksjonen får nøkkelen). Den dukker opp i oversikten ved neste oppdatering.

Fjerne en bedrift fra oversikten: `bash tools/remove-site.sh <id>`.

## Merkede lenker (se hvor besøkene kommer fra)
Apper som Instagram, Facebook, SMS og WhatsApp sender ofte ikke hvor besøket kom fra (da står det «Direkte»).
Bruk merkede lenker, så telles de riktig:
- Instagram-bio: `https://<adresse>/?fra=instagram`
- Facebook: `?fra=facebook` · TikTok: `?fra=tiktok` · Snapchat: `?fra=snapchat`
- QR-kode på plakat/disk: `?fra=qr` · Visittkort: `?fra=visittkort` · SMS: `?fra=sms` · E-post: `?fra=epost`
Ukjente merker telles som «Annet».

## Hva lagres
Per dag: antall sidevisninger, besøk (kom utenfra), hvilke sider og kilder. Ingen IP-adresse, ingen ID, ingen
informasjonskapsel. Roboter og forhåndsvisninger telles ikke. Nevn dette i bedriftens personvernerklæring.

## Bookingtall
Settet teller besøk. Har nettsiden timebestilling som Viggo's (netlify/lib/booking-core.mjs), bruk Viggo's
`netlify/functions/stats.mjs` + `netlify/lib/stats-bookings.mjs` i stedet – da kommer bookingtallene med.
