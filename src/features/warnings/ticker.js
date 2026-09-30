/**
 * Auto-void warnings past expires_at (opt-in per warning / guild default).
 * Minute cron via the shared scheduler.
 */

const { registerJob } = require("../../core/scheduler");
const {
  listExpiredActiveWarnings,
  voidWarning,
  countActiveWarnings,
  getGuildSettings,
} = require("../../db");
const { logWarnEvent } = require("../logs/auditLog");
const { recordSystemAudit } = require("../../core/auditTrail");
const { Color } = require("../../core/theme");
const { getDiscordOutbound } = require("../../platform/discord/outbound");
const { getCommunityById } = require("../../platform/community");

/** Every minute. */
const EXPIRY_CRON = "* * * * *";

const COLOR_VOID = Color.muted;

/**
 * Process due expirations.
 * @param {import("discord.js").Client} client
 * @param {{ now?: number, limit?: number }} [opts]
 * @returns {Promise<{ processed: number, voided: number, errors: number }>}
 */
async function runWarnExpiryTick(client, opts = {}) {
  const nowMs = opts.now ?? Date.now();
  const due = listExpiredActiveWarnings(nowMs, opts.limit ?? 50);
  let voided = 0;
  let errors = 0;

  const botId = client?.user?.id || "system:expiry";
  // OutboundClient for Discord-side logging; null client (tests) keeps the
  // old no-op behavior — logWarnEvent returns early on a null outbound.
  const outbound = client ? getDiscordOutbound(client) : null;

  for (const row of due) {
    try {
      // Ticker rows carry the internal integer (community_id); reverse-resolve
      // the Discord snowflake for audit-channel / DM lookups (spec § Tickers).
      const communityId = row.community_id;
      const community = getCommunityById(communityId);
      const guildId = community?.externalGuildId ?? null;
      if (!guildId) {
        console.error(
          `[warnings] no communities row for community ${communityId}; ` +
            `skipping Discord-side logging for W-${row.warning_number}`,
        );
      }

      const updated = voidWarning(communityId, row.warning_number, {
        voidedBy: botId,
        voidReason: "Auto-voided: expiry date reached",
      });
      if (!updated) continue;
      voided += 1;

      recordSystemAudit({
        communityId,
        action: "warnings.expire",
        targetType: "warning",
        targetId: String(updated.id),
        details: {
          warning_number: updated.warning_number,
          subject_user_id: row.user_id,
        },
      });

      const activeCount = countActiveWarnings(communityId, row.user_id);
      const ref = `W-${updated.warning_number}`;

      await logWarnEvent(outbound, guildId, {
        title: "Warning auto-voided (expired)",
        command: "warn-expiry-ticker",
        actor: client?.user || { id: botId, username: "Boiler Snake" },
        changes: [
          `${ref} on <@${row.user_id}>`,
          `Remaining active: **${activeCount}**`,
          "Reason: expiry date reached",
        ],
      }).catch(() => {});

      await maybeDmExpiry(client, communityId, guildId, updated, activeCount).catch(
        () => {}
      );
    } catch (err) {
      if (err?.code === "ALREADY_VOIDED") continue;
      errors += 1;
      console.error(
        `[warnings] expiry void failed W-${row.warning_number} community=${row.community_id}:`,
        err?.message || err
      );
    }
  }

  return { processed: due.length, voided, errors };
}

/**
 * Best-effort DM when community DMs are on.
 * @param {import("discord.js").Client} client
 * @param {number} communityId internal communities.id (settings lookup)
 * @param {string|null} externalGuildId Discord snowflake for the guild name
 *        (null when the communities row is missing)
 * @param {object} warn
 * @param {number} activeCount
 */
async function maybeDmExpiry(client, communityId, externalGuildId, warn, activeCount) {
  if (!client) return;
  const settings = getGuildSettings(communityId);
  if (Number(settings.warn_dm_members ?? 1) === 0) return;

  let user = null;
  try {
    user =
      client.users?.cache?.get?.(warn.user_id) ||
      (await client.users?.fetch?.(warn.user_id).catch(() => null));
  } catch {
    user = null;
  }
  if (!user || typeof user.send !== "function") return;

  let guildName = "a server";
  if (externalGuildId) {
    try {
      const g =
        client.guilds?.cache?.get?.(externalGuildId) ||
        (await client.guilds?.fetch?.(externalGuildId).catch(() => null));
      if (g?.name) guildName = g.name;
    } catch {
      /* keep default */
    }
  }

  const { EmbedBuilder } = require("discord.js");
  const ref = `W-${warn.warning_number}`;
  const embed = new EmbedBuilder()
    .setColor(COLOR_VOID)
    .setTitle(`Warning expired in ${guildName}`)
    .addFields(
      { name: "Warning", value: ref, inline: true },
      {
        name: "Active warnings remaining",
        value: String(activeCount),
        inline: true,
      },
      {
        name: "Note",
        value:
          "This warning reached its expiry date and was automatically voided. " +
          "It remains in your history as voided.",
      }
    )
    .setFooter({ text: "View your history anytime with /warn mine" });

  try {
    await user.send({ embeds: [embed] });
  } catch {
    /* DMs closed */
  }
}

/**
 * @param {import("discord.js").Client} client
 */
function startWarnExpiryTicker(client) {
  registerJob({
    name: "warningsExpiry",
    cron: EXPIRY_CRON,
    run: () => runWarnExpiryTick(client),
  });
  console.log("[warnings] Expiry ticker started (every minute)");
}

module.exports = {
  EXPIRY_CRON,
  runWarnExpiryTick,
  startWarnExpiryTicker,
};
