// De FASTE bedriftene i oversikten (nå bare Viggo, med nøkkelen STATS_KEY_VIGGOS i oversiktens innstillinger).
// NY BEDRIFT: IKKE legg den til her. Bruk tools/add-site.sh (se stats-kit/README.md): den lagres i oversiktens
// bedriftsliste (Blobs «oversikt-sites»), og oversikten trenger verken kodeendring eller ny publisering.
// En linje her (+ tools/link-stats-key.sh) virker først etter at oversikten er publisert på nytt (koster credits).
export const SITES = [
  { id: "viggos", name: "Viggo's Barbershop", url: "https://www.viggosbarbershop.no", keyEnv: "STATS_KEY_VIGGOS" },
];
