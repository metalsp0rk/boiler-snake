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

  // 3. Identifier type-ahead (§8.15 task 15.10) — user/role text fields
  //    carry data-lookup-url (a /g/.../lookups/{users,roles} endpoint);
  //    we suggest NAMES so operators never hunt for snowflakes. Selection
  //    writes the pure ID into the field (forms validate ids server-side);
  //    typed names still work server-side too (tolerant parsers) — this is
  //    an enhancement only, every page works with JS off (§8.2 SSR-first).
  //    XSS-safe by construction: every suggestion becomes textContent,
  //    never markup; ids are held on the node, not in attributes.
  var LOOKUP_DEBOUNCE_MS = 150;
  var LOOKUP_MAX_SHOWN = 12;

  function lookupItems(data, kind) {
    var arr = data && data[kind];
    return Array.isArray(arr) ? arr : [];
  }

  // Light client-side re-rank: exact > prefix > substring > subsequence.
  function rankItems(items, q) {
    var lq = q.toLowerCase();
    function score(it) {
      var n = String(it.name || "").toLowerCase();
      if (n === lq) return 0;
      if (n.indexOf(lq) === 0) return 1;
      if (n.indexOf(lq) !== -1) return 2;
      var i = 0; // subsequence ("kd" → "King Dead")
      for (var c = 0; c < n.length && i < lq.length; c++) {
        if (n[c] === lq[i]) i++;
      }
      return i === lq.length ? 3 : 4;
    }
    return items
      .map(function (it, idx) { return { it: it, idx: idx, s: score(it) }; })
      .filter(function (x) { return x.s < 4; })
      .sort(function (a, b) { return a.s - b.s || a.idx - b.idx; })
      .map(function (x) { return x.it; });
  }

  function ensureList(input) {
    if (input._lookupList) return input._lookupList;
    var pop = document.createElement("div");
    pop.className = "lookup-pop";
    pop.setAttribute("role", "listbox");
    pop.hidden = true;
    var host = input.closest("label") || input.parentNode;
    host.classList.add("lookup-host");
    host.appendChild(pop);
    input._lookupList = pop;
    input._lookupActive = -1;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-autocomplete", "list");
    pop.addEventListener("mousedown", function (evt) {
      var opt = evt.target.closest ? evt.target.closest(".lookup-opt") : null;
      if (opt && opt._lookupPick) {
        evt.preventDefault(); // before input blur
        opt._lookupPick();
      }
    });
    return pop;
  }

  function closeLookup(input) {
    var pop = input._lookupList;
    if (pop) {
      pop.hidden = true;
      while (pop.firstChild) pop.removeChild(pop.firstChild);
    }
    input._lookupActive = -1;
    input.setAttribute("aria-expanded", "false");
  }

  function showLookup(input, items, q) {
    var pop = ensureList(input);
    while (pop.firstChild) pop.removeChild(pop.firstChild);
    input._lookupActive = -1;
    var shown = rankItems(items, q).slice(0, LOOKUP_MAX_SHOWN);
    shown.forEach(function (it) {
      var opt = document.createElement("div");
      opt.className = "lookup-opt";
      opt.setAttribute("role", "option");
      var nm = document.createElement("span");
      nm.className = "lookup-name";
      nm.textContent = it.name || "(unknown name)";
      var id = document.createElement("span");
      id.className = "lookup-id";
      id.textContent = String(it.id);
      opt.appendChild(nm);
      opt.appendChild(id);
      opt._lookupPick = function () {
        // A role picked in a SEARCH bar filters by name (rows carry text);
        // everything else (form fields, people) submits the pure id.
        input.value = it.kind === "roles" &&
            input.getAttribute("data-lookup") === "mixed"
          ? String(it.name || it.id)
          : String(it.id);
        closeLookup(input);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      if (it.kind) {
        var tag = document.createElement("span");
        tag.className = "lookup-kind";
        tag.textContent = it.kind === "roles" ? "role" : "user";
        opt.appendChild(tag);
      }
      pop.appendChild(opt);
    });
    if (!shown.length) return closeLookup(input);
    pop.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function moveLookup(input, delta) {
    var pop = input._lookupList;
    if (!pop || pop.hidden) return;
    var opts = pop.querySelectorAll(".lookup-opt");
    if (!opts.length) return;
    if (input._lookupActive >= 0) opts[input._lookupActive].classList.remove("is-active");
    input._lookupActive = (input._lookupActive + delta + opts.length) % opts.length;
    var el = opts[input._lookupActive];
    el.classList.add("is-active");
    el.scrollIntoView({ block: "nearest" });
  }

  function pickLookup(input) {
    var pop = input._lookupList;
    if (!pop || pop.hidden || input._lookupActive < 0) return false;
    var opt = pop.querySelectorAll(".lookup-opt")[input._lookupActive];
    if (opt && opt._lookupPick) { opt._lookupPick(); return true; }
    return false;
  }

  function fetchLookup(url, q, kind) {
    return fetch(url + (url.indexOf("?") === -1 ? "?" : "&") + "q=" + encodeURIComponent(q), {
      credentials: "same-origin",
    })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (data) {
        return lookupItems(data, kind).map(function (it) {
          return { id: it.id, name: it.name, kind: kind };
        });
      });
  }

  document.addEventListener("input", function (evt) {
    var input = evt.target;
    if (!lookupInputActive(input)) return;
    var mode = input.getAttribute("data-lookup");
    var q = String(input.value || "").trim();
    if (input._lookupSeq === undefined) input._lookupSeq = 0;
    var seq = ++input._lookupSeq;
    if (input._lookupTimer) clearTimeout(input._lookupTimer);
    if (!q) return closeLookup(input);
    // mixed = search bars (archive): people AND roles at once. Single-kind
    // = the old data-lookup-url fields (forms get one list).
    var sources = mode === "mixed"
      ? [
          { url: input.getAttribute("data-lookup-users"), kind: "users" },
          { url: input.getAttribute("data-lookup-roles"), kind: "roles" },
        ].filter(function (src) { return src.url; })
      : [{
          url: input.getAttribute("data-lookup-url"),
          kind: mode === "roles" ? "roles" : "users",
        }];
    if (!sources.length) return;
    input._lookupTimer = setTimeout(function () {
      Promise.all(sources.map(function (src) {
        return fetchLookup(src.url, q, src.kind).catch(function () { return []; });
      }))
        .then(function (parts) {
          if (input._lookupSeq !== seq) return; // stale response
          showLookup(input, [].concat.apply([], parts), q);
        })
        .catch(function () { closeLookup(input); }); // enhancement may fail silently
    }, LOOKUP_DEBOUNCE_MS);
  });

  document.addEventListener("keydown", function (evt) {
    var input = evt.target;
    if (!lookupInputActive(input)) return;
    if (evt.key === "ArrowDown") { evt.preventDefault(); moveLookup(input, 1); }
    else if (evt.key === "ArrowUp") { evt.preventDefault(); moveLookup(input, -1); }
    else if (evt.key === "Escape") { closeLookup(input); }
    else if (evt.key === "Enter") { if (pickLookup(input)) evt.preventDefault(); }
    else if (evt.key === "Tab") { closeLookup(input); }
  });

  document.addEventListener("focusout", function (evt) {
    var input = evt.target;
    if (!lookupInputActive(input)) return;
    setTimeout(function () { closeLookup(input); }, 150); // let mousedown win
  });

  // 4. Lazy PROFILE CARDS on user-chip hover (§8.15 task 15.11) — any
  //    [data-user-card] element (every userRef chip) pops a card after a
  //    short intent delay: avatar, name, id, role chips. Data is fetched
  //    per chip URL, cached for the page lifetime, and the SERVER side is
  //    cache-only + self-warming — a cold chip shows an id card immediately
  //    and the next hover after the queue catches up shows the full card.
  //    DOM built via textContent; the avatar URL is only ever accepted from
  //    the Discord CDN (mirrors the CSP img-src).
  var CARD_HOVER_MS = 300;
  var CARD_HIDE_MS = 150;
  var CDN_PREFIX = "https://cdn.discordapp.com/";
  var cardEl = null;
  var cardShowTimer = null;
  var cardHideTimer = null;
  var cardCache = Object.create(null);
  var cardSeq = 0;

  function ensureCard() {
    if (cardEl) return cardEl;
    cardEl = document.createElement("div");
    cardEl.className = "user-card";
    cardEl.setAttribute("role", "tooltip");
    cardEl.hidden = true;
    document.body.appendChild(cardEl);
    cardEl.addEventListener("mouseenter", function () {
      if (cardHideTimer) { clearTimeout(cardHideTimer); cardHideTimer = null; }
    });
    cardEl.addEventListener("mouseleave", hideCardSoon);
    return cardEl;
  }

  function hideCardSoon() {
    if (cardHideTimer) clearTimeout(cardHideTimer);
    cardHideTimer = setTimeout(function () {
      if (cardEl) cardEl.hidden = true;
    }, CARD_HIDE_MS);
  }

  function renderCard(rect, data) {
    var el = ensureCard();
    while (el.firstChild) el.removeChild(el.firstChild);
    var head = document.createElement("div");
    head.className = "user-card-head";
    if (data.avatar && String(data.avatar).indexOf(CDN_PREFIX) === 0) {
      var img = document.createElement("img");
      img.className = "user-card-avatar";
      img.src = String(data.avatar);
      img.alt = "";
      img.width = 48;
      img.height = 48;
      head.appendChild(img);
    }
    var who = document.createElement("div");
    var nm = document.createElement("div");
    nm.className = "user-card-name";
    nm.textContent = data.name || data.tag || "(name unknown yet)";
    var idc = document.createElement("div");
    idc.className = "user-card-id";
    idc.textContent = String(data.id);
    who.appendChild(nm);
    who.appendChild(idc);
    head.appendChild(who);
    el.appendChild(head);
    if (Array.isArray(data.roles) && data.roles.length) {
      var roles = document.createElement("div");
      roles.className = "user-card-roles";
      data.roles.slice(0, 12).forEach(function (r) {
        var chip = document.createElement("span");
        chip.className = "user-card-role";
        chip.textContent = String(r.name || "");
        if (r.color && /^#[0-9a-fA-F]{6}$/.test(String(r.color))) {
          chip.style.borderColor = String(r.color);
        }
        roles.appendChild(chip);
      });
      if (data.roles.length > 12) {
        var more = document.createElement("span");
        more.className = "user-card-role user-card-more";
        more.textContent = "+" + (data.roles.length - 12);
        roles.appendChild(more);
      }
      el.appendChild(roles);
    }
    if (!data.known) {
      var warm = document.createElement("div");
      warm.className = "user-card-warm";
      warm.textContent = "not cached yet — details fill in shortly";
      el.appendChild(warm);
    }
    var w = 260;
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left));
    var top = rect.bottom + 6;
    el.style.left = left + "px";
    el.style.top = top + "px";
    el.style.width = w + "px";
    el.hidden = false;
  }

  function openCard(chip) {
    var url = chip.getAttribute("data-user-card");
    if (!url) return;
    var rect = chip.getBoundingClientRect();
    var hit = cardCache[url];
    if (hit) return renderCard(rect, hit);
    var seq = ++cardSeq;
    fetch(url, { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.id) return;
        cardCache[url] = data;
        if (seq === cardSeq) renderCard(rect, data); // chip hover still current
      })
      .catch(function () { /* enhancement may fail silently */ });
  }

  document.addEventListener("mouseover", function (evt) {
    var el = evt.target && evt.target.closest ? evt.target.closest("[data-user-card]") : null;
    if (!el) return;
    if (cardEl && !cardEl.hidden && cardEl._openFor === el) return;
    if (cardShowTimer) clearTimeout(cardShowTimer);
    cardShowTimer = setTimeout(function () {
      cardSeq++; // invalidate in-flight fetches for other chips
      var c = ensureCard();
      c._openFor = el;
      openCard(el);
    }, CARD_HOVER_MS);
  });

  document.addEventListener("mouseout", function (evt) {
    var el = evt.target && evt.target.closest ? evt.target.closest("[data-user-card]") : null;
    if (!el) return;
    if (evt.relatedTarget && el.contains(evt.relatedTarget)) return;
    if (cardShowTimer) { clearTimeout(cardShowTimer); cardShowTimer = null; }
    hideCardSoon();
  });

  document.addEventListener("keydown", function (evt) {
    if (evt.key === "Escape" && cardEl) cardEl.hidden = true;
  });
  window.addEventListener("scroll", function () {
    if (cardEl) cardEl.hidden = true;
  }, { passive: true, capture: true });
})();
