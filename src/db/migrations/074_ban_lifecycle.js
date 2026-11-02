/**
 * Ban lifecycle records (#772) + the two notification toggles.
 *
 * One durable row per ban cycle (guild, user, moderator, source, reason,
 * banned_at, expires_at NULL = permanent, status, DM flags). Discord bans
 * have no native duration — the expiry ticker, the auto-unban claim, and the
 * welcome-back path all key off THIS row, and the manual-unban event path
 * flows through the same record ("events keep the record truthful").
 *
 * - `UNIQUE (community_id, ban_number)` (named index, unlike 068's table
 *   constraint, so the repository's error path can name it): the B-n
 *   allocation belt — the repository assigns MAX+1 inside a transaction
 *   (warnings.nextWarningNumber posture), the constraint makes a
 *   double-allocation impossible even across callers.
 * - Partial UNIQUE on (community_id, user_id) WHERE status='active': ONE
 *   active ban per user per community at the SCHEMA level. The service runs
 *   the duplicate guard first for the friendly refusal; this index is the
 *   race-proof belt (a concurrent insert can never double-active).
 * - `source` is the audit split the issue demands: `staff` (/ban + context
 *   menu) vs `automod` (the #738 harness executing through the same ban
 *   service). CHECK keeps the vocabulary closed until a migration widens it.
 * - `status` vocabulary (migration 074 CHECK):
 *     `active`            ban in force (the only row the partial UNIQUE admits)
 *     `expired_unbanned`  the expiry ticker lifted the ban
 *     `unbanned_manual`   lifted outside this bot (event path) or by staff
 *     `pending_rejoin`    unbanned, welcome DM not delivered — retry on rejoin
 *     `welcomed`          rejoin welcome attempt made (regardless of outcome)
 *   The machine is APPEND-ONLY: SQLite cannot widen a CHECK in place, so
 *   #773 adds `clemency_granted` via a NEW migration (rebuild or table
 *   amendment), never by editing this file. The record `id` is stable by
 *   contract — #773 keys appeals as `appeal:<banRecordId>`, so ids are never
 *   renumbered or reused. BAN_RECORD_STATUSES in
 *   src/db/repositories/banRecords.js mirrors this CHECK (single source for
 *   code; this file stays single source for SQL).
 * - Notification flags (`ban_dm_sent`, `welcome_dm_sent`) are 0/1 stamps:
 *   "one ban DM per cycle, one welcome per cycle" is claim-row law, not
 *   event-ordering luck.
 *
 * Same migration lands the two per-guild toggles (009's warn_dm_members
 * family — default ON: non-destructive notices, flippable at any time):
 * - `ban_dm`: send the "you were banned, expires <t:F> (<t:R>)" DM BEFORE
 *   the ban executes (DM law K2: while the shared-guild DM path exists).
 * - `welcome_back_dm`: send the welcome-back DM on any tracked unban.
 *
 * FK posture mirrors 068_automod_cases: real `ON DELETE CASCADE` (community
 * rows own their ban records) with the 034 ordering guard — a ban record
 * must never exist unscoped.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function, addColumnIfMissing: Function }} helpers
 */
function up(db, { tableExists, addColumnIfMissing }) {
  if (!tableExists("communities")) {
    throw new Error(
      "074_ban_lifecycle: the 'communities' table is missing — migration 034_communities must run first; " +
        "ban records are community-scoped rows and must never be created unscoped",
    );
  }

  db.exec(`
CREATE TABLE IF NOT EXISTS ban_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  ban_number INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT,
  source TEXT NOT NULL DEFAULT 'staff'
    CHECK (source IN ('staff','automod')),
  reason TEXT NOT NULL,
  banned_at INTEGER NOT NULL,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','expired_unbanned','unbanned_manual','pending_rejoin','welcomed')),
  ban_dm_sent INTEGER NOT NULL DEFAULT 0,
  welcome_dm_sent INTEGER NOT NULL DEFAULT 0,
  unban_claimed_at INTEGER,
  unban_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ban_records_number
  ON ban_records(community_id, ban_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ban_records_active
  ON ban_records(community_id, user_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_ban_records_user
  ON ban_records(community_id, user_id, banned_at DESC);
CREATE INDEX IF NOT EXISTS idx_ban_records_due
  ON ban_records(expires_at) WHERE status='active';
`);

  addColumnIfMissing(
    "guild_settings",
    "ban_dm",
    "ban_dm INTEGER NOT NULL DEFAULT 1",
  );
  addColumnIfMissing(
    "guild_settings",
    "welcome_back_dm",
    "welcome_back_dm INTEGER NOT NULL DEFAULT 1",
  );
}

module.exports = { id: "074_ban_lifecycle", up };
