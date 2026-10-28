/**
 * Pure half of the data-lookup combobox (public/app.js contract, #710 port).
 * The DOM installer lives in lookup-install.js and is bundled by Vite.
 * Fuzzy ranking beyond this light client pass is #715, not this module.
 */

/**
 * @param {Element|{getAttribute:(name:string)=>string|null}|null} el
 * @returns {boolean}
 */
export function lookupInputActive(el) {
  if (!el || typeof el.getAttribute !== "function") return false;
  const mode = el.getAttribute("data-lookup");
  if (!mode) return false;
  if (mode === "mixed") {
    return Boolean(
      el.getAttribute("data-lookup-users") || el.getAttribute("data-lookup-roles")
    );
  }
  return Boolean(el.getAttribute("data-lookup-url"));
}

/**
 * @param {string|null} mode
 * @returns {"users"|"roles"|"channels"}
 */
export function lookupKind(mode) {
  if (mode === "roles") return "roles";
  if (mode === "channels") return "channels";
  return "users";
}

/**
 * @param {{id?:string,name?:string,kind?:string}} item
 * @param {string|null} mode
 * @returns {string}
 */
export function pickedValue(item, mode) {
  const it = item || {};
  if (it.kind === "roles" && mode === "mixed") return String(it.name || it.id);
  return String(it.id);
}

/**
 * Exact > prefix > substring > subsequence. Original order breaks ties.
 * @param {Array<{name?:string}>} items
 * @param {string} q
 */
export function rankItems(items, q) {
  const lq = String(q || "").toLowerCase();
  function score(it) {
    const n = String(it.name || "").toLowerCase();
    if (n === lq) return 0;
    if (n.indexOf(lq) === 0) return 1;
    if (n.indexOf(lq) !== -1) return 2;
    let i = 0;
    for (let c = 0; c < n.length && i < lq.length; c += 1) {
      if (n[c] === lq[i]) i += 1;
    }
    return i === lq.length ? 3 : 4;
  }
  return items
    .map((it, idx) => ({ it, idx, s: score(it) }))
    .filter((row) => row.s < 4)
    .sort((a, b) => a.s - b.s || a.idx - b.idx)
    .map((row) => row.it);
}
