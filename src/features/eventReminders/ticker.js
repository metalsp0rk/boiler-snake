/**
 * Delivery scheduler for scheduled event reminders + safety cleanup.
 * Minute cron plus a 5s first pass after ready.
 *
 * Delivery state model (audit-2026-10 H12 / #196): `claimDueReminders` CAS-claims
 * due rows into 'sending' (lease + TTL live in
 * `src/db/repositories/eventReminders.js`), then EVERY attempt resolves its
 * claim into exactly one persisted outcome — never an early `return` that
 * leaves the row to silently re-claim every tick:
 *
 *   SENT      → markReminderSent (terminal; sent_at + message_id)
 *   GONE      → retireReminderOffset — the target is definitively gone
 *               (notify channel deleted: Discord 10003/10004 — or exists but
 *               unsendable, or the event instance ended under a persistent
 *               config). Terminal on FIRST detection, never re-claimed.
 *   TRANSIENT → markReminderRetry — network/5xx/rate-limit/"guild not cached
 *               yet"/no notify channel configured. Growing backoff
 *               (never earlier than fire_at + one tick), terminal 'failed'
 *               after MAX_REMINDER_ATTEMPTS. The pre-fix code instead
 *               permanently DISCARDED these via markReminderSent(null).
 */

const { registerJob } = require("../../core/scheduler");
const {
  claimDueReminders,
  markReminderSent,
  retireReminderOffset,
  markReminderRetry,
  listAllActiveEventReminderConfigs,
} = require("../../db");
// Constants live on the repository (the db facade stays function-only —
// test/db-layer.test.js allow-list); direct require per the decay precedent.
const { MAX_REMINDER_ATTEMPTS } = require("../../db/repositories/eventReminders");
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
 * Discord JSON error codes meaning "the target is gone" (terminal), per the
 * issue's classification: 10003 Unknown Channel, 10004 Unknown Guild,
 * 10008 Unknown Guild Scheduled Event. Everything else a fetch/send can throw
 * at us (timeouts, 5xx, rate limits, 50001 Missing Access) is TRANSIENT and
 * retries with backoff — it must never retire or discard the reminder.
 */
const GONE_CHANNEL_CODES = new Set([10003, 10004]);
const GONE_EVENT_CODES = new Set([10008]);

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
 * @param {unknown} err a rejected fetch / thrown send (discord.js DiscordAPIError or mock)
 * @param {Set<number>} goneCodes
 */
function isGoneError(err, goneCodes) {
  const code = Number(err?.code ?? err?.rawError?.code);
  return Number.isFinite(code) && goneCodes.has(code);
}

/**
 * Map an internal community id back to its Discord Guild (cache first, then
 * fetch). Reminders fire from a ticker, so all we carry is the integer row key.
 * Failures are REPORTED, not swallowed into null: the caller must tell "guild
 * row missing / fetch failed" (transient → backoff) apart from a delivered
 * outcome (audit H12: the old `|| null` collapsed both and discarded rows).
 * @param {import("discord.js").Client} client
 * @param {number} communityId
 * @returns {Promise<{ guild: import("discord.js").Guild|null, error: string|null }>}
 */
async function resolveGuildResult(client, communityId) {
  let community = null;
  try {
    community = getCommunityById(communityId);
  } catch (err) {
    return {
      guild: null,
      error: `community lookup failed for id=${communityId}: ${err?.message || err}`,
    };
  }
  if (!community) {
    return { guild: null, error: `no community row id=${communityId}` };
  }
  const cached = client.guilds.cache.get(community.externalGuildId);
  if (cached) return { guild: cached, error: null };
  try {
    const guild = await client.guilds.fetch(community.externalGuildId);
    if (guild) return { guild, error: null };
    return {
      guild: null,
      error: `guild ${community.externalGuildId} unavailable (fetch returned nothing)`,
    };
  } catch (err) {
    return {
      guild: null,
      error: `guild ${community.externalGuildId} fetch failed: ${err?.message || err}`,
    };
  }
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
      await deliverOne(client, row, nowMs);
    } catch (err) {
      // Last-resort net: deliverOne resolves every outcome itself, so getting
      // here means the bookkeeping itself broke — name the row, never drop it.
      console.error(
        `[eventReminders] deliver failed offset=${row.offset_id} config=${row.config_id}:`,
        err?.message || err
      );
    }
  }

  await safetyCleanup(client, nowMs);
}

/**
 * Resolve a claimed row's delivery outcome into exactly one state transition.
 * Never throws: a failure to persist is logged with ids.
 * @param {object} row claimed row (status 'sending')
 * @param {string} reason specific cause for the operator/log
 * @param {number} nowMs
 */
function retryWithBackoff(row, reason, nowMs) {
  try {
    const res = markReminderRetry(row.offset_id, { error: reason, nowMs });
    if (res.outcome === "retry") {
      console.warn(
        `[eventReminders] offset=${row.offset_id} config=${row.config_id} transient failure ` +
          `(attempt ${res.attempts}/${MAX_REMINDER_ATTEMPTS}, retry at ` +
          `${new Date(res.nextAttemptAt).toISOString()}): ${reason}`
      );
    } else if (res.outcome === "failed") {
      console.error(
        `[eventReminders] offset=${row.offset_id} config=${row.config_id} permanently FAILED after ` +
          `${res.attempts} attempts: ${reason}`
      );
    } else {
      console.error(
        `[eventReminders] offset=${row.offset_id} lost its claim before retry bookkeeping; ` +
          `a re-claim owner will resolve it: ${reason}`
      );
    }
  } catch (err) {
    console.error(
      `[eventReminders] retry bookkeeping failed offset=${row.offset_id}:`,
      err?.message || err
    );
  }
}

/**
 * @param {object} row claimed row (status 'sending')
 * @param {string} reason terminal "gone" cause
 */
function retireRow(row, reason) {
  try {
    const { won } = retireReminderOffset(row.offset_id, reason);
    if (!won) {
      console.error(
        `[eventReminders] offset=${row.offset_id} lost its claim before retire bookkeeping: ${reason}`
      );
      return;
    }
    console.error(
      `[eventReminders] offset=${row.offset_id} config=${row.config_id} RETIRED (never fires again): ${reason}`
    );
  } catch (err) {
    console.error(
      `[eventReminders] retire bookkeeping failed offset=${row.offset_id}:`,
      err?.message || err
    );
  }
}

/**
 * @param {import("discord.js").Client} client
 * @param {object} row claimed row (status 'sending')
 * @param {number} [nowMs] clock used for retry scheduling (injected for determinism)
 */
async function deliverOne(client, row, nowMs = Date.now()) {
  const guildRes = await resolveGuildResult(client, row.community_id);
  if (!guildRes.guild) {
    // Transient (restart cache-cold, API blip) AND deleted-guild both land
    // here: retry with backoff, terminal 'failed' after MAX attempts. The old
    // code called markReminderSent(null) and permanently discarded the row.
    retryWithBackoff(row, `guild unavailable: ${guildRes.error}`, nowMs);
    return;
  }
  const guild = guildRes.guild;

  let scheduledEvent = null;
  let eventFetchError = null;
  try {
    scheduledEvent =
      guild.scheduledEvents?.cache?.get(row.scheduled_event_id) ||
      (await guild.scheduledEvents?.fetch?.(row.scheduled_event_id)) ||
      null;
  } catch (err) {
    eventFetchError = err;
  }
  if (eventFetchError && !isGoneError(eventFetchError, GONE_EVENT_CODES)) {
    // Transient event-fetch failure must NOT be mistaken for "event gone"
    // (the old `.catch(() => null)` fell into the config-cleanup branch).
    retryWithBackoff(
      row,
      `scheduled event ${row.scheduled_event_id} fetch failed: ${eventFetchError?.message || eventFetchError}`,
      nowMs
    );
    return;
  }

  if (!scheduledEvent || isEventTerminal(scheduledEvent)) {
    const reason = !scheduledEvent
      ? `scheduled event ${row.scheduled_event_id} not found`
      : `scheduled event ${row.scheduled_event_id} is terminal (status=${scheduledEvent.status})`;
    let cleared = null;
    try {
      cleared = await cleanupEventReminderByConfigId(guild, row.config_id);
    } catch (err) {
      retryWithBackoff(
        row,
        `cleanup after ${reason} failed: ${err?.message || err}`,
        nowMs
      );
      return;
    }
    if (cleared) {
      // Config + its offset rows are deleted; nothing left to transition.
      noteCleanup(row.community_id, row.config_id, row.scheduled_event_id || null);
      return;
    }
    // Persistent config survives event-instance cleanup → terminal RETIRE.
    retireRow(row, `${reason}; persistent config kept`);
    return;
  }

  const channelId = resolveNotifyChannelId(row.community_id, row.channel_id);
  if (!channelId) {
    // Operator-fixable (setchannel / edit), so not "gone": bounded retries
    // give a window to configure it, then terminal 'failed' — no claim-queue
    // re-claim loop.
    retryWithBackoff(
      row,
      `no notify channel configured (set one with /eventreminder setchannel or /eventreminder edit)`,
      nowMs
    );
    return;
  }

  let channel = guild.channels.cache.get(channelId) || null;
  let channelError = null;
  if (!channel) {
    try {
      channel = (await guild.channels.fetch(channelId)) || null;
    } catch (err) {
      channelError = err;
    }
  }
  if (channelError && !isGoneError(channelError, GONE_CHANNEL_CODES)) {
    retryWithBackoff(
      row,
      `channel ${channelId} fetch failed: ${channelError?.message || channelError}`,
      nowMs
    );
    return;
  }
  if (!channel) {
    // Gone: unknown/deleted channel (fetch resolved null or threw
    // 10003/10004). Terminal on FIRST detection — the audit's ~43k-hit
    // every-minute re-claim loop starts here, so it stops here.
    retireRow(
      row,
      `notify channel ${channelId} is gone (unknown/deleted${
        channelError ? `: ${channelError?.message || channelError}` : ""
      })`
    );
    return;
  }
  if (typeof channel.send !== "function") {
    // Exists but can never take the ping (wrong channel type) — retrying
    // cannot help; retire with the reason an operator can act on.
    retireRow(
      row,
      `notify channel ${channelId} is not sendable (type ${channel.type})`
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

  let msg;
  try {
    msg = await channel.send(payload);
  } catch (err) {
    if (isGoneError(err, GONE_CHANNEL_CODES)) {
      retireRow(
        row,
        `notify channel ${channelId} deleted between fetch and send: ${err?.message || err}`
      );
    } else {
      retryWithBackoff(
        row,
        `send to channel ${channelId} failed: ${err?.message || err}`,
        nowMs
      );
    }
    return;
  }

  const won = markReminderSent(row.offset_id, msg?.id || null);
  if (!won) {
    // Lease expired mid-send and another worker resolved the row already —
    // surface the (rare) duplicate-send window instead of silent corruption.
    console.error(
      `[eventReminders] offset=${row.offset_id} claim lost before marking sent ` +
        `(lease expired mid-send?); message posted as ${msg?.id || "?"} but row state owned elsewhere`
    );
  }
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
      const guildRes = await resolveGuildResult(client, config.community_id);
      if (!guildRes.guild) {
        console.warn(
          `[eventReminders] safety cleanup config=${config.id} skipped: ${guildRes.error}`
        );
        continue;
      }
      const guild = guildRes.guild;

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
          (o) =>
            o.sent_at != null ||
            o.status === "retired" ||
            o.status === "failed" ||
            o.fire_at <= nowMs
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
  GONE_CHANNEL_CODES,
  GONE_EVENT_CODES,
  runEventReminderTick,
  startEventReminderTicker,
  deliverOne,
  safetyCleanup,
  resolveGuildResult,
};
