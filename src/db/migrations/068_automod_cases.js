/**
 * Auto-moderation case records (#726, epic #723).
 *
 * One row per staff referral — the ONLY way a case starts (locked decision
 * 1: nothing in message-create opens a case; members have no command). The
 * intake path (slash `/automod refer` and the "Refer to automod" message
 * context menu) writes the row with status `recorded` and the ack replies
 * **A-n** — the per-community sequential display number, the same human-ref
 * idea as **N-n** staff notes and **T-n** tickets (067 kept the settings
 * family on guild_settings; cases are rows, so they get a real table).
 *
 * - `UNIQUE (community_id, case_number)`: the allocation belt. The repository
 *   assigns MAX+1 inside a transaction (staffNotes.nextNoteNumber posture);
 *   better-sqlite3 is a synchronous single writer, and the constraint makes a
 *   double-allocation impossible even if two callers interleave in a future
 *   multi-process world.
 * - `message_id` / `channel_id` (the referred message and the channel it
 *   lived in) and `target_user_id` are each nullable — a referral needs at
 *   least ONE of message/user (enforced by the referral service, not the
 *   schema: a user-only referral legitimately stores NULL message fields).
 * - `note` is the REFERRER'S explanation — case INPUT for the harness
 *   (#728). It is deliberately NOT a `staff_notes` row: the referrer is not a
 *   subject merely because they filed (contract #726), and staff notes are
 *   written by the harness for considered users only (locked decision 4).
 * - `status` vocabulary (minimal — the harness issue owns the pipeline):
 *     `recorded`   intake done, queued for the harness (only #726 writes it)
 *     `processing` a harness run claimed the case (#728 claim seam)
 *     `complete`   the run finished and its outcome was recorded (#728)
 *     `failed`     terminal: the case can never be judged (#728)
 *   #726 NEVER moves a case out of `recorded`; the executor state lives with
 *   the case-actions table owned by the sibling issue, NOT in this column.
 *
 * FK posture mirrors 062_rss_feeds: real `ON DELETE CASCADE` (community rows
 * own their cases) with the 034 ordering guard — a case must never exist
 * unscoped.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function }} helpers
 */
function up(db, { tableExists }) {
  if (!tableExists("communities")) {
    throw new Error(
      "068_automod_cases: the 'communities' table is missing — migration 034_communities must run first; " +
        "cases are community-scoped rows and must never be created unscoped",
    );
  }

  db.exec(`
CREATE TABLE IF NOT EXISTS automod_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  case_number INTEGER NOT NULL,
  referrer_user_id TEXT NOT NULL,
  message_id TEXT,
  channel_id TEXT,
  target_user_id TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('recorded','processing','complete','failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (community_id, case_number)
);
CREATE INDEX IF NOT EXISTS idx_automod_cases_status
  ON automod_cases(community_id, status);
CREATE INDEX IF NOT EXISTS idx_automod_cases_recent
  ON automod_cases(community_id, created_at DESC);
`);
}

module.exports = { id: "068_automod_cases", up };
