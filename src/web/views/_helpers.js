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

// ---------------------------------------------------------------------------
// #608 promoted families (census first — see test/web-helpers-dedup.test.js).
// TRUE twins are single-sourced HERE. Same-name-different-contract copies
// stay page-side, documented: pill ×3 (state/integ/voice vocabularies),
// pageHref ×3 (per-page query vocabularies), users' append-only pager (no
// prev, optional total), tickets' <nav> pager (different markup).
// ---------------------------------------------------------------------------

/**
 * Channel reference (§8.15 cache-only): the ID is the source-of-truth value
 * (no Discord lookups required). An OPTIONAL cached name (bot member cache
 * via the getClient seam) is appended in parentheses when present —
 * cache-only, never fetched; absent ⇒ id alone (graceful fallback).
 *
 * The zero-state is a parameter because the pages differ DELIBERATELY:
 * settings/integrations say "not configured", voice shows an em-dash.
 * Pass `missingHtml` for a page-specific zero-state.
 */
function channelRef(channelId, resolveName, missingHtml = null) {
  if (!channelId) return missingHtml || html`<em class="muted">not configured</em>`;
  const name = typeof resolveName === "function" ? resolveName(channelId) : null;
  return html`<code class="channel-id">${channelId}</code>${name
    ? html` <span class="channel-name">(${name})</span>`
    : html``}`;
}

/**
 * Panel section promoted from the settings/integrations/voice copies
 * (byte-exact for all three pages): a page that does not pass an option
 * renders an EMPTY fragment there — exactly what its old private copy did —
 * so the unified engine cannot shift a single byte. `cls` appends the
 * page's own panel class to the shared "panel settings-panel" base.
 * `id` (#642) lands on the <section> ONLY when it passes the strict
 * slug whitelist — deep-link/section-nav anchors can never smuggle
 * markup or attributes.
 */
const SECTION_ID_OK = /^[a-z0-9-]{1,40}$/;

function section(title, bodyHtml, opts = {}) {
  const idAttr =
    typeof opts.id === "string" && SECTION_ID_OK.test(opts.id)
      ? html` id="${opts.id}"`
      : html``;
  return html`
    <section${idAttr} class="panel settings-panel${opts.cls ? ` ${opts.cls}` : ""}">
      <h2>${title}</h2>
      ${opts.hint ? html`<p class="setting-admin-hint">${opts.hint}</p>` : html``}
      ${opts.notice ? banner("warn", opts.notice) : html``}
      ${bodyHtml}
    </section>`;
}

/**
 * The moderation/system pager engine — markup byte-identical on both pages;
 * the FILTER VOCABULARY stays page-side inside hrefFor (each page's pageHref
 * composes the href from validated parts only, §8.7). users' append-only
 * pager is a different contract (no prev, optional total) and stays local.
 *
 * @param {{ hrefFor: (offset: number) => string, offset: number,
 *           pageSize: number, total: number, shown: number }} p
 */
function pagerFor({ hrefFor, offset, pageSize, total, shown }) {
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + shown;
  const prev =
    offset > 0
      ? html`<a class="pager-prev" href="${hrefFor(Math.max(0, offset - pageSize))}">← prev</a>`
      : html``;
  const more = offset + shown < total;
  const next = more
    ? html` <a class="pager-next" href="${hrefFor(offset + shown)}">next →</a>`
    : html``;
  return html`<p class="pager">${prev}showing ${from}–${to} of ${total}${next}</p>`;
}

module.exports = {
  flashFromQuery,
  flashBanner,
  num,
  formatAge,
  formatTs,
  channelRef,
  section,
  pagerFor,
};

