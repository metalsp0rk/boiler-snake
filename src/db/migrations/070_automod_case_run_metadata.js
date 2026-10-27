/**
 * Auto-moderation case RUN METADATA columns (#728, epic #723).
 *
 * The LLM harness owns the case pipeline (recorded→processing→complete/
 * failed, 068) and must persist per-run provider metadata ON the case row
 * itself (contract #728: "Persist provider metadata on the case (model,
 * duration, tool names)"). These columns are written ONLY by the harness
 * (`src/features/automod/harness.js`) plus the boot sweep for runs a
 * restart interrupted.
 *
 * Deliberately NOT persisted (contract, verbatim): the raw chain of
 * thought. Duplicating Gork's interaction-log transcript store was
 * explicitly ruled out — a SHORT STRUCTURED decision log
 * (`decision_log`, JSON array of {seq, tool, args_summary, state,
 * result_or_error}) is the durable record of what the judge DID; staff
 * notes hold the human record of what it CONCLUDED (locked decision 4).
 *
 * Column notes (harness-owned naming, documented per the issue):
 *  - `last_model`         — provider model id the last run used (NULL when
 *                           no provider call was ever attempted, e.g. AI
 *                           not configured).
 *  - `last_duration_ms`   — wall-clock ms of the last run (claim → finish).
 *  - `last_tool_names`    — JSON array of distinct tool names the last run
 *                           called, first-call order (["read_warnings","warn",
 *                           "write_staff_note"]).
 *  - `decision_log`       — JSON array [{seq, tool, args_summary, state,
 *                           result_or_error}]; state ∈ read_ok | read_error
 *                           | recorded | refused | _log_truncated. NOT a
 *                           transcript copy (no message bodies, no chain).
 *  - `last_run_error`     — the last run's failure/problem cause verbatim
 *                           ("HTTP 500 …", "tool-round cap (12) reached",
 *                           "run interrupted by restart"); NULL on a clean
 *                           run. A round-cap run still finishes `complete`
 *                           (it committed) yet keeps its cause here.
 *
 * Posture: pure `addColumnIfMissing` appends (065/067 family) — idempotent
 * replay is a no-op, and old rows read the new columns as NULL (a case run
 * before this migration simply has no metadata). The 068-order guard mirrors
 * the 034-guard posture: these columns live ON `automod_cases`, so the
 * table must exist first.
 *
 * @param {import("better-sqlite3").Database} _db
 * @param {{ tableExists: Function, getColumns: Function, addColumnIfMissing: Function }} helpers
 */
function up(_db, { tableExists, addColumnIfMissing }) {
  if (!tableExists("automod_cases")) {
    throw new Error(
      "070_automod_case_run_metadata: the 'automod_cases' table is missing — migration 068_automod_cases must run first; " +
        "run metadata are columns ON the case row and can never exist without it",
    );
  }
  addColumnIfMissing("automod_cases", "last_model", "last_model TEXT");
  addColumnIfMissing("automod_cases", "last_duration_ms", "last_duration_ms INTEGER");
  addColumnIfMissing("automod_cases", "last_tool_names", "last_tool_names TEXT");
  addColumnIfMissing("automod_cases", "decision_log", "decision_log TEXT");
  addColumnIfMissing("automod_cases", "last_run_error", "last_run_error TEXT");
}

module.exports = { id: "070_automod_case_run_metadata", up };
