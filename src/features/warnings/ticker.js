/**
 * Auto-void warnings past expires_at (opt-in per warning / guild default).
 * Uses node-cron on a 60s cadence (same pattern as event reminders / decay).
 */

const cron = require("node-cron");
const {
  listExpiredActiveWarnings,
  voidWarning,
  countActiveWarnings,
  getGuildSettings,
} = require("../../db");
const { logWarnEvent } = require("../logs/auditLog");

/** Every minute. */
const EXPIRY_CRON = "* * * * *";

const COLOR_VOID = 0x95a5a6;

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

  for (const row of due) {
    try {
      const updated = voidWarning(row.guild_id, row.warning_number, {
        voidedBy: botId,
        voidReason: "Auto-voided: expiry date reached",
      });
      if (!updated) continue;
      voided += 1;

      const activeCount = countActiveWarnings(row.guild_id, row.user_id);
      const ref = `W-${updated.warning_number}`;

      await logWarnEvent(client, row.guild_id, {
        title: "Warning auto-voided (expired)",
        command: "warn-expiry-ticker",
        actor: client?.user || { id: botId, username: "Boiler Snake" },
        changes: [
          `${ref} on <@${row.user_id}>`,
          `Remaining active: **${activeCount}**`,
          "Reason: expiry date reached",
        ],
      }).catch(() => {});

      await maybeDmExpiry(client, updated, activeCount).catch(() => {});
    } catch (err) {
      if (err?.code === "ALREADY_VOIDED") continue;
      errors += 1;
      console.error(
        `[warnings] expiry void failed W-${row.warning_number} guild=${row.guild_id}:`,
        err?.message || err
      );
    }
  }

  return { processed: due.length, voided, errors };
}

/**
 * Best-effort DM when guild DMs are on.
 * @param {import("discord.js").Client} client
 * @param {object} warn
 * @param {number} activeCount
 */
async function maybeDmExpiry(client, warn, activeCount) {
  if (!client) return;
  const settings = getGuildSettings(warn.guild_id);
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
  try {
    const g =
      client.guilds?.cache?.get?.(warn.guild_id) ||
      (await client.guilds?.fetch?.(warn.guild_id).catch(() => null));
    if (g?.name) guildName = g.name;
  } catch {
    /* keep default */
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
 * @returns {import("node-cron").ScheduledTask}
 */
function startWarnExpiryTicker(client) {
  const task = cron.schedule(EXPIRY_CRON, () => {
    runWarnExpiryTick(client).catch((err) => {
      console.error("[warnings] expiry tick failed:", err?.message || err);
    });
  });
  console.log("[warnings] Expiry ticker started (every minute)");
  return task;
}

module.exports = {
  EXPIRY_CRON,
  runWarnExpiryTick,
  startWarnExpiryTicker,
};
