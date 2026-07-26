const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require("discord.js");
const cron = require("node-cron");
const {
  allUsersInGuild,
  countMessagesInWindow,
  setXp,
  getGuildSettings,
  updateGuildSettings,
} = require("../../db");
const { levelFromXp } = require("../../core/xpMath");
const { isAdminOrMod } = require("../../core/permissions");
const { syncMemberRoles } = require("../levelRoles/sync");
const { syncMemberReactionRoles } = require("../reactionRoles/service");
const { logLevelRoleChanges, logConfigChange, diffConfigLines } = require("../logs/auditLog");

const adminPerms = PermissionFlagsBits.ManageGuild;
const DECAY_CRON = "0 4 * * *";

const commands = [
  new SlashCommandBuilder()
    .setName("setdecay")
    .setDescription("Configure decay for this guild.")
    .setDefaultMemberPermissions(adminPerms)
    .addBooleanOption((opt) =>
      opt.setName("enabled").setDescription("Enable/disable decay").setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt.setName("messages").setDescription("Min messages required").setMinValue(0).setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt.setName("days").setDescription("Window in days").setMinValue(1).setRequired(false)
    )
    .addNumberOption((opt) =>
      opt
        .setName("percent")
        .setDescription("Decay percent (e.g. 10 = 10%)")
        .setMinValue(0)
        .setMaxValue(95)
        .setRequired(false)
    ),
];

async function handleSetDecay(interaction, ctx) {
  const { client } = ctx;
  if (!isAdminOrMod(interaction)) {
    await interaction.reply({
      content: "You don’t have permission to use this.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);
  const enabled = interaction.options.getBoolean("enabled");
  const messages = interaction.options.getInteger("messages");
  const days = interaction.options.getInteger("days");
  const percent = interaction.options.getNumber("percent");

  const patch = {};
  if (enabled !== null) patch.decay_enabled = enabled ? 1 : 0;
  if (messages !== null) patch.decay_min_messages = Math.max(0, messages);
  if (days !== null) patch.decay_window_days = Math.max(1, days);
  if (percent !== null) patch.decay_percent = Math.max(0, Math.min(0.95, percent / 100));

  if (!Object.keys(patch).length) {
    await interaction.reply({
      content: "No decay settings provided to update.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const before = settings;
  const updated = updateGuildSettings(guildId, patch);
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
    await logConfigChange(client, guildId, {
      title: "Decay settings updated",
      command: "/setdecay",
      actor: interaction.user,
      changes: lines,
    }).catch(() => {});
  }

  await interaction.reply({
    content:
      `Updated decay settings:\n` +
      `- enabled: **${!!updated.decay_enabled}**\n` +
      `- threshold: **${updated.decay_min_messages} messages** in **${updated.decay_window_days} days**\n` +
      `- percent: **${Math.round((Number(updated.decay_percent) || 0) * 100)}%**`,
    flags: MessageFlags.Ephemeral,
  });
}

async function runDecayForGuild(client, guildId) {
  const settings = getGuildSettings(guildId);
  if (!settings.decay_enabled) return;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const users = allUsersInGuild(guildId);
  for (const u of users) {
    const msgCount = countMessagesInWindow(
      guildId,
      u.user_id,
      settings.decay_window_days
    );

    if (msgCount >= settings.decay_min_messages) continue;

    const pct = Math.min(0.95, Math.max(0, Number(settings.decay_percent) || 0));
    const newXp = Math.floor(u.xp * (1 - pct));
    if (newXp === u.xp) continue;

    const oldLvl = levelFromXp(u.xp, settings.level_xp_factor);
    setXp(guildId, u.user_id, newXp);

    const member = await guild.members.fetch(u.user_id).catch(() => null);
    if (member) {
      const lvl = levelFromXp(newXp, settings.level_xp_factor);
      const levelChanges = await syncMemberRoles(member, lvl);
      await logLevelRoleChanges(client, member, levelChanges, lvl, "decay").catch(() => {});

      await syncMemberReactionRoles(member, lvl, {
        client,
        logSource: "decay_reaction_role",
      });

      if (lvl < oldLvl) {
        console.log(
          `[decay] ${guildId}/${u.user_id}: XP ${u.xp}→${newXp} (level ${oldLvl}→${lvl}); roles rechecked`
        );
      }
    }
  }
}

function startDecayScheduler(client) {
  cron.schedule(DECAY_CRON, async () => {
    try {
      for (const guild of client.guilds.cache.values()) {
        await runDecayForGuild(client, guild.id);
      }
    } catch (err) {
      console.error("[decay] scheduler error:", err?.message || err);
    }
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
