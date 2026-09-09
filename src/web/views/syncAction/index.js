/**
 * View vocabulary + trigger form for the Phase-3 command-visibility SYNC
 * action (roadmap/web-admin.md §8.6 "Command visibility" row; subtask 31).
 * The trigger FORM itself renders inside the staff page's sync panel
 * (views/staff) — this module owns the PRG flash vocabulary (frozen slugs →
 * fixed messages, exactly the views/xpActions doctrine) and the env-name →
 * slug-token tables BOTH the route (redirect minting) and the banner
 * (rendering) consult, so a hostile ?error= value can never echo (§8.7).
 *
 * Secrets (§8.7): `env_not_configured:<tokens>` carries env-variable NAMES
 * mapped through the frozen ENV_SLUG_TOKENS table — never a value, never a
 * raw submitted string. Unknown tokens render nothing; the banner re-derives
 * display names from the frozen table, never from the query.
 */

const { html } = require("../escape");
const { banner } = require("../components");

/**
 * Env-variable NAMES the command-permission config reader can report in
 * `cfg.missing` (features/commandPermissions/config.js — a CLOSED set) →
 * URL-safe slug tokens. Anything unmappable collapses to `setup` — the slug
 * never reflects an unexpected string (§8.7 whitelist discipline).
 */
const ENV_SLUG_TOKENS = Object.freeze({
  "CLIENT_ID": "client_id",
  "CLIENT_SECRET": "client_secret",
  "PUBLIC_HTTP_PORT or TICKET_HTTP_PORT": "http_port",
  "PUBLIC_BASE_URL or TICKET_PUBLIC_BASE_URL (or OAUTH_REDIRECT_URI)": "base_url",
  "OAuth redirect URI": "redirect_uri",
});

/** slug token → operator-facing display NAME (names only — never values). */
const ENV_SLUG_NAMES = Object.freeze({
  client_id: "CLIENT_ID",
  client_secret: "CLIENT_SECRET",
  http_port: "PUBLIC_HTTP_PORT (or TICKET_HTTP_PORT)",
  base_url: "PUBLIC_BASE_URL (or TICKET_PUBLIC_BASE_URL / OAUTH_REDIRECT_URI)",
  redirect_uri: "the OAuth redirect URI",
  setup: "the command-permission OAuth setup",
});

const ENV_SLUG_PREFIX = "env_not_configured:";
const ENV_SLUG_TOKEN_RE = /^[a-z_]+$/;

/**
 * Mint the whitelisted `env_not_configured:<tokens>` slug from config
 * missing NAMES (server-computed). Frozen-table mapping only — the input
 * NAMES never pass through verbatim.
 * @param {unknown[]} missing
 * @returns {string}
 */
function envNotConfiguredSlug(missing) {
  const tokens = Array.isArray(missing)
    ? missing.map((name) => ENV_SLUG_TOKENS[String(name)] || "setup")
    : ["setup"];
  const unique = [...new Set(tokens)].sort();
  return `${ENV_SLUG_PREFIX}${unique.join("+")}`;
}

/**
 * Validate a COMPOSITE env slug against the frozen token table (every
 * "+"-joined segment must be a known token). Returns the token list or null.
 * @param {string} slug
 * @returns {string[]|null}
 */
function parseEnvSlug(slug) {
  if (typeof slug !== "string" || !slug.startsWith(ENV_SLUG_PREFIX)) return null;
  const tail = slug.slice(ENV_SLUG_PREFIX.length);
  if (!tail) return null;
  const tokens = tail.split("+");
  for (const token of tokens) {
    if (!ENV_SLUG_TOKEN_RE.test(token) || !ENV_SLUG_NAMES[token]) return null;
  }
  return tokens;
}

/**
 * PRG flash vocabulary (frozen slugs → fixed messages; the query value is
 * only ever a map lookup / the composite env slug validated above — unknown
 * slugs render nothing). Wording mirrors the slash syncpermissions reply
 * semantics: the web never claims what the sync did not do.
 */
const FLASH_DONE = Object.freeze({
  sync_completed:
    "Command visibility synced — each staff role was re-allowed on the staff-tier slash commands (audit recorded).",
  sync_partial:
    "Sync finished with failures — some commands could not be updated. The panel's last-sync error names them.",
});

const FLASH_ERROR = Object.freeze({
  not_authorized_run_slash:
    "No stored authorization for this guild yet — a server admin must run /staff syncpermissions ONCE in Discord to authorize it (the web trigger only re-runs the sync afterwards). Nothing was changed.",
  reauth_required:
    "The stored authorization expired or was revoked — run /staff syncpermissions in Discord to re-authorize, then trigger again. Nothing new was changed.",
  sync_failed:
    "The sync could not complete — Discord could not be reached or refused the request. Nothing was claimed; check the panel state and try again.",
  invalid_return: "Invalid return target — nothing was changed.",
});

/**
 * Whitelist the PRG query: returns { done, error } where each value is a
 * KNOWN slug (or the validated composite env slug) or null. Anything else
 * (junk, arrays, hostile strings) is DROPPED — nothing unknown renders.
 * @param {{done?: unknown, error?: unknown}|undefined|null} query
 */
function flashFromQuery(query) {
  const done =
    typeof query?.done === "string" && FLASH_DONE[query.done] ? query.done : null;
  let error = null;
  const rawError = query?.error;
  if (typeof rawError === "string") {
    if (FLASH_ERROR[rawError]) error = rawError;
    else if (parseEnvSlug(rawError)) error = rawError;
  }
  return { done, error };
}

/**
 * Flash banner for the PRG round-trip. Frozen message chosen by slug —
 * the composite env slug renders env NAMES re-derived from the frozen
 * table, never the raw query value.
 * @param {{done: string|null, error: string|null}|null} flash
 */
function syncFlashBanner(flash) {
  if (!flash) return html``;
  if (flash.error) {
    if (FLASH_ERROR[flash.error]) return banner("warn", FLASH_ERROR[flash.error]);
    const tokens = parseEnvSlug(flash.error);
    if (tokens) {
      const names = tokens.map((t) => ENV_SLUG_NAMES[t]);
      return banner(
        "warn",
        html`Sync refused — this host is missing the command-permission OAuth configuration: ${names.join(
          ", "
        )} (names only — values are never shown). Nothing was changed.`
      );
    }
    return html``;
  }
  if (flash.done && FLASH_DONE[flash.done]) {
    return banner("info", FLASH_DONE[flash.done]);
  }
  return html``;
}

/**
 * The ADMIN-tier sync-trigger form (rendered INSIDE the staff page's sync
 * panel only for admin viewers with a stored authorization — the route
 * carries requireTier("admin") as the actual gate; a hidden form is UX, the
 * middleware is security). Plain POST form: hidden _csrf (double-submit
 * half, middleware/csrf.js) + the whitelisted `return` target so the PRG
 * lands back on the page the button was pressed on.
 *
 * @param {object} input
 * @param {string} input.guildId server-derived (guildScope snowflake)
 * @param {string|null} input.csrfToken req.csrfToken (null → empty, POST 403s)
 * @param {"staff"|"commands"} [input.returnTarget] whitelisted PRG surface
 */
function renderSyncTriggerForm({ guildId, csrfToken, returnTarget = "staff" }) {
  const actionPath = `/g/${encodeURIComponent(guildId)}/commands/sync`;
  const safeReturn = returnTarget === "commands" ? "commands" : "staff";
  return html`
    <form class="staff-mutate-form sync-trigger-form" method="post" action="${actionPath}">
      <input type="hidden" name="_csrf" value="${csrfToken || ""}"/>
      <input type="hidden" name="return" value="${safeReturn}"/>
      <button type="submit" class="btn">Sync command visibility now</button>
    </form>
    <p class="subheading">
      Re-applies the current staff roles to the staff-tier slash commands —
      the same code path and the SAME stored slash OAuth authorization as
      <code>/staff syncpermissions</code> (your web login token is never
      sent to Discord). One <code>admin_audit</code> row
      (<code>staff.sync_permissions</code>, origin <code>web</code>) per
      trigger.
    </p>`;
}

module.exports = {
  FLASH_DONE,
  FLASH_ERROR,
  ENV_SLUG_TOKENS,
  ENV_SLUG_NAMES,
  ENV_SLUG_PREFIX,
  envNotConfiguredSlug,
  parseEnvSlug,
  flashFromQuery,
  syncFlashBanner,
  renderSyncTriggerForm,
};
