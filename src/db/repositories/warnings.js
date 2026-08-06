const { db, now } = require("../connection");

/** Max reason / void_reason length (roadmap §6.3). */
const MAX_WARN_REASON = 1000;

/**
 * Normalize and validate warning reason text.
 * @param {string} reason
 * @param {string} [label="Reason"]
 * @returns {{ ok: true, reason: string } | { ok: false, error: string }}
 */
function normalizeWarnReason(reason, label = "Reason") {
  const text = reason == null ? "" : String(reason).trim();
  if (!text) {
    return { ok: false, error: `${label} cannot be empty.` };
  }
  if (text.length > MAX_WARN_REASON) {
    return {
      ok: false,
      error: `${label} is too long (max ${MAX_WARN_REASON} characters).`,
    };
  }
  return { ok: true, reason: text };
}

/**
 * Next sequential warning_number for a guild.
 * @param {string} guildId
 * @returns {number}
 */
function nextWarningNumber(guildId) {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(warning_number), 0) AS max_n FROM warnings WHERE guild_id=?`
    )
    .get(guildId);
  return Number(row?.max_n || 0) + 1;
}

/**
 * @param {object} opts
 * @param {string} opts.guildId
 * @param {string} opts.userId
 * @param {string} opts.issuerId
 * @param {string} opts.reason
 * @param {number|null} [opts.relatedNoteId]
 * @returns {object} created warning row
 */
function createWarning(opts) {
  const normalized = normalizeWarnReason(opts.reason, "Reason");
  if (!normalized.ok) {
    const err = new Error(normalized.error);
    err.code = "INVALID_REASON";
    throw err;
  }

  let relatedNoteId = null;
  if (opts.relatedNoteId != null) {
    const n = Number(opts.relatedNoteId);
    if (!Number.isFinite(n) || n < 1) {
      const err = new Error("related_note_id must be a positive integer.");
      err.code = "INVALID_NOTE";
      throw err;
    }
    relatedNoteId = Math.floor(n);
  }

  const t = now();
  const insert = db.prepare(`
    INSERT INTO warnings (
      guild_id, warning_number, user_id, issuer_id, reason, created_at, related_note_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    const warningNumber = nextWarningNumber(opts.guildId);
    const info = insert.run(
      opts.guildId,
      warningNumber,
      opts.userId,
      opts.issuerId,
      normalized.reason,
      t,
      relatedNoteId
    );
    return Number(info.lastInsertRowid);
  });

  const id = tx();
  return getWarningById(id);
}

/**
 * @param {number} id
 * @returns {object|null}
 */
function getWarningById(id) {
  if (id == null) return null;
  return (
    db.prepare(`SELECT * FROM warnings WHERE id=?`).get(Number(id)) || null
  );
}

/**
 * Lookup by human-friendly per-guild warning number.
 * @param {string} guildId
 * @param {number} warningNumber
 * @returns {object|null}
 */
function getWarning(guildId, warningNumber) {
  if (!guildId || warningNumber == null) return null;
  return (
    db
      .prepare(
        `SELECT * FROM warnings WHERE guild_id=? AND warning_number=?`
      )
      .get(guildId, Number(warningNumber)) || null
  );
}

/**
 * List warnings for a subject user (newest first).
 * @param {string} guildId
 * @param {string} userId
 * @param {object} [opts]
 * @param {boolean} [opts.includeVoided=false]
 * @param {number} [opts.limit=25]
 * @param {number} [opts.offset=0]
 * @returns {object[]}
 */
function listWarnings(guildId, userId, opts = {}) {
  const includeVoided = !!opts.includeVoided;
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), 100);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  if (includeVoided) {
    return db
      .prepare(
        `
      SELECT * FROM warnings
      WHERE guild_id=? AND user_id=?
      ORDER BY created_at DESC, warning_number DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(guildId, userId, limit, offset);
  }

  return db
    .prepare(
      `
    SELECT * FROM warnings
    WHERE guild_id=? AND user_id=? AND voided_at IS NULL
    ORDER BY created_at DESC, warning_number DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(guildId, userId, limit, offset);
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @param {object} [opts]
 * @param {boolean} [opts.includeVoided=false]
 * @returns {number}
 */
function countWarnings(guildId, userId, opts = {}) {
  const includeVoided = !!opts.includeVoided;
  if (includeVoided) {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM warnings WHERE guild_id=? AND user_id=?`
        )
        .get(guildId, userId)?.c || 0
    );
  }
  return countActiveWarnings(guildId, userId);
}

/**
 * Active (non-voided) warning count for a user in a guild.
 * @param {string} guildId
 * @param {string} userId
 * @returns {number}
 */
function countActiveWarnings(guildId, userId) {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM warnings WHERE guild_id=? AND user_id=? AND voided_at IS NULL`
      )
      .get(guildId, userId)?.c || 0
  );
}

/**
 * Void a warning (permanent row; marks inactive). Cannot un-void.
 * @param {string} guildId
 * @param {number} warningNumber
 * @param {object} opts
 * @param {string} opts.voidedBy
 * @param {string} opts.voidReason
 * @returns {object|null} updated row, or null if not found
 * @throws {{ code: string }} INVALID_REASON | ALREADY_VOIDED
 */
function voidWarning(guildId, warningNumber, opts) {
  const normalized = normalizeWarnReason(opts.voidReason, "Void reason");
  if (!normalized.ok) {
    const err = new Error(normalized.error);
    err.code = "INVALID_REASON";
    throw err;
  }

  const existing = getWarning(guildId, warningNumber);
  if (!existing) return null;
  if (existing.voided_at != null) {
    const err = new Error(
      `Warning W-${existing.warning_number} is already voided.`
    );
    err.code = "ALREADY_VOIDED";
    err.warning = existing;
    throw err;
  }

  const t = now();
  db.prepare(
    `
    UPDATE warnings
    SET voided_at=?, voided_by=?, void_reason=?
    WHERE guild_id=? AND warning_number=? AND voided_at IS NULL
  `
  ).run(
    t,
    opts.voidedBy,
    normalized.reason,
    guildId,
    Number(warningNumber)
  );

  return getWarning(guildId, warningNumber);
}

module.exports = {
  MAX_WARN_REASON,
  normalizeWarnReason,
  createWarning,
  getWarningById,
  getWarning,
  listWarnings,
  countWarnings,
  countActiveWarnings,
  voidWarning,
};
