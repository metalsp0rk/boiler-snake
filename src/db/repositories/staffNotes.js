const { db, now } = require("../connection");

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
 * Next sequential note_number for a guild (transaction-safe when used inside a tx).
 * @param {string} guildId
 * @returns {number}
 */
function nextNoteNumber(guildId) {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(note_number), 0) AS max_n FROM staff_notes WHERE guild_id=?`
    )
    .get(guildId);
  return Number(row?.max_n || 0) + 1;
}

/**
 * @param {object} opts
 * @param {string} opts.guildId
 * @param {string} opts.userId
 * @param {string} opts.authorId
 * @param {string} opts.content
 * @returns {object} created note row
 */
function createStaffNote(opts) {
  const normalized = normalizeNoteContent(opts.content);
  if (!normalized.ok) {
    const err = new Error(normalized.error);
    err.code = "INVALID_CONTENT";
    throw err;
  }

  const t = now();
  const insert = db.prepare(`
    INSERT INTO staff_notes (
      guild_id, note_number, user_id, author_id, content, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    const noteNumber = nextNoteNumber(opts.guildId);
    const info = insert.run(
      opts.guildId,
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
 * Lookup by human-friendly per-guild note number.
 * @param {string} guildId
 * @param {number} noteNumber
 * @returns {object|null}
 */
function getStaffNote(guildId, noteNumber) {
  if (!guildId || noteNumber == null) return null;
  return (
    db
      .prepare(
        `SELECT * FROM staff_notes WHERE guild_id=? AND note_number=?`
      )
      .get(guildId, Number(noteNumber)) || null
  );
}

/**
 * List notes for a subject user (newest first).
 * @param {string} guildId
 * @param {string} userId
 * @param {object} [opts]
 * @param {boolean} [opts.includeDeleted=false]
 * @param {number} [opts.limit=25]
 * @param {number} [opts.offset=0]
 * @returns {object[]}
 */
function listStaffNotes(guildId, userId, opts = {}) {
  const includeDeleted = !!opts.includeDeleted;
  const maxLimit = opts.export ? 5000 : 100;
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), maxLimit);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  if (includeDeleted) {
    return db
      .prepare(
        `
      SELECT * FROM staff_notes
      WHERE guild_id=? AND user_id=?
      ORDER BY created_at DESC, note_number DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(guildId, userId, limit, offset);
  }

  return db
    .prepare(
      `
    SELECT * FROM staff_notes
    WHERE guild_id=? AND user_id=? AND deleted_at IS NULL
    ORDER BY created_at DESC, note_number DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(guildId, userId, limit, offset);
}

/**
 * Recent notes across the whole guild (newest first).
 * @param {string} guildId
 * @param {object} [opts]
 * @param {boolean} [opts.includeDeleted=false]
 * @param {number} [opts.limit=25]
 * @param {number} [opts.offset=0]
 * @returns {object[]}
 */
function listRecentStaffNotes(guildId, opts = {}) {
  const includeDeleted = !!opts.includeDeleted;
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), 100);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  if (includeDeleted) {
    return db
      .prepare(
        `
      SELECT * FROM staff_notes
      WHERE guild_id=?
      ORDER BY created_at DESC, note_number DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(guildId, limit, offset);
  }

  return db
    .prepare(
      `
    SELECT * FROM staff_notes
    WHERE guild_id=? AND deleted_at IS NULL
    ORDER BY created_at DESC, note_number DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(guildId, limit, offset);
}

/**
 * @param {string} guildId
 * @param {string|null} [userId]
 * @param {object} [opts]
 * @param {boolean} [opts.includeDeleted=false]
 * @returns {number}
 */
function countStaffNotes(guildId, userId = null, opts = {}) {
  const includeDeleted = !!opts.includeDeleted;
  if (userId) {
    if (includeDeleted) {
      return (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM staff_notes WHERE guild_id=? AND user_id=?`
          )
          .get(guildId, userId)?.c || 0
      );
    }
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM staff_notes WHERE guild_id=? AND user_id=? AND deleted_at IS NULL`
        )
        .get(guildId, userId)?.c || 0
    );
  }

  if (includeDeleted) {
    return (
      db
        .prepare(`SELECT COUNT(*) AS c FROM staff_notes WHERE guild_id=?`)
        .get(guildId)?.c || 0
    );
  }
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM staff_notes WHERE guild_id=? AND deleted_at IS NULL`
      )
      .get(guildId)?.c || 0
  );
}

/**
 * Replace note body; records edited_at / edited_by.
 * Only active (non-deleted) notes can be edited.
 * @param {string} guildId
 * @param {number} noteNumber
 * @param {object} opts
 * @param {string} opts.content
 * @param {string} opts.editedBy
 * @returns {object|null} updated row, or null if missing/deleted
 */
function updateStaffNote(guildId, noteNumber, opts) {
  const normalized = normalizeNoteContent(opts.content);
  if (!normalized.ok) {
    const err = new Error(normalized.error);
    err.code = "INVALID_CONTENT";
    throw err;
  }

  const existing = getStaffNote(guildId, noteNumber);
  if (!existing || existing.deleted_at != null) return null;

  const t = now();
  db.prepare(
    `
    UPDATE staff_notes
    SET content=?, edited_at=?, edited_by=?
    WHERE guild_id=? AND note_number=? AND deleted_at IS NULL
  `
  ).run(normalized.content, t, opts.editedBy, guildId, Number(noteNumber));

  return getStaffNote(guildId, noteNumber);
}

/**
 * Soft-delete a note. Idempotent if already deleted (returns current row).
 * @param {string} guildId
 * @param {number} noteNumber
 * @param {string} deletedBy
 * @returns {object|null} row after soft-delete, or null if not found
 */
function softDeleteStaffNote(guildId, noteNumber, deletedBy) {
  const existing = getStaffNote(guildId, noteNumber);
  if (!existing) return null;
  if (existing.deleted_at != null) return existing;

  const t = now();
  db.prepare(
    `
    UPDATE staff_notes
    SET deleted_at=?, deleted_by=?
    WHERE guild_id=? AND note_number=? AND deleted_at IS NULL
  `
  ).run(t, deletedBy, guildId, Number(noteNumber));

  return getStaffNote(guildId, noteNumber);
}

module.exports = {
  MAX_NOTE_CONTENT,
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
