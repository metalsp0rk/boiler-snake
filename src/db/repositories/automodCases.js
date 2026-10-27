/**
 * Auto-moderation case records (#726, epic #723).
 *
 * The referral intake (slash `/automod refer` + the "Refer to automod"
 * context menu) writes one row per case; the harness issue (#728) owns every
 * status move after intake. Storage truth lives in migration 068.
 *
 * Case-number allocation mirrors staffNotes.js EXACTLY: per-community
 * `COALESCE(MAX(case_number), 0) + 1` read inside a `db.transaction()`
 * (retry-safe under better-sqlite3's synchronous single-writer contract —
 * the UNIQUE(community_id, case_number) constraint from 068 is the belt if
 * allocation is ever driven from elsewhere). Display form is **A-n**, the
 * human-ref sibling of N-n notes and T-n tickets.
 *
 * Error contract (AGENTS.md rule 6, ticketReports.js posture): write paths
 * return `{ ok: false, error }` with a specific message and never throw at
 * runtime; a non-integer community id stays a PROGRAMMER error through the
 * lazy assertCommunityId (same as every community-scoped repository).
 */

const { db, now } = require("../connection");

// src/platform/community.js requires the db facade (src/db/index.js), so a
// top-level require here would be a load-time cycle (partial exports). The
// lazy require resolves after boot; assertCommunityId stays single-source.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/**
 * Case status vocabulary (migration 068 CHECK). #726 writes ONLY `recorded`;
 * #728 (harness) owns recorded→processing→complete/failed.
 */
const AUTOMOD_CASE_STATUSES = Object.freeze([
  "recorded",
  "processing",
  "complete",
  "failed",
]);

/**
 * Referral-note cap. Sibling-consistent: MAX_WARN_REASON = 1000 and
 * MAX_TICKET_REASON = 1000 are the "explanation attached to a case" caps
 * (this is one), while MAX_NOTE_CONTENT = 2000 sizes a full staff-note body.
 * The slash option clamps via setMaxLength; the repository re-checks so no
 * caller can store an over-cap note.
 */
const AUTOMOD_REFER_NOTE_MAX_LEN = 1000;

/** Trim-to-null for the optional id/note fields ("" is absent, never stored). */
function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/**
 * Next sequential case_number for a community (transaction-safe when used
 * inside a tx — same seam as staffNotes.nextNoteNumber).
 * @param {number} communityId
 * @returns {number}
 */
function nextCaseNumber(communityId) {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(case_number), 0) AS max_n FROM automod_cases WHERE community_id=?`,
    )
    .get(communityId);
  return Number(row?.max_n || 0) + 1;
}

/**
 * Record one referral intake. The caller (referral service) has already run
 * the whole refusal battery — this repository only stores.
 *
 * @param {object} opts
 * @param {number} opts.communityId
 * @param {string} opts.referrerUserId staff member who filed the case
 * @param {string|null} [opts.messageId] referred message id (when given)
 * @param {string|null} [opts.channelId] channel the referred message lives in
 * @param {string|null} [opts.targetUserId] named member (when given)
 * @param {string|null} [opts.note] referrer's explanation (case input, capped)
 * @returns {{ ok: true, case: object } | { ok: false, error: string }}
 */
function createAutomodCase(opts = {}) {
  const { communityId, referrerUserId, messageId, channelId, targetUserId, note } =
    opts || {};
  assertCommunityId(communityId);

  const referrer = optionalText(referrerUserId);
  if (!referrer) {
    return { ok: false, error: "A case needs the referring staff member's user id." };
  }
  const msg = optionalText(messageId);
  const chan = optionalText(channelId);
  const target = optionalText(targetUserId);
  const noteText = optionalText(note);
  if (noteText && noteText.length > AUTOMOD_REFER_NOTE_MAX_LEN) {
    return {
      ok: false,
      error: `Referral note is ${noteText.length} characters — the cap is ${AUTOMOD_REFER_NOTE_MAX_LEN}.`,
    };
  }

  const t = now();
  try {
    const insert = db.prepare(`
      INSERT INTO automod_cases (
        community_id, case_number, referrer_user_id,
        message_id, channel_id, target_user_id, note,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'recorded', ?, ?)
    `);
    const tx = db.transaction(() => {
      const caseNumber = nextCaseNumber(communityId);
      return insert.run(
        communityId,
        caseNumber,
        referrer,
        msg,
        chan,
        target,
        noteText,
        t,
        t,
      );
    });
    const info = tx();
    return { ok: true, case: getAutomodCaseById(info.lastInsertRowid) };
  } catch (err) {
    // Constraint failure (community row gone via the FK, or an allocation
    // collision): specific, never a silent drop (rule 3).
    return {
      ok: false,
      error: `Could not save the auto-mod case: ${err?.message || err}`,
    };
  }
}

/**
 * Case row by primary key.
 * @param {number|string} id
 * @returns {object|null}
 */
function getAutomodCaseById(id) {
  const num = Number(id);
  if (!Number.isInteger(num) || num < 1) return null;
  return db.prepare(`SELECT * FROM automod_cases WHERE id=?`).get(num) || null;
}

/**
 * Lookup by the human-friendly per-community case number (the **A-n** ref).
 * @param {number} communityId
 * @param {number|string} caseNumber
 * @returns {object|null}
 */
function getAutomodCase(communityId, caseNumber) {
  assertCommunityId(communityId);
  const num = Number(caseNumber);
  if (!Number.isInteger(num) || num < 1) return null;
  return (
    db
      .prepare(
        `SELECT * FROM automod_cases WHERE community_id=? AND case_number=?`,
      )
      .get(communityId, num) || null
  );
}

/**
 * List cases for a community (newest first; optionally one status). The
 * harness picks up `recorded` rows; the card surfaces a case by number.
 *
 * @param {number} communityId
 * @param {object} [opts]
 * @param {string|null} [opts.status=null] restrict to one status
 * @param {number} [opts.limit=25] clamped 1–100
 * @param {number} [opts.offset=0]
 * @returns {object[]}
 */
function listAutomodCases(communityId, { status = null, limit = 25, offset = 0 } = {}) {
  assertCommunityId(communityId);
  const capped = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 25));
  const skip = Math.max(0, Math.floor(Number(offset)) || 0);
  if (status != null && !AUTOMOD_CASE_STATUSES.includes(status)) return [];
  return db
    .prepare(
      `SELECT * FROM automod_cases
       WHERE community_id=? ${status != null ? "AND status=? " : ""}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(
      ...(status != null ? [communityId, status] : [communityId]),
      capped,
      skip,
    );
}

/**
 * Move one case's status (the seam #728 claims and completes through). The
 * CHECK constraint is the vocabulary truth; this returns { ok:false } instead
 * of letting a CHECK throw reach a caller.
 *
 * @param {number} communityId
 * @param {number|string} caseNumber
 * @param {string} status one of AUTOMOD_CASE_STATUSES
 * @returns {{ ok: true, case: object } | { ok: false, error: string }}
 */
function setAutomodCaseStatus(communityId, caseNumber, status) {
  assertCommunityId(communityId);
  const next = optionalText(status);
  if (!AUTOMOD_CASE_STATUSES.includes(next)) {
    return {
      ok: false,
      error: `Unknown case status \`${status}\` — choose one of: ${AUTOMOD_CASE_STATUSES.join(", ")}.`,
    };
  }
  const row = getAutomodCase(communityId, caseNumber);
  if (!row) {
    return {
      ok: false,
      error: `No auto-mod case A-${caseNumber} in this community.`,
    };
  }
  try {
    db.prepare(
      `UPDATE automod_cases SET status=?, updated_at=? WHERE id=?`,
    ).run(next, now(), row.id);
    return { ok: true, case: getAutomodCaseById(row.id) };
  } catch (err) {
    return {
      ok: false,
      error: `Could not update case A-${caseNumber}: ${err?.message || err}`,
    };
  }
}

module.exports = {
  AUTOMOD_CASE_STATUSES,
  AUTOMOD_REFER_NOTE_MAX_LEN,
  nextCaseNumber,
  createAutomodCase,
  getAutomodCaseById,
  getAutomodCase,
  listAutomodCases,
  setAutomodCaseStatus,
};
