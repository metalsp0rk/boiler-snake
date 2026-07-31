/**
 * Delivery scheduler for scheduled event reminders + safety cleanup.
 * Uses node-cron (same dependency as decay) on a 60s cadence.
 */

const cron = require("node-cron");
const {
  claimDueReminders,
  markReminderSent,
  listAllActiveEventReminderConfigs,
} = require("../../db");
const {
  renderReminderMessage,
  resolveNotifyChannelId,
  cleanupEventReminderByConfigId,
  isEventTerminal,
  eventStartMs,
} = require("./service");

/** Every minute, wall clock (local timezone of the process). */
const REMINDER_CRON = "* * * * *";

/**
 * Deliver due offsets (one message per offset).
 * @param {import("discord.js").Client} client
 * @param {{ now?: number }} [opts]
 */
async function runEventReminderTick(client, opts = {}) {
  const nowMs = opts.now ?? Date.now();
  const due = claimDueReminders(nowMs, 50);

  for (const row of due) {
    try {
      await deliverOne(client, row);
    } catch (err) {
      console.error(
        `[eventReminders] deliver failed offset=${row.offset_id}:`,
        err?.message || err
      );
    }
  }

  await safetyCleanup(client, nowMs);
}

/**
 * @param {import("discord.js").Client} client
 * @param {object} row
 */
async function deliverOne(client, row) {
  const guild =
    client.guilds.cache.get(row.guild_id) ||
    (await client.guilds.fetch(row.guild_id).catch(() => null));
  if (!guild) {
    markReminderSent(row.offset_id, null);
    return;
  }

  let scheduledEvent = null;
  try {
    scheduledEvent =
      guild.scheduledEvents?.cache?.get(row.scheduled_event_id) ||
      (await guild.scheduledEvents?.fetch?.(row.scheduled_event_id).catch(() => null));
  } catch {
    scheduledEvent = null;
  }

  if (!scheduledEvent || isEventTerminal(scheduledEvent)) {
    await cleanupEventReminderByConfigId(guild, row.config_id);
    return;
  }

  const channelId = resolveNotifyChannelId(row.guild_id, row.channel_id);
  if (!channelId) {
    console.warn(
      `[eventReminders] no notify channel for guild ${row.guild_id} config ${row.config_id}; skipping offset ${row.offset_id}`
    );
    return;
  }

  const channel =
    guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel || typeof channel.send !== "function") {
    console.warn(
      `[eventReminders] channel ${channelId} missing/unsendable; skipping offset ${row.offset_id}`
    );
    return;
  }

  const startMs = eventStartMs(scheduledEvent) || row.fire_at + row.offset_minutes * 60_000;
  const content = renderReminderMessage(row.message_template, {
    eventName: scheduledEvent.name || "Event",
    startMs,
    roleId: row.role_id,
  });

  const msg = await channel.send({
    content,
    allowedMentions: { roles: [row.role_id] },
  });

  markReminderSent(row.offset_id, msg?.id || null);
}

/**
 * After event start (or if event gone), clean up configs.
 * @param {import("discord.js").Client} client
 * @param {number} nowMs
 */
async function safetyCleanup(client, nowMs) {
  const configs = listAllActiveEventReminderConfigs();
  for (const config of configs) {
    try {
      const guild =
        client.guilds.cache.get(config.guild_id) ||
        (await client.guilds.fetch(config.guild_id).catch(() => null));
      if (!guild) continue;

      let scheduledEvent = null;
      try {
        scheduledEvent =
          guild.scheduledEvents?.cache?.get(config.scheduled_event_id) ||
          (await guild.scheduledEvents
            ?.fetch?.(config.scheduled_event_id)
            .catch(() => null));
      } catch {
        scheduledEvent = null;
      }

      if (!scheduledEvent || isEventTerminal(scheduledEvent)) {
        await cleanupEventReminderByConfigId(guild, config.id);
        continue;
      }

      const start = eventStartMs(scheduledEvent);
      // Safety: once event has started and all offsets are either sent or past, cleanup soon after start.
      if (start != null && start + 5 * 60_000 < nowMs) {
        const allDone = (config.offsets || []).every(
          (o) => o.sent_at != null || o.fire_at <= nowMs
        );
        if (allDone) {
          await cleanupEventReminderByConfigId(guild, config.id);
        }
      }
    } catch (err) {
      console.error(
        `[eventReminders] safety cleanup config=${config.id}:`,
        err?.message || err
      );
    }
  }
}

/**
 * @param {import("discord.js").Client} client
 * @returns {import("node-cron").ScheduledTask}
 */
function startEventReminderTicker(client) {
  const task = cron.schedule(REMINDER_CRON, () => {
    runEventReminderTick(client).catch((err) => {
      console.error("[eventReminders] tick error:", err?.message || err);
    });
  });
  // First pass shortly after ready (don't wait for the next minute boundary)
  setTimeout(() => {
    runEventReminderTick(client).catch(() => {});
  }, 5_000);
  return task;
}

module.exports = {
  REMINDER_CRON,
  runEventReminderTick,
  startEventReminderTicker,
  deliverOne,
  safetyCleanup,
};
