// Støtte for eldre nettlesere (Safari/iOS 10+, Chrome 60+, Firefox 55+, Samsung 8+).
// Lastes før alle andre skript. Gjør ingenting i nettlesere som allerede har disse funksjonene.
(function () {
  "use strict";

  // fetch mangler i Safari/iOS 10.0–10.2. Dekker det siden bruker: method, headers, body, ok, status, json().
  if (!window.fetch) {
    window.fetch = function (url, opts) {
      opts = opts || {};
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        var headers = opts.headers || {};
        xhr.open(opts.method || "GET", url);
        Object.keys(headers).forEach(function (k) { xhr.setRequestHeader(k, headers[k]); });
        if (opts.cache === "no-store") xhr.setRequestHeader("Cache-Control", "no-store");
        xhr.onload = function () {
          var text = xhr.responseText;
          resolve({
            ok: xhr.status >= 200 && xhr.status < 300,
            status: xhr.status,
            json: function () { return new Promise(function (ok) { ok(JSON.parse(text)); }); }
          });
        };
        xhr.onerror = function () { reject(new TypeError("Network request failed")); };
        xhr.send(opts.body);
      });
    };
  }

  // <dialog> mangler i Firefox < 98 og Safari < 15.4. Utseendet ligger i .dialog-shim i CSS-en.
  if (typeof HTMLDialogElement === "function") return;

  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var stack = [];

  function setup(d) {
    var backdrop = null;
    var returnTo = null;
    d.classList.add("dialog-shim");
    d.setAttribute("role", "dialog");
    d.setAttribute("aria-modal", "true");
    d.open = false;

    d.showModal = function () {
      if (d.open) return;
      returnTo = document.activeElement;
      backdrop = document.createElement("div");
      backdrop.className = "dialog-shim-backdrop";
      // Et klikk på bakgrunnen treffer selve dialogen, akkurat som med ::backdrop
      backdrop.addEventListener("click", function () { d.click(); });
      document.body.appendChild(backdrop);
      d.open = true;
      d.setAttribute("open", "");
      stack.push(d);
      var first = d.querySelector("[autofocus]") || d.querySelector(FOCUSABLE);
      if (first) first.focus();
    };

    d.close = function () {
      if (!d.open) return;
      d.open = false;
      d.removeAttribute("open");
      stack.splice(stack.indexOf(d), 1);
      if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      backdrop = null;
      if (returnTo && returnTo.focus) returnTo.focus();
    };
  }

  Array.prototype.forEach.call(document.querySelectorAll("dialog"), setup);

  // Esc lukker, og Tab blir værende inne i dialogen
  document.addEventListener("keydown", function (e) {
    var d = stack[stack.length - 1];
    if (!d) return;
    var key = e.key || ({ 27: "Escape", 9: "Tab" })[e.keyCode];
    if (key === "Escape" || key === "Esc") { e.preventDefault(); d.close(); return; }
    if (key !== "Tab") return;
    var items = Array.prototype.filter.call(d.querySelectorAll(FOCUSABLE), function (el) { return el.offsetParent !== null; });
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
})();
