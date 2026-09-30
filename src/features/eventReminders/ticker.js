/**
 * Delivery scheduler for scheduled event reminders + safety cleanup.
 * Minute cron plus a 5s first pass after ready.
 */

const { registerJob } = require("../../core/scheduler");
const {
  claimDueReminders,
  markReminderSent,
  listAllActiveEventReminderConfigs,
} = require("../../db");
const {
  buildReminderDelivery,
  resolveNotifyChannelId,
  cleanupEventReminderByConfigId,
  isEventTerminal,
  eventStartMs,
} = require("./service");
const { recordSystemAudit } = require("../../core/auditTrail");
const { getCommunityById } = require("../../platform/community");

/** Every minute, wall clock (local timezone of the process). */
const REMINDER_CRON = "* * * * *";

/**
 * Ticker-side cleanup is an automated state mutation (config + role removal)
 * → one origin-'system' trail row. Slash-origin clears audit themselves.
 * @param {number} communityId
 * @param {number|string} configId
 * @param {string|null} [scheduledEventId]
 */
function noteCleanup(communityId, configId, scheduledEventId = null) {
  recordSystemAudit({
    communityId,
    action: "event_reminders.cleanup",
    targetType: "event_reminder",
    targetId: String(configId),
    details: { scheduled_event_id: scheduledEventId },
  });
}

/**
 * Map an internal community id back to its Discord Guild (cache first, then
 * fetch). Reminders fire from a ticker, so all we carry is the integer row key.
 * @param {import("discord.js").Client} client
 * @param {number} communityId
 * @returns {Promise<import("discord.js").Guild|null>}
 */
async function resolveGuild(client, communityId) {
  const community = getCommunityById(communityId);
  if (!community) {
    console.error(
      `[eventReminders] no community row id=${communityId} — cannot resolve guild`,
    );
    return null;
  }
  return (
    client.guilds.cache.get(community.externalGuildId) ||
    (await client.guilds.fetch(community.externalGuildId).catch(() => null))
  );
}

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
  const guild = await resolveGuild(client, row.community_id);
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
    noteCleanup(row.community_id, row.config_id, row.scheduled_event_id || null);
    markReminderSent(row.offset_id, null);
    return;
  }

  const channelId = resolveNotifyChannelId(row.community_id, row.channel_id);
  if (!channelId) {
    console.warn(
      `[eventReminders] no notify channel for community ${row.community_id} config ${row.config_id}; skipping offset ${row.offset_id}`
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

  const startMs =
    eventStartMs(scheduledEvent) ||
    row.fire_at + row.offset_minutes * 60_000;

  // Role ping must be in content (embed mentions do not notify).
  const payload = buildReminderDelivery({
    scheduledEvent,
    guildId: guild.id, // Discord snowflake for the event URL
    roleId: row.role_id,
    offsetMinutes: row.offset_minutes,
    template: row.message_template,
    startMs,
  });

  const msg = await channel.send(payload);

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
      const guild = await resolveGuild(client, config.community_id);
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
        noteCleanup(config.community_id, config.id, config.scheduled_event_id);
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
          noteCleanup(config.community_id, config.id, config.scheduled_event_id);
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
 */
function startEventReminderTicker(client) {
  registerJob({
    name: "eventReminders",
    cron: REMINDER_CRON,
    delayFirstMs: 5_000,
    run: () => runEventReminderTick(client),
  });
}

module.exports = {
  REMINDER_CRON,
  runEventReminderTick,
  startEventReminderTicker,
  deliverOne,
  safetyCleanup,
};
