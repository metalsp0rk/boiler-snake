/**
 * View for the Phase-3 XP grant surface (roadmap/web-admin.md §8.6 "XP" row —
 * grant xp is the ADMIN mutate of that row; subtask 28). The admin-only page
 * /g/:guildId/xp/grant mirrors the slash /grantxp command: one form, one
 * POST, everything re-validated server-side.
 *
 * COMPOSED ENTIRELY with the escaped-by-default `html` helper (../escape.js)
 * — same XSS contract as views/leaderboard and views/settings: raw() never
 * touches request/DB data, and the PRG flash renders ONLY fixed messages
 * chosen by WHITELISTED SLUG (the raw query value is never echoed, so a
 * hostile redirect target is inert — same doctrine as views/integrations).
 */

const { html } = require("../escape");
const { banner } = require("../components");

/**
 * PRG flash vocabulary (frozen slugs → fixed messages; the *query value* is
 * only ever a map lookup — unknown slugs render nothing). Messages mirror
 * the slash /grantxp replies and rejection reasons where one exists.
 */
const FLASH_DONE = Object.freeze({
  xp_granted: "XP granted — the full award pipeline (levels, role sync, audit) ran.",
});

const FLASH_ERROR = Object.freeze({
  invalid_user:
    "Invalid user ID — Discord user IDs are 5–20 digits. Nothing was changed.",
  invalid_amount:
    "Invalid XP amount — enter a whole number between 1 and 1,000,000,000. Nothing was changed.",
  reason_too_long:
    "Reason too long — the audit reason is at most 200 characters. Nothing was changed.",
  bot_target: "You can't grant XP to bots. Nothing was changed.",
});

/**
 * Whitelist the PRG query: returns { done, error } where each value is a
 * KNOWN slug or null. Anything else (junk, arrays, hostile strings) is
 * dropped — the flash map lookup is the only consumer.
 * @param {{done?: unknown, error?: unknown}|undefined|null} query
 */
function flashFromQuery(query) {
  const done =
    typeof query?.done === "string" && FLASH_DONE[query.done] ? query.done : null;
  const error =
    typeof query?.error === "string" && FLASH_ERROR[query.error]
      ? query.error
      : null;
  return { done, error };
}

/**
 * Flash banner for the PRG round-trip (frozen message chosen by slug —
 * never the raw query value).
 * @param {{done: string|null, error: string|null}|null} flash
 */
function flashBanner(flash) {
  if (!flash) return html``;
  if (flash.error && FLASH_ERROR[flash.error]) {
    return banner("warn", FLASH_ERROR[flash.error]);
  }
  if (flash.done && FLASH_DONE[flash.done]) {
    return banner("info", FLASH_DONE[flash.done]);
  }
  return html``;
}

/**
 * Admin-only grant form. Field names are the route's contract (user_id /
 * amount / reason); the hidden `_csrf` input is the CSRF double-submit half
 * (middleware/csrf.js reads it for /g/ mutations). Bounds mirror the slash
 * /grantxp option definitions (amount 1…MAX_XP_AWARD, reason ≤ 200) — the
 * BROWSER hint only: the route re-validates every field independently.
 *
 * @param {object} input
 * @param {string} input.guildId server-derived (guildScope snowflake)
 * @param {string|null} input.csrfToken req.csrfToken (null → empty, POST then 403s)
 * @param {{done: string|null, error: string|null}|null} [input.flash]
 * @param {number} input.maxAward MAX_XP_AWARD (rendered as a bound, never as data)
 */
function renderGrantForm({ guildId, csrfToken, flash, maxAward }) {
  const actionPath = `/g/${encodeURIComponent(guildId)}/xp/grant`;
  return html`
    ${flashBanner(flash)}
    <section class="panel xp-grant-panel">
      <h2>Grant XP</h2>
      <p class="hint">
        Runs the exact same award pipeline as slash
        <code>/grantxp</code>: XP total, activity log, level→role sync, and
        the <code>xp.grant</code> audit row — no shortcuts.
      </p>
      <form class="integ-write-form xp-grant-form" method="post" action="${actionPath}">
        <input type="hidden" name="_csrf" value="${csrfToken || ""}"/>
        <div class="integ-write-fields">
          <label>User ID<input name="user_id" type="text" inputmode="numeric" autocomplete="off" placeholder="Discord user id" maxlength="20"/></label>
          <label>Amount (XP)<input name="amount" type="number" min="1" max="${maxAward}" step="1"/></label>
          <label>Reason (optional)<input name="reason" type="text" maxlength="200" autocomplete="off" placeholder="shown in the audit trail"/></label>
        </div>
        <button type="submit" class="btn btn-write">Grant XP</button>
      </form>
      <p class="hint">
        Limits mirror the slash command: amount 1–${Number(maxAward).toLocaleString(
          "en-US"
        )} XP per grant; reason up to 200 characters. The bot's member cache is
        consulted for the bot check only — never a network fetch from this page.
      </p>
    </section>`;
}

module.exports = {
  FLASH_DONE,
  FLASH_ERROR,
  flashFromQuery,
  flashBanner,
  renderGrantForm,
};
