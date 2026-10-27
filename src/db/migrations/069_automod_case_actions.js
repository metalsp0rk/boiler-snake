/**
 * Auto-moderation case-action ledger (#729, epic #723).
 *
 * One row per action a case took, was suggested to take, or refused to
 * take against a considered user. This is the durable intent/commit record
 * the executor (src/features/automod/executor.js) claims and finalizes —
 * the automod sibling of the atomic ticket-create slot (052: the INSERT /
 * conditional UPDATE itself is the single-winner claim, so a double Approve
 * click or an auto re-entry can never re-run a Discord mutation).
 *
 * Schema notes:
 *  - Keyed by `community_id` (034 posture, FK to `communities(id)` like the
 *    062/063 precedent — CASCADE clears a deleted community's ledger); the
 *    Discord snowflake is kept in `guild_id` purely for log/reply echo.
 *  - `case_id` is a NULLABLE plain INTEGER with NO foreign key: the
 *    `automod_cases` table ships in the concurrent referral issue (#726);
 *    this ledger must land first and links by value, never by constraint.
 *  - `action` CHECK mirrors AUTOMOD_ACTIONS (repositories/automodSettings)
 *    and `state` CHECK pins the six-row state machine owned by
 *    repositories/automodCaseActions (suggested/approved/dismissed/
 *    executed/refused/failed). Every recorded row means the subject was
 *    CONSIDERED (#731's staff-note feed), which is why there is no
 *    separate considered column: the row's existence IS the flag.
 *  - `claimed_by` + `claimed_at` are the execution slot (who runs it and
 *    when — mirroring the 052 reservation); transitions only fire under a
 *    `WHERE state=?` guard, which is the single-winner UPDATE.
 *  - `ux_automod_case_actions_slot`: with a real `case_id` the
 *    (community, case, action, subject) tuple is unique — the auto-mode
 *    claim INSERT is the dedupe, so re-entry reads the existing outcome
 *    instead of double-mutating. Rows recorded WITHOUT a case (case tables
 *    land in #726) skip the slot: the per-row claim still dedupes them.
 *
 * @param {import("better-sqlite3").Database} db
 */
function up(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS automod_case_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  case_id INTEGER,
  guild_id TEXT,
  subject_user_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('no_action','warn','delete_message','ticket','timeout','kick','ban')),
  mode TEXT NOT NULL CHECK (mode IN ('off','suggest','auto')),
  state TEXT NOT NULL DEFAULT 'suggested' CHECK (state IN ('suggested','approved','dismissed','executed','refused','failed')),
  params_json TEXT,
  result_text TEXT,
  error_text TEXT,
  claimed_by TEXT,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automod_case_actions_case
  ON automod_case_actions(community_id, case_id)
 WHERE case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automod_case_actions_subject
  ON automod_case_actions(community_id, subject_user_id)
 WHERE subject_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_automod_case_actions_slot
  ON automod_case_actions(community_id, case_id, action, IFNULL(subject_user_id,''))
 WHERE case_id IS NOT NULL;
`);
}

module.exports = { id: "069_automod_case_actions", up };
