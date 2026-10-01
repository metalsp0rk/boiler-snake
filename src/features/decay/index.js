const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { registerJob } = require("../../core/scheduler");
const {
  countMessagesInWindow,
  setXp,
  getGuildSettings,
  updateGuildSettings,
} = require("../../db");
// src/db/index.js still maps the removed `allUsersInGuild` name, so import the
// renamed repository functions directly. // TODO(fluxer-pr4): facade re-export.
const {
  allUsersInCommunity,
  listCommunityIdsWithUsers,
} = require("../../db/repositories/users");
const { levelFromXp } = require("../../core/xpMath");
const { requireStaffFromContext } = require("../../core/permissions");
const { Color } = require("../../core/theme");
const { syncMemberRoles } = require("../levelRoles/sync");
const { syncMemberReactionRoles } = require("../reactionRoles/service");
const {
  logLevelRoleChanges,
  logConfigChange,
  diffConfigLines,
} = require("../logs/auditLog");
const {
  recordSlashAudit,
  recordSystemAudit,
} = require("../../core/auditTrail");
const { getDiscordOutbound } = require("../../platform/discord/outbound");
const { getCommunityById } = require("../../platform/community");

const staffPerms = PermissionFlagsBits.ManageGuild;
const DECAY_CRON = "0 4 * * *";

const commands = [
  new SlashCommandBuilder()
    .setName("setdecay")
    .setDescription("Configure decay for this guild.")
    .setDefaultMemberPermissions(staffPerms)
    .addBooleanOption((opt) =>
      opt
        .setName("enabled")
        .setDescription("Enable/disable decay")
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("messages")
        .setDescription("Min messages required")
        .setMinValue(0)
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("days")
        .setDescription("Window in days")
        .setMinValue(1)
        .setRequired(false),
    )
    .addNumberOption((opt) =>
      opt
        .setName("percent")
        .setDescription("Decay percent (e.g. 10 = 10%)")
        .setMinValue(0)
        .setMaxValue(95)
        .setRequired(false),
    ),
];

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} featureCtx
 */
async function handleSetDecay(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireStaffFromContext(commandCtx))) return;

  // CommandContext carries the resolved internal id (roadmap/fluxer.md
  // § Repository boundary); externalGuildId is the snowflake for audit text
  // and the audit-log mirror lookup — never a repository key.
  const communityId = commandCtx.communityId;
  const guildId = commandCtx.externalGuildId;
  const settings = getGuildSettings(communityId);
  const enabled = commandCtx.options.getBoolean("enabled");
  const messages = commandCtx.options.getInteger("messages");
  const days = commandCtx.options.getInteger("days");
  const percent = commandCtx.options.getNumber("percent");

  const patch = {};
  if (enabled !== null) patch.decay_enabled = enabled ? 1 : 0;
  if (messages !== null) patch.decay_min_messages = Math.max(0, messages);
  if (days !== null) patch.decay_window_days = Math.max(1, days);
  if (percent !== null)
    patch.decay_percent = Math.max(0, Math.min(0.95, percent / 100));

  if (!Object.keys(patch).length) {
    await commandCtx.reply({
      content: "No decay settings provided to update.",
      sensitive: true,
    });
    return;
  }

  const before = settings;
  const updated = updateGuildSettings(communityId, patch);
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "decay.settings_update",
    targetType: "guild",
    targetId: guildId,
    details: { patch },
  });
  const lines = diffConfigLines(before, updated, Object.keys(patch), (k) => {
    if (k === "decay_enabled") return "`decay_enabled`";
    if (k === "decay_percent") return "`decay_percent`";
    return `\`${k}\``;
  }).map((line) => {
    if (line.includes("decay_percent")) {
      const pctBefore = Math.round((Number(before.decay_percent) || 0) * 100);
      const pctAfter = Math.round((Number(updated.decay_percent) || 0) * 100);
      return `\`decay_percent\`: ${pctBefore}% → **${pctAfter}%**`;
    }
    if (line.includes("decay_enabled")) {
      return `\`decay_enabled\`: ${!!before.decay_enabled} → **${!!updated.decay_enabled}**`;
    }
    return line;
  });

  if (lines.length) {
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "Decay settings updated",
      command: "/setdecay",
      actor: commandCtx.user,
      changes: lines,
    }).catch(() => {});
  }

  const decayPct = Math.round((Number(updated.decay_percent) || 0) * 100);
  // Plain-object embed (NormalizedEmbed) — the Discord reply builder re-wraps
  // it into EmbedBuilder at the adapter edge.
  const embed = {
    title: "Updated decay settings",
    color: Color.config,
    footer: { text: "Staff only" },
    fields: [
      {
        name: "Enabled",
        value: `**${!!updated.decay_enabled}**`,
        inline: true,
      },
      {
        name: "Threshold",
        value: `**${updated.decay_min_messages}** messages / **${updated.decay_window_days}** days`,
        inline: true,
      },
      {
        name: "Percent",
        value: `**${decayPct}%**`,
        inline: true,
      },
    ],
  };

  await commandCtx.reply({ embeds: [embed], sensitive: true });
}

/**
 * Resolve the raw Discord client behind the supervisor (null when Discord is
 * unconfigured). A legacy raw client passed directly is honored (tests and
 * pre-cutover callers).
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
 * Resolve the OutboundClient for one community (roadmap/fluxer.md § Scheduler
 * jobs: "clientForCommunity for each community row that has users").
 * @param {object|null} supervisor
 * @param {number} communityId
 * @returns {object|null}
 */
function resolveOutbound(supervisor, communityId) {
  if (!supervisor) return null;
  if (typeof supervisor.clientForCommunity === "function") {
    try {
      return supervisor.clientForCommunity(communityId) ?? null;
    } catch (err) {
      console.error(
        `[decay] clientForCommunity(${communityId}) threw: ${err?.message || err}`,
      );
      return null;
    }
  }
  if (typeof supervisor.sendChannel === "function") return supervisor;
  const client = resolveDiscordClient(supervisor);
  if (client) {
    try {
      return getDiscordOutbound(client);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Run one decay pass for a community.
 * @param {object|null} supervisor PR 7 supervisor ({discord, fluxer, clientForCommunity})
 * @param {number} communityId  internal communities.id
 */
async function runDecayForGuild(supervisor, communityId) {
  const settings = getGuildSettings(communityId);
  if (!settings.decay_enabled) return;

  // Communities row carries the platform + capability flags (PR 6 camelCase).
  const community = getCommunityById(communityId);
  const guildId = community?.externalGuildId ?? null;
  if (!guildId) {
    console.error(
      `[decay] no communities row / external guild id for community ${communityId}; skipping decay`,
    );
    return;
  }
  const isDiscordRow = community.platform === "discord";

  // Per-row client (spec 575): clientForCommunity for this community.
  const outbound = resolveOutbound(supervisor, communityId);
  const client = resolveDiscordClient(supervisor);

  let guild = null;
  if (isDiscordRow) {
    // The Discord arm keeps the discord.js Guild path (member objects feed
    // syncMemberRoles / syncMemberReactionRoles / the audit mirror).
    if (!client) {
      console.error(
        `[decay] no Discord client configured for community ${communityId}; skipping decay`,
      );
      return;
    }
    guild = await client.guilds.fetch(guildId).catch((err) => {
      console.error(
        `[decay] failed to fetch Discord guild ${guildId} for community ${communityId}: ${err?.message || err}`,
      );
      return null;
    });
    if (!guild) return;
  }

  if (!outbound) {
    console.warn(
      `[decay] no ready client for community ${communityId} — skipping`,
    );
    return;
  }

  // K8: Fluxer role mutations are elevated-gated; Discord rows always re-sync.
  const fluxerCanResync = !isDiscordRow && Number(community.elevatedPermissions) === 1;

  const users = allUsersInCommunity(communityId);
  for (const u of users) {
    const msgCount = countMessagesInWindow(
      communityId,
      u.user_id,
      settings.decay_window_days,
    );

    if (msgCount >= settings.decay_min_messages) continue;

    const pct = Math.min(
      0.95,
      Math.max(0, Number(settings.decay_percent) || 0),
    );
    const newXp = Math.floor(u.xp * (1 - pct));
    if (newXp === u.xp) continue;

    const oldLvl = levelFromXp(u.xp, settings.level_xp_factor);
    setXp(communityId, u.user_id, newXp);
    recordSystemAudit({
      communityId,
      action: "decay.xp_decay",
      targetType: "user",
      targetId: u.user_id,
      details: {
        before_xp: u.xp,
        after_xp: newXp,
        percent: pct,
        old_level: oldLvl,
      },
    });

    const lvl = levelFromXp(newXp, settings.level_xp_factor);

    if (isDiscordRow) {
      const member = await guild.members.fetch(u.user_id).catch(() => null);
      if (member) {
        const levelChanges = await syncMemberRoles(outbound, communityId, member, lvl);
        await logLevelRoleChanges(
          outbound,
          communityId,
          member,
          levelChanges,
          lvl,
          "decay",
        ).catch(() => {});

        await syncMemberReactionRoles(member, lvl, {
          client,
          logSource: "decay_reaction_role",
        });

        if (lvl < oldLvl) {
          console.log(
            `[decay] ${guildId}/${u.user_id}: XP ${u.xp}→${newXp} (level ${oldLvl}→${lvl}); roles rechecked`,
          );
        }
      }
    } else if (fluxerCanResync) {
      // Fluxer elevated path (spec 575): re-sync roles through the OutboundClient
      // MemberHandle surface; K8 self-gates the actual REST calls. Reaction-role
      // sync needs discord.js member objects and stays Discord-only (PR 6 limit).
      const member = await outbound.fetchMember(communityId, u.user_id);
      if (member) {
        const levelChanges = await syncMemberRoles(outbound, communityId, member, lvl);
        await logLevelRoleChanges(
          outbound,
          communityId,
          member,
          levelChanges,
          lvl,
          "decay",
        ).catch(() => {});

        if (lvl < oldLvl) {
          console.log(
            `[decay] ${guildId}/${u.user_id}: XP ${u.xp}→${newXp} (level ${oldLvl}→${lvl}); roles rechecked`,
          );
        }
      }
    }
  }
}

function startDecayScheduler(supervisor) {
  registerJob({
    name: "decay",
    cron: DECAY_CRON,
    run: async () => {
      // Spec 575: iterate the communities that have tracked users; every
      // repository below receives the integer community id.
      for (const communityId of listCommunityIdsWithUsers()) {
        try {
          await runDecayForGuild(supervisor, communityId);
        } catch (err) {
          console.error(
            `[decay] decay run failed for community ${communityId}: ${err?.message || err}`,
          );
        }
      }
    },
  });
}

/**
 * @param {object|null} supervisor PR 7 supervisor ({discord, fluxer, clientForCommunity})
 * @param {object} [featureCtx]
 */
function start(supervisor, featureCtx) {
  void featureCtx;
  startDecayScheduler(supervisor);
}

module.exports = {
  name: "decay",
  commands,
  handlers: {
    setdecay: handleSetDecay,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): the slash
  // handler receives a CommandContext instead of a raw interaction.
  // PR 7: the ticker (startDecayScheduler / runDecayForGuild) takes the
  // supervisor and routes each tick by community.
  handlerApi: {
    setdecay: "context",
  },
  start,
  startDecayScheduler,
  runDecayForGuild,
};
