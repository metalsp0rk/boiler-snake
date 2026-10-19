const { db, now } = require("../connection");

// src/platform/community.js requires the db facade (src/db/index.js), so a
// top-level require here would be a load-time cycle (partial exports). The
// lazy require resolves after boot; assertCommunityId stays single-source.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/** Max note body length (slash option + modal paragraph). */
const MAX_NOTE_CONTENT = 2000;

/**
 * Normalize and validate note content.
 * @param {string} content
 * @returns {{ ok: true, content: string } | { ok: false, error: string }}
 */
function normalizeNoteContent(content) {
  const text = content == null ? "" : String(content).trim();
  if (!text) {
    return { ok: false, error: "Note content cannot be empty." };
  }
  if (text.length > MAX_NOTE_CONTENT) {
    return {
      ok: false,
      error: `Note content is too long (max ${MAX_NOTE_CONTENT} characters).`,
    };
  }
  return { ok: true, content: text };
}

/**
 * Next sequential note_number for a community (transaction-safe when used inside a tx).
 * @param {number} communityId
 * @returns {number}
 */
function nextNoteNumber(communityId) {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(note_number), 0) AS max_n FROM staff_notes WHERE community_id=?`
    )
    .get(communityId);
  return Number(row?.max_n || 0) + 1;
}

/**
 * @param {object} opts
 * @param {number} opts.communityId
 * @param {string} opts.userId
 * @param {string} opts.authorId
 * @param {string} opts.content
 * @returns {object} created note row
 */
function createStaffNote(opts) {
  assertCommunityId(opts.communityId);
  const normalized = normalizeNoteContent(opts.content);
  if (!normalized.ok) {
    const err = new Error(normalized.error);
    err.code = "INVALID_CONTENT";
    throw err;
  }

  const t = now();
  const insert = db.prepare(`
    INSERT INTO staff_notes (
      community_id, note_number, user_id, author_id, content, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    const noteNumber = nextNoteNumber(opts.communityId);
    const info = insert.run(
      opts.communityId,
      noteNumber,
      opts.userId,
      opts.authorId,
      normalized.content,
      t
    );
    return Number(info.lastInsertRowid);
  });

  const id = tx();
  return getStaffNoteById(id);
}

/**
 * @param {number} id
 * @returns {object|null}
 */
function getStaffNoteById(id) {
  if (id == null) return null;
  return (
    db.prepare(`SELECT * FROM staff_notes WHERE id=?`).get(Number(id)) || null
  );
}

/**
 * Lookup by human-friendly per-community note number.
 * @param {number} communityId
 * @param {number} noteNumber
 * @returns {object|null}
 */
function getStaffNote(communityId, noteNumber) {
  assertCommunityId(communityId);
  if (noteNumber == null) return null;
  return (
    db
      .prepare(
        `SELECT * FROM staff_notes WHERE community_id=? AND note_number=?`
      )
      .get(communityId, Number(noteNumber)) || null
  );
}

/**
 * List notes for a subject user (newest first).
 * @param {number} communityId
 * @param {string} userId
 * @param {object} [opts]
 * @param {boolean} [opts.includeDeleted=false]
 * @param {number} [opts.limit=25]
 * @param {number} [opts.offset=0]
 * @returns {object[]}
 */
function listStaffNotes(communityId, userId, opts = {}) {
  assertCommunityId(communityId);
  const includeDeleted = !!opts.includeDeleted;
  const maxLimit = opts.export ? 5000 : 100;
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), maxLimit);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  if (includeDeleted) {
    return db
      .prepare(
        `
      SELECT * FROM staff_notes
      WHERE community_id=? AND user_id=?
      ORDER BY created_at DESC, note_number DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(communityId, userId, limit, offset);
  }

  return db
    .prepare(
      `
    SELECT * FROM staff_notes
    WHERE community_id=? AND user_id=? AND deleted_at IS NULL
    ORDER BY created_at DESC, note_number DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(communityId, userId, limit, offset);
}

/**
 * Recent notes across the whole community (newest first).
 * @param {number} communityId
 * @param {object} [opts]
 * @param {boolean} [opts.includeDeleted=false]
 * @param {number} [opts.limit=25]
 * @param {number} [opts.offset=0]
 * @returns {object[]}
 */
function listRecentStaffNotes(communityId, opts = {}) {
  assertCommunityId(communityId);
  const includeDeleted = !!opts.includeDeleted;
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), 100);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  if (includeDeleted) {
    return db
      .prepare(
        `
      SELECT * FROM staff_notes
      WHERE community_id=?
      ORDER BY created_at DESC, note_number DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(communityId, limit, offset);
  }

  return db
    .prepare(
      `
    SELECT * FROM staff_notes
    WHERE community_id=? AND deleted_at IS NULL
    ORDER BY created_at DESC, note_number DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(communityId, limit, offset);
}

/**
 * @param {number} communityId
 * @param {string|null} [userId]
 * @param {object} [opts]
 * @param {boolean} [opts.includeDeleted=false]
 * @returns {number}
 */
function countStaffNotes(communityId, userId = null, opts = {}) {
  assertCommunityId(communityId);
  const includeDeleted = !!opts.includeDeleted;
  if (userId) {
    if (includeDeleted) {
      return (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM staff_notes WHERE community_id=? AND user_id=?`
          )
          .get(communityId, userId)?.c || 0
      );
    }
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM staff_notes WHERE community_id=? AND user_id=? AND deleted_at IS NULL`
        )
        .get(communityId, userId)?.c || 0
    );
  }

  if (includeDeleted) {
    return (
      db
        .prepare(`SELECT COUNT(*) AS c FROM staff_notes WHERE community_id=?`)
        .get(communityId)?.c || 0
    );
  }
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM staff_notes WHERE community_id=? AND deleted_at IS NULL`
      )
      .get(communityId)?.c || 0
  );
}

/**
 * Replace note body; records edited_at / edited_by.
 * Only active (non-deleted) notes can be edited.
 * @param {number} communityId
 * @param {number} noteNumber
 * @param {object} opts
 * @param {string} opts.content
 * @param {string} opts.editedBy
 * @returns {object|null} updated row, or null if missing/deleted
 */
function updateStaffNote(communityId, noteNumber, opts) {
  assertCommunityId(communityId);
  const normalized = normalizeNoteContent(opts.content);
  if (!normalized.ok) {
    const err = new Error(normalized.error);
    err.code = "INVALID_CONTENT";
    throw err;
  }

  const existing = getStaffNote(communityId, noteNumber);
  if (!existing || existing.deleted_at != null) return null;

  const t = now();
  db.prepare(
    `
    UPDATE staff_notes
    SET content=?, edited_at=?, edited_by=?
    WHERE community_id=? AND note_number=? AND deleted_at IS NULL
  `
  ).run(normalized.content, t, opts.editedBy, communityId, Number(noteNumber));

  return getStaffNote(communityId, noteNumber);
}

/**
 * Soft-delete a note. Idempotent if already deleted (returns current row).
 * @param {number} communityId
 * @param {number} noteNumber
 * @param {string} deletedBy
 * @returns {object|null} row after soft-delete, or null if not found
 */
/**
 * #469 (F2-11): the tombstone replacing note content on delete. A soft
 * delete used to keep the FULL text forever — and the staff-record export
 * includes deleted notes by default — so "delete" erased nothing: no
 * GDPR path existed. Erasure keeps the AUDIT CHAIN (number, author,
 * deleted_at/by stay) and destroys the CONTENT — a warning that links to
 * an erased note still resolves its stub instead of dangling.
 */
const ERASED_NOTE_CONTENT = "[erased — staff note deleted]";

function softDeleteStaffNote(communityId, noteNumber, deletedBy) {
  assertCommunityId(communityId);
  const existing = getStaffNote(communityId, noteNumber);
  if (!existing) return null;
  if (existing.deleted_at != null) return existing;

  const t = now();
  db.prepare(
    `
    UPDATE staff_notes
    SET deleted_at=?, deleted_by=?, content=?
    WHERE community_id=? AND note_number=? AND deleted_at IS NULL
  `
  ).run(t, deletedBy, ERASED_NOTE_CONTENT, communityId, Number(noteNumber));

  return getStaffNote(communityId, noteNumber);
}

/**
 * #469 (F2-11): retention primitive — erase-TOMBSTONES older than the
 * cutoff leave the table entirely (content was already destroyed at
 * delete time; the stub's remaining value decays). Opt-in via
 * RETENTION_ERASED_NOTES_DAYS.
 * @param {number} cutoffMs rows deleted strictly before (epoch ms)
 * @param {number} [limit]
 * @returns {number} rows deleted
 */
function deleteErasedNotesOlderThan(cutoffMs, limit = 500) {
  if (!Number.isSafeInteger(cutoffMs)) {
    throw new TypeError(
      `deleteErasedNotesOlderThan: cutoffMs must be an integer ms epoch, got ${String(cutoffMs)}`
    );
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError(
      `deleteErasedNotesOlderThan: limit must be a positive integer, got ${String(limit)}`
    );
  }
  return db
    .prepare(
      `DELETE FROM staff_notes WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT ?`,
    )
    .run(cutoffMs, limit).changes;
}

module.exports = {
  MAX_NOTE_CONTENT,
  ERASED_NOTE_CONTENT,
  deleteErasedNotesOlderThan,
  normalizeNoteContent,
  createStaffNote,
  getStaffNoteById,
  getStaffNote,
  listStaffNotes,
  listRecentStaffNotes,
  countStaffNotes,
  updateStaffNote,
  softDeleteStaffNote,
};
