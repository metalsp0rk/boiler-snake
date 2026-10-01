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
 * Resolve the OutboundClient for one warning row (roadmap/fluxer.md § Scheduler
 * jobs: clientForCommunity(warn.community_id) for the DM and the log channel).
 * Accepts the PR 7 supervisor, a raw OutboundClient, or a legacy raw discord.js
 * client (pre-cutover tests). Null = no ready client for the row.
 *
 * @param {object|null} supervisor
 * @param {number} communityId
 * @returns {object|null} OutboundClient
 */
function resolveOutbound(supervisor, communityId) {
  if (!supervisor) return null;
  if (typeof supervisor.clientForCommunity === "function") {
    try {
      return supervisor.clientForCommunity(communityId) ?? null;
    } catch (err) {
      console.error(
        `[warnings] clientForCommunity(${communityId}) threw: ${err?.message || err}`,
      );
      return null;
    }
  }
  if (typeof supervisor.sendChannel === "function") return supervisor;
  if (supervisor.guilds || supervisor.channels || supervisor.users) {
    // Legacy raw discord.js client (pre-PR 7 call site).
    try {
      return getDiscordOutbound(supervisor);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The raw Discord client behind the supervisor (null when Discord is
 * unconfigured). A legacy raw client passed directly is honored.
 * @param {object|null} supervisor
 * @returns {object|null}
 */
function resolveDiscordClient(supervisor) {
  if (!supervisor) return null;
  if (typeof supervisor.clientForCommunity === "function") {
    return supervisor.discord ?? null;
  }
  if (supervisor.guilds) return supervisor; // legacy raw discord.js client
  return null;
}

/**
 * Process due expirations.
 * @param {object|null} supervisor PR 7 supervisor ({discord, fluxer, clientForCommunity});
 *        a raw discord.js client is accepted (legacy shim), null tolerable
 * @param {{ now?: number, limit?: number }} [opts]
 * @returns {Promise<{ processed: number, voided: number, errors: number }>}
 */
async function runWarnExpiryTick(supervisor, opts = {}) {
  const nowMs = opts.now ?? Date.now();
  const due = listExpiredActiveWarnings(nowMs, opts.limit ?? 50);
  let voided = 0;
  let errors = 0;

  const client = resolveDiscordClient(supervisor);
  const botId = client?.user?.id || "system:expiry";

  for (const row of due) {
    try {
      // Ticker rows carry the internal integer (community_id); reverse-resolve
      // the external guild id for audit-channel lookups (spec § Tickers).
      const communityId = row.community_id;
      const community = getCommunityById(communityId);
      const guildId = community?.externalGuildId ?? null;
      if (!guildId) {
        console.error(
          `[warnings] no communities row for community ${communityId}; ` +
            `skipping Discord-side logging for W-${row.warning_number}`,
        );
      }

      // Per-row OutboundClient (spec 579: the DM and the log channel both go
      // through clientForCommunity). null → logging/DM steps no-op below.
      const outbound = resolveOutbound(supervisor, communityId);

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

      await maybeDmExpiry(outbound, communityId, updated, activeCount).catch(
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
 * Best-effort DM when community DMs are on, via OutboundClient.sendDm.
 * K2 (roadmap/fluxer.md Key Decisions): a DM failure is logged with the
 * instance key and NEVER posted to the channel.
 * @param {object|null} outbound OutboundClient for the row's community
 * @param {number} communityId internal communities.id (settings lookup)
 * @param {object} warn the voided warning row
 * @param {number} activeCount
 */
async function maybeDmExpiry(outbound, communityId, warn, activeCount) {
  if (!outbound) return; // no ready client for this row (spec 579: log-and-skip)
  const settings = getGuildSettings(communityId);
  if (Number(settings.warn_dm_members ?? 1) === 0) return;

  // instanceKey for the K2 log line; fetchGuild supplies the display name on
  // both platforms (the Discord adapter resolves the communities row itself).
  const community = getCommunityById(communityId);
  const instanceKey = community?.instanceKey ?? "discord";

  let guildName = "a server";
  const guildHandle = await outbound.fetchGuild(communityId);
  if (guildHandle?.name) guildName = guildHandle.name;

  const ref = `W-${warn.warning_number}`;
  // Plain NormalizedEmbed payload (spec § Embeds and attachments) — the
  // visible copy is byte-identical to the previous EmbedBuilder output.
  const embed = {
    color: COLOR_VOID,
    title: `Warning expired in ${guildName}`,
    fields: [
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
      },
    ],
    footer: { text: "View your history anytime with /warn mine" },
  };

  const result = await outbound.sendDm(warn.user_id, { embeds: [embed] });
  if (!result || result.ok !== true) {
    // K2: log the specific cause with the instance key; never echo the
    // warning body into a channel.
    console.warn(
      `[warnings] expiry DM failed for community ${communityId} (instance ${instanceKey}): ${
        result?.error || "sendDm returned no result"
      }`,
    );
  }
}

/**
 * @param {object|null} supervisor PR 7 supervisor
 */
function startWarnExpiryTicker(supervisor) {
  registerJob({
    name: "warningsExpiry",
    cron: EXPIRY_CRON,
    run: () => runWarnExpiryTick(supervisor),
  });
  console.log("[warnings] Expiry ticker started (every minute)");
}

module.exports = {
  EXPIRY_CRON,
  runWarnExpiryTick,
  startWarnExpiryTicker,
};
