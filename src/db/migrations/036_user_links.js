/**
 * Account-linking schema (roadmap/account-linking.md, design bundle § Data
 * model — T1): two tables that relate ONE Discord-side identity to ONE
 * Fluxer-side identity inside bridge-paired communities:
 *
 *   user_links       the linked pair (side a ↔ side b) with per-direction XP
 *                    mirror percentages and the gork-memory mirror switch
 *   user_link_codes  one-time, hashed, expiring pairing codes minted by
 *                    `link create` and consumed by `link connect` (single use)
 *
 * The DDL is the design bundle's, verbatim, with `IF NOT EXISTS` added for the
 * house idempotency rule (migrations re-run on every boot).
 *
 * `community_id_a` / `community_id_b` reference `communities(id)` (034) by
 * convention — same documentation-only FK stance as 035_bridges: the identity
 * firewall (src/platform/community.js) guarantees every caller resolves the
 * INTEGER community id first, and a `user_links` row is the ONLY structure
 * allowed to relate a Discord snowflake to a Fluxer sub. Raw id strings are
 * never joined across platforms.
 *
 * `code_hash` stores SHA-256 of the canonical plaintext code (mirrors
 * bridges.code_hash, 035_bridges.js): the plaintext is shown once at mint time
 * and never stored. `used_at` is NULL until redeemed — single use is enforced
 * atomically by the repository (UPDATE ... WHERE used_at IS NULL AND
 * expires_at > ?).
 *
 * `up` refuses to run without the `communities` table (034): link rows are
 * (community_id, user_id) pairs, and a linking schema created on a DB where
 * 034 never ran would hold unscoped rows that no adapter can ever resolve.
 * A mis-ordered migration must fail loudly, not create an unfixable schema
 * (the same guard 035_bridges enforces for its ends).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function }} helpers
 */

const CREATE_USER_LINKS_SQL = `
CREATE TABLE IF NOT EXISTS user_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id_a INTEGER NOT NULL,          -- one side (e.g. Discord community)
  user_id_a      TEXT NOT NULL,             -- external user id in that community's platform
  community_id_b INTEGER NOT NULL,          -- other side (e.g. Fluxer community)
  user_id_b      TEXT NOT NULL,
  mirror_a_to_b_pct INTEGER NOT NULL DEFAULT 100,  -- XP earned in A → mirrored to B
  mirror_b_to_a_pct INTEGER NOT NULL DEFAULT 100,
  mirror_memory INTEGER NOT NULL DEFAULT 1,       -- gork memory mirroring on/off
  created_at INTEGER NOT NULL,
  UNIQUE (community_id_a, user_id_a),
  UNIQUE (community_id_b, user_id_b)
);
`;

const CREATE_USER_LINK_CODES_SQL = `
CREATE TABLE IF NOT EXISTS user_link_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,           -- SHA-256 of the plaintext code
  community_id INTEGER NOT NULL,            -- community where the code was CREATED
  user_id TEXT NOT NULL,                    -- external user id at creation side
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,              -- now + 15 min
  used_at INTEGER                           -- NULL until redeemed (single use)
);
`;

// Reverse-lookup support: getLinkFor probes both sides, and a UNIQUE (a, b)
// index cannot serve a user-first lookup, so the (user, community) order is
// the one that matters here. expires_at serves the purge sweeper's range scan.
const USER_LINK_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_user_links_a_lookup
  ON user_links (user_id_a, community_id_a);
CREATE INDEX IF NOT EXISTS idx_user_links_b_lookup
  ON user_links (user_id_b, community_id_b);
CREATE INDEX IF NOT EXISTS idx_user_link_codes_expires_at
  ON user_link_codes (expires_at);
`;

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function }} helpers
 * @returns {{ migrated: boolean }}
 */
function up(db, { tableExists }) {
  if (!tableExists("communities")) {
    throw new Error(
      "036_user_links: the 'communities' table is missing — migration 034_communities must run first; " +
        "link rows are (community_id, user_id) pairs and must never be created unscoped",
    );
  }

  // One transaction: both tables land together or not at all, so a crash
  // mid-migration cannot leave half the linking schema for a later boot.
  const run = db.transaction(() => {
    db.exec(CREATE_USER_LINKS_SQL);
    db.exec(CREATE_USER_LINK_CODES_SQL);
    db.exec(USER_LINK_INDEXES_SQL);
  });
  run();

  return { migrated: true };
}

module.exports = { id: "036_user_links", up };
