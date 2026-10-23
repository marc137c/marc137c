/* Databasen (Supabase) med menyen og prisene som eieren endrer på admin.html.
   Nøkkelen er en publiserbar nøkkel og kan ligge åpent: databasen slipper bare inn
   gjennom funksjonene i supabase/oppsett.sql, og for å lagre trengs eierkoden.
   Uten denne filen viser siden menyen i meny.js, og eieren kan bare laste ned en ny meny.js. */
window.KC_DATABASE = {
  supabaseUrl: "https://epdxvcgstojcffyznohx.supabase.co",
  supabaseKey: "sb_publishable_DCw7ZypPdJCFiQlO_Sq_6g_GdxYMybz"
};
