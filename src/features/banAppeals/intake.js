/**
 * Ban appeals — VALIDATION CORE (#773 §1 + locked decision 6).
 *
 * The intake battery every press and every modal submit must pass BEFORE
 * anything is filed. Pure decision logic: NO Discord objects ever enter or
 * leave, and every storage read is an injectable dep (defaults resolve the
 * db facade lazily at CALL time, banService posture — requiring this module
 * with injected deps never opens SQLite). Filing orchestration (open the
 * ticket, post the header) is subtask 04; it codes against THESE result
 * shapes.
 *
 * Decision-code enum (INTAKE_CODES — the single source later tasks match
 * on; values are stable strings, never re-spelled inline):
 *
 *   OK                the press/submit passed the whole battery — proceed
 *   NOT_YOU           presser/submitter is not the record's banned member
 *                     (stale or forged press) — or carried no identity
 *   NO_RECORD         no ban record behind the id: gone, or the ban was
 *                     never tracked by #772 (honeypot/external = no record =
 *                     no appeal path, issue "Known gaps"), or the id is a
 *                     cross-community forgery (answered as if gone — a
 *                     forged probe never learns the other row exists)
 *   NOT_ACTIVE        record exists but the ban is no longer `active`
 *   APPEALS_OFF       the guild's `ban_appeals` toggle is off
 *   ALREADY_FILED     one appeal per ban cycle — result.appeal carries the
 *                     LIVE row (status keys the copy: filed/open/granted/
 *                     denied/closed)
 *   DB_ERROR          a storage read threw — result.error carries the
 *                     specific cause (AGENTS.md rule 3), never a generic
 *   MISSING_STATEMENT modal submit without the required statement
 *   STATEMENT_TOO_LONG statement over MAX_APPEAL_STATEMENT (modal clamps
 *                     first; this is the belt)
 *
 * There is deliberately NO untracked-guild code: the record itself carries
 * `community_id`, so a GUILDESS presser (banned users cannot resolve a
 * guild context) resolves everything through the record — a ban with no
 * record has no appeal lane at all and reads as NO_RECORD.
 *
 * Every failure result carries `error`: the SPECIFIC ephemeral refusal copy
 * (constants.js builders — never generic, always "Nothing was filed.").
 * The CALLER logs it as `[appeals] <what> refused: code=… record=… user=…`
 * with the guild/user/record ids and replies it ephemerally with
 * allowedMentions {parse: []} — the validator performs neither.
 */

const {
  LOG_PREFIX, // re-exported so the caller's log lines share one grep
  refusalNotYou,
  refusalNoRecord,
  refusalNotActive,
  refusalAppealsOff,
  refusalAlreadyFiled,
  refusalMissingStatement,
  refusalStatementTooLong,
  refusalValidationFailed,
} = require("./constants");

/* ── decision codes (assigned consts — the colon-literal object form trips
 * the env-parity SCREAMING-literal scan; banAppeals.js fileAppeal pins the
 * same law) ─────────────────────────────────────────────────────────────── */

const CODE_OK = "OK";
const CODE_NOT_YOU = "NOT_YOU";
const CODE_NO_RECORD = "NO_RECORD";
const CODE_NOT_ACTIVE = "NOT_ACTIVE";
const CODE_APPEALS_OFF = "APPEALS_OFF";
const CODE_ALREADY_FILED = "ALREADY_FILED";
const CODE_DB_ERROR = "DB_ERROR";
const CODE_MISSING_STATEMENT = "MISSING_STATEMENT";
const CODE_STATEMENT_TOO_LONG = "STATEMENT_TOO_LONG";

/** The enum every caller matches against (frozen — never mutate at runtime). */
const INTAKE_CODES = Object.freeze({
  OK: CODE_OK,
  NOT_YOU: CODE_NOT_YOU,
  NO_RECORD: CODE_NO_RECORD,
  NOT_ACTIVE: CODE_NOT_ACTIVE,
  APPEALS_OFF: CODE_APPEALS_OFF,
  ALREADY_FILED: CODE_ALREADY_FILED,
  DB_ERROR: CODE_DB_ERROR,
  MISSING_STATEMENT: CODE_MISSING_STATEMENT,
  STATEMENT_TOO_LONG: CODE_STATEMENT_TOO_LONG,
});

/* ── dependency seams ─────────────────────────────────────────────────────── */

/**
 * Lazy db access (call time, never require time — #699 load-cycle law,
 * banService exemplar). A non-integer community id stays a programmer error
 * INSIDE the repositories; the validator only ever feeds them the record's
 * own stored community_id.
 */
const dbApi = () => require("../../db");

/**
 * Normalize the caller's deps. Defaults are the shipped reads; tests inject
 * plain doubles and unit-run the whole battery with zero SQLite.
 *
 * @param {object} [deps]
 * @param {(id: number) => object|null} [deps.getBanRecord]
 * @param {(communityId: number, banRecordId: number) => object|null} [deps.getAppealByBanRecord]
 * @param {(communityId: number) => { ok: boolean, enabled?: boolean, error?: string }} [deps.appealsGate]
 * @param {number} [deps.maxStatementLength]
 * @param {() => number} [deps.now]
 */
function resolveDeps(deps = {}) {
  return {
    getBanRecord:
      deps.getBanRecord || ((id) => dbApi().getBanRecord(id)),
    getAppealByBanRecord:
      deps.getAppealByBanRecord ||
      ((communityId, banRecordId) =>
        dbApi().getAppealByBanRecord(communityId, banRecordId)),
    // The toggle read rides the settings seam (single source for the
    // default-ON posture: Number(ban_appeals ?? 1) !== 0).
    appealsGate:
      deps.appealsGate ||
      ((communityId) => {
        const read = require("./settings").readSettings(communityId);
        if (!read.ok) return { ok: false, error: read.error };
        return { ok: true, enabled: read.settings.appealsEnabled };
      }),
    // LEFT NULL on purpose: the cap lives in the repository (single truth);
    // resolve it at USE time, so a fully-injected test never touches the
    // db facade — resolveDeps itself must stay SQLite-free.
    maxStatementLength:
      deps.maxStatementLength != null ? Number(deps.maxStatementLength) : null,
    now: deps.now || (() => Date.now()),
  };
}

/** Statement cap: the repository's truth, read only when actually needed. */
function statementCap(d) {
  return d.maxStatementLength != null
    ? d.maxStatementLength
    : dbApi().MAX_APPEAL_STATEMENT;
}

/* ── shape helpers (pure) ─────────────────────────────────────────────────── */

/**
 * Positive-integer coercion for a parsed customId payload; else null.
 * isSafeInteger, not isInteger: a forged 1e24-id would pass the shape as a
 * JS float and die at the SQLite bind — garbage belongs at the shape gate
 * (NO_RECORD), not inside a read.
 */
function positiveIntOrNull(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** Failure result builder (refusal copy is the user-facing `error`). */
function fail(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

/** Storage-failure result: specific cause quoted, never a generic. */
function dbFail(what, err, extra = {}) {
  return fail(
    CODE_DB_ERROR,
    refusalValidationFailed(what, String(err?.message || err || "read failed")),
    extra,
  );
}

/* ── the press battery ────────────────────────────────────────────────────── */

/**
 * Validate an `appeal:<recordId>` BUTTON PRESS before the statement modal
 * opens. Battery order (each failure short-circuits with its own specific
 * refusal — locked decision 6: stale/forged presses get named, logged
 * refusals, never a generic drop):
 *
 *   id shape → record exists (+ community consistency) → presser identity →
 *   ban still active → guild toggle ON → no appeal filed for the cycle yet
 *
 * The OK result hands the caller everything filing needs: the live record,
 * the record's community (guildless pressers resolve community ONLY through
 * the row) and the parsed id.
 *
 * @param {object} input
 * @param {number|string} input.banRecordId parsed digits-only record id
 *        (constants.js parseAppealPressRecordId already stripped the customId)
 * @param {string|null} [input.pressingUserId] the guildless interaction's user id
 * @param {number|string|null} [input.communityId] OPTIONAL caller-side claim;
 *        present and different from the record's community reads as NO_RECORD
 * @param {object} [input.deps] test seams (see resolveDeps)
 * @returns {{ ok: true, code: "OK", communityId: number, banRecordId: number, record: object }
 *          | { ok: false, code: string, error: string, record?: object, appeal?: object }}
 */
function validateAppealPress(input = {}) {
  const d = resolveDeps(input.deps);
  const banRecordId = positiveIntOrNull(input.banRecordId);
  const pressingUserId = String(input.pressingUserId ?? "").trim();

  // A garbage id and a stripped record are the same honest answer: there is
  // no tracked ban behind this link. A press with no identity is never OK.
  if (banRecordId == null) return fail(CODE_NO_RECORD, refusalNoRecord());
  if (pressingUserId === "") return fail(CODE_NOT_YOU, refusalNotYou());

  let record = null;
  try {
    record = d.getBanRecord(banRecordId) || null;
  } catch (err) {
    return dbFail("ban record lookup", err, { banRecordId });
  }
  if (!record) return fail(CODE_NO_RECORD, refusalNoRecord());

  const recordCommunity = Number(record.community_id);
  if (
    input.communityId != null &&
    Number(input.communityId) !== recordCommunity
  ) {
    // Cross-community forged id: answered as if the record were GONE — a
    // probe learns nothing beyond "this link is dead here".
    return fail(CODE_NO_RECORD, refusalNoRecord());
  }

  // Presser identity is the record's, not the interaction's (the ban DM
  // went to this user; anyone else's press is stale or forged).
  if (String(record.user_id ?? "") !== pressingUserId) {
    return fail(CODE_NOT_YOU, refusalNotYou(), {
      record,
      communityId: recordCommunity,
      banRecordId,
    });
  }

  // Only an ACTIVE ban is appealable (lifted/expired/decided cycles closed
  // their window — the status machine's word is the row's, not ours).
  if (record.status !== "active") {
    return fail(CODE_NOT_ACTIVE, refusalNotActive(), {
      record,
      communityId: recordCommunity,
      banRecordId,
    });
  }

  // Per-guild intake gate (default ON — migration 075 + settings seam).
  let gate = null;
  try {
    gate = d.appealsGate(recordCommunity);
  } catch (err) {
    return dbFail("appeals setting read", err, {
      record,
      communityId: recordCommunity,
      banRecordId,
    });
  }
  if (!gate || gate.ok !== true) {
    return dbFail(
      "appeals setting read",
      gate?.error || "no result from the appeals gate",
      { record, communityId: recordCommunity, banRecordId },
    );
  }
  if (!gate.enabled) {
    return fail(CODE_APPEALS_OFF, refusalAppealsOff(), {
      record,
      communityId: recordCommunity,
      banRecordId,
    });
  }

  // One appeal per ban cycle — read BEFORE filing so the refusal names the
  // live appeal's status (the 075 UNIQUE stays the race-proof belt when two
  // presses sail past this check together).
  let existing = null;
  try {
    existing = d.getAppealByBanRecord(recordCommunity, banRecordId) || null;
  } catch (err) {
    return dbFail("existing appeal lookup", err, {
      record,
      communityId: recordCommunity,
      banRecordId,
    });
  }
  if (existing) {
    return fail(CODE_ALREADY_FILED, refusalAlreadyFiled(existing.status), {
      record,
      appeal: existing,
      communityId: recordCommunity,
      banRecordId,
    });
  }

  return { ok: true, code: CODE_OK, communityId: recordCommunity, banRecordId, record };
}

/* ── the modal-submit battery ─────────────────────────────────────────────── */

/**
 * Validate an `appeal:s:<recordId>` MODAL SUBMIT. Runs the FULL press
 * battery again first — settings can flip, and another press can file the
 * cycle's single appeal, between press and submit; the durable-id modal has
 * no token store to age out, so the DATABASE is the one-shot (uniqueness
 * enforced by the 075 UNIQUE, honesty enforced here). Statement rules then
 * apply: presence is required (verbatim into the ticket header, issue §1),
 * the cap is MAX_APPEAL_STATEMENT (the modal clamps first; this is the
 * belt).
 *
 * @param {object} input validateAppealPress input + `statement` (raw modal text)
 * @returns {{ ok: true, code: "OK", communityId: number, banRecordId: number, record: object, statement: string, nowMs: number }
 *          | { ok: false, code: string, error: string, record?: object, appeal?: object }}
 */
function validateModalSubmission(input = {}) {
  const press = validateAppealPress(input);
  if (!press.ok) return press;

  const d = resolveDeps(input.deps);
  const statement = String(input.statement ?? "").trim();
  if (statement === "") {
    return fail(CODE_MISSING_STATEMENT, refusalMissingStatement(), {
      record: press.record,
      communityId: press.communityId,
      banRecordId: press.banRecordId,
    });
  }
  const maxStatement = statementCap(d);
  if (statement.length > maxStatement) {
    return fail(
      CODE_STATEMENT_TOO_LONG,
      refusalStatementTooLong(maxStatement),
      {
        record: press.record,
        communityId: press.communityId,
        banRecordId: press.banRecordId,
      },
    );
  }

  return { ...press, statement, nowMs: d.now() };
}

module.exports = {
  LOG_PREFIX,
  INTAKE_CODES,
  // individual codes (tests + callers may import any subset):
  CODE_OK,
  CODE_NOT_YOU,
  CODE_NO_RECORD,
  CODE_NOT_ACTIVE,
  CODE_APPEALS_OFF,
  CODE_ALREADY_FILED,
  CODE_DB_ERROR,
  CODE_MISSING_STATEMENT,
  CODE_STATEMENT_TOO_LONG,
  validateAppealPress,
  validateModalSubmission,
};
