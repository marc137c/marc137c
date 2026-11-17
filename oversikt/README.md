# Oversikt – alle bedriftene

Eierens egen side: besøk og bookinger for alle bedriftene, side om side. Egen Netlify-side (ikke Viggo's).

## Slik henger det sammen
- Hver bedrifts side har `netlify/functions/stats.mjs` + `netlify/lib/stats-bookings.mjs` (samme filer som Viggo's).
  De teller besøk uten informasjonskapsler og regner bookingtall ut fra bookingene – bare tall, aldri navn eller telefon.
- Bedriftens side svarer på `/api/stats` bare til innlogget barber **eller** med lesenøkkelen `STATS_READ_KEY`.
- Oversikten (`netlify/functions/overview.mjs`) henter alle bedriftene samtidig med hver sin nøkkel
  (`STATS_KEY_<NAVN>` i oversiktens innstillinger) og viser dem i én tabell + ett kort per bedrift.
- Innlogging: passordet `OVERVIEW_PASSWORD` (settes i et skjult vindu, vises aldri). 8 feil på 15 min = pause.

## Ny bedrift
1. Gi bedriftens side de to statistikkfilene og beacon-linjene i `script.js` (som Viggo's).
2. Legg til én linje i `sites.mjs`: `{ id, name, url, keyEnv: "STATS_KEY_<NAVN>" }`.
3. Kjør `tools/link-stats-key.sh <bedriftens-netlify-side-id> STATS_KEY_<NAVN>` – lager en tilfeldig nøkkel og
   lagrer den på begge sidene uten å vise den.
4. Publiser bedriftens side og oversikten på nytt.

## Publisere oversikten
Fra denne mappen: `netlify deploy --prod --site <oversiktens side-id>` (funksjonene bygges fra `netlify/functions`).

## Teste lokalt
`npm test` i rotmappen kjører testene for statistikken og oversikten.
