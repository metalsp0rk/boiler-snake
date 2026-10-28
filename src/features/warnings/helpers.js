/**
 * Warn list formatting and best-effort member DMs.
 */
const {
  getGuildSettings,
  MAX_EXPIRY_DAYS,
} = require("../../db");
const { formatWarnRef, tsRelative, tsFull } = require("../../core/theme");
const { snippet } = require("../../core/text"); // #470 (H1-7): shared copy
const { COLOR_ISSUE } = require("./constants");


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
 * Whether community settings allow member DMs for warnings.
 * @param {number} communityId internal communities.id (resolved at the Discord edge)
 * @returns {boolean}
 */
function warnDmEnabled(communityId) {
  const s = getGuildSettings(communityId);
  return Number(s.warn_dm_members ?? 1) !== 0;
}

/**
 * @param {number} communityId internal communities.id (resolved at the Discord edge)
 * @returns {number}
 */
function guildWarnExpiryDays(communityId) {
  const s = getGuildSettings(communityId);
  const n = Number(s.warn_expiry_days ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), MAX_EXPIRY_DAYS);
}

/**
 * #733 (epic #723) MINIMAL EXTRACTION — the standard warning-issued MEMBER DM
 * payload, extracted from the `/warn add` handler's inline embed so the
 * automod warn tool sends the SAME member-facing framing (extracted loudly:
 * the DM builder was NOT exported as a service anywhere — this is the pure
 * shape only; `/warn add` keeps its current inline build and its behavior is
 * unchanged, a follow-up can point it here).
 *
 * Copy law (docs/warnings.md "Member DMs"): title `Warning issued in
 * {guild}`, fields W-n / issuer / active count / REASON / when (+ expires).
 * Evidence and every staff-only artifact (note bodies, model rationales,
 * note refs) NEVER belong in this payload — the caller passes member-safe
 * values only, and this builder never reads anything else.
 *
 * @param {object} input
 * @param {object} input.warn                       the created warnings row (reason/created_at/expires_at/warning_number)
 * @param {string} [input.guildName]                display name ("this server" fallback)
 * @param {string} [input.issuedByLabel]            display label for the issuer (never a note ref)
 * @param {number|string} [input.activeCount]       active warnings count for the member
 * @returns {object} a plain send-able payload ({ embeds: [...] })
 */
function buildWarnDmPayload({
  warn,
  guildName = "this server",
  issuedByLabel = "staff",
  activeCount,
} = {}) {
  const ref = formatWarnRef(warn?.warning_number);
  const dmFields = [
    { name: "Warning", value: ref, inline: true },
    { name: "Issued by", value: String(issuedByLabel || "staff"), inline: true },
    { name: "Active warnings", value: String(activeCount ?? ""), inline: true },
    { name: "Reason", value: String(warn?.reason ?? "").slice(0, 1024) },
    { name: "When", value: tsFull(warn?.created_at), inline: true },
  ];
  if (warn?.expires_at != null) {
    dmFields.push({ name: "Expires", value: tsFull(warn.expires_at), inline: true });
  }
  // Evidence stays staff-only — not included in the member DM (by design).
  return {
    embeds: [
      {
        title: `Warning issued in ${guildName || "this server"}`,
        color: COLOR_ISSUE,
        fields: dmFields,
        footer: { text: "View your history anytime with /warn mine" },
      },
    ],
  };
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
  buildWarnDmPayload,
  tryDmUser,
};
