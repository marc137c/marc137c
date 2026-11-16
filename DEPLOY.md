# Publisering og domene – sjekkliste

Denne lista gjelder hver gang koden på `fix/server` (og senere `main`) publiseres til https://www.viggosbarbershop.no.
Hver linje kan krysses av. **Ingenting publiseres før eieren har gitt sitt ene, endelige ja** (nederst), og det kommer
først etter at domenet virker. Bruksanvisningen for barberen står i `viggos-barbershop/README.md`; reglene og
eierens beslutninger i `docs/SPEC.md`.

## 1. Før publisering

- [ ] `npm test` og `npm run check` er grønne lokalt. Netlify kjører dem også før hver publisering (`netlify.toml`), og et rødt bygg publiseres aldri.
- [ ] Eieren har svart på spørsmålene i del 6 med ett ja.
- [ ] Netlify → Forms: skjemagjenkjenning er slått av (Form detection → Disable), og de gamle «booking»-innsendingene er slettet. Dette må være gjort før `personvern.html` publiseres, fordi siden sier at Netlify Blobs er det eneste stedet bestillinger lagres.
- [ ] Netlify → Site configuration → Build & deploy: Deploy Previews er av eller krever godkjenning, og grenutrullinger (branch deploys) er av.
- [ ] Ingen miljøvariabler for den fjernede meldingstjenesten finnes i noen kontekst, og de opprettes aldri (navnene står i `OLD_ENV` i test/no-sms.test.mjs). Koden bruker dem ikke.
- [ ] Husk: en endret miljøvariabel gjelder først etter en ny publisering (Deploys → Trigger deploy → Deploy site). Hver utrulling beholder verdiene den ble bygget med.
- [ ] Prøvekjøring på en godkjent forhåndsvisning (eget lager `bookings-preview`): én nettbestilling, ett nytt forsøk etter et tapt svar, én flytting over månedsskifte, én helt blokkert dag (står som stengt i kalenderen, i linjen øverst og i ukestripen), «Avlys alle nettbestillinger fra …», varselet «Ny time» på barberens telefon, kalenderabonnementet, kundens «Legg i kalenderen» og en 429-melding med 409 63 911.

## 2. Rett etter første publisering av denne koden

- [ ] Slett alle eldre utrullinger, også deploy-preview-1 og deploy-preview-2: Deploys → velg utrullingen → Options → Delete deploy. De har gammel kode og det gamle passordet på sine egne adresser (`<id>--…`); den nye koden svarer 410 «Bruk hovedsiden.» der, men bare slettede utrullinger er helt borte.
- [ ] Kjør `node scripts/smoke-live.mjs https://www.viggosbarbershop.no <gamle permalenkeverter …>`. Alle linjer er OK, og hver gamle permalenke svarer 410 eller 404 på `/api/admin/items`, aldri 401.
- [ ] Etter første døgn: Netlify → Logs → Functions → `retention` viser «Opprydding: N slettet, …». Gamle oppføringer med umulige datoer og de gamle `auth/*`-tellerne er borte, og timeboken viser ingen avtale som ikke kan slettes.

## 3. Eget domene: www.viggosbarbershop.no

Status 16.11.2026 (meldt): domenet virker. www er primæradresse, viggosbarbershop.no og http sender dit, og Let's Encrypt-sertifikatet er gyldig. Sjekk likevel hver linje med smoke-testen etter publisering.

- [ ] Netlify → Domain management: `www.viggosbarbershop.no` er primærdomene, `viggosbarbershop.no` sender dit, og HTTPS-sertifikatet er utstedt.
- [ ] DNS hos Simply.com peker til Netlify slik Netlify viser under Domain management (apex og www). Ingen andre poster for nettstedet.
- [ ] `https://boisterous-salamander-9c6b34.netlify.app/` svarer 301 til https://www.viggosbarbershop.no/ (regelen står i `netlify.toml`; smoke-testen sjekker det).
- [ ] Domenebyttet i koden er gjort: canonical, og:url, og:image (med bredde, høyde og alt), twitter:card og JSON-LD `url` og `image` peker på https://www.viggosbarbershop.no/, og ingen fil nevner en netlify.app-adresse (test/page/site-head.test.mjs).
- [ ] Bytt passordet til timeboken (`ADMIN_PASSWORD`) i Netlify, og publiser på nytt (Deploys → Trigger deploy → Deploy site). Først da gjelder det nye passordet. Alle gamle innlogginger, varsler og den gamle kalenderlenken slutter da å virke.
- [ ] Viggo: slett det gamle «Timebok»-ikonet på Hjem-skjermen. Åpne https://www.viggosbarbershop.no/admin, logg inn, legg Timebok til på Hjem-skjermen igjen (iPhone: Del → Legg til på Hjem-skjerm) og åpne den derfra.
- [ ] Viggo: slå på varsler igjen på hver enhet (Oppsett → Slå på varsler → Tillat). Varsler hører til adressen, så de fra den gamle adressen kommer ikke lenger. «Send testvarsel» skal komme én gang, ikke to.
- [ ] Viggo: lag kalenderlenken på nytt (Oppsett → Lag kalenderlenke), legg den til på telefonen og slett den gamle kalenderen der.
- [ ] Viggo: legg inn nettsiden https://www.viggosbarbershop.no i Google-bedriftsprofilen (Google Business Profile → Rediger profil → Kontakt → Nettsted), så Google Maps og søk lenker til siden.
- [ ] Valgfritt: oppdater lenken i Instagram-bioen, på Facebook-siden og på TikTok til https://www.viggosbarbershop.no.
- [ ] Instagram: legg til `https://www.viggosbarbershop.no/api/connect/instagram/callback` som Redirect URL i Meta-appen, koble til på nytt (README, Instagram steg 6), og sjekk at `/api/social` gir innlegg eller en tom liste (da er feeden skjult).
- [ ] Google-anmeldelser: er `GOOGLE_PLACES_API_KEY` satt, er betalingskontoen koblet til og `GOOGLE_PLACE_ID` satt (README, Google-anmeldelser). Uten nøkkel vises eierens tre utvalgte anmeldelser.
- [ ] https://www.viggosbarbershop.no/personvern.html er oppe (lang nb), lenket nederst på siden og under «Bestill time». Fakta stemmer med «Bedriftsinfo (bekreftet)» i README, og listen over hvem som får opplysninger stemmer med det som er publisert (test/page/privacy.test.mjs).
- [ ] `node scripts/smoke-live.mjs https://www.viggosbarbershop.no` er grønn: favicon lik filen i repoet, apple-touch-icon 200, egen 404-side med «Viggo» og 409 63 911, /README.md gir 404, /personvern.html 200, /api/availability med `closed` og «Herreklipp + skjeggtrim» = 30 min, ingen `data-netlify` og ingen Google Fonts, og og:url er https://www.viggosbarbershop.no/.

## 4. Sjekk for hånd i ekte nettlesere (én om gangen)

- [ ] Chromium 60 og Firefox 57 (`viggos-work/oldbrowsers`), én iPhone og én Android: bestill en ledig tid helt gjennom; feilmeldinger synes, fokus havner riktig, bekreftelsen blir stående og «Legg i kalenderen» åpner.
- [ ] Menyen lukkes med Esc og med et trykk utenfor; Tab går i samme rekkefølge som man ser (1440 px); «Til toppen» går helt opp (375 og 1440 px).
- [ ] Bildeboksen i galleriet, språkbryteren (norsk som standard, engelsk huskes) og «Vis kart» virker; ingen vannrett rulling ved 320 px, og språkbryteren og ikonene øverst er lette å treffe ved 320 og 360 px.
- [ ] /admin ved 320 og 375 px (dato-raden viser hele året, søket, linjen om varsler, kortene og statistikkortet har minst 12 px kant på hver side), på tvers (844×390: toppen ruller med siden), axe-core på admin.html, og at trykk på påminnelsen fra Timebok åpner Oppsett på iPhone.
- [ ] Konsollen i hver nettleser: ingen advarsel eller feil fra våre egne sider (bortsett fra forventede 4xx/5xx-svar).
- [ ] Anmeldelser: gullstjernene ved 4,7, lange navn bryter pent ved 320/375/768/1440 px, arabisk tekst står til høyre, og merket øverst står på egen linje i Safari 10 og Firefox 55.

## 5. Eierens gjennomgang av timeboken (på Viggos egen telefon)

- [ ] Finn en kunde på telefonnummer og avlys timen.
- [ ] Flytt en time til neste måned.
- [ ] Blokker en ferie over eksisterende timer (kundene listes opp).
- [ ] Den blokkerte dagen står som stengt på nettsiden.
- [ ] La fanen stå åpen over natten (den viser den nye dagen).
- [ ] Endre samme time på to enheter (varselet om endring på den andre enheten vises).
- [ ] Avlys mange nettbestillinger fra ett nummer på én gang.
- [ ] Samtykke til bildene: hver person på bildene i `viggos-barbershop/img/` har sagt ja til at bildet brukes på nettsiden.

## 6. Spørsmål og beskjeder til eieren (ett ja for alt)

Koden bygger standardvalgene under. Eieren svarer én gang, i det endelige ja-et.

- [ ] Høyst 6 nettbestillinger per telefonnummer per døgn.
- [ ] Stjernemerket øverst vises når Google har minst 5 anmeldelser, uansett snitt; et lavt snitt skjules aldri.
- [ ] Tomme seksjoner (Instagram uten innlegg, Google uten anmeldelser med tekst) skjules.
- [ ] Kilden står som ren tekst «Google Maps», og kartet lastes først når kunden trykker «Vis kart».
- [ ] Facebook-lenken er i dag en delingslenke; bekreft profiladressen hvis den skal byttes.
- [ ] Kundetekstene: «Vi fikk ikke svar fra bookingsystemet, så vi vet ikke om timen ble lagret. Ring oss på 409 63 911 før du prøver igjen.», «Timen ble ikke lagret. Ring oss på 409 63 911.» og «For mange bestillinger på nett akkurat nå. Ring oss på 409 63 911.» (den siste vises for alle tre grensene: per nettverk, per nummer og for hele siden, så den nevner ingen av dem).
- [ ] Besøksstatistikken (uten personopplysninger) beholdes i 400 dager (slettes ved den daglige oppryddingen, altså senest etter 401 dager).
- [ ] Google-anmeldelser mellomlagres i 12 timer og vises høyst 3 døgn etter siste vellykkede henting (se `docs/contracts/google-places.md`, regel 5).
- [ ] Personvernsiden: teksten i `viggos-barbershop/personvern.html` godkjennes. Skriftene ligger nå på egen server, så Google nevnes ikke lenger for skrifter. Bekreft om misbrukstellerne (nøkkel-hash, slettes ved den daglige oppryddingen når siste forsøk er over 24 timer gammelt, altså senest etter 48 timer) skal ha eget behandlingsgrunnlag på siden (for eksempel berettiget interesse, artikkel 6 nr. 1 bokstav f); i dag står bare bestillingens grunnlag (bokstav b).
- [ ] Etter publiseringen må Viggo logge inn på nytt, slå på varsler igjen og lage ny kalenderlenke én gang (ny nøkkel i koden og ny adresse; del 3). En enhet som ikke logger inn igjen før innloggingen går ut, får ett siste varsel uten kundedata: «Innloggingen på denne enheten har gått ut. …».
- [ ] De nye tekstene barberen ser i timeboken (søk, «Avlys alle nettbestillinger fra …», linjen om varsler, påminnelsen fra Timebok, spørsmålet om å slå av varsler på alle andre enheter) godkjennes.
- [ ] Eierens endelige ja: først da publiseres `main` til https://www.viggosbarbershop.no. Etter publiseringen gjentas del 2 (slett eldre utrullinger, kjør smoke-testen).
