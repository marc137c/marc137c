# Oversikt – alle bedriftene

Eierens egen side (bare du har passordet): besøk og bookinger for alle bedriftene, side om side. Egen Netlify-side (ikke Viggo's).

## Slik henger det sammen
- Nye bedrifters sider har statistikk-settet (`stats-kit/`: `stats.mjs` + `stats-beacon.js`). Viggo har sin egen
  `netlify/functions/stats.mjs` + `netlify/lib/stats-bookings.mjs` (med bookingtall). Begge teller besøk uten
  informasjonskapsler – bare tall, aldri navn eller telefon.
- Bedriftens side svarer på `/api/stats` **bare** med lesenøkkelen `STATS_READ_KEY` – kun eieren ser statistikken.
  Bedriftene (f.eks. Viggo i /admin) ser den ikke.
- Bedriftslisten = de faste i `sites.mjs` (Viggo, nøkkel `STATS_KEY_VIGGOS` i oversiktens innstillinger) + bedrifter
  lagt til med `tools/add-site.sh` (oversiktens Blobs-lager «oversikt-sites», med nøkkelen; den sendes aldri til nettleseren).
- Oversikten (`netlify/functions/overview.mjs`) henter alle bedriftene samtidig og viser dem i én tabell + ett kort
  per bedrift. Svarene behandles som utrygge (bare tall går videre). Kan bedriftslisten ikke leses, eller er en
  oppføring ugyldig, står det øverst på siden – bedrifter forsvinner ikke i stillhet.
- Innlogging: passordet `OVERVIEW_PASSWORD` (settes i et skjult vindu, vises aldri). 8 feil på 15 min = pause
  (også når mange forsøk kommer samtidig).

## Én gang: publiser oversikten fra commit a10db3f eller nyere
Den publiserte oversikten (6bf757a) kjenner ikke bedriftslisten. Én produksjonspublisering (se under) trengs før
bedrifter lagt til med `add-site.sh` vises. Publiser oversikten **før** Viggo's side publiseres med de nye kildene
(QR, SMS, e-post, visittkort, Snapchat), ellers viser den gamle oversikten «undefined NN %» og mister de nye kildene.

## Ny bedrift (ingen ny publisering av oversikten)
Følg `stats-kit/README.md`: kopier settet inn i bedriftens side, kjør
`bash viggos-work/tools/add-site.sh <bedriftens Netlify-mappe> <id> "<Navn>" https://<endelig adresse>`
og publiser bedriftens side én gang. Fjerne: `bash viggos-work/tools/remove-site.sh <id>`.

Den gamle veien (en linje i `sites.mjs` + `tools/link-stats-key.sh`) brukes bare for Viggo, og krever at oversikten
publiseres på nytt (koster credits).

## Publisere oversikten
Fra denne mappen, FØRST `npm install` (funksjonen trenger `@netlify/blobs` i `oversikt/node_modules`: CLI-en pakker fra
repo-roten og følger ikke en Windows-kobling til `node_modules`, da mangler pakken når funksjonen kjører), deretter:
`netlify deploy --prod --site <oversiktens side-id> --dir public --functions netlify/functions`.
Sjekk etterpå: `/api/overview` uten innlogging skal gi 401 (502 betyr at pakken mangler).

## Teste lokalt
`npm test` i rotmappen kjører testene for statistikken og oversikten.
