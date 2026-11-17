// Bedriftene i oversikten. NY BEDRIFT: legg til én linje her (id, navn, adresse og navnet på lesenøkkelen),
// kjør så tools/link-stats-key.sh slik at bedriftens side og oversikten får den samme hemmelige lesenøkkelen.
// Bedriftens side må ha netlify/functions/stats.mjs (samme fil som Viggo's) for at tallene skal komme.
export const SITES = [
  { id: "viggos", name: "Viggo's Barbershop", url: "https://www.viggosbarbershop.no", keyEnv: "STATS_KEY_VIGGOS" },
];
