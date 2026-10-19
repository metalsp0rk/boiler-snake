/**
 * Community events repository (epic #218, roadmap/community-events.md).
 *
 * All event tables live here: events, event_options, event_signups,
 * event_notifications, event_mutes, event_guild_settings, event_activity,
 * event_series, event_presets(+options), event_channels, event_wizards,
 * event_google_links, event_crossposts(+messages).
 *
 * House rules honored here:
 *  - `community_id INTEGER` everywhere (migration 034); a Discord snowflake
 *    can never reach these functions (assertCommunityId rejects it).
 *  - REFERENCES clauses are documentation only: every delete is an explicit
 *    child-then-parent transaction.
 *  - Constants live on THIS module (facade exports functions only — the
 *    db-layer facade shape test).
 *  - The reminder rows share the 038 claim state machine of feature 2:
 *    pending → sending (CAS claim) → sent | failed | retired, with the same
 *    attempt ladder, so a crashed claim re-fires after the TTL and a
 *    permanent failure is a row state, never a lost message.
 */

const { db, now } = require("../connection");

/** Lazily required to avoid a require cycle (same as eventReminders). */
const assertCommunityId = (id) =>
  require("../../platform/community").assertCommunityId(id);

// ── constants (repo-local; consumers require this file directly) ────────────

const MAX_EVENT_REMINDER_ATTEMPTS = 12;
const EVENT_REMINDER_CLAIM_TTL_MS = 5 * 60_000;
const MAX_POST_ATTEMPTS = 12;
const POST_CLAIM_TTL_MS = 5 * 60_000;
const MAX_REMINDERS_PER_EVENT = 8;
const MAX_OFFSET_MINUTES = 30 * 24 * 60; // same 30-day cap as feature 2
const MAX_OPTIONS_PER_EVENT = 10;
const MAX_PRESETS_PER_COMMUNITY = 25;
const EVENT_ROLE_PREFIX = "event-";

/** Event status values (CHECK-constrained in migration 042). */
const EVENT_STATUSES = ["draft", "pending_confirm", "posted", "archived", "skipped"];
const REMINDER_STATUSES = ["pending", "sending", "sent", "failed", "retired"];

/**
 * Backoff ladder identical in shape to feature 2 (feature 2:
 * eventReminders.reminderRetryDelayMs): 60s·2^(attempts-1), floored one
 * minute past fire_at, capped at 6 hours.
 */
function eventReminderRetryDelayMs(attempts, fireAt, nowMs) {
  const exp = Math.min(attempts, 12);
  const backoff = Math.min(60_000 * 2 ** (exp - 1), 6 * 3_600_000);
  const due = fireAt + 60_000;
  return Math.max(nowMs + backoff, due) - nowMs;
}

// ── tiny JSON column helpers ────────────────────────────────────────────────

function toJsonArray(value) {
  if (value == null) return "[]";
  if (Array.isArray(value)) return JSON.stringify(value.map(String));
  return "[]";
}

function fromJsonArray(text) {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

const bool = (v) => (v ? 1 : 0);

// ── guild settings ──────────────────────────────────────────────────────────

const selectSettings = db.prepare(
  `SELECT * FROM event_guild_settings WHERE community_id = ?`,
);

const SETTINGS_COLUMNS = [
  "default_reminder_minutes",
  "show_attendees",
  "time_zone",
  "create_role_id",
  "edit_role_id",
  "delete_role_id",
  "channels_role_id",
  "options_role_id",
  "thread_reminders",
  "reminder_channel_id",
  "auto_archive",
  "auto_archive_delay_minutes",
  "digest_channel_id",
  "digest_frequency",
  "digest_hour_utc",
  "digest_weekday",
  "digest_last_sent_at",
  "google_auto_user_id",
  "google_auto_enabled",
];
const SETTINGS_BOOL_COLUMNS = new Set([
  "show_attendees",
  "thread_reminders",
  "auto_archive",
  "google_auto_enabled",
]);
const SETTINGS_INT_COLUMNS = new Set([
  "default_reminder_minutes",
  "auto_archive_delay_minutes",
  "digest_hour_utc",
  "digest_weekday",
  "digest_last_sent_at",
]);
const SETTINGS_TEXT_COLUMNS = new Set([
  "time_zone",
  "create_role_id",
  "edit_role_id",
  "delete_role_id",
  "channels_role_id",
  "options_role_id",
  "reminder_channel_id",
  "digest_channel_id",
  "google_auto_user_id",
]);
const SETTINGS_ENUMS = {
  digest_frequency: ["none", "daily", "weekly"],
};

function defaultSettings(communityId) {
  return {
    community_id: communityId,
    default_reminder_minutes: 15,
    show_attendees: 1,
    time_zone: "UTC",
    create_role_id: null,
    edit_role_id: null,
    delete_role_id: null,
    channels_role_id: null,
    options_role_id: null,
    thread_reminders: 1,
    reminder_channel_id: null,
    auto_archive: 0,
    auto_archive_delay_minutes: 120,
    digest_channel_id: null,
    digest_frequency: "none",
    digest_hour_utc: 18,
    digest_weekday: 1,
    digest_last_sent_at: null,
    google_auto_user_id: null,
    google_auto_enabled: 0,
    updated_at: 0,
  };
}

/** Read (or lazily create) the guild's event settings row. */
function getEventGuildSettings(communityId) {
  assertCommunityId(communityId);
  const row = selectSettings.get(communityId);
  if (row) return row;
  db.prepare(
    `INSERT INTO event_guild_settings (community_id, updated_at) VALUES (?, ?)
     ON CONFLICT (community_id) DO NOTHING`,
  ).run(communityId, now());
  return selectSettings.get(communityId) || defaultSettings(communityId);
}

/** Patch known settings columns; unknown keys and bad enums are ignored. */
function updateEventGuildSettings(communityId, patch = {}) {
  assertCommunityId(communityId);
  getEventGuildSettings(communityId); // ensure row exists
  const sets = [];
  const values = [];
  for (const [key, raw] of Object.entries(patch)) {
    if (!SETTINGS_COLUMNS.includes(key)) continue;
    let value = raw;
    if (SETTINGS_BOOL_COLUMNS.has(key)) value = bool(Boolean(raw));
    else if (SETTINGS_INT_COLUMNS.has(key))
      value = value == null ? null : Math.trunc(Number(value));
    else if (SETTINGS_TEXT_COLUMNS.has(key))
      value = value == null ? null : String(value).trim() || null;
    const allowed = SETTINGS_ENUMS[key];
    if (allowed && value != null && !allowed.includes(value)) continue;
    sets.push(`${key} = ?`);
    values.push(value);
  }
  if (!sets.length) return getEventGuildSettings(communityId);
  sets.push("updated_at = ?");
  values.push(now(), communityId);
  db.prepare(
    `UPDATE event_guild_settings SET ${sets.join(", ")} WHERE community_id = ?`,
  ).run(...values);
  return selectSettings.get(communityId);
}

// ── events ──────────────────────────────────────────────────────────────────

const EVENT_PATCH_COLUMNS = new Set([
  "channel_id",
  "message_id",
  "thread_id",
  "title",
  "description",
  "location",
  "start_at",
  "end_at",
  "duration_minutes",
  "image_url",
  "color",
  "announce_role_ids",
  "attendee_role_id",
  "attendee_role_existing",
  "role_mode",
  "status",
  "post_at",
  "cutoff_at",
  "role_whitelist",
  "multiple_signups",
  "thread_enabled",
  "thread_private",
  "series_id",
]);

const EVENT_JSON_COLUMNS = new Set(["announce_role_ids", "role_whitelist"]);
const EVENT_BOOL_COLUMNS = new Set([
  "multiple_signups",
  "thread_enabled",
  "thread_private",
]);

function normalizeEventPatch(patch = {}) {
  const out = {};
  for (const [key, raw] of Object.entries(patch)) {
    if (!EVENT_PATCH_COLUMNS.has(key)) continue;
    if (raw === undefined) continue;
    if (EVENT_JSON_COLUMNS.has(key)) out[key] = toJsonArray(raw);
    else if (EVENT_BOOL_COLUMNS.has(key)) out[key] = bool(Boolean(raw));
    else out[key] = raw;
  }
  return out;
}

/**
 * Create an event row. `options` (optional) are inserted atomically.
 * @returns {{ ok: true, event: object, options: object[] }|{ ok: false, error: string }}
 */
function createEvent({
  communityId,
  creatorId,
  title,
  status = "pending_confirm",
  startAt,
  channelId = null,
  postAt = null,
  options = null,
  ...rest
}) {
  try {
    assertCommunityId(communityId);
    if (typeof title !== "string" || title.trim() === "") {
      return { ok: false, error: "A title is required." };
    }
    if (!Number.isFinite(startAt)) {
      return { ok: false, error: "A valid start time is required." };
    }
    if (options && options.length > MAX_OPTIONS_PER_EVENT) {
      return {
        ok: false,
        error: `At most ${MAX_OPTIONS_PER_EVENT} signup options per event.`,
      };
    }
    const p = normalizeEventPatch(rest);
    const insertEvent = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO events (
             community_id, creator_id, title, status, start_at, channel_id, post_at,
             description, location, end_at, duration_minutes, image_url, color,
             announce_role_ids, attendee_role_id, attendee_role_existing, role_mode,
             series_id, cutoff_at, role_whitelist, multiple_signups,
             thread_enabled, thread_private, created_at, updated_at
           ) VALUES (
             @community_id, @creator_id, @title, @status, @start_at, @channel_id, @post_at,
             @description, @location, @end_at, @duration_minutes, @image_url, @color,
             @announce_role_ids, @attendee_role_id, @attendee_role_existing, @role_mode,
             @series_id, @cutoff_at, @role_whitelist, @multiple_signups,
             @thread_enabled, @thread_private, @created_at, @updated_at
           )`,
        )
        .run({
          community_id: communityId,
          creator_id: String(creatorId),
          title: title.trim(),
          status,
          start_at: startAt,
          channel_id: channelId,
          post_at: postAt,
          description: p.description ?? null,
          location: p.location ?? null,
          end_at: p.end_at ?? null,
          duration_minutes: p.duration_minutes ?? null,
          image_url: p.image_url ?? null,
          color: p.color ?? null,
          announce_role_ids: p.announce_role_ids ?? "[]",
          attendee_role_id: p.attendee_role_id ?? null,
          attendee_role_existing: p.attendee_role_existing ?? null,
          role_mode: p.role_mode ?? "temp",
          series_id: p.series_id ?? null,
          cutoff_at: p.cutoff_at ?? null,
          role_whitelist: p.role_whitelist ?? "[]",
          multiple_signups: p.multiple_signups ?? 0,
          thread_enabled: p.thread_enabled ?? 1,
          thread_private: p.thread_private ?? 0,
          created_at: now(),
          updated_at: now(),
        });
      const eventId = info.lastInsertRowid;
      const insertedOptions = [];
      for (const [i, opt] of (options || []).entries()) {
        const oi = db
          .prepare(
            `INSERT INTO event_options
               (event_id, label, emoji, position, capacity, waitlist_on, reminders_on, role_whitelist)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            eventId,
            String(opt.label).trim(),
            opt.emoji ?? null,
            Number.isFinite(opt.position) ? opt.position : i,
            Math.max(0, Math.trunc(Number(opt.capacity) || 0)),
            bool(opt.waitlist_on !== false),
            bool(Boolean(opt.reminders_on)),
            toJsonArray(opt.role_whitelist),
          );
        insertedOptions.push({ id: oi.lastInsertRowid, label: String(opt.label).trim() });
      }
      return eventId;
    });
    const eventId = insertEvent();
    return { ok: true, event: getEventById(eventId), options: listEventOptions(eventId) };
  } catch (err) {
    return { ok: false, error: `database error: ${err?.message || err}` };
  }
}

function getEventById(eventId) {
  const row = db.prepare(`SELECT * FROM events WHERE id = ?`).get(eventId);
  return row || null;
}

/** Fetch an event and assert it belongs to this community. */
function getEventForCommunity(eventId, communityId) {
  assertCommunityId(communityId);
  const row = getEventById(eventId);
  if (!row || row.community_id !== communityId) return null;
  return row;
}

function getEventByMessage(messageId) {
  if (!messageId) return null;
  return (
    db.prepare(`SELECT * FROM events WHERE message_id = ?`).get(String(messageId)) || null
  );
}

/**
 * List events for a community.
 * @param {number} communityId
 * @param {object} [opts]
 * @param {string[]} [opts.statuses] default ['posted']
 * @param {number|null} [opts.from]  start_at >= from (ms)
 * @param {number|null} [opts.to]    start_at <= to (ms)
 * @param {string} [opts.creatorId] filter by creator
 * @param {number} [opts.limit]
 */
function listEvents(communityId, opts = {}) {
  assertCommunityId(communityId);
  const statuses = Array.isArray(opts.statuses) && opts.statuses.length
    ? opts.statuses
    : ["posted"];
  const clauses = [`community_id = ?`, `status IN (${statuses.map(() => "?").join(",")})`];
  const params = [communityId, ...statuses];
  if (opts.from != null) {
    clauses.push("start_at >= ?");
    params.push(opts.from);
  }
  if (opts.to != null) {
    clauses.push("start_at <= ?");
    params.push(opts.to);
  }
  if (opts.creatorId) {
    clauses.push("creator_id = ?");
    params.push(String(opts.creatorId));
  }
  if (opts.seriesId != null) {
    clauses.push("series_id = ?");
    params.push(opts.seriesId);
  }
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit || 50)), 200);
  params.push(limit);
  return db
    .prepare(
      `SELECT * FROM events WHERE ${clauses.join(" AND ")}
       ORDER BY start_at ASC, id ASC LIMIT ?`,
    )
    .all(...params);
}

/** Posted events that have not ended yet (or have no end). */
function listUpcomingEvents(communityId, { limit = 20, nowMs = now() } = {}) {
  assertCommunityId(communityId);
  // E9: drafts/pending previews stay discoverable (list marks them).
  return db
    .prepare(
      `SELECT * FROM events
       WHERE community_id = ? AND status IN ('posted', 'draft', 'pending_confirm')
         AND (end_at IS NULL OR end_at >= ?)
       ORDER BY start_at ASC, id ASC LIMIT ?`,
    )
    .all(communityId, nowMs, Math.min(Math.max(1, limit), 50));
}

/** Patch allow-listed event columns (returns updated row or error). */
function updateEvent(eventId, patch = {}) {
  const p = normalizeEventPatch(patch);
  const keys = Object.keys(p);
  if (!keys.length) return { ok: true, event: getEventById(eventId) };
  if (!getEventById(eventId)) return { ok: false, error: "Event not found." };
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const params = keys.map((k) => p[k]);
  params.push(now(), eventId);
  try {
    db.prepare(`UPDATE events SET ${sets}, updated_at = ? WHERE id = ?`).run(...params);
    return { ok: true, event: getEventById(eventId) };
  } catch (err) {
    return { ok: false, error: `database error: ${err?.message || err}` };
  }
}

/** Transition a draft → posted with its Discord coordinates. */
function markEventPosted(eventId, { channelId, messageId }) {
  db.prepare(
    `UPDATE events
     SET status = 'posted', channel_id = ?, message_id = ?,
         post_at = NULL, next_attempt_at = NULL, post_attempts = 0,
         last_post_error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(String(channelId), String(messageId), now(), eventId);
  return getEventById(eventId);
}

function setEventThread(eventId, threadId) {
  db.prepare(`UPDATE events SET thread_id = ?, updated_at = ? WHERE id = ?`).run(
    threadId ? String(threadId) : null,
    now(),
    eventId,
  );
  return getEventById(eventId);
}

/**
 * Claim drafts whose scheduled post time is due (or whose post-backoff is
 * due). A claimed row is marked by post_attempts + a fresh next_attempt_at
 * (TTL) so a crashed pass re-claims after POST_CLAIM_TTL_MS.
 * Drafts never scheduled (post_at NULL) are NOT auto-posted.
 */
function claimDueScheduledPosts(nowMs, limit = 20) {
  const claim = db.transaction(() => {
    const candidates = db
      .prepare(
        `SELECT * FROM events
         WHERE status = 'draft' AND post_at IS NOT NULL
           AND COALESCE(next_attempt_at, post_at) <= ?
         ORDER BY COALESCE(next_attempt_at, post_at) ASC, id ASC
         LIMIT ?`,
      )
      .all(nowMs, limit);
    const won = [];
    for (const row of candidates) {
      const info = db
        .prepare(
          `UPDATE events SET next_attempt_at = ?, updated_at = ?
           WHERE id = ? AND status = 'draft' AND post_at IS NOT NULL
             AND COALESCE(next_attempt_at, post_at) <= ?`,
        )
        .run(nowMs + POST_CLAIM_TTL_MS, nowMs, row.id, nowMs);
      if (info.changes === 1) won.push(row);
    }
    return won;
  });
  return claim.immediate();
}

/** Record a failed post attempt; at MAX_POST_ATTEMPTS the draft carries last_post_error. */
function recordEventPostFailure(eventId, errorText, nowMs = now()) {
  const row = db.prepare(`SELECT post_attempts FROM events WHERE id = ?`).get(eventId);
  if (!row) return null;
  const attempts = row.post_attempts + 1;
  const failed = attempts >= MAX_POST_ATTEMPTS;
  const backoff = failed ? null : nowMs + Math.min(60_000 * 2 ** (attempts - 1), 6 * 3_600_000);
  db.prepare(
    `UPDATE events
     SET post_attempts = ?, next_attempt_at = ?, last_post_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(attempts, backoff, String(errorText || "").slice(0, 500), nowMs, eventId);
  return { attempts, failed, nextAttemptAt: backoff };
}

/** Delete an event and every child row (child-first, one transaction). */
function deleteEventCascade(eventId) {
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM event_signups WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM event_notifications WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM event_mutes WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM event_activity WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM event_crosspost_messages WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM event_options WHERE event_id = ?`).run(eventId);
    const info = db.prepare(`DELETE FROM events WHERE id = ?`).run(eventId);
    return info.changes > 0;
  });
  return { ok: true, deleted: run() };
}

/**
 * Abandoned drafts older than the TTL: /event create previews
 * (`pending_confirm`) AND duplicate/adopt/series drafts (`draft` with no
 * post time). A draft WITH a post_at was adopted deliberately (a schedule
 * was set) — it is never treated as abandoned (#454: docs promise "drafts
 * never posted are cleaned up after 24 h", so ALL abandonables must sweep).
 */
function listExpiredDrafts(nowMs, ageMs = 24 * 3_600_000) {
  return db
    .prepare(
      `SELECT * FROM events
       WHERE (status = 'pending_confirm'
              OR (status = 'draft' AND post_at IS NULL))
         AND created_at < ?
       ORDER BY id ASC LIMIT 50`,
    )
    .all(nowMs - ageMs);
}

/**
 * Posted events past their auto-archive deadline whose guild enabled the
 * feature (E8: default off, default delay two hours after end/start).
 */
function listEventsToAutoArchive(nowMs) {
  return db
    .prepare(
      `SELECT e.* FROM events e
       JOIN event_guild_settings s ON s.community_id = e.community_id
       WHERE e.status = 'posted' AND s.auto_archive = 1
         AND COALESCE(e.end_at, e.start_at) + s.auto_archive_delay_minutes * 60000 <= ?
       ORDER BY e.id ASC LIMIT 50`,
    )
    .all(nowMs);
}

// ── options ─────────────────────────────────────────────────────────────────

function listEventOptions(eventId) {
  return db
    .prepare(
      `SELECT * FROM event_options WHERE event_id = ? ORDER BY position ASC, id ASC`,
    )
    .all(eventId)
    .map((o) => ({ ...o, role_whitelist: fromJsonArray(o.role_whitelist) }));
}

function getEventOptionById(optionId) {
  const row = db.prepare(`SELECT * FROM event_options WHERE id = ?`).get(optionId);
  return row ? { ...row, role_whitelist: fromJsonArray(row.role_whitelist) } : null;
}

function countEventOptions(eventId) {
  return db
    .prepare(`SELECT COUNT(*) AS c FROM event_options WHERE event_id = ?`)
    .get(eventId).c;
}

const OPTION_PATCH_COLUMNS = new Set([
  "label",
  "emoji",
  "position",
  "capacity",
  "waitlist_on",
  "reminders_on",
  "role_whitelist",
]);

/**
 * #399 (B2-7): retention primitive — event_activity rows created strictly
 * before `cutoffMs`, LIMIT-bounded. The event's own audit feed; events are
 * archived, not deleted, so without this the table only ever grows.
 * Indexed by idx_event_activity_created (053).
 * @param {number} cutoffMs
 * @param {number} limit
 * @returns {number}
 */
function deleteEventActivityOlderThan(cutoffMs, limit) {
  return db
    .prepare(`DELETE FROM event_activity WHERE created_at < ? LIMIT ?`)
    .run(cutoffMs, Math.max(1, Math.floor(Number(limit) || 1))).changes;
}

/**
 * #399 (B2-7): retention primitive — SETTLED reminder rows (sent/retired)
 * whose fire_at is strictly older than `cutoffMs`, LIMIT-bounded. Pending/
 * sending/backoff rows are NEVER touched: only terminals die, and only
 * long after their fire time. Indexed by idx_event_notifications_settled
 * (053) — (status, fire_at); the due ticker's index leads next_attempt_at
 * and would scan every sent row per sweep.
 * @param {number} cutoffMs
 * @param {number} limit
 * @returns {number}
 */
function deleteEventNotificationsOlderThan(cutoffMs, limit) {
  return db
    .prepare(
      `DELETE FROM event_notifications
       WHERE status IN ('sent', 'retired') AND fire_at < ?
       LIMIT ?`,
    )
    .run(cutoffMs, Math.max(1, Math.floor(Number(limit) || 1))).changes;
}

function createEventOption(eventId, opt = {}) {
  // #400 (B2-8): the cap check and the insert commit as ONE transaction —
  // outside it the count was a check-then-act race (two adds both saw n-1,
  // both inserted past the cap). One writer connection makes the txn the
  // honest serialization point.
  const run = db.transaction(() => {
    if (countEventOptions(eventId) >= MAX_OPTIONS_PER_EVENT) {
      return { ok: false, error: `At most ${MAX_OPTIONS_PER_EVENT} options per event.` };
    }
    const info = db
      .prepare(
        `INSERT INTO event_options
           (event_id, label, emoji, position, capacity, waitlist_on, reminders_on, role_whitelist)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        String(opt.label ?? "").trim(),
        opt.emoji ?? null,
        Number.isFinite(opt.position)
          ? opt.position
          : countEventOptions(eventId),
        Math.max(0, Math.trunc(Number(opt.capacity) || 0)),
        bool(opt.waitlist_on !== false),
        bool(Boolean(opt.reminders_on)),
        toJsonArray(opt.role_whitelist),
      );
    return { ok: true, option: getEventOptionById(info.lastInsertRowid) };
  });
  try {
    return run();
  } catch (err) {
    return { ok: false, error: `database error: ${err?.message || err}` };
  }
}

function updateEventOption(optionId, patch = {}) {
  const sets = [];
  const params = [];
  for (const [key, raw] of Object.entries(patch)) {
    if (!OPTION_PATCH_COLUMNS.has(key) || raw === undefined) continue;
    if (key === "role_whitelist") params.push(toJsonArray(raw));
    else if (key === "waitlist_on" || key === "reminders_on") params.push(bool(Boolean(raw)));
    else if (key === "capacity") params.push(Math.max(0, Math.trunc(Number(raw) || 0)));
    else if (key === "position") params.push(Math.trunc(Number(raw) || 0));
    else params.push(raw);
    sets.push(`${key} = ?`);
  }
  if (!sets.length) return { ok: true, option: getEventOptionById(optionId) };
  params.push(optionId);
  db.prepare(`UPDATE event_options SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return { ok: true, option: getEventOptionById(optionId) };
}

/** Remove an option and its signups (waitlist rows included). */
function deleteEventOption(optionId) {
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM event_signups WHERE option_id = ?`).run(optionId);
    return db.prepare(`DELETE FROM event_options WHERE id = ?`).run(optionId).changes > 0;
  });
  return { ok: true, deleted: run() };
}

/**
 * #400 (B2-8): replace EVERY option of an event atomically — deletes and
 * inserts commit as one unit. The feature-layer loop this replaces committed
 * each delete on its own, so a mid-swap failure left a published event with
 * ZERO options while its message kept pointing at dead option ids. The cap
 * lives inside the same transaction (checked before any delete — a refusal
 * changes nothing). Signups of removed options cascade away exactly as
 * deleteEventOption always did; only the ATOMICITY is new.
 * Positions are assigned 1..n in spec order.
 *
 * @param {number} eventId
 * @param {Array<object>} specs createEventOption-shaped specs
 * @returns {{ok: true, options: object[]}|{ok: false, error: string}}
 */
function replaceEventOptions(eventId, specs = []) {
  const run = db.transaction(() => {
    if (!Array.isArray(specs) || specs.length > MAX_OPTIONS_PER_EVENT) {
      return { ok: false, error: `At most ${MAX_OPTIONS_PER_EVENT} options per event.` };
    }
    for (const row of db
      .prepare(`SELECT id FROM event_options WHERE event_id = ?`)
      .all(eventId)) {
      db.prepare(`DELETE FROM event_signups WHERE option_id = ?`).run(row.id);
      db.prepare(`DELETE FROM event_options WHERE id = ?`).run(row.id);
    }
    let pos = 1;
    for (const spec of specs) {
      const info = db
        .prepare(
          `INSERT INTO event_options
             (event_id, label, emoji, position, capacity, waitlist_on, reminders_on, role_whitelist)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          String(spec?.label ?? "").trim(),
          spec?.emoji ?? null,
          pos++,
          Math.max(0, Math.trunc(Number(spec?.capacity) || 0)),
          bool(spec?.waitlist_on !== false),
          bool(Boolean(spec?.reminders_on)),
          toJsonArray(spec?.role_whitelist),
        );
      void info;
    }
    return { ok: true, options: listEventOptions(eventId) };
  });
  try {
    return run();
  } catch (err) {
    return { ok: false, error: `database error: ${err?.message || err}` };
  }
}

/** Reorder by the given id sequence; ids not listed keep their tail order. */
function reorderEventOptions(eventId, orderedIds = []) {
  const run = db.transaction(() => {
    let pos = 0;
    for (const id of orderedIds) {
      db.prepare(
        `UPDATE event_options SET position = ? WHERE id = ? AND event_id = ?`,
      ).run(pos++, id, eventId);
    }
    const listed = new Set(orderedIds.map(Number));
    for (const row of listEventOptions(eventId)) {
      if (!listed.has(row.id)) {
        db.prepare(`UPDATE event_options SET position = ? WHERE id = ?`).run(pos++, row.id);
      }
    }
  });
  run();
  return listEventOptions(eventId);
}

// ── signups ─────────────────────────────────────────────────────────────────

function getSignup(eventId, optionId, userId) {
  return (
    db
      .prepare(
        `SELECT * FROM event_signups WHERE event_id = ? AND option_id = ? AND user_id = ?`,
      )
      .get(eventId, optionId, String(userId)) || null
  );
}

function listUserSignups(eventId, userId) {
  return db
    .prepare(
      `SELECT * FROM event_signups WHERE event_id = ? AND user_id = ? ORDER BY id ASC`,
    )
    .all(eventId, String(userId));
}

function listEventSignups(eventId, { state = null, optionId = null, limit = 500 } = {}) {
  const clauses = [`s.event_id = ?`];
  const params = [eventId];
  if (state) {
    clauses.push(`s.state = ?`);
    params.push(state);
  }
  if (optionId != null) {
    clauses.push(`s.option_id = ?`);
    params.push(optionId);
  }
  params.push(limit);
  return db
    .prepare(
      `SELECT s.*, o.label AS option_label FROM event_signups s
       JOIN event_options o ON o.id = s.option_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY s.id ASC LIMIT ?`,
    )
    .all(...params);
}

/** Per-option counts: { optionId: { signedUp, waitlisted } }. */
function countEventSignups(eventId) {
  const rows = db
    .prepare(
      `SELECT option_id, state, COUNT(*) AS c FROM event_signups
       WHERE event_id = ? GROUP BY option_id, state`,
    )
    .all(eventId);
  const out = {};
  for (const r of rows) {
    out[r.option_id] = out[r.option_id] || { signedUp: 0, waitlisted: 0 };
    if (r.state === "signed_up") out[r.option_id].signedUp = r.c;
    else out[r.option_id].waitlisted = r.c;
  }
  return out;
}

/** user_ids holding a signed_up row on a reminders-on option (E6 "attending"). */
function listAttendingUserIds(eventId) {
  return db
    .prepare(
      `SELECT DISTINCT s.user_id FROM event_signups s
       JOIN event_options o ON o.id = s.option_id
       WHERE s.event_id = ? AND s.state = 'signed_up' AND o.reminders_on = 1`,
    )
    .all(eventId)
    .map((r) => r.user_id);
}

/**
 * Attendee role ids the user still qualifies for (phase-3 refcount):
 * signed_up on a reminders-on option of a posted, not-yet-ended event.
 */
function listEventRoleIdsUserStillHolds(communityId, userId) {
  assertCommunityId(communityId);
  return db
    .prepare(
      `SELECT DISTINCT COALESCE(e.attendee_role_existing, e.attendee_role_id) AS role_id
       FROM event_signups s
       JOIN event_options o ON o.id = s.option_id
       JOIN events e ON e.id = s.event_id
       WHERE e.community_id = ? AND s.user_id = ? AND s.state = 'signed_up'
         AND o.reminders_on = 1 AND e.status = 'posted'
         AND (e.end_at IS NULL OR e.end_at >= ?)
         AND COALESCE(e.attendee_role_existing, e.attendee_role_id) IS NOT NULL`,
    )
    .all(communityId, String(userId), now())
    .map((r) => r.role_id);
}

/**
 * Atomic signup mutation. The capacity check + insert share one immediate
 * transaction so two members racing the last slot cannot oversell.
 *
 * Semantics (phase 1 contract):
 *  - tapping the option you already hold → withdraw that row;
 *  - multiple_signups off → other held options are replaced;
 *  - option full → 'waitlisted' when the option allows it, else error;
 *  - any slot freed by this mutation promotes the oldest waiter.
 *
 * @returns {{ ok: true, result: 'signed_up'|'waitlisted'|'removed',
 *             promoted: Array<{optionId:number, userId:string}>, position?: number,
 *             removedSignedUpUserIds: string[] }
 *           |{ ok: false, error: string, code?: string }}
 */
function applySignupChoice({ eventId, optionId, userId, actorId = null, allowMultiple = false }) {
  userId = String(userId);
  const run = db.transaction(() => {
    const option = db.prepare(`SELECT * FROM event_options WHERE id = ?`).get(optionId);
    if (!option || option.event_id !== eventId) {
      return { ok: false, error: "That signup option is not part of this event." };
    }
    const mine = db
      .prepare(`SELECT * FROM event_signups WHERE event_id = ? AND user_id = ?`)
      .all(eventId, userId);
    const same = mine.find((s) => s.option_id === optionId);
    const freedOptionIds = new Set();
    if (same) {
      db.prepare(`DELETE FROM event_signups WHERE id = ?`).run(same.id);
      if (same.state === "signed_up") freedOptionIds.add(optionId);
    } else {
      if (!allowMultiple) {
        for (const other of mine) {
          db.prepare(`DELETE FROM event_signups WHERE id = ?`).run(other.id);
          if (other.state === "signed_up") freedOptionIds.add(other.option_id);
        }
      }
      const signed = db
        .prepare(
          `SELECT COUNT(*) AS c FROM event_signups
           WHERE option_id = ? AND state = 'signed_up'`,
        )
        .get(optionId).c;
      if (option.capacity > 0 && signed >= option.capacity) {
        if (!option.waitlist_on) {
          return {
            ok: false,
            code: "FULL",
            error: `**${option.label}** is full and its waitlist is off.`,
          };
        }
        const wl = db
          .prepare(
            `SELECT COUNT(*) AS c FROM event_signups
             WHERE option_id = ? AND state = 'waitlisted'`,
          )
          .get(optionId).c;
        db.prepare(
          `INSERT INTO event_signups (event_id, option_id, user_id, state, created_at, updated_by)
           VALUES (?, ?, ?, 'waitlisted', ?, ?)`,
        ).run(eventId, optionId, userId, now(), actorId ? String(actorId) : null);
        return {
          ok: true,
          result: "waitlisted",
          position: wl + 1,
          promoted: promoteFreed(freedOptionIds, eventId),
          removedSignedUpUserIds: [],
        };
      }
      db.prepare(
        `INSERT INTO event_signups (event_id, option_id, user_id, state, created_at, updated_by)
         VALUES (?, ?, ?, 'signed_up', ?, ?)`,
      ).run(eventId, optionId, userId, now(), actorId ? String(actorId) : null);
    }
    return {
      ok: true,
      result: same ? "removed" : "signed_up",
      promoted: promoteFreed(freedOptionIds, eventId),
      removedSignedUpUserIds: same && same.state === "signed_up" ? [userId] : [],
    };
  });

  /** Promote one waiter per option whose signed_up count dropped. */
  function promoteFreed(optionIds, evId) {
    const promoted = [];
    for (const optId of optionIds) {
      const opt = db.prepare(`SELECT * FROM event_options WHERE id = ?`).get(optId);
      if (!opt) continue;
      if (opt.capacity > 0) {
        const signed = db
          .prepare(
            `SELECT COUNT(*) AS c FROM event_signups
             WHERE option_id = ? AND state = 'signed_up'`,
          )
          .get(optId).c;
        if (signed >= opt.capacity) continue;
      }
      const waiter = db
        .prepare(
          `SELECT * FROM event_signups
           WHERE option_id = ? AND state = 'waitlisted' ORDER BY id ASC LIMIT 1`,
        )
        .get(optId);
      if (!waiter) continue;
      db.prepare(
        `UPDATE event_signups SET state = 'signed_up', updated_by = 'waitlist-promotion', created_at = ?
         WHERE id = ?`,
      ).run(now(), waiter.id);
      promoted.push({ optionId: optId, userId: waiter.user_id, eventId: evId });
    }
    return promoted;
  }

  try {
    return run.immediate();
  } catch (err) {
    return { ok: false, error: `database error: ${err?.message || err}` };
  }
}

/** Organizer/staff removal of one row, with the same waitlist promotion. */
function removeSignupRow({ eventId, optionId, userId, actorId = null }) {
  const run = db.transaction(() => {
    const row = getSignup(eventId, optionId, userId);
    if (!row) return { ok: false, error: "That member is not on that option." };
    db.prepare(`DELETE FROM event_signups WHERE id = ?`).run(row.id);
    if (row.state !== "signed_up") {
      return { ok: true, result: "removed_waitlisted", promoted: [] };
    }
    const promoted = [];
    const opt = db.prepare(`SELECT * FROM event_options WHERE id = ?`).get(optionId);
    if (opt) {
      const signed = db
        .prepare(
          `SELECT COUNT(*) AS c FROM event_signups WHERE option_id = ? AND state = 'signed_up'`,
        )
        .get(optionId).c;
      const room = !(opt.capacity > 0 && signed >= opt.capacity);
      if (room) {
        const waiter = db
          .prepare(
            `SELECT * FROM event_signups
             WHERE option_id = ? AND state = 'waitlisted' ORDER BY id ASC LIMIT 1`,
          )
          .get(optionId);
        if (waiter) {
          db.prepare(
            `UPDATE event_signups SET state = 'signed_up', updated_by = ?, created_at = ?
             WHERE id = ?`,
          ).run(String(actorId || "organizer"), now(), waiter.id);
          promoted.push({ optionId, userId: waiter.user_id, eventId });
        }
      }
    }
    return { ok: true, result: "removed", promoted };
  });
  try {
    return run.immediate();
  } catch (err) {
    return { ok: false, error: `database error: ${err?.message || err}` };
  }
}

/** Direct organizer add (bypasses capacity/whitelist per E5): force signed_up. */
function forceSignup({ eventId, optionId, userId, actorId }) {
  try {
    const run = db.transaction(() => {
      const option = db.prepare(`SELECT * FROM event_options WHERE id = ?`).get(optionId);
      if (!option || option.event_id !== eventId) return { ok: false, error: "Option not on this event." };
      const existing = getSignup(eventId, optionId, userId);
      if (existing) {
        db.prepare(
          `UPDATE event_signups SET state = 'signed_up', updated_by = ? WHERE id = ?`,
        ).run(String(actorId), existing.id);
        return { ok: true, already: Boolean(existing) };
      }
      db.prepare(
        `INSERT INTO event_signups (event_id, option_id, user_id, state, created_at, updated_by)
         VALUES (?, ?, ?, 'signed_up', ?, ?)`,
      ).run(eventId, optionId, String(userId), now(), String(actorId));
      return { ok: true, already: false };
    });
    return run.immediate();
  } catch (err) {
    return { ok: false, error: `database error: ${err?.message || err}` };
  }
}

/** All events where the user currently holds any signup (for status replies). */
function listUserEventsAcrossCommunity(communityId, userId) {
  assertCommunityId(communityId);
  return db
    .prepare(
      `SELECT e.id AS event_id, e.title, e.start_at, e.status, o.label AS option_label, s.state
       FROM event_signups s
       JOIN events e ON e.id = s.event_id
       JOIN event_options o ON o.id = s.option_id
       WHERE e.community_id = ? AND s.user_id = ?
         AND e.status IN ('posted','draft')
         AND (e.end_at IS NULL OR e.end_at >= ?)
       ORDER BY e.start_at ASC`,
    )
    .all(communityId, String(userId), now());
}

// ── reminder rows (claim state machine mirrors feature 2 / migration 038) ───

/**
 * Arm reminder rows for an event. rows: [{ offsetMinutes, fireAt, message?,
 * target?, roleId? }]. fireAt is absolute ms.
 */
function createEventReminders(eventId, rows = []) {
  try {
    const existing = db
      .prepare(
        `SELECT COUNT(*) AS c FROM event_notifications WHERE event_id = ? AND status IN ('pending','sending')`,
      )
      .get(eventId).c;
    if (existing + rows.length > MAX_REMINDERS_PER_EVENT) {
      return {
        ok: false,
        error: `At most ${MAX_REMINDERS_PER_EVENT} reminders per event (${existing} already armed).`,
      };
    }
    const insert = db.prepare(
      `INSERT INTO event_notifications (event_id, offset_minutes, fire_at, message, target, role_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const run = db.transaction(() => {
      for (const r of rows) {
        insert.run(
          eventId,
          Math.trunc(r.offsetMinutes),
          Math.trunc(r.fireAt),
          r.message ?? null,
          r.target === "role" ? "role" : "attendees",
          r.roleId ?? null,
        );
      }
    });
    run();
    return { ok: true, reminders: listEventReminders(eventId) };
  } catch (err) {
    return { ok: false, error: `database error: ${err?.message || err}` };
  }
}

function listEventReminders(eventId, { unsentOnly = false } = {}) {
  return db
    .prepare(
      `SELECT * FROM event_notifications WHERE event_id = ? ${
        unsentOnly ? `AND status IN ('pending','sending')` : ""
      } ORDER BY fire_at ASC, id ASC`,
    )
    .all(eventId);
}

function getEventReminderById(id) {
  return db.prepare(`SELECT * FROM event_notifications WHERE id = ?`).get(id) || null;
}

/** Delete unsent reminders (returns count removed). */
function deleteEventReminder(id) {
  return (
    db
      .prepare(`DELETE FROM event_notifications WHERE id = ? AND status = 'pending'`)
      .run(id).changes > 0
  );
}

/**
 * E14: start time moved → unsent fire times move with it (each row keeps
 * its own offset; stale backoff is discarded so a moved reminder re-fires
 * on the new schedule).
 */
function rescheduleUnsentEventReminders(eventId, startMs) {
  const rows = db
    .prepare(
      `SELECT id, offset_minutes FROM event_notifications
       WHERE event_id = ? AND sent_at IS NULL AND status IN ('pending','sending')`,
    )
    .all(eventId);
  const upd = db.prepare(
    `UPDATE event_notifications SET fire_at = ?, next_attempt_at = NULL WHERE id = ?`,
  );
  const run = db.transaction(() => {
    for (const r of rows) upd.run(startMs - r.offset_minutes * 60_000, r.id);
  });
  run();
  return rows.length;
}

/** Move pending rows out of the way / stop them: retire every unsent row. */
function retireAllUnsentEventReminders(eventId, reason) {
  return db
    .prepare(
      `UPDATE event_notifications
       SET status = 'retired', last_error = ?, next_attempt_at = NULL, claimed_at = NULL
       WHERE event_id = ? AND status IN ('pending','sending')`,
    )
    .run(String(reason || "").slice(0, 500), eventId).changes;
}

/**
 * Claim due rows — the SAME contract as feature 2's claimDueReminders
 * (migration 038): pending rows whose backoff-gated due time passed, plus
 * sending rows whose claim went stale (crash window). Only rows won by the
 * CAS are returned; every claimed row must resolve to sent/retired/retry.
 */
function claimDueEventReminders(nowMs, limit = 50) {
  const claim = db.transaction(() => {
    const candidates = db
      .prepare(
        `SELECT * FROM event_notifications
         WHERE (status = 'pending' AND COALESCE(next_attempt_at, fire_at) <= ?)
            OR (status = 'sending' AND claimed_at < ?)
         ORDER BY COALESCE(next_attempt_at, fire_at) ASC, id ASC
         LIMIT ?`,
      )
      .all(nowMs, nowMs - EVENT_REMINDER_CLAIM_TTL_MS, limit);
    const won = [];
    for (const row of candidates) {
      const info = db
        .prepare(
          `UPDATE event_notifications
           SET status = 'sending', claimed_at = ?
           WHERE id = ? AND (
             (status = 'pending' AND COALESCE(next_attempt_at, fire_at) <= ?)
             OR (status = 'sending' AND claimed_at < ?)
           )`,
        )
        .run(nowMs, row.id, nowMs, nowMs - EVENT_REMINDER_CLAIM_TTL_MS);
      if (info.changes === 1) won.push(row);
    }
    return won;
  });
  return claim.immediate();
}

/** SENT (CAS on sending). Returns whether the write was won. */
function markEventReminderSent(id, messageId, nowMs = now()) {
  const info = db
    .prepare(
      `UPDATE event_notifications
       SET status = 'sent', sent_at = ?, message_id = ?, last_error = NULL,
           claimed_at = NULL, next_attempt_at = NULL
       WHERE id = ? AND status = 'sending'`,
    )
    .run(nowMs, messageId ? String(messageId) : null, id);
  return { won: info.changes === 1 };
}

/** Permanent stop (channel gone, event deleted, muted audience empty…). */
function retireEventReminder(id, reason) {
  db.prepare(
    `UPDATE event_notifications
     SET status = 'retired', last_error = ?, claimed_at = NULL, next_attempt_at = NULL
     WHERE id = ?`,
  ).run(String(reason || "").slice(0, 500), id);
  return true;
}

/** TRANSIENT: bump attempts, back off; terminal 'failed' at the cap. */
function markEventReminderRetry(id, reason, nowMs = now()) {
  const row = db.prepare(`SELECT * FROM event_notifications WHERE id = ?`).get(id);
  if (!row) return null;
  const attempts = row.attempts + 1;
  if (attempts >= MAX_EVENT_REMINDER_ATTEMPTS) {
    db.prepare(
      `UPDATE event_notifications
       SET status = 'failed', attempts = ?, last_error = ?, claimed_at = NULL, next_attempt_at = NULL
       WHERE id = ?`,
    ).run(attempts, String(reason || "").slice(0, 500), id);
    return { attempts, terminal: true, nextAttemptAt: null };
  }
  const nextAt =
    nowMs + eventReminderRetryDelayMs(attempts, row.fire_at, nowMs);
  db.prepare(
    `UPDATE event_notifications
     SET status = 'pending', attempts = ?, next_attempt_at = ?, last_error = ?, claimed_at = NULL
     WHERE id = ?`,
  ).run(attempts, nextAt, String(reason || "").slice(0, 500), id);
  return { attempts, terminal: false, nextAttemptAt: nextAt };
}

/** Due digest settings (the tick decides daily/weekly windows in JS). */
function listDigestSettings() {
  return db
    .prepare(
      `SELECT * FROM event_guild_settings
       WHERE digest_frequency != 'none' AND digest_channel_id IS NOT NULL`,
    )
    .all();
}

function setEventDigestLastSent(communityId, nowMs = now()) {
  assertCommunityId(communityId);
  db.prepare(
    `UPDATE event_guild_settings SET digest_last_sent_at = ?, updated_at = ? WHERE community_id = ?`,
  ).run(nowMs, nowMs, communityId);
}

// ── mutes (per-event, keyed by OUR event id) ───────────────────────────────

function setEventMute(communityId, eventId, userId) {
  assertCommunityId(communityId);
  db.prepare(
    `INSERT INTO event_mutes (community_id, event_id, user_id, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (community_id, event_id, user_id) DO NOTHING`,
  ).run(communityId, eventId, String(userId), now());
  return true;
}

function clearEventMute(communityId, eventId, userId) {
  assertCommunityId(communityId);
  return (
    db
      .prepare(
        `DELETE FROM event_mutes WHERE community_id = ? AND event_id = ? AND user_id = ?`,
      )
      .run(communityId, eventId, String(userId)).changes > 0
  );
}

function isEventMuted(communityId, eventId, userId) {
  assertCommunityId(communityId);
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM event_mutes WHERE community_id = ? AND event_id = ? AND user_id = ?`,
      )
      .get(communityId, eventId, String(userId)),
  );
}

function listEventMutes(communityId, eventId = null) {
  assertCommunityId(communityId);
  if (eventId == null) {
    return db
      .prepare(`SELECT * FROM event_mutes WHERE community_id = ?`)
      .all(communityId);
  }
  return db
    .prepare(`SELECT * FROM event_mutes WHERE community_id = ? AND event_id = ?`)
    .all(communityId, eventId);
}

function clearEventMutesForEvent(communityId, eventId) {
  assertCommunityId(communityId);
  return db.prepare(`DELETE FROM event_mutes WHERE community_id = ? AND event_id = ?`).run(
    communityId,
    eventId,
  ).changes;
}

// ── activity ────────────────────────────────────────────────────────────────

function logEventActivity({ eventId, actorId = null, action, detail = null }) {
  db.prepare(
    `INSERT INTO event_activity (event_id, actor_id, action, detail, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(eventId, actorId ? String(actorId) : null, String(action), detail ? String(detail).slice(0, 500) : null, now());
}

function listEventActivity(eventId, limit = 50) {
  return db
    .prepare(
      `SELECT * FROM event_activity WHERE event_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(eventId, Math.min(Math.max(1, limit), 200));
}

// ── series ──────────────────────────────────────────────────────────────────

const SERIES_PATCH_COLUMNS = new Set([
  "cadence",
  "weekdays",
  "month_day",
  "time_of_day_min",
  "end_mode",
  "end_count",
  "end_at",
  "next_occurrence_at",
  "occurrences_created",
  "status",
  "stopped_at",
]);

function createEventSeries({
  communityId,
  templateEventId,
  cadence,
  weekdays = [],
  monthDay = null,
  timeOfDayMin,
  endMode = "never",
  endCount = null,
  endAt = null,
  nextOccurrenceAt = null,
  createdBy,
}) {
  try {
    assertCommunityId(communityId);
    if (!["daily", "weekly", "monthly"].includes(cadence)) {
      return { ok: false, error: "Cadence must be daily, weekly, or monthly." };
    }
    if (cadence === "weekly" && (!Array.isArray(weekdays) || weekdays.length === 0)) {
      return { ok: false, error: "Weekly series need at least one weekday (0=Sun…6=Sat)." };
    }
    if (cadence === "monthly" && (!Number.isFinite(monthDay) || monthDay < 1 || monthDay > 31)) {
      return { ok: false, error: "Monthly series need a month day between 1 and 31." };
    }
    if (!["never", "count", "until"].includes(endMode)) {
      return { ok: false, error: "End mode must be never, count, or until." };
    }
    const info = db
      .prepare(
        `INSERT INTO event_series
           (community_id, template_event_id, cadence, weekdays, month_day, time_of_day_min,
            end_mode, end_count, end_at, next_occurrence_at, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        communityId,
        templateEventId,
        cadence,
        JSON.stringify((weekdays || []).map(Number)),
        monthDay ?? null,
        Math.trunc(timeOfDayMin),
        endMode,
        endCount == null ? null : Math.trunc(Number(endCount)),
        endAt == null ? null : Math.trunc(Number(endAt)),
        nextOccurrenceAt == null ? null : Math.trunc(Number(nextOccurrenceAt)),
        String(createdBy),
        now(),
      );
    return { ok: true, series: getEventSeries(info.lastInsertRowid) };
  } catch (err) {
    return { ok: false, error: `database error: ${err?.message || err}` };
  }
}

function getEventSeries(seriesId) {
  const row = db.prepare(`SELECT * FROM event_series WHERE id = ?`).get(seriesId);
  if (!row) return null;
  let weekdays = [];
  try {
    weekdays = JSON.parse(row.weekdays || "[]");
  } catch {
    weekdays = [];
  }
  return { ...row, weekdays };
}

function getEventSeriesForCommunity(seriesId, communityId) {
  assertCommunityId(communityId);
  const row = getEventSeries(seriesId);
  return row && row.community_id === communityId ? row : null;
}

function listEventSeries(communityId, { activeOnly = false } = {}) {
  assertCommunityId(communityId);
  return db
    .prepare(
      `SELECT * FROM event_series WHERE community_id = ? ${
        activeOnly ? `AND status = 'active'` : ""
      } ORDER BY created_at DESC, id DESC`,
    )
    .all(communityId)
    .map((row) => {
      let weekdays = [];
      try {
        weekdays = JSON.parse(row.weekdays || "[]");
      } catch {
        weekdays = [];
      }
      return { ...row, weekdays };
    });
}

function updateEventSeries(seriesId, patch = {}) {
  const sets = [];
  const params = [];
  for (const [key, raw] of Object.entries(patch)) {
    if (!SERIES_PATCH_COLUMNS.has(key) || raw === undefined) continue;
    if (key === "weekdays") params.push(JSON.stringify((raw || []).map(Number)));
    else params.push(raw);
    sets.push(`${key} = ?`);
  }
  if (!sets.length) return getEventSeries(seriesId);
  params.push(seriesId);
  db.prepare(`UPDATE event_series SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getEventSeries(seriesId);
}

function stopEventSeries(seriesId) {
  db.prepare(
    `UPDATE event_series SET status = 'stopped', stopped_at = ? WHERE id = ?`,
  ).run(now(), seriesId);
  return getEventSeries(seriesId);
}

/**
 * Dissolve a series: unposted (draft/skipped) occurrences are deleted,
 * posted/archived ones survive as one-off events (series_id cleared).
 */
function dissolveEventSeries(seriesId) {
  const run = db.transaction(() => {
    const drafts = db
      .prepare(
        `SELECT id FROM events WHERE series_id = ? AND status IN ('draft','skipped')`,
      )
      .all(seriesId);
    for (const d of drafts) deleteEventCascade(d.id);
    db.prepare(
      `UPDATE events SET series_id = NULL WHERE series_id = ?`,
    ).run(seriesId);
    db.prepare(`UPDATE event_series SET status = 'stopped', stopped_at = ? WHERE id = ?`).run(
      now(),
      seriesId,
    );
    return db.prepare(`DELETE FROM event_series WHERE id = ?`).run(seriesId).changes > 0;
  });
  return { ok: true, deleted: run() };
}

/** Active series whose cursor is due. */
function listDueEventSeries(nowMs, limit = 20) {
  return db
    .prepare(
      `SELECT * FROM event_series
       WHERE status = 'active' AND next_occurrence_at IS NOT NULL AND next_occurrence_at <= ?
       ORDER BY next_occurrence_at ASC LIMIT ?`,
    )
    .all(nowMs, limit)
    .map((row) => {
      let weekdays = [];
      try {
        weekdays = JSON.parse(row.weekdays || "[]");
      } catch {
        weekdays = [];
      }
      return { ...row, weekdays };
    });
}

// ── presets ─────────────────────────────────────────────────────────────────

function createEventPreset(communityId, name, options = [], createdBy = null) {
  try {
    assertCommunityId(communityId);
    const clean = String(name || "").trim();
    if (!clean) return { ok: false, error: "A preset name is required." };
    if (!options.length) return { ok: false, error: "A preset needs at least one option." };
    const count = db
      .prepare(
        `SELECT COUNT(*) AS c FROM event_presets WHERE community_id = ?`,
      )
      .get(communityId).c;
    if (count >= MAX_PRESETS_PER_COMMUNITY) {
      return { ok: false, error: `At most ${MAX_PRESETS_PER_COMMUNITY} presets per server.` };
    }
    const dup = db
      .prepare(`SELECT id FROM event_presets WHERE community_id = ? AND name = ?`)
      .get(communityId, clean);
    if (dup) return { ok: false, error: `A preset named **${clean}** already exists.` };
    const run = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO event_presets (community_id, name, created_by, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(communityId, clean, createdBy ? String(createdBy) : null, now());
      const presetId = info.lastInsertRowid;
      const ins = db.prepare(
        `INSERT INTO event_preset_options
           (preset_id, label, emoji, position, capacity, waitlist_on, reminders_on, role_whitelist)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const [i, o] of options.entries()) {
        ins.run(
          presetId,
          String(o.label).trim(),
          o.emoji ?? null,
          i,
          Math.max(0, Math.trunc(Number(o.capacity) || 0)),
          bool(o.waitlist_on !== false),
          bool(Boolean(o.reminders_on)),
          toJsonArray(o.role_whitelist),
        );
      }
      return presetId;
    });
    return { ok: true, preset: getEventPreset(run()) };
  } catch (err) {
    return { ok: false, error: `database error: ${err?.message || err}` };
  }
}

function attachPresetOptions(preset) {
  return {
    ...preset,
    options: db
      .prepare(
        `SELECT * FROM event_preset_options WHERE preset_id = ? ORDER BY position ASC, id ASC`,
      )
      .all(preset.id)
      .map((o) => ({ ...o, role_whitelist: fromJsonArray(o.role_whitelist) })),
  };
}

function getEventPreset(presetId) {
  const row = db.prepare(`SELECT * FROM event_presets WHERE id = ?`).get(presetId);
  return row ? attachPresetOptions(row) : null;
}

function getEventPresetByName(communityId, name) {
  assertCommunityId(communityId);
  const row = db
    .prepare(`SELECT * FROM event_presets WHERE community_id = ? AND name = ?`)
    .get(communityId, String(name || "").trim());
  return row ? attachPresetOptions(row) : null;
}

function listEventPresets(communityId) {
  assertCommunityId(communityId);
  return db
    .prepare(
      `SELECT * FROM event_presets WHERE community_id = ? ORDER BY name ASC`,
    )
    .all(communityId)
    .map(attachPresetOptions);
}

function deleteEventPreset(presetId) {
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM event_preset_options WHERE preset_id = ?`).run(presetId);
    return db.prepare(`DELETE FROM event_presets WHERE id = ?`).run(presetId).changes > 0;
  });
  return { ok: true, deleted: run() };
}

// ── event channels ──────────────────────────────────────────────────────────

function markEventChannel(communityId, channelId) {
  assertCommunityId(communityId);
  db.prepare(
    `INSERT INTO event_channels (community_id, channel_id, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT (community_id, channel_id) DO NOTHING`,
  ).run(communityId, String(channelId), now());
  return true;
}

function unmarkEventChannel(communityId, channelId) {
  assertCommunityId(communityId);
  return (
    db
      .prepare(
        `DELETE FROM event_channels WHERE community_id = ? AND channel_id = ?`,
      )
      .run(communityId, String(channelId)).changes > 0
  );
}

function isEventChannel(communityId, channelId) {
  assertCommunityId(communityId);
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM event_channels WHERE community_id = ? AND channel_id = ?`,
      )
      .get(communityId, String(channelId)),
  );
}

function listEventChannels(communityId) {
  assertCommunityId(communityId);
  return db
    .prepare(`SELECT * FROM event_channels WHERE community_id = ? ORDER BY created_at ASC`)
    .all(communityId);
}

function setEventChannelPurge(communityId, channelId, purge) {
  assertCommunityId(communityId);
  return (
    db
      .prepare(
        `UPDATE event_channels SET purge = ? WHERE community_id = ? AND channel_id = ?`,
      )
      .run(bool(Boolean(purge)), communityId, String(channelId)).changes > 0
  );
}

// ── DM wizard state ─────────────────────────────────────────────────────────

function getEventWizard(communityId, userId) {
  assertCommunityId(communityId);
  return (
    db
      .prepare(
        `SELECT * FROM event_wizards WHERE community_id = ? AND user_id = ?`,
      )
      .get(communityId, String(userId)) || null
  );
}

function upsertEventWizard(communityId, userId, { step, draft, eventId = null }) {
  assertCommunityId(communityId);
  db.prepare(
    `INSERT INTO event_wizards (community_id, user_id, event_id, step, draft, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (community_id, user_id) DO UPDATE SET
       event_id = excluded.event_id,
       step = excluded.step,
       draft = excluded.draft,
       updated_at = excluded.updated_at`,
  ).run(
    communityId,
    String(userId),
    eventId,
    String(step),
    typeof draft === "string" ? draft : JSON.stringify(draft || {}),
    now(),
    now(),
  );
  return getEventWizard(communityId, userId);
}

function deleteEventWizard(communityId, userId) {
  assertCommunityId(communityId);
  return (
    db
      .prepare(
        `DELETE FROM event_wizards WHERE community_id = ? AND user_id = ?`,
      )
      .run(communityId, String(userId)).changes > 0
  );
}

/** All open wizards for a user (cross-guild; used by the DM dispatcher). */
function listUserOpenWizards(userId) {
  return db
    .prepare(`SELECT * FROM event_wizards WHERE user_id = ? ORDER BY updated_at DESC`)
    .all(String(userId));
}

function deleteStaleEventWizards(nowMs, ageMs = 7 * 24 * 3_600_000) {
  return db
    .prepare(`DELETE FROM event_wizards WHERE updated_at < ?`)
    .run(nowMs - ageMs).changes;
}

// ── Google Calendar links ───────────────────────────────────────────────────

function upsertEventGoogleLink({
  communityId,
  userId,
  email = null,
  calendarId = "primary",
  accessTokenEnc,
  refreshTokenEnc = null,
  expiry = null,
}) {
  assertCommunityId(communityId);
  db.prepare(
    `INSERT INTO event_google_links
       (community_id, user_id, email, calendar_id, access_token_enc, refresh_token_enc,
        expiry, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (community_id, user_id) DO UPDATE SET
       email = excluded.email,
       calendar_id = excluded.calendar_id,
       access_token_enc = excluded.access_token_enc,
       refresh_token_enc = COALESCE(excluded.refresh_token_enc, event_google_links.refresh_token_enc),
       expiry = excluded.expiry,
       enabled = 1,
       updated_at = excluded.updated_at`,
  ).run(
    communityId,
    String(userId),
    email,
    String(calendarId || "primary"),
    accessTokenEnc,
    refreshTokenEnc,
    expiry,
    now(),
    now(),
  );
  return getEventGoogleLink(communityId, userId);
}

function getEventGoogleLink(communityId, userId) {
  assertCommunityId(communityId);
  return (
    db
      .prepare(
        `SELECT * FROM event_google_links WHERE community_id = ? AND user_id = ?`,
      )
      .get(communityId, String(userId)) || null
  );
}

function updateEventGoogleLinkTokens(communityId, userId, { accessTokenEnc, expiry }) {
  assertCommunityId(communityId);
  db.prepare(
    `UPDATE event_google_links SET access_token_enc = ?, expiry = ?, updated_at = ?
     WHERE community_id = ? AND user_id = ?`,
  ).run(accessTokenEnc, expiry, now(), communityId, String(userId));
}

function disableEventGoogleLink(communityId, userId) {
  assertCommunityId(communityId);
  return (
    db
      .prepare(
        `UPDATE event_google_links SET enabled = 0, updated_at = ?
         WHERE community_id = ? AND user_id = ?`,
      )
      .run(now(), communityId, String(userId)).changes > 0
  );
}

function deleteEventGoogleLink(communityId, userId) {
  assertCommunityId(communityId);
  return (
    db
      .prepare(
        `DELETE FROM event_google_links WHERE community_id = ? AND user_id = ?`,
      )
      .run(communityId, String(userId)).changes > 0
  );
}

// ── cross-posts ─────────────────────────────────────────────────────────────

function randomInviteCode() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  const buf = require("node:crypto").randomBytes(8);
  for (const b of buf) out += chars[b % chars.length];
  return out;
}

/**
 * Source guild invites the destination. Re-inviting an existing pair is an
 * update as long as the pair is not already active.
 */
function inviteEventCrosspost({
  sourceCommunityId,
  destCommunityId,
  createdBy,
  mentions = [],
  roleWhitelist = [],
  postOffsetMinutes = 0,
  destChannelId = null,
}) {
  assertCommunityId(sourceCommunityId);
  assertCommunityId(destCommunityId);
  if (sourceCommunityId === destCommunityId) {
    return { ok: false, error: "A guild cannot cross-post to itself." };
  }
  const existing = db
    .prepare(
      `SELECT * FROM event_crossposts WHERE source_community_id = ? AND dest_community_id = ?`,
    )
    .get(sourceCommunityId, destCommunityId);
  if (existing && existing.state === "active") {
    return { ok: false, error: "This destination already approved this source." };
  }
  const code = existing?.state === "pending" ? existing.invite_code : randomInviteCode();
  db.prepare(
    `INSERT INTO event_crossposts
       (source_community_id, dest_community_id, dest_channel_id, state, invite_code,
        mentions, role_whitelist, post_offset_minutes, created_by, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_community_id, dest_community_id) DO UPDATE SET
       dest_channel_id = COALESCE(excluded.dest_channel_id, event_crossposts.dest_channel_id),
       state = 'pending',
       invite_code = excluded.invite_code,
       mentions = excluded.mentions,
       role_whitelist = excluded.role_whitelist,
       post_offset_minutes = excluded.post_offset_minutes,
       created_by = excluded.created_by,
       created_at = excluded.created_at,
       revoked_at = NULL`,
  ).run(
    sourceCommunityId,
    destCommunityId,
    destChannelId,
    code,
    toJsonArray(mentions),
    toJsonArray(roleWhitelist),
    Math.trunc(Number(postOffsetMinutes) || 0),
    String(createdBy),
    now(),
  );
  return { ok: true, crosspost: getEventCrosspostByPair(sourceCommunityId, destCommunityId) };
}

function decorateCrosspost(row) {
  if (!row) return null;
  return {
    ...row,
    mentions: fromJsonArray(row.mentions),
    role_whitelist: fromJsonArray(row.role_whitelist),
  };
}

function getEventCrosspostById(id) {
  return decorateCrosspost(db.prepare(`SELECT * FROM event_crossposts WHERE id = ?`).get(id));
}

function getEventCrosspostByCode(code) {
  if (!code) return null;
  return (
    decorateCrosspost(
      db.prepare(`SELECT * FROM event_crossposts WHERE invite_code = ?`).get(String(code).trim().toLowerCase()),
    ) || null
  );
}

function getEventCrosspostByPair(sourceCommunityId, destCommunityId) {
  return decorateCrosspost(
    db
      .prepare(
        `SELECT * FROM event_crossposts WHERE source_community_id = ? AND dest_community_id = ?`,
      )
      .get(sourceCommunityId, destCommunityId),
  );
}

function approveEventCrosspost(id, { approvedBy, destChannelId }) {
  const info = db
    .prepare(
      `UPDATE event_crossposts
       SET state = 'active', approved_by = ?, approved_at = ?,
           dest_channel_id = COALESCE(?, dest_channel_id)
       WHERE id = ? AND state = 'pending'`,
    )
    .run(
      String(approvedBy),
      now(),
      destChannelId ? String(destChannelId) : null,
      id,
    );
  if (info.changes !== 1) {
    return { ok: false, error: "That invite is no longer pending (approved already, or revoked)." };
  }
  return { ok: true, crosspost: getEventCrosspostById(id) };
}

function revokeEventCrosspost(id) {
  const info = db
    .prepare(
      `UPDATE event_crossposts SET state = 'revoked', revoked_at = ? WHERE id = ? AND state != 'revoked'`,
    )
    .run(now(), id);
  if (info.changes !== 1) return { ok: false, error: "That cross-post is already revoked." };
  return { ok: true, crosspost: getEventCrosspostById(id) };
}

/** Cross-post rows involving this community (either direction). */
function listEventCrosspostsForCommunity(communityId) {
  assertCommunityId(communityId);
  return db
    .prepare(
      `SELECT * FROM event_crossposts
       WHERE source_community_id = ? OR dest_community_id = ?
       ORDER BY created_at DESC`,
    )
    .all(communityId, communityId)
    .map((row) => ({
      ...decorateCrosspost(row),
      direction: row.source_community_id === communityId ? "source" : "destination",
    }));
}

/** Active destinations for one source community (posting fans out to these). */
function listActiveCrosspostsForSource(sourceCommunityId) {
  assertCommunityId(sourceCommunityId);
  return db
    .prepare(
      `SELECT * FROM event_crossposts WHERE source_community_id = ? AND state = 'active'`,
    )
    .all(sourceCommunityId)
    .map(decorateCrosspost);
}

function updateEventCrosspost(id, patch = {}) {
  const sets = [];
  const params = [];
  for (const [key, raw] of Object.entries(patch)) {
    if (key === "mentions" || key === "role_whitelist") params.push(toJsonArray(raw));
    else if (key === "dest_channel_id") params.push(raw ? String(raw) : null);
    else if (key === "post_offset_minutes") params.push(Math.trunc(Number(raw) || 0));
    else continue;
    sets.push(`${key} = ?`);
  }
  if (!sets.length) return getEventCrosspostById(id);
  params.push(id);
  db.prepare(`UPDATE event_crossposts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getEventCrosspostById(id);
}

function recordEventCrosspostMessage({
  crosspostId,
  eventId,
  destCommunityId,
  destChannelId,
  destMessageId,
}) {
  db.prepare(
    `INSERT INTO event_crosspost_messages
       (crosspost_id, event_id, dest_community_id, dest_channel_id, dest_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (crosspost_id, event_id) DO UPDATE SET
       dest_channel_id = excluded.dest_channel_id,
       dest_message_id = excluded.dest_message_id`,
  ).run(crosspostId, eventId, destCommunityId, String(destChannelId), String(destMessageId), now());
  return true;
}

function listEventCrosspostMessagesForEvent(eventId) {
  return db
    .prepare(`SELECT * FROM event_crosspost_messages WHERE event_id = ?`)
    .all(eventId);
}

function deleteEventCrosspostMessagesForEvent(eventId) {
  return db
    .prepare(`DELETE FROM event_crosspost_messages WHERE event_id = ?`)
    .run(eventId).changes;
}

module.exports = {
  // constants that EXTERNAL consumers actually import (#470 H1-2 dropped the
  // nine export-only-dead names; the definitions stay — they are load-bearing
  // inside this module): the facade stays functions-only.
  MAX_OFFSET_MINUTES,
  MAX_OPTIONS_PER_EVENT,
  EVENT_ROLE_PREFIX,

  // settings
  getEventGuildSettings,
  updateEventGuildSettings,

  // events
  createEvent,
  getEventById,
  getEventForCommunity,
  getEventByMessage,
  listEvents,
  listUpcomingEvents,
  updateEvent,
  markEventPosted,
  setEventThread,
  claimDueScheduledPosts,
  recordEventPostFailure,
  deleteEventCascade,
  listExpiredDrafts,
  listEventsToAutoArchive,
  listDigestSettings,
  setEventDigestLastSent,

  // options
  listEventOptions,
  getEventOptionById,
  countEventOptions,
  createEventOption,
  updateEventOption,
  deleteEventOption,
  reorderEventOptions,
  replaceEventOptions,
  deleteEventActivityOlderThan,
  deleteEventNotificationsOlderThan,

  // signups
  getSignup,
  listUserSignups,
  listEventSignups,
  countEventSignups,
  listAttendingUserIds,
  listEventRoleIdsUserStillHolds,
  applySignupChoice,
  removeSignupRow,
  forceSignup,
  listUserEventsAcrossCommunity,

  // reminder rows
  createEventReminders,
  listEventReminders,
  getEventReminderById,
  deleteEventReminder,
  rescheduleUnsentEventReminders,
  retireAllUnsentEventReminders,
  claimDueEventReminders,
  markEventReminderSent,
  retireEventReminder,
  markEventReminderRetry,

  // mutes
  setEventMute,
  clearEventMute,
  isEventMuted,
  listEventMutes,
  clearEventMutesForEvent,

  // activity
  logEventActivity,
  listEventActivity,

  // series
  createEventSeries,
  getEventSeries,
  getEventSeriesForCommunity,
  listEventSeries,
  updateEventSeries,
  stopEventSeries,
  dissolveEventSeries,
  listDueEventSeries,

  // presets
  createEventPreset,
  getEventPreset,
  getEventPresetByName,
  listEventPresets,
  deleteEventPreset,

  // event channels
  markEventChannel,
  unmarkEventChannel,
  isEventChannel,
  listEventChannels,
  setEventChannelPurge,

  // wizard
  getEventWizard,
  upsertEventWizard,
  deleteEventWizard,
  listUserOpenWizards,
  deleteStaleEventWizards,

  // google calendar links
  upsertEventGoogleLink,
  getEventGoogleLink,
  updateEventGoogleLinkTokens,
  disableEventGoogleLink,
  deleteEventGoogleLink,

  // cross-posts
  inviteEventCrosspost,
  getEventCrosspostById,
  getEventCrosspostByCode,
  getEventCrosspostByPair,
  approveEventCrosspost,
  revokeEventCrosspost,
  listEventCrosspostsForCommunity,
  listActiveCrosspostsForSource,
  updateEventCrosspost,
  recordEventCrosspostMessage,
  listEventCrosspostMessagesForEvent,
  deleteEventCrosspostMessagesForEvent,
};
