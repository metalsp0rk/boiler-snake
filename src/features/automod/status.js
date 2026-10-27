/**
 * /automod status — the read-only config surface (#725).
 *
 * Plain text reply (the /ticket settings + /note settings idiom), ephemeral,
 * with the declared **Label:** value copy convention (#471 H2-13). No
 * secrets: only ids, modes, caps, counters, and the breaker note.
 */

const { tsFull, tsRelative } = require("../../core/theme");
const { readSettings } = require("./settings");
const { AUTOMOD_ACTIONS } = require("./constants");

/**
 * Budget copy for one tri-state limit + today's counter:
 * `-1` blocked, `0` unlimited, N capped. Kept in one place so status, the
 * `/automodconfig budget` echo, and later card replies never drift.
 *
 * @param {{ dailyCaseLimit: number, casesUsed: number, casesRemaining: number|null }} s
 * @returns {string}
 */
function formatBudgetLine(s) {
  if (s.dailyCaseLimit <= -1) {
    return "**blocked** (`-1`) — every referral is refused until the budget is opened";
  }
  if (s.dailyCaseLimit === 0) {
    return `**unlimited** (0) · ${s.casesUsed} case(s) counted today`;
  }
  const remaining = s.casesRemaining ?? 0;
  return (
    `**${remaining}** of ${s.dailyCaseLimit} left today ` +
    `(${s.casesUsed} used, UTC days, \`0\` = unlimited, \`-1\` = blocked)`
  );
}

/** "3600 s (1 h)" — seconds stay authoritative, the human part is a hint. */
function formatTimeoutCap(seconds) {
  const n = Number(seconds) || 0;
  if (n % 3600 === 0 && n >= 3600) return `${n} s (${n / 3600} h)`;
  if (n % 60 === 0 && n >= 60) return `${n} s (${n / 60} min)`;
  return `${n} s`;
}

/**
 * Build the /automod status reply payload.
 *
 * @param {number} communityId
 * @param {number} [nowMs] injectable UTC clock (budget view)
 * @returns {{ ok: true, payload: object } | { ok: false, error: string }}
 */
function buildStatusPayload(communityId, nowMs) {
  const read = readSettings(communityId, nowMs);
  if (!read.ok) return read;
  const s = read.settings;

  const channel = s.channelId
    ? `<#${s.channelId}>`
    : "_not set_ — every case needs it (`/automodconfig channel set`)";
  const rules = s.rules
    ? `set (**${s.rulesChars}** chars — \`/automodconfig rules set\` to replace)`
    : "_not set_ — every case needs it (`/automodconfig rules set`)";
  const modes = AUTOMOD_ACTIONS.map((a) => `\`${a}\`: **${s.modes[a]}**`).join(" · ");
  const safety = s.paused
    ? `**paused** since ${tsFull(s.pausedAt)} (${tsRelative(s.pausedAt)})${
        s.pauseReason ? ` — reason: \`${s.pauseReason}\`` : ""
      } — re-arm with \`/automodconfig safety resume\` (confirm)`
    : "active (breaker not tripped)";

  const content =
    `**Automod status**\n` +
    `**Enabled:** ${s.enabled ? "**yes**" : "**off**"} — toggle with \`/automodconfig enable\`\n` +
    `**Channel:** ${channel}\n` +
    `**Rules:** ${rules}\n` +
    `**Modes:** ${modes}\n` +
    `**Staff notes:** always on (no mode — locked decision)\n` +
    `**Timeout cap:** ${formatTimeoutCap(s.timeoutCap)}\n` +
    `**Daily budget:** ${formatBudgetLine(s)}\n` +
    `**Safety:** ${safety}`;

  return { ok: true, payload: { content, sensitive: true } };
}

module.exports = { buildStatusPayload, formatBudgetLine, formatTimeoutCap };
