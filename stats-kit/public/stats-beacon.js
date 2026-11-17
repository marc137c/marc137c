/* Besøksteller (statistikk-settet). Uten informasjonskapsler: sender bare side, avsendernettsted og en eventuell
   merket kilde (?fra=instagram) til /api/hit. Ingen ID, ingenting lagres på besøkerens enhet.
   ES5 og XMLHttpRequest, så den virker også i gamle nettlesere (Safari/iOS 10, Chrome 60, Firefox 55, Samsung 8).
   Bruk på hver side: <script src="/stats-beacon.js" defer></script> */
(function () {
  try {
    var m = /[?&]fra=([a-z0-9_-]{1,20})/i.exec(location.search || "");
    var ref = document.referrer ? (document.referrer.split("/")[2] || "") : "";
    var x = new XMLHttpRequest();
    x.open("POST", "/api/hit", true);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(JSON.stringify({ p: location.pathname, r: ref, f: m ? m[1].toLowerCase() : "" }));
  } catch (e) { /* telleren er aldri viktigere enn siden */ }
})();
