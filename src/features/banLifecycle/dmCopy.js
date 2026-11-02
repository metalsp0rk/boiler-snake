/**
 * Ban-lifecycle DM copy (#772 §3 + §5) — pure builders returning plain
 * Discord message payloads. No db and no discord.js import: timestamps are
 * rendered as the raw `<t:UNIX:F>` / `<t:UNIX:R>` tags Discord localizes
 * client-side, which keeps this module dependency-free and grep-verifiable.
 *
 * Hard rules baked into the shapes below:
 *  - An expiring ban's DM shows BOTH the calendar stamp (`:F`) and the
 *    relative stamp (`:R`) — the issue requires each; the permanent variant
 *    says staff may lift it at their discretion and renders no stamp.
 *  - The copy NEVER names the moderator, automod case ids, staff notes, or
 *    warning history — so these builders take no such inputs at all.
 *  - Every payload carries allowedMentions { parse: [] } (repo DM idiom:
 *    a guild name containing "@everyone" can never notify anyone).
 *  - `**Label:** value` reply-copy convention (#471 H2-13): the expiring and
 *    permanent lines bold the label with the colon inside the bold.
 */

/** `<t:UNIX:F> (<t:UNIX:R>)` — locale-aware calendar time + "in 3 days". */
function expiryStamps(expiresAtMs) {
  const unix = Math.floor(expiresAtMs / 1000);
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

/** Guild name belt: never an empty bold run; never interpolated deeper. */
function guildMention(guildName) {
  return `**${String(guildName ?? "").trim() || "the server"}**`;
}

/**
 * Ban-time DM payload (#772 §3), sent BEFORE the ban executes while the
 * shared-guild DM path still exists; the ban runs regardless of delivery.
 *
 * #773 SEAM (locked): `components` is a message-components pass-through —
 * appeals will inject the Appeal button row through this parameter WITHOUT
 * touching the copy below. It is attached untouched (default undefined →
 * component-free payload today).
 *
 * @param {object} opts
 * @param {string} opts.guildName guild display name (interpolated bold)
 * @param {number|null} [opts.expiresAtMs] expiry ms; null/absent → permanent variant
 * @param {*} [opts.components] #773 pass-through, attached verbatim when provided
 * @returns {{ content: string, allowedMentions: { parse: string[] }, components?: * }}
 */
function buildBanDm({ guildName, expiresAtMs, components } = {}) {
  const guild = guildMention(guildName);
  const content =
    typeof expiresAtMs === "number" && Number.isFinite(expiresAtMs)
      ? "You have been banned from " +
        `${guild}. This ban **expires:** ${expiryStamps(expiresAtMs)}. ` +
        "You're welcome back after that — if you'd like to discuss the " +
        "situation, any staff member is happy to help."
      : `You have been banned from ${guild}. This ban **has no set expiry:** ` +
        "staff may lift it at their discretion. If you'd like to discuss the " +
        "situation, any staff member is happy to help.";

  const payload = { content, allowedMentions: { parse: [] } };
  if (components !== undefined) payload.components = components;
  return payload;
}

/**
 * Welcome-back DM payload (#772 §5), sent once per ban cycle on any unban
 * (auto-expiry or manual — the copy deliberately never says WHO unbanned).
 *
 * @param {object} opts
 * @param {string} opts.guildName guild display name (interpolated bold)
 * @returns {{ content: string, allowedMentions: { parse: string[] } }}
 */
function buildWelcomeDm({ guildName } = {}) {
  return {
    content:
      `You've been unbanned from ${guildMention(guildName)}. You're welcome ` +
      "back — we hope to see you around again. If you'd like to talk about " +
      "what happened, any staff member is happy to help.",
    allowedMentions: { parse: [] },
  };
}

module.exports = {
  buildBanDm,
  buildWelcomeDm,
  // exported for tests: the exact stamp rendering is part of the locked copy
  // surface (#772 §3 requires both :F and :R on expiring bans).
  expiryStamps,
};
