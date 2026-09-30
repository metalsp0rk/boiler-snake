const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { registerJob } = require("../../core/scheduler");
const {
  countMessagesInWindow,
  setXp,
  getGuildSettings,
  updateGuildSettings,
} = require("../../db");
// src/db/index.js still maps the removed `allUsersInGuild` name, so import the
// renamed repository function directly. // TODO(fluxer-pr4): facade re-export.
const { allUsersInCommunity } = require("../../db/repositories/users");
const { levelFromXp } = require("../../core/xpMath");
const { isStaff } = require("../../core/permissions");
const { replyDenied, replyEphemeral } = require("../../core/interaction");
const { Color, baseEmbed } = require("../../core/theme");
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
const {
  ensureCommunity,
  getCommunityById,
} = require("../../platform/community");

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

async function handleSetDecay(interaction, ctx) {
  const { client } = ctx;
  if (!isStaff(interaction)) {
    await replyDenied(interaction);
    return;
  }

  const guildId = interaction.guildId;
  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: guildId,
  });
  const settings = getGuildSettings(communityId);
  const enabled = interaction.options.getBoolean("enabled");
  const messages = interaction.options.getInteger("messages");
  const days = interaction.options.getInteger("days");
  const percent = interaction.options.getNumber("percent");

  const patch = {};
  if (enabled !== null) patch.decay_enabled = enabled ? 1 : 0;
  if (messages !== null) patch.decay_min_messages = Math.max(0, messages);
  if (days !== null) patch.decay_window_days = Math.max(1, days);
  if (percent !== null)
    patch.decay_percent = Math.max(0, Math.min(0.95, percent / 100));

  if (!Object.keys(patch).length) {
    await replyEphemeral(interaction, "No decay settings provided to update.");
    return;
  }

  const before = settings;
  const updated = updateGuildSettings(communityId, patch);
  recordSlashAudit({
    interaction,
    communityId,
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
    await logConfigChange(getDiscordOutbound(client), guildId, {
      title: "Decay settings updated",
      command: "/setdecay",
      actor: interaction.user,
      changes: lines,
    }).catch(() => {});
  }

  const decayPct = Math.round((Number(updated.decay_percent) || 0) * 100);
  const embed = baseEmbed({
    color: Color.config,
    title: "Updated decay settings",
    footer: "Staff only",
  }).addFields(
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
  );

  await replyEphemeral(interaction, { embeds: [embed] });
}

/**
 * Run one decay pass for a community.
 * @param {import("discord.js").Client} client
 * @param {number} communityId  internal communities.id (tickers pass row ids;
 *        resolved from the Discord guild snowflake at the scheduler edge)
 */
async function runDecayForGuild(client, communityId) {
  const settings = getGuildSettings(communityId);
  if (!settings.decay_enabled) return;

  // Ticker rows carry the community id; reverse-resolve the Discord guild.
  const community = getCommunityById(communityId);
  const guildId = community?.externalGuildId ?? null;
  if (!guildId) {
    console.error(
      `[decay] no communities row / external guild id for community ${communityId}; skipping decay`,
    );
    return;
  }
  const guild = await client.guilds.fetch(guildId).catch((err) => {
    console.error(
      `[decay] failed to fetch Discord guild ${guildId} for community ${communityId}: ${err?.message || err}`,
    );
    return null;
  });
  if (!guild) return;

  const outbound = getDiscordOutbound(client);
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

    const member = await guild.members.fetch(u.user_id).catch(() => null);
    if (member) {
      const lvl = levelFromXp(newXp, settings.level_xp_factor);
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
  }
}

function startDecayScheduler(client) {
  registerJob({
    name: "decay",
    cron: DECAY_CRON,
    run: async () => {
      for (const guild of client.guilds.cache.values()) {
        // Edge resolution: ticker entry points translate the Discord snowflake
        // once, then every repository below receives the integer community id.
        const communityId = ensureCommunity({
          platform: "discord",
          instanceKey: "discord",
          externalGuildId: guild.id,
        });
        await runDecayForGuild(client, communityId);
      }
    },
  });
}

function start(client) {
  startDecayScheduler(client);
}

module.exports = {
  name: "decay",
  commands,
  handlers: {
    setdecay: handleSetDecay,
  },
  start,
  startDecayScheduler,
  runDecayForGuild,
};
