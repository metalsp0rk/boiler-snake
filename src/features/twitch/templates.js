/**
 * Go-live message templates (issue #178) — per-guild custom text for the
 * go-live announcement's CONTENT LINE (the embed is untouched).
 *
 * Layout: everything here is a pure function except `setGoLiveTemplate`,
 * the settings-write service (doctrine #6: returns {ok:false,error}, never
 * replies to Discord, never throws uncaught). Storage: the nullable
 * `guild_settings.twitch_golive_template` column (migration 061); NULL =
 * the built-in default template, which renders BYTE-IDENTICAL to the
 * pre-#178 hardcoded content line.
 *
 * Placeholder semantics (docs/twitch-notifications.md § /twitch template):
 *   • KNOWN placeholders ({streamer} {login} {title} {game} {url}
 *     {viewers} {uptime}) always render a substituted value — a missing
 *     stream field falls back to the documented stand-in and NEVER to a
 *     literal "undefined"/"null".
 *   • UNKNOWN placeholders stay LITERAL (`{nope}` renders as `{nope}`).
 *     Chosen over dropping: a typo stays visible to the admin who made it
 *     instead of silently deleting half a sentence, and inventing data for
 *     an unknown token would lie. Rendering never throws on any token shape.
 *   • Matching is case-insensitive ({TITLE} works); tokens with spaces or
 *     other punctuation are not placeholders and stay literal.
 *   • Values are inserted verbatim (function replacer — `$&`-style
 *     replacement patterns in stream data are inert). Pings are NOT a
 *     rendering concern: the sender pins allowedMentions (#272 posture),
 *     so a `{title}` (or template) containing @everyone / role tokens
 *     stays plain text.
 *
 * Role-mention composition (#177 posture): the resolved mention role
 * (per-subscription `notify_role_id` override, else the guild
 * `twitch_notify_role_id`) is prefixed BEFORE the rendered template as
 * `<@&id> ` — the template never replaces or reorders the ping.
 */

/** Discord's hard message-content cap — the final content line is clamped to it. */
const MAX_GOLIVE_TEMPLATE_LEN = 2000;

/** Renders byte-identical to the pre-#178 hardcoded content line. */
const DEFAULT_GOLIVE_TEMPLATE = "**{streamer}** is live!";

/** Ordered placeholder set for command help + docs (all lowercase tokens). */
const GOLIVE_PLACEHOLDER_TOKENS = [
  "{streamer}",
  "{login}",
  "{title}",
  "{game}",
  "{url}",
  "{viewers}",
  "{uptime}",
];

/** `{token}` — letters/digits/underscore inside braces, case-insensitive. */
const PLACEHOLDER_RE = /\{([a-z0-9_]+)\}/gi;

/** Fallbacks for missing stream fields (never "undefined"/"null"). */
const FALLBACK_TITLE = "Untitled stream";
const FALLBACK_GAME = "Unknown";
const FALLBACK_VIEWERS = "0";
const FALLBACK_UPTIME = "just went live";

/**
 * Human-readable stream uptime from Helix `started_at` (ISO string or ms).
 * Unparseable, absent, or < 1 minute old (the common go-live case) reads
 * "just went live" — at go-live detection a stream is minutes young.
 *
 * @param {string|number|null|undefined} startsAt
 * @param {number} [nowMs] injectable clock for tests
 * @returns {string}
 */
function formatStreamUptime(startsAt, nowMs = Date.now()) {
  const start =
    typeof startsAt === "number" ? startsAt : Date.parse(String(startsAt ?? ""));
  if (!Number.isFinite(start)) return FALLBACK_UPTIME;
  const elapsedMin = Math.floor((nowMs - start) / 60_000);
  if (!(elapsedMin >= 1)) return FALLBACK_UPTIME;
  const h = Math.floor(elapsedMin / 60);
  const m = elapsedMin % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

const cleanText = (v) => String(v ?? "").trim();

/**
 * Build the placeholder context for one (subscription, stream) pair.
 * Every value is a NON-EMPTY string — the renderer may insert it verbatim
 * without re-checking for missing data. Unknown/absent fields never crash:
 * the whole context degrades to fallbacks.
 *
 * @param {object|null} sub stored twitch_channels row
 * @param {object|null} stream Helix stream object (or EventSub minimal shape)
 * @param {number} [nowMs] injectable clock for tests
 */
function goLiveTemplateContext(sub, stream, nowMs = Date.now()) {
  // sub.login is schema NOT-NULL; Helix streams carry user_login/user_name.
  // "unknown" is the unreachable last-resort so {login}/{url} stay literal-free.
  const login =
    cleanText(sub?.login || stream?.user_login || stream?.user_name).toLowerCase() ||
    "unknown";
  // Same primary chain the pre-#178 content line used (display_name || login),
  // extended so a stripped row still never renders "undefined".
  const streamer =
    cleanText(sub?.display_name || sub?.login || stream?.user_name || stream?.user_login) ||
    "a streamer";
  return {
    streamer,
    login,
    title: cleanText(stream?.title) || FALLBACK_TITLE,
    game: cleanText(stream?.game_name) || FALLBACK_GAME,
    url: `https://twitch.tv/${login}`,
    viewers: Number.isFinite(stream?.viewer_count)
      ? String(stream.viewer_count)
      : FALLBACK_VIEWERS,
    uptime: formatStreamUptime(stream?.started_at, nowMs),
  };
}

/**
 * Replace every KNOWN placeholder with its context value; unknown tokens
 * (and anything not shaped like `{token}`) stay exactly as typed. Pure and
 * total: never throws, whatever `template`/`ctx` are.
 *
 * @param {string|null|undefined} template
 * @param {Record<string, string>|null} ctx from goLiveTemplateContext (or a test map)
 * @returns {string}
 */
function renderGoLiveTemplate(template, ctx) {
  return String(template ?? "").replace(PLACEHOLDER_RE, (match, key) => {
    const k = String(key).toLowerCase();
    // Own-property only: {constructor}/{__proto__} are unknown tokens, not
    // prototype lookups (never render inherited values).
    if (!ctx || !Object.prototype.hasOwnProperty.call(ctx, k)) return match;
    const value = ctx[k];
    return value === null || value === undefined ? "" : String(value);
  });
}

/**
 * Compose the final message CONTENT line: optional role-mention prefix
 * (the resolved ping role — the template never drops it) + the rendered
 * template (custom when non-blank, else the default). Clamped to Discord's
 * 2000-char content cap by truncating the rendered body with an ellipsis —
 * a long stream title must never make the whole go-live send fail.
 *
 * @param {{ template?: string|null, roleId?: string|null, ctx?: object }} opts
 * @returns {string}
 */
function buildGoLiveContent({ template, roleId, ctx } = {}) {
  const custom = cleanText(template);
  const rendered = renderGoLiveTemplate(
    custom || DEFAULT_GOLIVE_TEMPLATE,
    ctx,
  );
  const prefix = roleId ? `<@&${roleId}> ` : "";
  const budget = Math.max(0, MAX_GOLIVE_TEMPLATE_LEN - prefix.length);
  const body =
    rendered.length <= budget
      ? rendered
      : `${rendered.slice(0, Math.max(0, budget - 1))}…`;
  return prefix + body;
}

/**
 * Validate an admin-authored template WITHOUT touching storage.
 * Returns {ok:true, template} (trimmed; null = "restore the default") or
 * {ok:false, error} carrying the specific, actionable cause (doctrine #3).
 *
 * @param {string|null|undefined} raw
 * @returns {{ ok: true, template: string|null } | { ok: false, error: string }}
 */
function validateGoLiveTemplate(raw) {
  if (raw === null || raw === undefined) return { ok: true, template: null };
  const text = cleanText(raw);
  if (!text) return { ok: true, template: null }; // empty restores the default
  if (text.length > MAX_GOLIVE_TEMPLATE_LEN) {
    return {
      ok: false,
      error:
        `Template is ${text.length} characters — the maximum is ` +
        `${MAX_GOLIVE_TEMPLATE_LEN} (Discord's message cap). Shorten it and try again.`,
    };
  }
  return { ok: true, template: text };
}

/**
 * Settings-write service (doctrine #6): persist the guild template.
 * `clear:true` or blank text stores NULL (built-in default restored);
 * validation failure returns {ok:false, error} and writes NOTHING.
 *
 * @param {number} communityId
 * @param {{ template?: string|null, clear?: boolean }} opts
 * @returns {{ ok: true, template: string|null } | { ok: false, error: string }}
 */
function setGoLiveTemplate(communityId, { template, clear = false } = {}) {
  // Lazy require: keeps this module (the pure renderer the ticker requires)
  // require-light — the db facade only loads when a settings write happens.
  const { updateGuildSettings } = require("../../db");
  const wanted = clear ? null : template;
  const validation = validateGoLiveTemplate(wanted);
  if (!validation.ok) return validation;
  // The repo re-normalizes defensively (over-length is rejected there too,
  // keeping the prior value); NULL vs text is the tri-state contract.
  updateGuildSettings(communityId, { twitch_golive_template: validation.template });
  return { ok: true, template: validation.template };
}

module.exports = {
  MAX_GOLIVE_TEMPLATE_LEN,
  DEFAULT_GOLIVE_TEMPLATE,
  GOLIVE_PLACEHOLDER_TOKENS,
  FALLBACK_TITLE,
  FALLBACK_GAME,
  FALLBACK_VIEWERS,
  FALLBACK_UPTIME,
  formatStreamUptime,
  goLiveTemplateContext,
  renderGoLiveTemplate,
  buildGoLiveContent,
  validateGoLiveTemplate,
  setGoLiveTemplate,
};
