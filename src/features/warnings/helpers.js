/**
 * Warn list formatting and best-effort member DMs.
 */
const {
  getGuildSettings,
  MAX_EXPIRY_DAYS,
} = require("../../db");
const { formatWarnRef, tsRelative } = require("../../core/theme");
const { SNIPPET_LEN } = require("./constants");

/**
 * @param {string} content
 * @param {number} [max]
 * @returns {string}
 */
function snippet(content, max = SNIPPET_LEN) {
  const s = String(content || "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * @param {object} warn
 * @returns {string}
 */
function formatListLine(warn) {
  const ref = formatWarnRef(warn.warning_number);
  const voided = warn.voided_at != null ? " · ~~voided~~" : "";
  const exp =
    warn.voided_at == null && warn.expires_at != null
      ? ` · expires ${tsRelative(warn.expires_at)}`
      : "";
  return (
    `**${ref}** · by <@${warn.issuer_id}> · ${tsRelative(warn.created_at)}${voided}${exp}\n` +
    `> ${snippet(warn.reason)}`
  );
}

/**
 * Whether guild settings allow member DMs for warnings.
 * @param {string} guildId
 * @returns {boolean}
 */
function warnDmEnabled(guildId) {
  const s = getGuildSettings(guildId);
  return Number(s.warn_dm_members ?? 1) !== 0;
}

/**
 * @param {string} guildId
 * @returns {number}
 */
function guildWarnExpiryDays(guildId) {
  const s = getGuildSettings(guildId);
  const n = Number(s.warn_expiry_days ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), MAX_EXPIRY_DAYS);
}

/**
 * Best-effort DM to a user. Never throws; never rolls back DB.
 * @param {import("discord.js").User} user
 * @param {object} payload
 * @returns {Promise<boolean>} true if sent
 */
async function tryDmUser(user, payload) {
  if (!user || typeof user.send !== "function") return false;
  try {
    await user.send(payload);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  snippet,
  formatListLine,
  warnDmEnabled,
  guildWarnExpiryDays,
  tryDmUser,
};
