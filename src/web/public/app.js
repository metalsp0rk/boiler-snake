/**
 * Shell front-end behavior (roadmap/web-admin.md §8.1-2: a SMALL nonce'd
 * vanilla module — no Alpine/React/build step).
 *
 * Served from /static/app.js with the per-response CSP nonce attached by
 * views/layout.js. NO inline scripts, NO inline handlers: everything is
 * wired through addEventListener in this external file (§8.7).
 *
 * Responsibilities (kept deliberately tiny):
 *  1. Guild switcher — navigate on <select data-guild-switcher> change.
 *     Every page works without this file (links + plain forms); the shell
 *     only enhances, never depends (§8.2 SSR-first).
 *
 * #459: the htmx CSRF wiring this file used to open with was wiring for a
 * library NO page ever activated (zero hx-* attributes existed) — it and
 * the vendored library are gone. Mutations are plain <form method="post">
 * with hidden `_csrf` fields; middleware/csrf.js still accepts the
 * X-CSRF-Token header as a JS-request channel should scripted POSTs ever
 * ship, fed by <body data-csrf-token>.
 */
(function () {
  "use strict";

  function csrfToken() {
    var body = document.body;
    return body ? body.getAttribute("data-csrf-token") || "" : "";
  }

  // 0. SHELL NAV COLLAPSE (#642) — the phone Menu button + width contract.
  //    The SERVER never renders body.nav-collapsed; applyWidth() adds it
  //    under 720px on load and on every matchMedia change (so expanding the
  //    list, widening past 720, then narrowing again re-collapses). The
  //    click handler toggles the class itself and never calls applyWidth.
  //    Escape, while focus sits inside an EXPANDED phone nav, collapses the
  //    list and returns focus to the Menu button. No focus trap anywhere.
  var NAV_PHONE_QUERY = "(max-width: 719px)";
  var navMq = window.matchMedia ? window.matchMedia(NAV_PHONE_QUERY) : null;

  function navToggleButton() {
    return document.querySelector("[data-nav-toggle]");
  }

  function setNavExpanded(btn, expanded) {
    if (btn) btn.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function applyWidth() {
    if (!document.body) return;
    var phone = navMq ? navMq.matches : false;
    document.body.classList.toggle("nav-collapsed", phone);
    // Expanded (visible) off-phone; collapsed by default on a phone.
    setNavExpanded(navToggleButton(), !phone);
  }

  if (navMq) {
    if (navMq.addEventListener) navMq.addEventListener("change", applyWidth);
    else if (navMq.addListener) navMq.addListener(applyWidth);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyWidth);
  } else {
    applyWidth();
  }

  document.addEventListener("click", function (evt) {
    var btn = evt.target && evt.target.closest ? evt.target.closest("[data-nav-toggle]") : null;
    if (!btn) return;
    var collapsed = document.body.classList.toggle("nav-collapsed");
    setNavExpanded(btn, !collapsed); // toggles ONLY — never applyWidth()
  });

  document.addEventListener("keydown", function (evt) {
    if (evt.key !== "Escape" || !document.body) return;
    if (!navMq || !navMq.matches) return; // phone widths only
    var nav = document.getElementById("shell-nav");
    if (!nav) return;
    if (document.body.classList.contains("nav-collapsed")) return; // already closed
    if (!nav.contains(document.activeElement)) return; // only when focus is IN the nav
    document.body.classList.add("nav-collapsed");
    var btn = navToggleButton();
    setNavExpanded(btn, false);
    if (btn && btn.focus) btn.focus();
  });

  // 0b. SHELL FLASH FOCUS (#642) — a banner/flash carrying data-flash gets
  //     programmatic focus (tabindex="-1" on the node from banner()) so
  //     screen readers announce it after a PRG round-trip. preventScroll:
  //     the page must not jump. No input is ever autofocused on a GET.
  document.addEventListener("DOMContentLoaded", function () {
    var flashEl = document.querySelector("[data-flash]");
    if (flashEl && flashEl.focus) flashEl.focus({ preventScroll: true });
  });

  // Guild switcher navigation (CSP-safe replacement for inline onchange).
  // #459 removed the dead htmx wiring above; csrfToken() stays as the
  // documented token source for any future scripted request (§ csrf.js).
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
  var OPT_SEQ = 0;

  /**
   * Is this element a WIRED-UP lookup input? (#642 — the input/keydown/
   * focusout listeners below all gate on this; before it existed every
   * keystroke threw ReferenceError before fetch.)
   *  - data-lookup="mixed" (archive search bars): active only with a
   *    data-lookup-users or data-lookup-roles source;
   *  - any other data-lookup kind (incl. #645's "channels"): active only
   *    with data-lookup-url;
   *  - anything else: the listeners return.
   */
  function lookupInputActive(el) {
    if (!el || !el.getAttribute) return false;
    var mode = el.getAttribute("data-lookup");
    if (!mode) return false;
    if (mode === "mixed") {
      return Boolean(el.getAttribute("data-lookup-users") || el.getAttribute("data-lookup-roles"));
    }
    return Boolean(el.getAttribute("data-lookup-url"));
  }

  /**
   * Which payload list + badge a single-kind lookup field reads (#645).
   * roles → roles, channels → channels, everything else → users. The
   * "mixed" search bars never route through this (two sources at once).
   */
  function lookupKind(mode) {
    if (mode === "roles") return "roles";
    if (mode === "channels") return "channels";
    return "users";
  }

  /**
   * What picking a suggestion WRITES into the field (#645). Everything
   * submits the numeric id as a string — including channels, so the
   * pattern="[0-9]{5,20}" channel fields stay valid. The one exception is
   * the pre-existing mixed-role search case, which filters rows by NAME.
   */
  function pickedValue(item, mode) {
    var it = item || {};
    if (it.kind === "roles" && mode === "mixed") return String(it.name || it.id);
    return String(it.id);
  }

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
    input.removeAttribute("aria-activedescendant");
  }

  function showLookup(input, items, q) {
    var pop = ensureList(input);
    while (pop.firstChild) pop.removeChild(pop.firstChild);
    input._lookupActive = -1;
    input.removeAttribute("aria-activedescendant");
    var shown = rankItems(items, q).slice(0, LOOKUP_MAX_SHOWN);
    shown.forEach(function (it) {
      var opt = document.createElement("div");
      opt.className = "lookup-opt";
      opt.setAttribute("role", "option");
      // Stable per-option id so aria-activedescendant can point at the
      // active row for screen readers (#642; textContent-only build).
      opt.id = "lookup-opt-" + (++OPT_SEQ);
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
        // everything else (form fields, people, channels) submits the pure
        // id — pickedValue owns the single exception (#645).
        input.value = pickedValue(it, input.getAttribute("data-lookup"));
        closeLookup(input);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      if (it.kind) {
        var tag = document.createElement("span");
        tag.className = "lookup-kind";
        tag.textContent = it.kind === "roles" ? "role" : it.kind === "channels" ? "channel" : "user";
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
    if (input._lookupActive >= 0) {
      opts[input._lookupActive].classList.remove("is-active");
      opts[input._lookupActive].removeAttribute("aria-selected");
    }
    input._lookupActive = (input._lookupActive + delta + opts.length) % opts.length;
    var el = opts[input._lookupActive];
    el.classList.add("is-active");
    el.setAttribute("aria-selected", "true"); // #642: the active option is announced
    input.setAttribute("aria-activedescendant", el.id);
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
    // = the old data-lookup-url fields (forms get one list): roles → roles,
    // channels (#645) → channels, anything else → users.
    var sources = mode === "mixed"
      ? [
          { url: input.getAttribute("data-lookup-users"), kind: "users" },
          { url: input.getAttribute("data-lookup-roles"), kind: "roles" },
        ].filter(function (src) { return src.url; })
      : [{
          url: input.getAttribute("data-lookup-url"),
          kind: lookupKind(mode),
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

  // 3b. FIND BOX (#642) — local-only section filter used by the settings and
  //     integrations pages: [data-setting-filter] input lowercases the query
  //     and toggles `hidden` on every [data-setting-section] whose text does
  //     not contain it. Empty query shows all. NO network, no re-render.
  document.addEventListener("input", function (evt) {
    var box = evt.target;
    if (!box || !box.matches || !box.matches("[data-setting-filter]")) return;
    var q = String(box.value || "").toLowerCase();
    document.querySelectorAll("[data-setting-section]").forEach(function (sec) {
      sec.hidden = q !== "" && String(sec.textContent || "").toLowerCase().indexOf(q) === -1;
    });
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

  // Keyboard path (#642): focusing a chip opens its card with NO delay
  // (the 300 ms intent delay stays for hover only) and leaving focus hides
  // it; Escape hides it too. The chip stays a plain link — nothing is
  // preventDefault-ed, no focus trap, the first tap is never stolen.
  document.addEventListener("focusin", function (evt) {
    var el = evt.target && evt.target.closest ? evt.target.closest("[data-user-card]") : null;
    if (!el) return;
    if (cardShowTimer) { clearTimeout(cardShowTimer); cardShowTimer = null; }
    cardSeq++; // invalidate in-flight fetches for other chips
    var c = ensureCard();
    c._openFor = el;
    openCard(el);
  });

  document.addEventListener("focusout", function (evt) {
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

  // 5. DASHBOARD CHARTS (Phase 4, operator decision 2026-09-25) — ONE-SHOT
  //    progressive enhancement. The SSR dashboard already shows every number
  //    (tables/dl/lists); this fills the [data-chart-src] boxes on the
  //    guild dashboard with Chart.js visuals fetched from the staff-tier
  //    JSON API (no-store, ≥30 s cached server-side per §8.6). With JS off,
  //    a fetch failure, or a missing vendor artifact, the page loses ONLY
  //    the picture — a small honest "unavailable" note replaces it, never a
  //    broken layout and never fabricated points. Chart.js is the vendored
  //    UMD (globalThis.Chart, everything auto-registered, loaded before
  //    this file via defer order in views/layout.js). XSS-safe by
  //    construction: textContent/DOM APIs only — zero HTML-string sinks.
  var ChartLib = globalThis.Chart || null;

  function chartFail(box, detail) {
    console.warn("[charts] " + detail);
    var note = document.createElement("p");
    note.className = "chart-unavailable";
    note.textContent = "chart unavailable — the tables on this page carry the same data";
    var figure = box.parentNode;
    (figure || box).appendChild(note);
  }

  function fetchJson(url) {
    return fetch(url, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  // Chart hygiene: never double-instantiate on a canvas that already
  // carries a live chart — destroy first, then create.
  function mountChart(canvas, config) {
    if (ChartLib.getChart(canvas)) ChartLib.getChart(canvas).destroy();
    return new ChartLib(canvas, config);
  }

  // #711: line = teal (--chart-line), bars = steel (--chart-bar).
  // getPropertyValue returns the specified value, so var(--bs-action)
  // is resolved on a probe element. Literals match the forge tokens
  // when the custom property is missing.
  function readCssColor(name, fallback) {
    var specified = "";
    try {
      specified = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch (err) {
      return fallback;
    }
    if (!specified) return fallback;
    if (/^(#|rgb|hsl)/i.test(specified)) return specified;
    try {
      var probe = document.createElement("span");
      probe.style.position = "absolute";
      probe.style.color = specified;
      document.documentElement.appendChild(probe);
      var resolved = getComputedStyle(probe).color;
      probe.remove();
      if (resolved && resolved !== "rgba(0, 0, 0, 0)") return resolved;
    } catch (err2) {
      /* fall through */
    }
    return fallback;
  }

  function colorWithAlpha(color, alpha) {
    var hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || ""));
    var h = hex ? hex[1] : "";
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length === 6) {
      var n = parseInt(h, 16);
      return "rgba(" + ((n >> 16) & 255) + ", " + ((n >> 8) & 255) + ", " + (n & 255) + ", " + alpha + ")";
    }
    var rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(String(color || ""));
    if (rgb) return "rgba(" + rgb[1] + ", " + rgb[2] + ", " + rgb[3] + ", " + alpha + ")";
    return color;
  }

  var LINE_COLOR = readCssColor("--chart-line", "#29a8bd");
  var BAR_COLOR = readCssColor("--chart-bar", "#86a9c6");
  var LINE_FILL = colorWithAlpha(LINE_COLOR, 0.15);
  var BAR_FILL = colorWithAlpha(BAR_COLOR, 0.45);
  var BAR_EDGE = BAR_COLOR;

  function lineConfig(data) {
    return {
      type: "line",
      data: {
        labels: data.points.map(function (p) { return p.day.slice(5); }), // MM-DD
        datasets: [{
          label: "Messages",
          data: data.points.map(function (p) { return p.messages; }),
          borderColor: LINE_COLOR,
          backgroundColor: LINE_FILL,
          fill: true,
          pointRadius: 0, // 30-day window: clean line, tooltips stay usable
          tension: 0.1, // honest near-straight daily counts
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false, // container CSS owns the height
        resizeDelay: 150, // mobile: debounce URL-bar/rotation resize storms
        animation: false, // admin panel: instant, predictable repaint
        interaction: { mode: "index", intersect: false }, // touch-friendly
        plugins: { legend: { display: false } }, // single dataset
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    };
  }

  function barConfig(data) {
    return {
      type: "bar",
      data: {
        labels: data.leaders.map(function (l) { return l.name || String(l.userId); }),
        datasets: [{
          label: "XP",
          data: data.leaders.map(function (l) { return l.xp; }),
          backgroundColor: BAR_FILL,
          borderColor: BAR_EDGE,
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: "y", // member labels read left-to-right at any width
        responsive: true,
        maintainAspectRatio: false,
        resizeDelay: 150, // mobile: debounce URL-bar/rotation resize storms
        animation: false,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true } },
      },
    };
  }

  function renderChartBox(box) {
    var kind = box.getAttribute("data-chart");
    var src = box.getAttribute("data-chart-src");
    var canvas = box.querySelector("canvas");
    if (!src || !canvas) return;
    if (!ChartLib) {
      chartFail(box, "Chart.js vendor artifact missing");
      return;
    }
    if (kind !== "line" && kind !== "bar") return; // unknown kind: leave inert
    fetchJson(src)
      .then(function (data) {
        if (kind === "line") {
          if (!data || !Array.isArray(data.points) || !data.points.length) {
            throw new Error("bad activity payload");
          }
          mountChart(canvas, lineConfig(data));
        } else {
          if (!data || !Array.isArray(data.leaders)) throw new Error("bad leaders payload");
          if (!data.leaders.length) {
            // Empty real data is a real state: say so, render nothing fake.
            var note = document.createElement("p");
            note.className = "chart-unavailable";
            note.textContent = "no XP rows yet";
            (box.parentNode || box).appendChild(note);
            return;
          }
          mountChart(canvas, barConfig(data));
        }
      })
      .catch(function (err) {
        chartFail(box, "chart render failed: " + (err && err.message ? err.message : err));
      });
  }

  document.querySelectorAll("[data-chart-src]").forEach(renderChartBox);
})();
