/**
 * Auto-moderation case-action ledger repository (#729, epic #723).
 *
 * Owns `automod_case_actions` (migration 069): the intent/commit record for
 * every sanction a case suggested, executed, refused, or failed to execute
 * against a considered user. The executor
 * (`src/features/automod/executor.js`) is the primary writer; the card
 * (#730) reads via `getAutomodAction`/`listAutomodActionsForCase`, and the
 * staff-note commit (#731) consumes the considered rows.
 *
 * Claim model (mirrors claimTicketCreateSlot in repositories/tickets.js —
 * "compare the atomic ticket-create slot"): every mutation-owning transition
 * is ONE conditional UPDATE (or the INSERT itself against
 * `ux_automod_case_actions_slot`), so exactly one caller wins and losers
 * re-read the existing row instead of re-running the mutation. better-sqlite3
 * is a synchronous single writer — a claim can never interleave.
 *
 * Considered semantics (#731): an existing row IS the considered flag.
 * Every state — including `dismissed`, `refused`, and `failed` — marks the
 * subject as considered for that case; the note is owed in all of them.
 *
 * Error contract (AGENTS.md rule 6): writers return { ok:false, error } on
 * bad input or a constraint failure — never throw. A community id that is
 * not an integer is a PROGRAMMER error and goes through assertCommunityId
 * (same posture as repositories/ticketReports.js).
 */

const { db, now } = require("../connection");

// Lazy require: src/platform/community.js requires the db facade, so a
// top-level require would be a load-time cycle. See repositories/users.js.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

// Action + mode vocabulary stays single-source in automodSettings (#725);
// this repo only owns the STATE enum. No cycle: automodSettings never
// requires this module.
const { AUTOMOD_ACTIONS, normalizeAutomodMode } = require("./automodSettings");

/** The pinned row state machine (migration 069 CHECK mirrors it). */
const AUTOMOD_ACTION_STATES = Object.freeze([
  "suggested", // pending suggestion (suggest mode) — claimable, not run
  "approved", // claimed (auto slot insert or Approve click) — owned, running/ran
  "dismissed", // staff declined the suggestion — never runs
  "executed", // mutation completed (or no_action recorded its outcome)
  "refused", // a guard/precondition said no — specific error_text recorded
  "failed", // the mutation or its verification blew up — error_text recorded
]);

/**
 * Every state counts the subject as CONSIDERED (epic #723 decision 4: a
 * suggestion, a refusal, or an execution all owe one staff note per case).
 * Exported as a set-shaped constant so #731 asserts against a name instead
 * of hard-coding the list.
 */
const AUTOMOD_CONSIDERED_STATES = AUTOMOD_ACTION_STATES;

// ── Shared input helpers ───────────────────────────────────────────────────

function normText(value) {
  const s = value == null ? "" : String(value).trim();
  return s === "" ? null : s;
}

function serializeParams(params) {
  if (params == null) return null;
  if (typeof params === "string") return params;
  try {
    return JSON.stringify(params);
  } catch {
    return JSON.stringify({ unserializable: String(params) });
  }
}

/** Row → same row with `params` parsed (null on garbage; row untouched). */
function parseAutomodActionParams(row) {
  if (!row) return null;
  let params = null;
  if (row.params_json != null) {
    try {
      params = JSON.parse(row.params_json);
    } catch {
      params = null;
    }
  }
  return { ...row, params };
}

/**
 * True when `err` is the slot UNIQUE index rejecting a duplicate intent.
 * Matched on the constraint class + table, not the index name: SQLite's
 * "UNIQUE constraint failed:" text names columns, not indexes. On an INSERT
 * into this table a UNIQUE violation can only come from the slot index (the
 * INTEGER PRIMARY KEY AUTOINCREMENT id never collides, and CHECK/FK
 * violations carry their own SQLITE_CONSTRAINT_CHECK/_FOREIGN_KEY codes).
 */
function isSlotConflict(err) {
  return (
    String(err?.code || "").startsWith("SQLITE_CONSTRAINT") &&
    /UNIQUE constraint failed/i.test(String(err?.message || "")) &&
    /automod_case_actions/.test(String(err?.message || ""))
  );
}

/**
 * Validate the shared fields of an intent insert. Returns
 * { ok:true, fields } | { ok:false, error }. `state`/claim fields are
 * supplied by each named wrapper — nothing here decides the state machine.
 */
function normalizeIntent(opts = {}) {
  const communityId = opts.communityId;
  assertCommunityId(communityId);
  const action = String(opts.action ?? "").trim().toLowerCase();
  if (!AUTOMOD_ACTIONS.includes(action)) {
    return {
      ok: false,
      error: `Unknown auto-mod action \`${opts.action ?? ""}\` — choose one of: ${AUTOMOD_ACTIONS.join(", ")}.`,
    };
  }
  const mode = normalizeAutomodMode(opts.mode);
  if (!mode) {
    return {
      ok: false,
      error: `Unknown auto-mod mode \`${opts.mode ?? ""}\` for the action record — choose one of: off, suggest, auto.`,
    };
  }
  let caseId = null;
  if (opts.caseId != null) {
    const n = Number(opts.caseId);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, error: "caseId must be a positive integer (or omitted)." };
    }
    caseId = n;
  }
  return {
    ok: true,
    fields: {
      communityId,
      caseId,
      guildId: normText(opts.guildId),
      subjectUserId: normText(opts.subjectUserId),
      action,
      mode,
      paramsJson: serializeParams(opts.params ?? null),
    },
  };
}

/** The slot tuple a conflict reads back by (case-scoped rows only). */
function getAutomodActionBySlot({ communityId, caseId, subjectUserId, action } = {}) {
  assertCommunityId(communityId);
  const c = Number(caseId);
  if (!Number.isInteger(c) || c < 1) return null;
  const act = String(action ?? "").trim().toLowerCase();
  if (!AUTOMOD_ACTIONS.includes(act)) return null;
  const row = db
    .prepare(
      `SELECT * FROM automod_case_actions
       WHERE community_id=? AND case_id=? AND action=? AND IFNULL(subject_user_id,'')=?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(communityId, c, act, normText(subjectUserId) ?? "");
  return row || null;
}

/**
 * Shared intent insert. `mutate` adds the state/claim columns; on a slot
 * conflict the existing row is returned as `existing` (dedupe, never an
 * error). Without a case_id the UNIQUE index does not apply — the row
 * inserts freely and per-row claims still dedupe later.
 */
function insertIntent(opts, mutate) {
  const norm = normalizeIntent(opts);
  if (!norm.ok) return norm;
  const { communityId, caseId, guildId, subjectUserId, action, mode, paramsJson } =
    norm.fields;
  const at = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : now();
  const extra = mutate({ at });
  try {
    const info = db
      .prepare(
        `INSERT INTO automod_case_actions (
           community_id, case_id, guild_id, subject_user_id, action, mode,
           state, params_json, result_text, error_text,
           claimed_by, claimed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        communityId,
        caseId,
        guildId,
        subjectUserId,
        action,
        mode,
        extra.state,
        paramsJson,
        extra.resultText ?? null,
        extra.errorText ?? null,
        extra.claimedBy ?? null,
        extra.claimedAt ?? null,
        at,
        at,
      );
    return { ok: true, row: getAutomodAction(info.lastInsertRowid) };
  } catch (err) {
    if (isSlotConflict(err)) {
      const existing = getAutomodActionBySlot({
        communityId,
        caseId,
        subjectUserId,
        action,
      });
      if (existing) return { ok: false, deduped: true, existing };
    }
    return {
      ok: false,
      error: `Could not record the auto-mod action (${action}): ${err?.message || err}`,
    };
  }
}

// ── Intent inserts (each is its own atomic slot step) ─────────────────────

/**
 * Record a PENDING SUGGESTION (suggest mode). Not claimed: a later
 * claimAutomodSuggestion/recordAutomodActionResult pair owns it.
 *
 * @param {object} opts
 * @param {number} opts.communityId
 * @param {number|null} [opts.caseId] automod_cases id (#726); slot-deduped when set
 * @param {string|null} [opts.guildId] Discord snowflake, log echo only
 * @param {string|null} [opts.subjectUserId]
 * @param {string} opts.action
 * @param {"off"|"suggest"|"auto"} opts.mode mode AT RECORD TIME
 * @param {object|string|null} [opts.params] pre-run params (executor clamps before insert)
 * @param {number} [opts.nowMs]
 * @returns {{ ok: true, row: object }
 *          | { ok: false, deduped: true, existing: object }
 *          | { ok: false, error: string }}
 */
function insertAutomodActionSuggestion(opts = {}) {
  return insertIntent(opts, () => ({ state: "suggested" }));
}

/**
 * AUTO-MODE CLAIM: the INSERT itself is the single-winner slot (052 ticket-
 * create posture, extended — the state starts at `approved` because the
 * winner OWNS the run). A duplicate (community, case, action, subject) intent
 * violates ux_automod_case_actions_slot and returns the existing row: the
 * re-entry never runs the mutation, it reports what the winner recorded.
 *
 * @param {object} opts same fields as insertAutomodActionSuggestion, plus:
 * @param {string} [opts.claimant] owner label (defaults recorded as-is)
 * @returns {{ ok: true, row: object }
 *          | { ok: false, deduped: true, existing: object }
 *          | { ok: false, error: string }}
 */
function claimAutomodActionSlot(opts = {}) {
  return insertIntent(opts, ({ at }) => ({
    state: "approved",
    claimedBy: String(opts.claimant ?? "auto").trim() || "auto",
    claimedAt: at,
  }));
}

/**
 * Record an immediate REFUSAL row (e.g. the mode gate refused an `off`
 * action). Still a considered row for #731. Slot-deduped like every insert.
 *
 * @param {object} opts same fields as insertAutomodActionSuggestion, plus:
 * @param {string} opts.error the specific refusal reason (staff-facing)
 */
function recordAutomodActionRefusal(opts = {}) {
  const error = normText(opts.error) || "Auto-mod action refused.";
  return insertIntent(opts, () => ({ state: "refused", errorText: error }));
}

// ── Claim / finalize transitions (conditional single-winner UPDATEs) ───────

/**
 * Claim a pending suggestion for execution: one UPDATE gated on
 * `state='suggested'`. Winner owns the row (state becomes `approved`); a
 * second Approve click loses and receives the existing row, so the Discord
 * mutation is never re-run (epic #723: "Approve must claim the action row
 * before calling Discord; a second click returns the existing result").
 *
 * @param {number} actionRowId
 * @param {string} claimant who claimed (staff snowflake / label)
 * @param {{ nowMs?: number }} [opts]
 * @returns {{ ok: true, row: object }
 *          | { ok: false, deduped: true, row: object }
 *          | { ok: false, error: string }}
 */
function claimAutomodSuggestion(actionRowId, claimant, { nowMs = now() } = {}) {
  const id = Number(actionRowId);
  if (!Number.isInteger(id) || id < 1) {
    return { ok: false, error: "actionRowId must be a positive integer." };
  }
  const at = Number.isFinite(Number(nowMs)) ? Number(nowMs) : now();
  const info = db
    .prepare(
      `UPDATE automod_case_actions
       SET state='approved', claimed_by=?, claimed_at=?, updated_at=?
       WHERE id=? AND state='suggested'`,
    )
    .run(String(claimant ?? "staff").trim() || "staff", at, at, id);
  if (info.changes === 1) return { ok: true, row: getAutomodAction(id) };

  const row = getAutomodAction(id);
  if (!row) return { ok: false, error: `No auto-mod action row #${id}.` };
  return { ok: false, deduped: true, row };
}

/**
 * Record the staff DECLINE of a suggestion: single-winner UPDATE on
 * `state='suggested'`. Nothing runs; the row still counts the subject as
 * considered. A second Dismiss click loses and returns the existing row.
 *
 * @param {number} actionRowId
 * @param {string} claimant the dismissing staff member
 * @param {{ note?: string|null, nowMs?: number }} [opts]
 * @returns {{ ok: true, row: object }
 *          | { ok: false, deduped: true, row: object }
 *          | { ok: false, error: string }}
 */
function dismissAutomodSuggestion(actionRowId, claimant, { note = null, nowMs = now() } = {}) {
  const id = Number(actionRowId);
  if (!Number.isInteger(id) || id < 1) {
    return { ok: false, error: "actionRowId must be a positive integer." };
  }
  const at = Number.isFinite(Number(nowMs)) ? Number(nowMs) : now();
  const resultText =
    normText(note) ||
    "Dismissed by staff — the suggested action was not run.";
  const info = db
    .prepare(
      `UPDATE automod_case_actions
       SET state='dismissed', claimed_by=?, claimed_at=?, result_text=?, updated_at=?
       WHERE id=? AND state='suggested'`,
    )
    .run(
      String(claimant ?? "staff").trim() || "staff",
      at,
      resultText,
      at,
      id,
    );
  if (info.changes === 1) return { ok: true, row: getAutomodAction(id) };

  const row = getAutomodAction(id);
  if (!row) return { ok: false, error: `No auto-mod action row #${id}.` };
  return { ok: false, deduped: true, row };
}

/**
 * Finalize a CLAIMED row: the state machine's only exit. Gated on
 * `state='approved'` — an unclaimed row can never be finalized (claim
 * first, mutate second, record third), and the second finalize of a row
 * loses to the first. `executed` carries the post-clamp params and the
 * human-readable result; `refused`/`failed` carry the specific error text.
 *
 * @param {number} actionRowId
 * @param {object} fields
 * @param {"executed"|"refused"|"failed"} fields.state
 * @param {string|null} [fields.resultText] one-line outcome (staff-facing)
 * @param {string|null} [fields.errorText] specific failure/refusal cause
 * @param {object|string|null} [fields.params] EFFECTIVE params (post-clamp)
 * @param {{ nowMs?: number }} [opts]
 * @returns {{ ok: true, row: object }
 *          | { ok: false, deduped: true, row: object }
 *          | { ok: false, error: string }}
 */
function recordAutomodActionResult(
  actionRowId,
  { state, resultText = null, errorText = null, params = null, } = {},
  { nowMs = now() } = {},
) {
  const id = Number(actionRowId);
  if (!Number.isInteger(id) || id < 1) {
    return { ok: false, error: "actionRowId must be a positive integer." };
  }
  if (!["executed", "refused", "failed"].includes(state)) {
    return {
      ok: false,
      error: `Invalid auto-mod action outcome \`${state}\` — expected executed, refused, or failed.`,
    };
  }
  const at = Number.isFinite(Number(nowMs)) ? Number(nowMs) : now();
  const paramsJson = params === null ? null : serializeParams(params);
  const info = db
    .prepare(
      `UPDATE automod_case_actions
       SET state=?,
           result_text=COALESCE(?, result_text),
           error_text=COALESCE(?, error_text),
           params_json=COALESCE(?, params_json),
           updated_at=?
       WHERE id=? AND state='approved'`,
    )
    .run(
      state,
      normText(resultText),
      normText(errorText),
      paramsJson,
      at,
      id,
    );
  if (info.changes === 1) return { ok: true, row: getAutomodAction(id) };

  const row = getAutomodAction(id);
  if (!row) return { ok: false, error: `No auto-mod action row #${id}.` };
  return { ok: false, deduped: true, row };
}

// ── Reads ──────────────────────────────────────────────────────────────────

/**
 * One row by id (params left raw — parse with parseAutomodActionParams).
 * @param {number|string} actionRowId
 * @returns {object|null}
 */
function getAutomodAction(actionRowId) {
  const id = Number(actionRowId);
  if (!Number.isInteger(id) || id < 1) return null;
  return (
    db.prepare(`SELECT * FROM automod_case_actions WHERE id=?`).get(id) || null
  );
}

/**
 * The case's action rows (card + staff-note commit read), in insertion
 * order. `opts.state` optionally filters (unknown state → no rows).
 *
 * @param {number} communityId
 * @param {number} caseId
 * @param {{ state?: string }} [opts]
 * @returns {object[]}
 */
function listAutomodActionsForCase(communityId, caseId, { state = null } = {}) {
  assertCommunityId(communityId);
  const c = Number(caseId);
  if (!Number.isInteger(c) || c < 1) return [];
  if (state != null && !AUTOMOD_ACTION_STATES.includes(state)) return [];
  if (state != null) {
    return db
      .prepare(
        `SELECT * FROM automod_case_actions
         WHERE community_id=? AND case_id=? AND state=?
         ORDER BY id ASC`,
      )
      .all(communityId, c, state);
  }
  return db
    .prepare(
      `SELECT * FROM automod_case_actions
       WHERE community_id=? AND case_id=?
       ORDER BY id ASC`,
    )
    .all(communityId, c);
}

module.exports = {
  AUTOMOD_ACTION_STATES,
  AUTOMOD_CONSIDERED_STATES,
  insertAutomodActionSuggestion,
  claimAutomodActionSlot,
  recordAutomodActionRefusal,
  claimAutomodSuggestion,
  dismissAutomodSuggestion,
  recordAutomodActionResult,
  getAutomodAction,
  getAutomodActionBySlot,
  listAutomodActionsForCase,
  parseAutomodActionParams,
};
