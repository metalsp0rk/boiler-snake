/**
 * Gork answer sanitizer (roadmap/gork.md §7.15 Fix 1).
 *
 * The model sees raw Discord markup in the conversation context and can
 * echo it back (`<@123>`, `<@&role>`, `<#channel>`), which renders as raw
 * garbage in a plain-text reply and can ping people unintentionally. This
 * module rewrites those tokens in the final answer to readable names:
 *
 * - `<@id>` / `<@!id>`  → `@Display Name` via the Fix 2 roster; unknown
 *   ids become `@someone` (never raw markup).
 * - `<@&id>`            → `@Role Name` via the guild role cache.
 * - `<#id>`             → `#channel-name` via the guild channel cache.
 * - Custom emoji (`<:n:id>`, `<a:n:id>`) and timestamps (`<t:...>`) are
 *   left alone: they render fine and never ping.
 * - Tokens inside inline code / fenced code blocks are left verbatim
 *   (code content is data, not markup).
 *
 * Ping control is layered separately (locked decision 11 keeps answers as
 * plain text): the reply path sends `allowedMentions: NO_PING_MENTIONS`
 * so nothing in an answer can notify anyone. Precedent:
 * `replaceMentionsInContent()` in `src/features/tickets/users.js` and
 * `NO_PING_MENTIONS` in `src/features/reactionRoles/service.js`.
 */

/** Reply payload that suppresses every mention/ping parse. */
const NO_PING_MENTIONS = { parse: [] };

/** Code regions kept verbatim: fenced blocks (``` or ~~~) and inline code. */
const CODE_REGION_RE =
  /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;

// Ids are intentionally loose (`\w-` chars, not just snowflake digits):
// any malformed mention markup still gets neutralized instead of leaking.
const USER_MENTION_RE = /<@!?([\w-]+)>/g;
const ROLE_MENTION_RE = /<@&([\w-]+)>/g;
const CHANNEL_MENTION_RE = /<#([\w-]+)>/g;

/**
 * Replace user/role/channel mention markup outside code regions.
 *
 * @param {unknown} text raw model answer
 * @param {object} [opts]
 * @param {{ entries?: Map<string, { display?: string|null, handle?: string|null }> }} [opts.roster]
 *   buildRoster() result (id → resolved entry)
 * @param {import("discord.js").Guild|null} [opts.guild] guild for role/channel names
 * @returns {string} sanitized answer text
 */
function sanitizeAnswer(text, { roster, guild } = {}) {
  const source = text == null ? "" : String(text);
  if (!source) return source;

  const replaceOutsideCode = (segment) => {
    let out = segment.replace(USER_MENTION_RE, (_full, id) => {
      const entry = roster?.entries?.get?.(String(id));
      const name = entry?.display || entry?.handle;
      return name ? `@${name}` : "@someone";
    });
    out = out.replace(ROLE_MENTION_RE, (_full, id) => {
      const role = guild?.roles?.cache?.get?.(id);
      return role?.name ? `@${role.name}` : "@some-role";
    });
    out = out.replace(CHANNEL_MENTION_RE, (_full, id) => {
      const channel = guild?.channels?.cache?.get?.(id);
      return channel?.name ? `#${channel.name}` : "#some-channel";
    });
    return out;
  };

  const parts = source.split(CODE_REGION_RE);
  // String.split with a capture group alternates: [text, code, text, code, ...]
  // Odd indexes are the captured code regions — keep them verbatim.
  return parts
    .map((part, i) => (i % 2 === 1 ? part : replaceOutsideCode(part)))
    .join("");
}

module.exports = {
  NO_PING_MENTIONS,
  sanitizeAnswer,
};
