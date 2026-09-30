/**
 * Gork community-memory repository (roadmap §7.16): per-community, per-person
 * memory rows keyed by (community_id, subject_user_id, mem_date, title_key).
 *
 * Synchronous better-sqlite3 throughout (same pattern as gorkAccess). Read
 * helpers never throw on empty results — they return [] / null / 0.
 * Entry validation (subject allow-list, kind/importance coercion) happens
 * upstream in the memory layer; this module only type-normalizes.
 */

const { db, now } = require("../connection");

// Lazy require: src/platform/community.js requires the db facade, so a
// top-level require would be a load-time cycle. See src/db/repositories/users.js.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/** Per-person row cap used when callers don't pass one (roadmap §7.16.1). */
const DEFAULT_CAP = 25;

/** Hard cap on the merged source_message_ids JSON array (newest win). */
const MAX_SOURCE_IDS = 20;

const MEMORY_COLUMNS = `
  id, community_id, subject_user_id, mem_date, title, title_key, body, kind,
  importance, source_message_ids, created_at, updated_at, last_used_at
`;

const toIdList = (value) =>
  Array.isArray(value) ? value.map(String) : [];

/** Positive-integer rowid coercion; garbage input never reaches SQLite binding (NaN throws). */
const toRowId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * JSON-union merge of source_message_ids: old + new in order, unique (a
 * repeated id takes its NEWEST position), capped at the 20 newest entries.
 *
 * @param {string|null|undefined} existingJson stored JSON array (may be corrupt)
 * @param {string[]} incoming fresh message ids from this turn
 * @returns {string[]}
 */
function mergeSourceIds(existingJson, incoming) {
  let existing = [];
  try {
    const parsed = JSON.parse(existingJson ?? "[]");
    if (Array.isArray(parsed)) existing = parsed.map(String);
  } catch {
    existing = []; // corrupt stored JSON is treated as empty, never throws
  }
  const ordered = [...existing, ...toIdList(incoming)];
  const uniqueLatest = [];
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    if (!uniqueLatest.includes(ordered[i])) uniqueLatest.unshift(ordered[i]);
  }
  return uniqueLatest.slice(-MAX_SOURCE_IDS);
}

/**
 * Delete the subject's overflow rows above `cap`, keeping the ranked
 * survivors: importance DESC, COALESCE(last_used_at, updated_at) DESC,
 * mem_date DESC, id DESC (roadmap §7.16.1 eviction order).
 *
 * Internal helper: callers pass an already-asserted community id.
 *
 * @param {number} communityId
 * @param {string} subjectUserId
 * @param {number} cap
 * @returns {number} evicted row count
 */
function evictOverflow(communityId, subjectUserId, cap) {
  const raw = Number(cap);
  const limit = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : DEFAULT_CAP;
  const doomed = db
    .prepare(
      `SELECT id FROM gork_memories
     WHERE community_id=? AND subject_user_id=?
     ORDER BY importance DESC, COALESCE(last_used_at, updated_at) DESC, mem_date DESC, id DESC
     LIMIT -1 OFFSET ?`
    )
    .all(communityId, subjectUserId, limit)
    .map((r) => r.id);
  if (!doomed.length) return 0;
  const del = db.prepare(
    `DELETE FROM gork_memories WHERE community_id=? AND subject_user_id=? AND id=?`
  );
  return doomed.reduce(
    (count, id) => count + del.run(communityId, subjectUserId, id).changes,
    0
  );
}

/**
 * Insert-or-overwrite one memory and evict the subject's overflow.
 * Same (community, subject, mem_date, title_key) updates in place: title, body,
 * kind, importance, merged source_message_ids and updated_at are replaced;
 * created_at and last_used_at survive.
 *
 * @param {{
 *   communityId: number, subjectUserId: string, memDate: string,
 *   title: string, titleKey: string, body: string,
 *   kind?: string, importance?: number, sourceMessageIds?: string[]
 * }} entry
 * @param {number} [cap] per-person row cap (default 25)
 * @returns {{ id: number, created: boolean, evicted: number }}
 */
function upsertMemory(entry, cap = DEFAULT_CAP) {
  const t = now();
  const communityId = assertCommunityId(entry.communityId);
  const subjectUserId = String(entry.subjectUserId);
  const memDate = String(entry.memDate);
  const titleKey = String(entry.titleKey ?? "");
  const title = String(entry.title ?? "");
  const body = String(entry.body ?? "");
  const kind = entry.kind == null || entry.kind === "" ? "profile" : String(entry.kind);
  const importanceNum = Number(entry.importance);
  const importance = Number.isFinite(importanceNum) ? Math.floor(importanceNum) : 3;

  const existing = db
    .prepare(
      `SELECT id, source_message_ids FROM gork_memories
     WHERE community_id=? AND subject_user_id=? AND mem_date=? AND title_key=?`
    )
    .get(communityId, subjectUserId, memDate, titleKey);

  const sourceIds = JSON.stringify(
    mergeSourceIds(existing?.source_message_ids, toIdList(entry.sourceMessageIds))
  );

  db.prepare(
    `INSERT INTO gork_memories
       (community_id, subject_user_id, mem_date, title_key, title, body, kind,
        importance, source_message_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(community_id, subject_user_id, mem_date, title_key) DO UPDATE SET
       title=excluded.title,
       body=excluded.body,
       kind=excluded.kind,
       importance=excluded.importance,
       source_message_ids=excluded.source_message_ids,
       updated_at=excluded.updated_at`
  ).run(
    communityId, subjectUserId, memDate, titleKey, title, body, kind,
    importance, sourceIds, t, t
  );

  const id = existing
    ? Number(existing.id)
    : Number(
        db
          .prepare(
            `SELECT id FROM gork_memories
             WHERE community_id=? AND subject_user_id=? AND mem_date=? AND title_key=?`
          )
          .get(communityId, subjectUserId, memDate, titleKey).id
      );

  return { id, created: !existing, evicted: evictOverflow(communityId, subjectUserId, cap) };
}

/**
 * Memories for a set of subjects (read path + extraction input), each
 * person's newest/highest-ranked rows first, `perPersonLimit` per person.
 * Ranking: importance DESC, mem_date DESC, id DESC (roadmap §7.16.2 order).
 *
 * @param {number} communityId
 * @param {string[]} userIds
 * @param {number} [perPersonLimit]
 * @returns {object[]}
 */
function listForSubjects(communityId, userIds, perPersonLimit = DEFAULT_CAP) {
  assertCommunityId(communityId);
  const ids = [...new Set(toIdList(userIds))].filter(Boolean);
  if (!ids.length) return [];
  const raw = Number(perPersonLimit);
  const limit = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : DEFAULT_CAP;
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM (
         SELECT ${MEMORY_COLUMNS},
                ROW_NUMBER() OVER (
                  PARTITION BY subject_user_id
                  ORDER BY importance DESC, mem_date DESC, id DESC
                ) AS rn
         FROM gork_memories
         WHERE community_id=? AND subject_user_id IN (${placeholders})
       )
       WHERE rn <= ?
       ORDER BY subject_user_id ASC, importance DESC, mem_date DESC, id DESC`
    )
    .all(communityId, ...ids, limit);
}

/**
 * One person's memories, newest-first (updated_at DESC, id DESC).
 *
 * @param {number} communityId
 * @param {string} userId
 * @returns {object[]}
 */
function listForSubject(communityId, userId) {
  assertCommunityId(communityId);
  return db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM gork_memories
     WHERE community_id=? AND subject_user_id=?
     ORDER BY updated_at DESC, id DESC`
    )
    .all(communityId, userId);
}

/**
 * Newest memories across the community (staff `/gork memory show`).
 * Non-finite `limit` means "all rows".
 *
 * @param {number} communityId
 * @param {number} limit
 * @returns {object[]}
 */
function listForGuild(communityId, limit) {
  assertCommunityId(communityId);
  const raw = Number(limit);
  const lim = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : -1;
  return db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM gork_memories
     WHERE community_id=?
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`
    )
    .all(communityId, lim);
}

/**
 * Community-scoped fetch by the `#id` handle.
 *
 * @param {number} communityId
 * @param {number|string} id
 * @returns {object|null}
 */
function getById(communityId, id) {
  assertCommunityId(communityId);
  const rowId = toRowId(id);
  if (rowId === null) return null;
  const row = db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM gork_memories WHERE community_id=? AND id=?`
    )
    .get(communityId, rowId);
  return row ?? null;
}

/**
 * Community-scoped delete by `#id`.
 *
 * @param {number} communityId
 * @param {number|string} id
 * @returns {boolean} true when a row actually existed and was removed
 */
function deleteById(communityId, id) {
  assertCommunityId(communityId);
  const rowId = toRowId(id);
  if (rowId === null) return false;
  const result = db
    .prepare(`DELETE FROM gork_memories WHERE community_id=? AND id=?`)
    .run(communityId, rowId);
  return result.changes > 0;
}

/**
 * Wipe one person's memories in a community (`/gork memory clear <user>`).
 *
 * @param {number} communityId
 * @param {string} userId
 * @returns {number} deleted row count
 */
function deleteForSubject(communityId, userId) {
  assertCommunityId(communityId);
  return db
    .prepare(`DELETE FROM gork_memories WHERE community_id=? AND subject_user_id=?`)
    .run(communityId, userId).changes;
}

/**
 * Wipe the whole community's memory (`/gork memory clear`).
 *
 * @param {number} communityId
 * @returns {number} deleted row count
 */
function deleteForGuild(communityId) {
  assertCommunityId(communityId);
  return db
    .prepare(`DELETE FROM gork_memories WHERE community_id=?`)
    .run(communityId).changes;
}

/**
 * @param {number} communityId
 * @returns {number} stored memory rows for the community (staff `status` line)
 */
function countForGuild(communityId) {
  assertCommunityId(communityId);
  return db
    .prepare(`SELECT COUNT(*) AS n FROM gork_memories WHERE community_id=?`)
    .get(communityId).n;
}

/**
 * Stamp `last_used_at = now()` for recalled ids (community-scoped) so they
 * win the eviction recency tie-break.
 *
 * @param {number} communityId
 * @param {Array<number|string>} ids
 * @returns {number} rows touched
 */
function touchMemories(communityId, ids) {
  assertCommunityId(communityId);
  const list = toIdList(ids)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) return 0;
  const stmt = db.prepare(
    `UPDATE gork_memories SET last_used_at=? WHERE community_id=? AND id=?`
  );
  const t = now();
  return list.reduce(
    (count, id) => count + stmt.run(t, communityId, id).changes,
    0
  );
}

module.exports = {
  upsertMemory,
  listForSubjects,
  listForSubject,
  listForGuild,
  getById,
  deleteById,
  deleteForSubject,
  deleteForGuild,
  countForGuild,
  touchMemories,
};
