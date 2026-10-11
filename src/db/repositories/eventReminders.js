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
      // Replace only the rows still in play (pending/sending); sent history
      // and terminal retired/failed rows stay as an audit trail. Re-adding a
      // retired offset inserts a fresh pending row (re-arm via /edit).
      db.prepare(
        `DELETE FROM event_reminder_offsets WHERE config_id=? AND sent_at IS NULL AND status IN ('pending','sending')`
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
 * Recompute fire_at for claimable offsets from event start time. Resetting
 * `next_attempt_at` re-arms the schedule: a rescheduled event starts from the
 * new fire_at, discarding any stale retry backoff. Terminal rows (sent /
 * retired / failed) are left alone.
 * @param {number} configId
 * @param {number} eventStartMs
 */
function setOffsetFireTimes(configId, eventStartMs) {
  const start = Number(eventStartMs);
  if (!Number.isFinite(start)) return;
  db.prepare(
    `UPDATE event_reminder_offsets
     SET fire_at = ? - (offset_minutes * 60000), next_attempt_at = NULL
     WHERE config_id=? AND sent_at IS NULL AND status IN ('pending','sending')`
  ).run(start, configId);
}

/**
 * Claim lease: a 'sending' row whose worker died (crash mid-delivery) becomes
 * claimable again once its `claimed_at` is older than this. Sized so a normal
 * delivery (a handful of REST calls, seconds) can never lose its claim.
 */
const REMINDER_CLAIM_TTL_MS = 5 * 60_000;

/** Transient-failure attempts tolerated before the offset goes terminal 'failed'. */
const MAX_REMINDER_ATTEMPTS = 12;

/** Ticker granularity (every minute): the retry floor is fire_at + one tick. */
const REMINDER_TICK_MS = 60_000;

/** Ceiling for one backoff step. */
const REMINDER_RETRY_MAX_MS = 6 * 60 * 60_000;

/**
 * Backoff curve for transient delivery failures: 1 min, 2, 4, 8, … doubling,
 * capped at 6 h. Attempt 1 of a row that fails on its first claim therefore
 * retries at +60 s — one tick later, never earlier. With
 * MAX_REMINDER_ATTEMPTS=12 the full curve spans roughly a day of Discord
 * outages before the offset goes terminal 'failed'.
 * @param {number} attempts 1-based failure count
 * @returns {number} delay in ms
 */
function reminderRetryDelayMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(REMINDER_TICK_MS * 2 ** (n - 1), REMINDER_RETRY_MAX_MS);
}

/** Row shape returned by claimDueReminders (offset joined with active config). */
const CLAIM_SELECT = `
  SELECT
    o.id AS offset_id,
    o.config_id,
    o.offset_minutes,
    o.fire_at,
    o.sent_at,
    o.message_id,
    o.status,
    o.attempts,
    o.next_attempt_at,
    o.claimed_at,
    o.last_error,
    c.community_id,
    c.scheduled_event_id,
    c.shortname,
    c.role_id,
    c.channel_id,
    c.message_template,
    c.persistent
  FROM event_reminder_offsets o
  INNER JOIN event_reminder_configs c ON c.id = o.config_id
`;

/**
 * Atomically claim due offsets (CAS BEFORE WORK, audit H12 — house style per
 * tickets.claimTicketArchive). A row is claimable when:
 *
 *  - `status='pending'` and its due time `COALESCE(next_attempt_at, fire_at)`
 *    has passed (backoff gates retries; NULL keeps legacy rows on `fire_at`); or
 *  - `status='sending'` with a `claimed_at` lease older than REMINDER_CLAIM_TTL_MS
 *    (the previous owner crashed — take over).
 *  `sent_at IS NULL` is belt-and-braces for legacy fixtures that write the
 *  old column set directly: a delivered row is never re-claimable.
 *
 * The per-row conditional UPDATE is the CAS: rows another ticker won first
 * report `changes===0` and are skipped, so each due offset is delivered by
 * exactly one caller. The whole batch runs in a single IMMEDIATE transaction
 * (write lock up front), keeping the LIMIT-50 queue semantics race-free.
 * Claimed rows are 'sending' and invisible to other tickers until they go
 * terminal (sent/retired/failed) or the lease expires.
 *
 * @param {number} nowMs
 * @param {number} [limit]
 * @returns {object[]} claimed rows (status 'sending')
 */
function claimDueReminders(nowMs, limit = 50) {
  const cap = Math.max(1, Math.min(Number(limit) || 50, 200));
  const staleBefore = nowMs - REMINDER_CLAIM_TTL_MS;

  const selectDue = db.prepare(`
    SELECT o.id FROM event_reminder_offsets o
    INNER JOIN event_reminder_configs c ON c.id = o.config_id
    WHERE c.active = 1
      AND o.sent_at IS NULL
      AND (
        (o.status='pending'  AND COALESCE(o.next_attempt_at, o.fire_at) <= ?)
        OR (o.status='sending' AND o.claimed_at IS NOT NULL AND o.claimed_at < ?)
      )
    ORDER BY COALESCE(o.next_attempt_at, o.fire_at) ASC, o.id ASC
    LIMIT ?
  `);
  const claimOne = db.prepare(`
    UPDATE event_reminder_offsets
    SET status='sending', claimed_at=?
    WHERE id=?
      AND sent_at IS NULL
      AND (
        (status='pending'  AND COALESCE(next_attempt_at, fire_at) <= ?)
        OR (status='sending' AND claimed_at IS NOT NULL AND claimed_at < ?)
      )
      AND EXISTS (
        SELECT 1 FROM event_reminder_configs c
        WHERE c.id = event_reminder_offsets.config_id AND c.active = 1
      )
  `);
  const fetchClaimed = db.prepare(`${CLAIM_SELECT} WHERE o.id=?`);

  const tx = db.transaction(() => {
    const claimed = [];
    for (const { id } of selectDue.all(nowMs, staleBefore, cap)) {
      if (claimOne.run(nowMs, id, nowMs, staleBefore).changes === 1) {
        claimed.push(fetchClaimed.get(id));
      }
    }
    return claimed;
  });
  return tx.immediate();
}

/**
 * Terminal transition: the reminder message hit Discord. CAS on the live
 * claim — only the ticker that currently holds the 'sending' claim can mark
 * it sent (a late write after a lease expiry reports won:false so the caller
 * can log it instead of corrupting the new owner's row).
 * @param {number} offsetId
 * @param {string|null} messageId
 * @param {number} [nowMs]
 * @returns {boolean} true only for the caller that still holds the claim
 */
function markReminderSent(offsetId, messageId, nowMs = now()) {
  const info = db.prepare(
    `UPDATE event_reminder_offsets
     SET status='sent', sent_at=?, message_id=?, claimed_at=NULL
     WHERE id=? AND status='sending'`
  ).run(nowMs, messageId || null, offsetId);
  return info.changes === 1;
}

/**
 * Terminal transition: the row CAN'T be delivered because the target is gone
 * (notify channel deleted — Discord 10003/10004 — or present but unsendable)
 * or because the event instance died under a persistent config. Retired rows
 * are never re-claimed: this is what stops a deleted channel from burning the
 * claim queue every minute for 30 days (audit H12).
 * @param {number} offsetId
 * @param {string} reason specific, human-readable (surfaced in logs + last_error)
 * @returns {{ won: boolean }}
 */
function retireReminderOffset(offsetId, reason) {
  const info = db.prepare(
    `UPDATE event_reminder_offsets
     SET status='retired', claimed_at=NULL, last_error=?
     WHERE id=? AND status='sending'`
  ).run(String(reason || "retired"), offsetId);
  return { won: info.changes === 1 };
}

/**
 * Transient-failure transition (network / 5xx / rate limit / guild not yet
 * cached / no notify channel configured): increment `attempts` and either
 * re-arm `pending` with a growing backoff, or go terminal `failed` once
 * MAX_REMINDER_ATTEMPTS is reached. The retry time is
 * `max(now + reminderRetryDelayMs(attempts), fire_at + REMINDER_TICK_MS)` —
 * the second term is the audit's "never earlier than next-offset + 1 tick"
 * floor. Never discards the row (the pre-fix markReminderSent(null) bug).
 * CAS on 'sending': a caller that lost its lease gets outcome 'skipped'.
 *
 * @param {number} offsetId
 * @param {{ error?: string|null, nowMs?: number }} [opts]
 * @returns {{ outcome: 'retry'|'failed'|'skipped', attempts: number, delayMs?: number, nextAttemptAt?: number }}
 */
function markReminderRetry(offsetId, opts = {}) {
  const errorText =
    opts.error == null ? null : String(opts.error).slice(0, 500);
  const nowMs = opts.nowMs ?? now();

  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT status, attempts, fire_at FROM event_reminder_offsets WHERE id=?`
      )
      .get(offsetId);
    if (!row || row.status !== 'sending') {
      return { outcome: 'skipped', attempts: Number(row?.attempts) || 0 };
    }
    const attempts = (Number(row.attempts) || 0) + 1;
    if (attempts >= MAX_REMINDER_ATTEMPTS) {
      db.prepare(
        `UPDATE event_reminder_offsets
         SET status='failed', attempts=?, claimed_at=NULL, last_error=?
         WHERE id=? AND status='sending'`
      ).run(attempts, errorText, offsetId);
      return { outcome: 'failed', attempts };
    }
    const delayMs = reminderRetryDelayMs(attempts);
    const floor = Number(row.fire_at) + REMINDER_TICK_MS;
    const nextAttemptAt = Math.max(nowMs + delayMs, floor);
    db.prepare(
      `UPDATE event_reminder_offsets
       SET status='pending', attempts=?, claimed_at=NULL, last_error=?, next_attempt_at=?
       WHERE id=? AND status='sending'`
    ).run(attempts, errorText, nextAttemptAt, offsetId);
    return { outcome: 'retry', attempts, delayMs, nextAttemptAt };
  });
  return tx.immediate();
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
  retireReminderOffset,
  markReminderRetry,
  reminderRetryDelayMs,
  REMINDER_CLAIM_TTL_MS,
  MAX_REMINDER_ATTEMPTS,
  REMINDER_TICK_MS,
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
