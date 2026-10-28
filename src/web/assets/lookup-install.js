/**
 * data-lookup combobox installer. Markup contract (unchanged from app.js):
 *   data-lookup="users|roles|channels" + data-lookup-url
 *   data-lookup="mixed" + data-lookup-users / data-lookup-roles
 * Selection writes the id, except a mixed-mode role which writes the name.
 * Suggestions are textContent only.
 */
import { lookupInputActive, lookupKind, pickedValue, rankItems } from "./lookup-rank.mjs";

const LOOKUP_DEBOUNCE_MS = 150;
const LOOKUP_MAX_SHOWN = 12;

function lookupItems(data, kind) {
  const arr = data && data[kind];
  return Array.isArray(arr) ? arr : [];
}

function kindLabel(kind) {
  if (kind === "roles") return "role";
  if (kind === "channels") return "channel";
  return "user";
}

/**
 * @param {Document} doc
 */
export function installLookupCombobox(doc) {
  let optSeq = 0;

  function arm(input) {
    if (!lookupInputActive(input)) return;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    if (!input.hasAttribute("aria-expanded")) {
      input.setAttribute("aria-expanded", "false");
    }
  }

  function ensureList(input) {
    if (input._lookupList) return input._lookupList;
    const pop = doc.createElement("div");
    pop.className = "lookup-pop";
    pop.setAttribute("role", "listbox");
    pop.hidden = true;
    const host = input.closest("label") || input.parentNode;
    host.classList.add("lookup-host");
    host.appendChild(pop);
    input._lookupList = pop;
    input._lookupActive = -1;
    arm(input);
    pop.addEventListener("mousedown", (evt) => {
      const opt = evt.target.closest ? evt.target.closest(".lookup-opt") : null;
      if (opt && opt._lookupPick) {
        evt.preventDefault();
        opt._lookupPick();
      }
    });
    return pop;
  }

  function closeLookup(input) {
    const pop = input._lookupList;
    if (pop) {
      pop.hidden = true;
      while (pop.firstChild) pop.removeChild(pop.firstChild);
    }
    input._lookupActive = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function showLookup(input, items, q) {
    const pop = ensureList(input);
    while (pop.firstChild) pop.removeChild(pop.firstChild);
    input._lookupActive = -1;
    input.removeAttribute("aria-activedescendant");
    const shown = rankItems(items, q).slice(0, LOOKUP_MAX_SHOWN);
    shown.forEach((it) => {
      const opt = doc.createElement("div");
      opt.className = "lookup-opt";
      opt.setAttribute("role", "option");
      opt.id = `lookup-opt-${++optSeq}`;
      const nm = doc.createElement("span");
      nm.className = "lookup-name";
      nm.textContent = it.name || "(unknown name)";
      const id = doc.createElement("span");
      id.className = "lookup-id bs-id";
      id.textContent = String(it.id);
      opt.appendChild(nm);
      opt.appendChild(id);
      opt._lookupPick = () => {
        input.value = pickedValue(it, input.getAttribute("data-lookup"));
        closeLookup(input);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      if (it.kind) {
        const tag = doc.createElement("span");
        tag.className = "lookup-kind";
        tag.textContent = kindLabel(it.kind);
        opt.appendChild(tag);
      }
      pop.appendChild(opt);
    });
    if (!shown.length) {
      closeLookup(input);
      return;
    }
    pop.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function moveLookup(input, delta) {
    const pop = input._lookupList;
    if (!pop || pop.hidden) return;
    const opts = pop.querySelectorAll(".lookup-opt");
    if (!opts.length) return;
    if (input._lookupActive >= 0) {
      opts[input._lookupActive].classList.remove("is-active");
      opts[input._lookupActive].removeAttribute("aria-selected");
    }
    input._lookupActive = (input._lookupActive + delta + opts.length) % opts.length;
    const el = opts[input._lookupActive];
    el.classList.add("is-active");
    el.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", el.id);
    el.scrollIntoView({ block: "nearest" });
  }

  function pickLookup(input) {
    const pop = input._lookupList;
    if (!pop || pop.hidden || input._lookupActive < 0) return false;
    const opt = pop.querySelectorAll(".lookup-opt")[input._lookupActive];
    if (opt && opt._lookupPick) {
      opt._lookupPick();
      return true;
    }
    return false;
  }

  function fetchLookup(url, q, kind) {
    const join = url.indexOf("?") === -1 ? "?" : "&";
    return fetch(`${url}${join}q=${encodeURIComponent(q)}`, { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) =>
        lookupItems(data, kind).map((it) => ({ id: it.id, name: it.name, kind }))
      );
  }

  doc.querySelectorAll("[data-lookup]").forEach(arm);

  doc.addEventListener("input", (evt) => {
    const input = evt.target;
    if (!lookupInputActive(input)) return;
    const mode = input.getAttribute("data-lookup");
    const q = String(input.value || "").trim();
    if (input._lookupSeq === undefined) input._lookupSeq = 0;
    const seq = ++input._lookupSeq;
    if (input._lookupTimer) clearTimeout(input._lookupTimer);
    if (!q) {
      closeLookup(input);
      return;
    }
    const sources =
      mode === "mixed"
        ? [
            { url: input.getAttribute("data-lookup-users"), kind: "users" },
            { url: input.getAttribute("data-lookup-roles"), kind: "roles" },
          ].filter((src) => src.url)
        : [{ url: input.getAttribute("data-lookup-url"), kind: lookupKind(mode) }];
    if (!sources.length) return;
    input._lookupTimer = setTimeout(() => {
      Promise.all(
        sources.map((src) => fetchLookup(src.url, q, src.kind).catch(() => []))
      )
        .then((parts) => {
          if (input._lookupSeq !== seq) return;
          showLookup(input, [].concat(...parts), q);
        })
        .catch(() => closeLookup(input));
    }, LOOKUP_DEBOUNCE_MS);
  });

  doc.addEventListener("keydown", (evt) => {
    const input = evt.target;
    if (!lookupInputActive(input)) return;
    if (evt.key === "ArrowDown") {
      evt.preventDefault();
      moveLookup(input, 1);
    } else if (evt.key === "ArrowUp") {
      evt.preventDefault();
      moveLookup(input, -1);
    } else if (evt.key === "Escape") {
      closeLookup(input);
    } else if (evt.key === "Enter") {
      if (pickLookup(input)) evt.preventDefault();
    } else if (evt.key === "Tab") {
      closeLookup(input);
    }
  });

  doc.addEventListener("focusout", (evt) => {
    const input = evt.target;
    if (!lookupInputActive(input)) return;
    setTimeout(() => closeLookup(input), 150);
  });
}
