# Oversikt – alle bedriftene

Eierens egen side (bare du har passordet): besøk og bookinger for alle bedriftene, side om side. Egen Netlify-side (ikke Viggo's).

## Slik henger det sammen
- Hver bedrifts side har `netlify/functions/stats.mjs` + `netlify/lib/stats-bookings.mjs` (samme filer som Viggo's).
  De teller besøk uten informasjonskapsler og regner bookingtall ut fra bookingene – bare tall, aldri navn eller telefon.
- Bedriftens side svarer på `/api/stats` **bare** med lesenøkkelen `STATS_READ_KEY` – kun eieren ser statistikken.
  Bedriftene (f.eks. Viggo i /admin) ser den ikke.
- Oversikten (`netlify/functions/overview.mjs`) henter alle bedriftene samtidig med hver sin nøkkel
  (`STATS_KEY_<NAVN>` i oversiktens innstillinger) og viser dem i én tabell + ett kort per bedrift.
- Innlogging: passordet `OVERVIEW_PASSWORD` (settes i et skjult vindu, vises aldri). 8 feil på 15 min = pause.

## Ny bedrift
1. Gi bedriftens side de to statistikkfilene og beacon-linjene i `script.js` (som Viggo's).
2. Legg til én linje i `sites.mjs`: `{ id, name, url, keyEnv: "STATS_KEY_<NAVN>" }`.
3. Kjør `viggos-work/tools/link-stats-key.sh <bedriftens Netlify-mappe> <oversiktens Netlify-mappe> STATS_KEY_<NAVN>`
   (mappene er koblet med `netlify link`) – lager en tilfeldig nøkkel og lagrer den på begge sidene uten å vise den.
4. Publiser bedriftens side og oversikten på nytt.

## Publisere oversikten
1. Legg inn variablene FØRST: `OVERVIEW_PASSWORD` (`set-overview-password.sh`) og hver `STATS_KEY_<NAVN>`
   (`link-stats-key.sh`). Hver publisering beholder variablene den ble laget med, så en ny eller endret variabel
   gjelder først etter en ny publisering av oversikten (og en ny lesenøkkel også etter en ny publisering av bedriftens side).
2. Fra denne mappen, `npm install` (funksjonen trenger `@netlify/blobs` i `oversikt/node_modules`: CLI-en pakker fra
   repo-roten og følger ikke en Windows-kobling til `node_modules`, da mangler pakken når funksjonen kjører), deretter:
   `netlify deploy --prod --site <oversiktens side-id> --dir public --functions netlify/functions`.
3. Sjekk etterpå: `node smoke.mjs https://<oversiktens adresse>`. Den prøver å logge inn med et tilfeldig, påfunnet
   passord: 401 «Feil passord.» betyr at passordet er med i publiseringen. 503 «Passordet er ikke satt ennå.» betyr at
   publiseringen ble laget før passordet: publiser på nytt. 502 betyr at `@netlify/blobs` mangler i pakken.
   (`/api/overview` uten innlogging gir 401 også når passordet mangler, så den alene sier ingenting.)
4. Logg inn: Viggo's rad skal vise tall, ikke «Mangler lesenøkkel» (`STATS_KEY_VIGGOS` er ikke med i denne
   publiseringen) eller «Lesenøkkelen ble ikke godtatt» (nøklene på de to sidene er ulike, eller bedriftens side er ikke
   publisert på nytt etter at `STATS_READ_KEY` ble lagt inn).

## Teste lokalt
`npm test` i rotmappen kjører testene for statistikken og oversikten.
