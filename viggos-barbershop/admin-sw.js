// Service worker for timeboken (/admin): viser varsel om nye bestillinger (Web Push) og åpner timeboken på riktig
// dag når Viggo trykker på varselet. admin.js registrerer den med scope «/admin», så den aldri styrer nettsiden.
// Ingen fetch-håndtering og ingen mellomlagring: timeboken hentes alltid fersk fra serveren.
// Bytter nettleseren ut abonnementet (pushsubscriptionchange), gir den serveren det nye (POST /api/push/renew).
// Meldingen er JSON fra netlify/lib/push.mjs: { title, body, url, tag }.
(function () {
  "use strict";
  var HOME = "/admin";
  var ICON = "/admin-icon-192.png";
  var ADMIN_PATH = /^\/admin(?:\.html)?$/;

  // Bare timeboken på denne nettsiden kan åpnes fra et varsel
  function target(url) {
    try {
      var u = new URL(String(url || HOME), self.location.origin);
      if (u.origin === self.location.origin && ADMIN_PATH.test(u.pathname)) return u.pathname + u.search;
    } catch (e) { /* ugyldig adresse */ }
    return HOME;
  }
  // /admin?varsler=1: timeboken åpner Oppsett ved «Slå på varsler» (påminnelsen nedenfor)
  function wantsPush(url) { return /[?&]varsler=1(?:&|$)/.test(url); }
  function dayIn(url) {
    var m = /[?&]dag=(\d{4}-\d{2}-\d{2})(?:&|$)/.exec(url);
    return m ? m[1] : null;
  }

  self.addEventListener("install", function () { self.skipWaiting(); });
  self.addEventListener("activate", function (event) { event.waitUntil(self.clients.claim()); });

  // Hver push viser et varsel. Safari og Chrome krever det, ellers trekkes tillatelsen tilbake.
  self.addEventListener("push", function (event) {
    var data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
    if (!data || typeof data !== "object") data = {};
    var options = {
      body: typeof data.body === "string" ? data.body : "Noe nytt i timeboken.",
      icon: ICON,
      lang: "nb",
      data: { url: target(data.url) }
    };
    if (typeof data.tag === "string" && data.tag) options.tag = data.tag;
    var title = typeof data.title === "string" && data.title ? data.title : "Timebok";
    event.waitUntil(self.registration.showNotification(title, options));
  });

  // Trykk på varselet: er timeboken åpen, vis dagen der; ellers åpne den på den dagen
  self.addEventListener("notificationclick", function (event) {
    event.notification.close();
    var url = target(event.notification.data && event.notification.data.url);
    // compat-ok: Clients.matchAll (service worker), ikke String.prototype.matchAll; finnes der service workers finnes
    event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var client = list[i];
        var path = "";
        try { path = new URL(client.url).pathname; } catch (e) { path = ""; }
        if (ADMIN_PATH.test(path) && typeof client.focus === "function") {
          client.postMessage(wantsPush(url) ? { type: "open-push" } : { type: "open-day", date: dayIn(url) });
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }));
  });

  // base64url av en nøkkel fra PushSubscription.getKey (en ArrayBuffer)
  function b64u(buf) {
    var bytes = new Uint8Array(buf), s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return self.btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  // Gir serveren det nye abonnementet. Service workeren har ingen innlogging, så den viser at den eier det gamle med
  // dets adresse og auth-hemmelighet (som bare nettleseren og serveren kjenner). Svarer om serveren tok imot det.
  function tellServer(old, sub) {
    var auth = null;
    try { auth = old && typeof old.getKey === "function" ? old.getKey("auth") : null; } catch (e) { auth = null; }
    if (!sub || !old || typeof old.endpoint !== "string" || !auth) return Promise.resolve(false);
    return withTimeout(self.fetch("/api/push/renew", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ oldEndpoint: old.endpoint, oldAuth: b64u(auth), subscription: sub })
    }), 15000).then(function (res) { return !!(res && res.ok); }, function () { return false; });
  }
  // Gikk det ikke, sier et varsel fra Timebok det. Et trykk åpner timeboken i Oppsett med «Slå på varsler» klar
  // (admin.js leser ?varsler=1, eller meldingen «open-push» når timeboken allerede er åpen).
  function remind() {
    return self.registration.showNotification("Timebok", {
      body: "Varslene om nye bestillinger må slås på igjen på denne enheten. Trykk her, og så «Slå på varsler».",
      icon: ICON,
      lang: "nb",
      tag: "forny-varsler",
      data: { url: HOME + "?varsler=1" }
    });
  }
  // Svarer ikke serveren innen ms, regnes det som at det ikke gikk (da kommer påminnelsen)
  function withTimeout(promise, ms) {
    var timer;
    var late = new Promise(function (resolve, reject) { timer = setTimeout(function () { reject(new Error("timeout")); }, ms); });
    return Promise.race([promise, late]).then(function (v) { clearTimeout(timer); return v; }, function (err) { clearTimeout(timer); throw err; });
  }

  // Nettleseren har byttet ut abonnementet: bruk det nye den har laget, eller lag et med samme nøkkel, og gi det til
  // serveren. Ellers ville serveren sendt til den gamle adressen, fått 410 og slettet enheten uten at noen merket det.
  self.addEventListener("pushsubscriptionchange", function (event) {
    var old = event.oldSubscription;
    var key = old && old.options && old.options.applicationServerKey;
    var renewed = event.newSubscription ? Promise.resolve(event.newSubscription)
      : key ? self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
      : Promise.resolve(null);
    event.waitUntil(renewed.then(function (sub) { return tellServer(old, sub); }, function () { return false; })
      .then(function (ok) { if (!ok) return remind(); }));
  });
})();
