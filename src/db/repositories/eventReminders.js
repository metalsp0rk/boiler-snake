const { db, now } = require("../connection");

/**
 * @param {string} guildId
 * @returns {{ event_reminder_channel_id: string|null }}
 */
function getEventReminderSettings(guildId) {
  const { getGuildSettings } = require("./guildSettings");
  const s = getGuildSettings(guildId);
  return {
    event_reminder_channel_id: s.event_reminder_channel_id ?? null,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.guildId
 * @param {string} opts.scheduledEventId
 * @param {string} opts.shortname
 * @param {string} opts.roleId
 * @param {string|null} [opts.channelId]
  * @param {string|null} [opts.messageTemplate]
  * @param {boolean} [opts.persistent]
  * @param {{ offsetMinutes: number, fireAt: number }[]} opts.offsets
  * @param {string} opts.createdBy
  * @returns {object} config row with offsets
  */
function createEventReminderConfig(opts) {
  const t = now();
  const insertConfig = db.prepare(`
     INSERT INTO event_reminder_configs (
       guild_id, scheduled_event_id, shortname, role_id, channel_id,
       message_template, persistent, active, created_at, created_by
     ) VALUES (
       @guild_id, @scheduled_event_id, @shortname, @role_id, @channel_id,
       @message_template, @persistent, 1, @created_at, @created_by
     )
   `);
  const insertOffset = db.prepare(`
    INSERT INTO event_reminder_offsets (config_id, offset_minutes, fire_at, sent_at, message_id)
    VALUES (?, ?, ?, NULL, NULL)
  `);

  const tx = db.transaction(() => {
    const info = insertConfig.run({
      guild_id: opts.guildId,
      scheduled_event_id: opts.scheduledEventId,
      shortname: opts.shortname,
      role_id: opts.roleId,
      channel_id: opts.channelId ?? null,
      message_template: opts.messageTemplate ?? null,
      persistent: opts.persistent ? 1 : 0,
      created_at: t,
      created_by: opts.createdBy,
    });
    const configId = Number(info.lastInsertRowid);
    for (const off of opts.offsets || []) {
      insertOffset.run(configId, off.offsetMinutes, off.fireAt);
    }
    return configId;
  });

  const configId = tx();
  return getEventReminderConfigById(configId);
}

/**
 * @param {number} configId
 * @returns {object|null}
 */
function getEventReminderConfigById(configId) {
  const row = db
    .prepare(`SELECT * FROM event_reminder_configs WHERE id=?`)
    .get(configId);
  if (!row) return null;
  return attachOffsets(row);
}

/**
 * @param {string} guildId
 * @param {string} scheduledEventId
 * @returns {object|null}
 */
function getConfigByScheduledEventId(guildId, scheduledEventId) {
  const row = db
    .prepare(
      `SELECT * FROM event_reminder_configs
       WHERE guild_id=? AND scheduled_event_id=? AND active=1`
    )
    .get(guildId, scheduledEventId);
  if (!row) return null;
  return attachOffsets(row);
}

/**
 * Any config for event (active or not) — used for uniqueness checks.
 * @param {string} guildId
 * @param {string} scheduledEventId
 */
function getAnyConfigByScheduledEventId(guildId, scheduledEventId) {
  const row = db
    .prepare(
      `SELECT * FROM event_reminder_configs
       WHERE guild_id=? AND scheduled_event_id=?`
    )
    .get(guildId, scheduledEventId);
  if (!row) return null;
  return attachOffsets(row);
}

/**
 * @param {string} guildId
 * @param {string} shortname
 * @returns {object|null}
 */
function getConfigByShortname(guildId, shortname) {
  return (
    db
      .prepare(
        `SELECT * FROM event_reminder_configs WHERE guild_id=? AND shortname=?`
      )
      .get(guildId, shortname) || null
  );
}

/**
 * @param {string} guildId
 * @param {{ activeOnly?: boolean }} [opts]
 * @returns {object[]}
 */
function listEventReminderConfigs(guildId, opts = {}) {
  const activeOnly = opts.activeOnly !== false;
  const rows = activeOnly
    ? db
        .prepare(
          `SELECT * FROM event_reminder_configs WHERE guild_id=? AND active=1 ORDER BY created_at ASC`
        )
        .all(guildId)
    : db
        .prepare(
          `SELECT * FROM event_reminder_configs WHERE guild_id=? ORDER BY created_at ASC`
        )
        .all(guildId);
  return rows.map(attachOffsets);
}

/**
 * @returns {object[]} all active configs (for ticker safety cleanup)
 */
function listAllActiveEventReminderConfigs() {
  const rows = db
    .prepare(`SELECT * FROM event_reminder_configs WHERE active=1`)
    .all();
  return rows.map(attachOffsets);
}

/**
 * Replace unsent offsets and update config fields (edit flow).
 * @param {number} configId
 * @param {object} patch
 * @param {string} [patch.shortname]
 * @param {string} [patch.roleId]
 * @param {string|null} [patch.channelId]
 * @param {string|null} [patch.messageTemplate]
 * @param {boolean} [patch.persistent]
 * @param {{ offsetMinutes: number, fireAt: number }[]} [patch.offsets] if set, replaces unsent offsets
 */
function updateEventReminderConfig(configId, patch) {
  const existing = getEventReminderConfigById(configId);
  if (!existing) return null;

  const tx = db.transaction(() => {
    const fields = [];
    const params = { id: configId };

    if (patch.shortname !== undefined) {
      fields.push("shortname=@shortname");
      params.shortname = patch.shortname;
    }
    if (patch.roleId !== undefined) {
      fields.push("role_id=@role_id");
      params.role_id = patch.roleId;
    }
    if (patch.channelId !== undefined) {
      fields.push("channel_id=@channel_id");
      params.channel_id = patch.channelId;
    }
    if (patch.messageTemplate !== undefined) {
      fields.push("message_template=@message_template");
      params.message_template = patch.messageTemplate;
    }
    if (patch.persistent !== undefined) {
      fields.push("persistent=@persistent");
      params.persistent = patch.persistent ? 1 : 0;
    }

    if (fields.length) {
      db.prepare(
        `UPDATE event_reminder_configs SET ${fields.join(", ")} WHERE id=@id`
      ).run(params);
    }

    if (Array.isArray(patch.offsets)) {
      db.prepare(
        `DELETE FROM event_reminder_offsets WHERE config_id=? AND sent_at IS NULL`
      ).run(configId);
      const insertOffset = db.prepare(`
        INSERT INTO event_reminder_offsets (config_id, offset_minutes, fire_at, sent_at, message_id)
        VALUES (?, ?, ?, NULL, NULL)
      `);
      for (const off of patch.offsets) {
        insertOffset.run(configId, off.offsetMinutes, off.fireAt);
      }
    }
  });

  tx();
  return getEventReminderConfigById(configId);
}

/**
 * Delete config (+ offsets via CASCADE). Returns role_id for Discord cleanup.
 * @param {string} guildId
 * @param {string} scheduledEventId
 * @returns {{ role_id: string, shortname: string, id: number }|null}
 */
function clearEventReminderConfig(guildId, scheduledEventId) {
  const row = db
    .prepare(
      `SELECT id, role_id, shortname FROM event_reminder_configs
       WHERE guild_id=? AND scheduled_event_id=?`
    )
    .get(guildId, scheduledEventId);
  if (!row) return null;

  // SQLite FK CASCADE may be off; delete children explicitly.
  db.prepare(`DELETE FROM event_reminder_offsets WHERE config_id=?`).run(row.id);
  db.prepare(`DELETE FROM event_reminder_configs WHERE id=?`).run(row.id);
  clearEventReminderMutesForEvent(guildId, scheduledEventId);
  return {
    id: row.id,
    role_id: row.role_id,
    shortname: row.shortname,
  };
}

/**
 * @param {number} configId
 * @returns {{ role_id: string, shortname: string, guild_id: string, scheduled_event_id: string }|null}
 */
function clearEventReminderConfigById(configId) {
  const row = db
    .prepare(
      `SELECT id, role_id, shortname, guild_id, scheduled_event_id
       FROM event_reminder_configs WHERE id=?`
    )
    .get(configId);
  if (!row) return null;
  db.prepare(`DELETE FROM event_reminder_offsets WHERE config_id=?`).run(configId);
  db.prepare(`DELETE FROM event_reminder_configs WHERE id=?`).run(configId);
  clearEventReminderMutesForEvent(row.guild_id, row.scheduled_event_id);
  return {
    id: row.id,
    role_id: row.role_id,
    shortname: row.shortname,
    guild_id: row.guild_id,
    scheduled_event_id: row.scheduled_event_id,
  };
}

/**
 * Recompute fire_at for unsent offsets from event start time.
 * @param {number} configId
 * @param {number} eventStartMs
 */
function setOffsetFireTimes(configId, eventStartMs) {
  const start = Number(eventStartMs);
  if (!Number.isFinite(start)) return;
  db.prepare(
    `UPDATE event_reminder_offsets
     SET fire_at = ? - (offset_minutes * 60000)
     WHERE config_id=? AND sent_at IS NULL`
  ).run(start, configId);
}

/**
 * Due unsent offsets joined with active config.
 * @param {number} nowMs
 * @param {number} [limit]
 * @returns {object[]}
 */
function claimDueReminders(nowMs, limit = 50) {
  const cap = Math.max(1, Math.min(Number(limit) || 50, 200));
    return db
      .prepare(
        `SELECT
          o.id AS offset_id,
          o.config_id,
          o.offset_minutes,
          o.fire_at,
          o.sent_at,
          o.message_id,
          c.guild_id,
          c.scheduled_event_id,
          c.shortname,
          c.role_id,
          c.channel_id,
          c.message_template,
          c.persistent
        FROM event_reminder_offsets o
        INNER JOIN event_reminder_configs c ON c.id = o.config_id
        WHERE o.sent_at IS NULL
          AND o.fire_at <= ?
          AND c.active = 1
        ORDER BY o.fire_at ASC
        LIMIT ?`
      )
      .all(nowMs, cap);
}

/**
 * @param {number} offsetId
 * @param {string} messageId
 */
function markReminderSent(offsetId, messageId) {
  db.prepare(
    `UPDATE event_reminder_offsets
     SET sent_at=?, message_id=?
     WHERE id=? AND sent_at IS NULL`
  ).run(now(), messageId || null, offsetId);
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @returns {boolean}
 */
function isEventReminderOptedOut(guildId, userId) {
  const row = db
    .prepare(
      `SELECT 1 FROM event_reminder_optouts WHERE guild_id=? AND user_id=?`
    )
    .get(guildId, userId);
  return !!row;
}

/**
 * @param {string} guildId
 * @param {string} userId
 */
function setEventReminderOptOut(guildId, userId) {
  db.prepare(
    `INSERT INTO event_reminder_optouts (guild_id, user_id, opted_out_at)
     VALUES (?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET opted_out_at=excluded.opted_out_at`
  ).run(guildId, userId, now());
}

/**
 * @param {string} guildId
 * @param {string} userId
 */
function clearEventReminderOptOut(guildId, userId) {
  db.prepare(
    `DELETE FROM event_reminder_optouts WHERE guild_id=? AND user_id=?`
  ).run(guildId, userId);
}

/**
 * Per-event mute (independent of guild-wide opt-out).
 * @param {string} guildId
 * @param {string} userId
 * @param {string} scheduledEventId
 * @returns {boolean}
 */
function isEventReminderMuted(guildId, userId, scheduledEventId) {
  const row = db
    .prepare(
      `SELECT 1 FROM event_reminder_event_optouts
       WHERE guild_id=? AND user_id=? AND scheduled_event_id=?`
    )
    .get(guildId, userId, scheduledEventId);
  return !!row;
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @param {string} scheduledEventId
 */
function setEventReminderMute(guildId, userId, scheduledEventId) {
  db.prepare(
    `INSERT INTO event_reminder_event_optouts
       (guild_id, user_id, scheduled_event_id, muted_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id, scheduled_event_id)
     DO UPDATE SET muted_at=excluded.muted_at`
  ).run(guildId, userId, scheduledEventId, now());
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @param {string} scheduledEventId
 */
function clearEventReminderMute(guildId, userId, scheduledEventId) {
  db.prepare(
    `DELETE FROM event_reminder_event_optouts
     WHERE guild_id=? AND user_id=? AND scheduled_event_id=?`
  ).run(guildId, userId, scheduledEventId);
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @returns {{ scheduled_event_id: string, muted_at: number }[]}
 */
function listEventReminderMutes(guildId, userId) {
  return db
    .prepare(
      `SELECT scheduled_event_id, muted_at FROM event_reminder_event_optouts
       WHERE guild_id=? AND user_id=?
       ORDER BY muted_at DESC`
    )
    .all(guildId, userId);
}

/**
 * Drop all mutes for a scheduled event (config cleanup).
 * @param {string} guildId
 * @param {string} scheduledEventId
 */
function clearEventReminderMutesForEvent(guildId, scheduledEventId) {
  db.prepare(
    `DELETE FROM event_reminder_event_optouts
     WHERE guild_id=? AND scheduled_event_id=?`
  ).run(guildId, scheduledEventId);
}

/**
 * Guild opt-out OR per-event mute blocks reminder roles for that event.
 * @param {string} guildId
 * @param {string} userId
 * @param {string} scheduledEventId
 * @returns {boolean}
 */
function isUserBlockedFromEventReminders(guildId, userId, scheduledEventId) {
  return (
    isEventReminderOptedOut(guildId, userId) ||
    isEventReminderMuted(guildId, userId, scheduledEventId)
  );
}

/**
 * @param {string} guildId
 * @returns {string[]} role ids for active configs
 */
function listActiveEventReminderRoleIds(guildId) {
  return db
    .prepare(
      `SELECT role_id FROM event_reminder_configs WHERE guild_id=? AND active=1`
    )
    .all(guildId)
    .map((r) => r.role_id);
}

/**
 * @param {object} row
 */
function attachOffsets(row) {
  const offsets = db
    .prepare(
      `SELECT * FROM event_reminder_offsets WHERE config_id=? ORDER BY offset_minutes DESC`
    )
    .all(row.id);
  return { ...row, offsets };
}

module.exports = {
  getEventReminderSettings,
  createEventReminderConfig,
  getEventReminderConfigById,
  getConfigByScheduledEventId,
  getAnyConfigByScheduledEventId,
  getConfigByShortname,
  listEventReminderConfigs,
  listAllActiveEventReminderConfigs,
  updateEventReminderConfig,
  clearEventReminderConfig,
  clearEventReminderConfigById,
  setOffsetFireTimes,
  claimDueReminders,
  markReminderSent,
  isEventReminderOptedOut,
  setEventReminderOptOut,
  clearEventReminderOptOut,
  isEventReminderMuted,
  setEventReminderMute,
  clearEventReminderMute,
  listEventReminderMutes,
  clearEventReminderMutesForEvent,
  isUserBlockedFromEventReminders,
  listActiveEventReminderRoleIds,
};
