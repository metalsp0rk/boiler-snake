/**
 * Shared view micro-framework (#470 H1-8).
 *
 * These helpers existed as drifted private copies across the console views
 * (flashFromQuery ×6 / 3 bodies, flashBanner ×6 / 4 bodies, num ×3,
 * formatAge ×4, formatTs ×3). Identical or output-identical contracts are
 * single-sourced HERE; pages bind their own frozen vocabulary tables and
 * (syncAction) plug one extra hook for its composite env slug.
 *
 * The PRG invariant is unchanged (§8.7): only values PRESENT in the page's
 * frozen tables ever render — junk/hostile/foreign query values are dropped,
 * so no banner can ever echo submitted input.
 */
const { html } = require("./escape");
const { banner } = require("./components");

/**
 * Whitelist one page's PRG query against ITS OWN frozen tables: each value
 * is a known slug or null. `extraError(raw)` may vouch for an otherwise
 * unknown error slug (syncAction's composite env slug) by returning a
 * normalized string; anything falsy stays dropped.
 *
 * @param {{done?: unknown, error?: unknown}|undefined|null} query
 * @param {{doneTable: Readonly<Record<string,string>>,
 *          errorTable: Readonly<Record<string,string>>,
 *          extraError?: ((raw: string) => string|null)|null}} opts
 * @returns {{done: string|null, error: string|null}}
 */
function flashFromQuery(query, { doneTable, errorTable, extraError = null }) {
  const done =
    typeof query?.done === "string" && doneTable[query.done] ? query.done : null;
  const rawError = query?.error;
  let error =
    typeof rawError === "string" && errorTable[rawError] ? rawError : null;
  if (!error && typeof rawError === "string" && extraError) {
    const vouched = extraError(rawError);
    if (typeof vouched === "string" && vouched) error = vouched;
  }
  return { done, error };
}

/**
 * Flash banner for the PRG round-trip: the frozen message is chosen by slug,
 * never the raw query value. Unknown error slugs fall through to the done
 * check (the historical page semantics) UNLESS `extraBanner(raw)` is wired —
 * syncAction renders env NAMES for its composite slug and returns an empty
 * fragment for anything else, which its no-fall-through contract needs.
 *
 * @param {{done: string|null, error: string|null}|null} flash
 * @param {{doneTable: Readonly<Record<string,string>>,
 *          errorTable: Readonly<Record<string,string>>,
 *          extraBanner?: ((raw: string) => any)|null}} opts
 */
function flashBanner(flash, { doneTable, errorTable, extraBanner = null }) {
  if (!flash) return html``;
  if (flash.error && errorTable[flash.error]) {
    return banner("warn", errorTable[flash.error]);
  }
  if (flash.error && extraBanner) return extraBanner(flash.error);
  if (flash.done && doneTable[flash.done]) {
    return banner("info", doneTable[flash.done]);
  }
  return html``;
}

/** Integer-ish display that never invents a number for null. */
function num(value, suffix = "") {
  return value == null ? html`<em class="muted">unset</em>` : html`${value}${suffix}`;
}

/** Compact elapsed-age: "12s" / "3m 12s" / "2h 5m". */
function formatAge(ms) {
  const s = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${Math.floor(s % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Deterministic UTC stamp for stored epoch-ms values (no locale drift,
 * no fake "relative" times). null → honest em-dash.
 */
function formatTs(ms) {
  if (ms == null) return "\u2014";
  try {
    return new Date(Number(ms)).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  } catch {
    return "\u2014";
  }
}

module.exports = { flashFromQuery, flashBanner, num, formatAge, formatTs };
