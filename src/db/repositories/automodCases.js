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

/**
 * Required-context cap (#771): the modal's optional "what the reviewer
 * needs to see" field — sibling of the problem/note cap (same kind of case
 * input, same belt: the service clamps shape, the repository re-checks so
 * no caller can store an over-cap text).
 */
const AUTOMOD_REFER_CONTEXT_MAX_LEN = 1000;

/** Persisted anchor-snippet cap (card "**Reported message:**" line). */
const AUTOMOD_CASE_SNIPPET_MAX = 300;

/**
 * Case-level resolution vocabulary (migration 071 `resolution` column).
 * #771: the FIRST valid staff click wins; the repository's single-winner
 * UPDATE is the law. `recommended` runs the pending set through the
 * executor; `manual`/`none` execute nothing and supersede the pending rows.
 */
const AUTOMOD_CASE_RESOLUTIONS = Object.freeze([
  "recommended",
  "manual",
  "none",
]);

/**
 * Hard ceiling for one window direction (#771 §2). The service/modal clamps
 * first; the repository clamps again (belt — the stored value is ALWAYS
 * inside 0–500, whatever a future caller attempts).
 */
const AUTOMOD_CASE_READ_WINDOW_MAX = 500;

/** Clamp one read-window count into 0–500 (null/undefined pass through). */
function clampReadWindow(value) {
  if (value == null || value === "") return null;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(AUTOMOD_CASE_READ_WINDOW_MAX, Math.max(0, n));
}

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
 * @param {string|null} [opts.note] referrer's problem statement (case input,
 *   capped) — the #771 referral modal makes this the REQUIRED problem field
 * @param {string|null} [opts.requiredContext] modal "what the reviewer needs
 *   to see or know" text, verbatim case input (capped, #771)
 * @param {number|null} [opts.readBefore] per-case window back from the
 *   anchor (0–500, clamped here; #771 §2)
 * @param {number|null} [opts.readAfter] per-case window forward (#771 §2)
 * @param {string|null} [opts.messageSnippet] single-line anchor excerpt
 *   captured at intake (capped/squashed here; #771 §4)
 * @returns {{ ok: true, case: object } | { ok: false, error: string }}
 */
function createAutomodCase(opts = {}) {
  const {
    communityId,
    referrerUserId,
    messageId,
    channelId,
    targetUserId,
    note,
    requiredContext = null,
    readBefore = null,
    readAfter = null,
    messageSnippet = null,
  } = opts || {};
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
  const contextText = optionalText(requiredContext);
  if (contextText && contextText.length > AUTOMOD_REFER_CONTEXT_MAX_LEN) {
    return {
      ok: false,
      error: `Required context is ${contextText.length} characters — the cap is ${AUTOMOD_REFER_CONTEXT_MAX_LEN}.`,
    };
  }
  const before = clampReadWindow(readBefore);
  const after = clampReadWindow(readAfter);
  const snippetText = optionalText(messageSnippet);
  const snippetStored =
    snippetText != null && snippetText.length > AUTOMOD_CASE_SNIPPET_MAX
      ? snippetText.slice(0, AUTOMOD_CASE_SNIPPET_MAX)
      : snippetText;

  const t = now();
  try {
    const insert = db.prepare(`
      INSERT INTO automod_cases (
        community_id, case_number, referrer_user_id,
        message_id, channel_id, target_user_id, note,
        required_context, read_before, read_after, message_snippet,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?, ?)
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
        contextText,
        before,
        after,
        snippetStored,
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

/**
 * Persist the harness's closing decision estimate (#771 §4, the card's
 * "**What happened:**" line). NULL-safe: null clears. Written only by the
 * harness metadata writer; the card only READS it.
 *
 * @param {number} caseId
 * @param {string|null} text
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function setAutomodCaseIncidentSummary(caseId, text) {
  const id = Number(caseId);
  if (!Number.isInteger(id) || id < 1) {
    return { ok: false, error: "No such auto-mod case row." };
  }
  try {
    const res = db
      .prepare(`UPDATE automod_cases SET incident_summary=? WHERE id=?`)
      .run(optionalText(text), id);
    if (res.changes === 0) return { ok: false, error: `No auto-mod case row #${id}.` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not record the incident summary: ${err?.message || err}` };
  }
}

/**
 * Reveal the reporter on ONE case (#771 §3) — single-winner by shape:
 * `WHERE revealed_at IS NULL` makes the FIRST staff press the only writer.
 *
 * @param {number} caseId
 * @param {string} staffUserId the revealing staff member
 * @param {{ nowMs?: number }} [opts]
 * @returns {{ ok: true, revealed: boolean, alreadyRevealed: boolean, case: object }
 *          | { ok: false, error: string }}
 *   `revealed: true` on the winning press; `revealed: false,
 *   alreadyRevealed: true` on an idempotent re-press (ZERO mutation — the
 *   caller audits nothing new, #771: "re-press on a revealed card notes
 *   it's already revealed; no duplicate audit rows").
 */
function revealAutomodCaseReporter(caseId, staffUserId, { nowMs } = {}) {
  const id = Number(caseId);
  if (!Number.isInteger(id) || id < 1) {
    return { ok: false, error: "No such auto-mod case row." };
  }
  const staff = optionalText(staffUserId);
  if (!staff) return { ok: false, error: "A reveal needs the revealing staff member's user id." };
  try {
    const stamp = Number.isFinite(Number(nowMs)) ? Math.floor(Number(nowMs)) : now();
    const res = db
      .prepare(
        `UPDATE automod_cases
            SET revealed_at=?, revealed_by_user_id=?, updated_at=?
          WHERE id=? AND revealed_at IS NULL`,
      )
      .run(stamp, staff, stamp, id);
    const row = getAutomodCaseById(id);
    if (!row) return { ok: false, error: `No auto-mod case row #${id}.` };
    return { ok: true, revealed: res.changes === 1, alreadyRevealed: res.changes === 0, case: row };
  } catch (err) {
    return { ok: false, error: `Could not reveal the reporter: ${err?.message || err}` };
  }
}

/**
 * Resolve ONE case at the CASE level (#771 §5) — the first valid staff
 * click wins (single-winner UPDATE, same law as the row-level claim):
 * a losing click gets `{ok:true, won:false, existing:{...}}` and mutates
 * NOTHING (the callers show the EXISTING resolution — never an error).
 *
 * @param {number} caseId
 * @param {string} resolution one of AUTOMOD_CASE_RESOLUTIONS
 * @param {string} staffUserId the resolving staff member
 * @param {{ nowMs?: number }} [opts]
 * @returns {{ ok: true, won: boolean, existing: object|null, case: object }
 *          | { ok: false, error: string }}
 */
function resolveAutomodCase(caseId, resolution, staffUserId, { nowMs } = {}) {
  const id = Number(caseId);
  if (!Number.isInteger(id) || id < 1) {
    return { ok: false, error: "No such auto-mod case row." };
  }
  const kind = optionalText(resolution);
  if (!AUTOMOD_CASE_RESOLUTIONS.includes(kind)) {
    return {
      ok: false,
      error: `Unknown case resolution \`${resolution}\` — choose one of: ${AUTOMOD_CASE_RESOLUTIONS.join(", ")}.`,
    };
  }
  const staff = optionalText(staffUserId);
  if (!staff) return { ok: false, error: "A resolution needs the resolving staff member's user id." };
  try {
    const stamp = Number.isFinite(Number(nowMs)) ? Math.floor(Number(nowMs)) : now();
    const res = db
      .prepare(
        `UPDATE automod_cases
            SET resolved_at=?, resolution=?, resolved_by_user_id=?, updated_at=?
          WHERE id=? AND resolved_at IS NULL`,
      )
      .run(stamp, kind, staff, stamp, id);
    const row = getAutomodCaseById(id);
    if (!row) return { ok: false, error: `No auto-mod case row #${id}.` };
    return {
      ok: true,
      won: res.changes === 1,
      existing:
        res.changes === 1
          ? null
          : {
              resolution: row.resolution,
              resolvedByUserId: row.resolved_by_user_id,
              resolvedAt: row.resolved_at,
            },
      case: row,
    };
  } catch (err) {
    return { ok: false, error: `Could not resolve the case: ${err?.message || err}` };
  }
}

module.exports = {
  AUTOMOD_CASE_STATUSES,
  AUTOMOD_CASE_RESOLUTIONS,
  AUTOMOD_REFER_NOTE_MAX_LEN,
  AUTOMOD_REFER_CONTEXT_MAX_LEN,
  AUTOMOD_CASE_SNIPPET_MAX,
  AUTOMOD_CASE_READ_WINDOW_MAX,
  clampReadWindow,
  nextCaseNumber,
  createAutomodCase,
  getAutomodCaseById,
  getAutomodCase,
  listAutomodCases,
  setAutomodCaseStatus,
  setAutomodCaseIncidentSummary,
  revealAutomodCaseReporter,
  resolveAutomodCase,
};
