/**
 * Shell front-end behavior (roadmap/web-admin.md §8.1-2: vendored htmx +
 * a SMALL nonce'd vanilla module — no Alpine/React/build step).
 *
 * Served from /static/app.js with the per-response CSP nonce attached by
 * views/layout.js. NO inline scripts, NO inline handlers: everything is
 * wired through addEventListener in this external file (§8.7).
 *
 * Responsibilities (kept deliberately tiny):
 *  1. htmx CSRF wiring — read `data-csrf-token` off <body> (rendered by
 *     views/layout.js from req.csrfToken) and attach it as the
 *     `X-CSRF-Token` request header to EVERY htmx request via the
 *     `htmx:configRequest` event — the hx-headers equivalent, but with the
 *     per-session token injected at request time instead of baked into an
 *     hx-headers JSON attribute. middleware/csrf.js accepts exactly this
 *     header (and `_csrf` form fields for JS-free posts).
 *  2. Guild switcher — navigate on <select data-guild-switcher> change.
 *     Every page works without this file (links + plain forms); the shell
 *     only enhances, never depends (§8.2 SSR-first).
 */
(function () {
  "use strict";

  function csrfToken() {
    var body = document.body;
    return body ? body.getAttribute("data-csrf-token") || "" : "";
  }

  // Our CSP never grants 'unsafe-eval', so htmx's JS-expression attributes
  // (hx-on:, javascript: URLs) cannot run anyway — turn them off at the
  // library too, so the failure is a clean htmx error instead of a CSP
  // violation report (§8.7 "no inline handlers" made two-fold).
  if (window.htmx && window.htmx.config) {
    window.htmx.config.allowEval = false;
  }

  // 1. htmx request headers (X-CSRF-Token) — hx-headers wiring from the
  //    body's data-csrf-token attribute. Verified against the vendored
  //    2.0.10 build: configRequest detail carries a mutable `headers`
  //    object and the request consumes whatever the handler leaves there.
  document.body.addEventListener("htmx:configRequest", function (evt) {
    var token = csrfToken();
    if (token && evt && evt.detail && evt.detail.headers) {
      evt.detail.headers["X-CSRF-Token"] = token;
    }
  });

  // 2. Guild switcher navigation (CSP-safe replacement for inline onchange).
  document.addEventListener("change", function (evt) {
    var el = evt.target;
    if (
      el &&
      el.matches &&
      el.matches("select[data-guild-switcher]") &&
      el.value
    ) {
      window.location.assign(el.value);
    }
  });
})();
