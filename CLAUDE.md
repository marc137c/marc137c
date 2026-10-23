# Arbeidsregler

- Svar på norsk, i vanlig tekst med få punktlister. Forklar kort hva som gjøres.
- Bruk hver skill og hvert verktøy som er nyttig til oppgaven, uten å spørre først.
- Står du fast på noe du ikke klarer selv, finn et verktøy, en skill eller en tilkobling som klarer det, før du gir opp eller ber brukeren gjøre det.
- Alt må være bakoverkompatibelt: det som virker i dag, skal fortsette å virke.
- Finn rotårsaken før noe rettes, og rett den der.
- Koder, API-nøkler og hemmeligheter skal aldri ligge i koden eller i git. Bare bcrypt-hasher i databasen.

# Prosjektet

Nettsiden til Kebab Corner Halden ligger i `kebab-corner-halden/` (ren HTML og JavaScript, ingen byggesteg).
Menyen og prisene endres av eieren på `admin.html` og lagres i Supabase (`supabase/oppsett.sql`).
Finnes ikke menyen i databasen, brukes `meny.js`, og ellers menyen inne i `index.html`.
