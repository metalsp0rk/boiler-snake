/**
 * Bridge mention disarming (roadmap/bridge.md §10.11, KD 13).
 *
 * Mentions are disarmed TWICE on every relayed body: the send-side
 * `allowedMentions: { parse: [] }` payload (NO_PING below — Discord parses by
 * default, Fluxer webhook execute suppresses, and defaults can change, so the
 * body rewrite is load-bearing too) and this body rewrite, applied to source
 * text AND to any snapshot/quote text before it enters a payload.
 *
 * Replacement table (spec §10.11):
 *   <@id> / <@!id>  → @display when the SOURCE mention list carries the id and
 *                      the lookup resolves a name; @user otherwise
 *   <@&id>          → @role (name when known)
 *   <#id>           → #name when known; #channel otherwise
 *   @everyone       → @<ZWSP>everyone
 *   @here           → @<ZWSP>here
 *
 * Hard rule (asserted by tests): no raw `<@`, `<#`, `@everyone`, `@here` may
 * survive neutralization — a copied channel snowflake can resolve on the
 * other deployment, and a live @everyone is a mass ping.
 *
 * This module is pure: no imports, no I/O, no platform SDK.
 */

/** Send-side suppression payload for Discord allowedMentions (spec §10.11). */
const NO_PING = Object.freeze({ parse: [] });

/** Zero-width space: breaks the @everyone/@here ping token, keeps the word. */
const ZWSP = "​";

/**
 * Resolve a display name for one mention id. Implementations read the source
 * message's own payload (raw mention objects) — never a platform call.
 * @typedef {(kind: "user"|"role"|"channel", id: string) => string|null|undefined} MentionLookup
 */

/**
 * @param {unknown} mentions source NormalizedMessage.mentions ({users,roles,channels})
 * @returns {{ users: Set<string>, roles: Set<string>, channels: Set<string> }}
 */
function mentionSets(mentions) {
  const toSet = (list) =>
    new Set(
      Array.isArray(list)
        ? list.map((id) => String(id)).filter((id) => /^\d+$/.test(id))
        : [],
    );
  return {
    users: toSet(mentions?.users),
    roles: toSet(mentions?.roles),
    channels: toSet(mentions?.channels),
  };
}

function cleanName(name) {
  if (name == null) return null;
  const trimmed = String(name).replace(/[@#]/g, "").replace(/\s+/g, " ").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Neutralize every pinging token in a text destined for the other platform.
 *
 * @param {unknown} text source message content (or snapshot/quote text)
 * @param {{users?:Array,roles?:Array,channels?:Array}|null|undefined} sourceMentions
 *   the source message's structured mentions (a token counts as "known" only
 *   when its id appears HERE — the spec's source-mention-list rule)
 * @param {MentionLookup} [lookup] id → display name resolver
 * @returns {string} safe text: no raw <@, <@&, <#, @everyone, @here
 */
function neutralizeContent(text, sourceMentions, lookup) {
  const sets = mentionSets(sourceMentions);
  const resolve = typeof lookup === "function" ? lookup : () => null;

  const userLabel = (id) => {
    if (!sets.users.has(id)) return "@user";
    const name = cleanName(resolve("user", id));
    return name ? `@${name}` : "@user";
  };
  const roleLabel = (id) => {
    const name = cleanName(resolve("role", id));
    return name ? `@${name}` : "@role";
  };
  const channelLabel = (id) => {
    const name = cleanName(resolve("channel", id));
    return name ? `#${name}` : "#channel";
  };

  let out = String(text ?? "");

  // User mentions: <@id> and the legacy <@!id> form.
  out = out.replace(/<@[!]?(\d{1,25})>/g, (_m, id) => userLabel(id));
  // Role mentions: <@&id>.
  out = out.replace(/<@&(\d{1,25})>/g, (_m, id) => roleLabel(id));
  // Channel mentions: <#id> — never a raw channel snowflake on the wire.
  out = out.replace(/<#(\d{1,25})>/g, (_m, id) => channelLabel(id));
  // Everyone / here: the zero-width space breaks the ping token.
  out = out.replace(/@everyone/g, `@${ZWSP}everyone`);
  out = out.replace(/@here/g, `@${ZWSP}here`);

  // Sweep: ANY residual markup shape (non-numeric ids, oversized numbers,
  // nested junk) that survived the typed passes. Users collapse to @user,
  // channels to #channel, roles to @role.
  out = out.replace(/<@(![&]?|!|&)?([\w-]{1,32})>/g, (match, _q, token) =>
    /^\d+$/.test(token) ? userLabel(token) : "@user",
  );
  out = out.replace(/<#[\w-]{1,32}>/g, (match) => {
    const id = /^<#(\d{1,25})>$/.exec(match)?.[1];
    return id ? channelLabel(id) : "#channel";
  });

  return out;
}

module.exports = {
  NO_PING,
  neutralizeContent,
};
