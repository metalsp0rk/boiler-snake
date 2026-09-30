const { db, now } = require("../connection");

// src/platform/community.js requires the db facade (src/db/index.js), so a
// top-level require here would be a load-time cycle (partial exports). The
// lazy require resolves after boot; assertCommunityId stays single-source.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/**
 * @param {number} communityId
 * @returns {{ event_reminder_channel_id: string|null }}
 */
function getEventReminderSettings(communityId) {
  assertCommunityId(communityId);
  const { getGuildSettings } = require("./guildSettings");
  const s = getGuildSettings(communityId);
  return {
    event_reminder_channel_id: s.event_reminder_channel_id ?? null,
  };
}

/**
 * @param {object} opts
 * @param {number} opts.communityId
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
  assertCommunityId(opts.communityId);
  const t = now();
  const insertConfig = db.prepare(`
     INSERT INTO event_reminder_configs (
       community_id, scheduled_event_id, shortname, role_id, channel_id,
       message_template, persistent, active, created_at, created_by
     ) VALUES (
       @community_id, @scheduled_event_id, @shortname, @role_id, @channel_id,
       @message_template, @persistent, 1, @created_at, @created_by
     )
   `);
  const insertOffset = db.prepare(`
    INSERT INTO event_reminder_offsets (config_id, offset_minutes, fire_at, sent_at, message_id)
    VALUES (?, ?, ?, NULL, NULL)
  `);

  const tx = db.transaction(() => {
    const info = insertConfig.run({
      community_id: opts.communityId,
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
 * @param {number} communityId
 * @param {string} scheduledEventId
 * @returns {object|null}
 */
function getConfigByScheduledEventId(communityId, scheduledEventId) {
  assertCommunityId(communityId);
  const row = db
    .prepare(
      `SELECT * FROM event_reminder_configs
       WHERE community_id=? AND scheduled_event_id=? AND active=1`
    )
    .get(communityId, scheduledEventId);
  if (!row) return null;
  return attachOffsets(row);
}

/**
 * Any config for event (active or not) — used for uniqueness checks.
 * @param {number} communityId
 * @param {string} scheduledEventId
 */
function getAnyConfigByScheduledEventId(communityId, scheduledEventId) {
  assertCommunityId(communityId);
  const row = db
    .prepare(
      `SELECT * FROM event_reminder_configs
       WHERE community_id=? AND scheduled_event_id=?`
    )
    .get(communityId, scheduledEventId);
  if (!row) return null;
  return attachOffsets(row);
}

/**
 * @param {number} communityId
 * @param {string} shortname
 * @returns {object|null}
 */
function getConfigByShortname(communityId, shortname) {
  assertCommunityId(communityId);
  return (
    db
      .prepare(
        `SELECT * FROM event_reminder_configs WHERE community_id=? AND shortname=?`
      )
      .get(communityId, shortname) || null
  );
}

/**
 * @param {number} communityId
 * @param {{ activeOnly?: boolean }} [opts]
 * @returns {object[]}
 */
function listEventReminderConfigs(communityId, opts = {}) {
  assertCommunityId(communityId);
  const activeOnly = opts.activeOnly !== false;
  const rows = activeOnly
    ? db
        .prepare(
          `SELECT * FROM event_reminder_configs WHERE community_id=? AND active=1 ORDER BY created_at ASC`
        )
        .all(communityId)
    : db
        .prepare(
          `SELECT * FROM event_reminder_configs WHERE community_id=? ORDER BY created_at ASC`
        )
        .all(communityId);
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
 * @param {number} communityId
 * @param {string} scheduledEventId
 * @returns {{ role_id: string, shortname: string, id: number }|null}
 */
function clearEventReminderConfig(communityId, scheduledEventId) {
  assertCommunityId(communityId);
  const row = db
    .prepare(
      `SELECT id, role_id, shortname FROM event_reminder_configs
       WHERE community_id=? AND scheduled_event_id=?`
    )
    .get(communityId, scheduledEventId);
  if (!row) return null;

  // SQLite FK CASCADE may be off; delete children explicitly.
  db.prepare(`DELETE FROM event_reminder_offsets WHERE config_id=?`).run(row.id);
  db.prepare(`DELETE FROM event_reminder_configs WHERE id=?`).run(row.id);
  clearEventReminderMutesForEvent(communityId, scheduledEventId);
  return {
    id: row.id,
    role_id: row.role_id,
    shortname: row.shortname,
  };
}

/**
 * @param {number} configId
 * @returns {{ role_id: string, shortname: string, community_id: number, scheduled_event_id: string }|null}
 */
function clearEventReminderConfigById(configId) {
  const row = db
    .prepare(
      `SELECT id, role_id, shortname, community_id, scheduled_event_id
       FROM event_reminder_configs WHERE id=?`
    )
    .get(configId);
  if (!row) return null;
  db.prepare(`DELETE FROM event_reminder_offsets WHERE config_id=?`).run(configId);
  db.prepare(`DELETE FROM event_reminder_configs WHERE id=?`).run(configId);
  clearEventReminderMutesForEvent(row.community_id, row.scheduled_event_id);
  return {
    id: row.id,
    role_id: row.role_id,
    shortname: row.shortname,
    community_id: row.community_id,
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
          c.community_id,
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
 * @param {number} communityId
 * @param {string} userId
 * @returns {boolean}
 */
function isEventReminderOptedOut(communityId, userId) {
  assertCommunityId(communityId);
  const row = db
    .prepare(
      `SELECT 1 FROM event_reminder_optouts WHERE community_id=? AND user_id=?`
    )
    .get(communityId, userId);
  return !!row;
}

/**
 * @param {number} communityId
 * @param {string} userId
 */
function setEventReminderOptOut(communityId, userId) {
  assertCommunityId(communityId);
  db.prepare(
    `INSERT INTO event_reminder_optouts (community_id, user_id, opted_out_at)
     VALUES (?, ?, ?)
     ON CONFLICT(community_id, user_id) DO UPDATE SET opted_out_at=excluded.opted_out_at`
  ).run(communityId, userId, now());
}

/**
 * @param {number} communityId
 * @param {string} userId
 */
function clearEventReminderOptOut(communityId, userId) {
  assertCommunityId(communityId);
  db.prepare(
    `DELETE FROM event_reminder_optouts WHERE community_id=? AND user_id=?`
  ).run(communityId, userId);
}

/**
 * Per-event mute (independent of community-wide opt-out).
 * @param {number} communityId
 * @param {string} userId
 * @param {string} scheduledEventId
 * @returns {boolean}
 */
function isEventReminderMuted(communityId, userId, scheduledEventId) {
  assertCommunityId(communityId);
  const row = db
    .prepare(
      `SELECT 1 FROM event_reminder_event_optouts
       WHERE community_id=? AND user_id=? AND scheduled_event_id=?`
    )
    .get(communityId, userId, scheduledEventId);
  return !!row;
}

/**
 * @param {number} communityId
 * @param {string} userId
 * @param {string} scheduledEventId
 */
function setEventReminderMute(communityId, userId, scheduledEventId) {
  assertCommunityId(communityId);
  db.prepare(
    `INSERT INTO event_reminder_event_optouts
       (community_id, user_id, scheduled_event_id, muted_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(community_id, user_id, scheduled_event_id)
     DO UPDATE SET muted_at=excluded.muted_at`
  ).run(communityId, userId, scheduledEventId, now());
}

/**
 * @param {number} communityId
 * @param {string} userId
 * @param {string} scheduledEventId
 */
function clearEventReminderMute(communityId, userId, scheduledEventId) {
  assertCommunityId(communityId);
  db.prepare(
    `DELETE FROM event_reminder_event_optouts
     WHERE community_id=? AND user_id=? AND scheduled_event_id=?`
  ).run(communityId, userId, scheduledEventId);
}

/**
 * @param {number} communityId
 * @param {string} userId
 * @returns {{ scheduled_event_id: string, muted_at: number }[]}
 */
function listEventReminderMutes(communityId, userId) {
  assertCommunityId(communityId);
  return db
    .prepare(
      `SELECT scheduled_event_id, muted_at FROM event_reminder_event_optouts
       WHERE community_id=? AND user_id=?
       ORDER BY muted_at DESC`
    )
    .all(communityId, userId);
}

/**
 * Drop all mutes for a scheduled event (config cleanup).
 * @param {number} communityId
 * @param {string} scheduledEventId
 */
function clearEventReminderMutesForEvent(communityId, scheduledEventId) {
  assertCommunityId(communityId);
  db.prepare(
    `DELETE FROM event_reminder_event_optouts
     WHERE community_id=? AND scheduled_event_id=?`
  ).run(communityId, scheduledEventId);
}

/**
 * Community opt-out OR per-event mute blocks reminder roles for that event.
 * @param {number} communityId
 * @param {string} userId
 * @param {string} scheduledEventId
 * @returns {boolean}
 */
function isUserBlockedFromEventReminders(communityId, userId, scheduledEventId) {
  assertCommunityId(communityId);
  return (
    isEventReminderOptedOut(communityId, userId) ||
    isEventReminderMuted(communityId, userId, scheduledEventId)
  );
}

/**
 * @param {number} communityId
 * @returns {string[]} role ids for active configs
 */
function listActiveEventReminderRoleIds(communityId) {
  assertCommunityId(communityId);
  return db
    .prepare(
      `SELECT role_id FROM event_reminder_configs WHERE community_id=? AND active=1`
    )
    .all(communityId)
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
