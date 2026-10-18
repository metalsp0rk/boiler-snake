/**
 * Reaction-role claims (#433, audit E2-09).
 *
 * Removing a reaction stripped the option's role whenever the member held
 * it — with NO refcount over the SAME role granted by other panels. Panel
 * deploy copies options between panels as a first-class flow ("Copied N
 * options"), so: claim 🎮→role X on panels A and B, un-react on A → role X
 * revoked although B's claim still stood. Neither platform could answer
 * "does this user still react on panel B?" without a GET the Fluxer REST
 * surface does not have (reactions are PUT/DELETE-only there), so the claim
 * itself gets a durable row: written whenever an option reaction is
 * accepted, deleted on un-react, and pruned when the option or panel goes
 * away. The strip path checks remaining claims JOINed against live options
 * before touching the role (mirrors the events refcount pattern).
 *
 * @param {import("better-sqlite3").Database} db
 */
function up(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS reaction_role_claims (
  community_id INTEGER NOT NULL REFERENCES communities(id),
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  emoji_key TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id, message_id, emoji_key)
);
CREATE INDEX IF NOT EXISTS idx_rrc_user
  ON reaction_role_claims(community_id, user_id);
`);
}

module.exports = { id: "051_reaction_role_claims", up };
