/**
 * Channel bridge schema (roadmap/bridge.md § Data Model Changes) — six tables
 * for the Discord ↔ Fluxer channel bridge:
 *
 *   bridges               the pairing state machine (pending → active → broken)
 *   bridge_ends           the two channel ends; UNIQUE (community_id, channel_id)
 *                         makes the 1:1 rule true under races (KD 2)
 *   bridge_outbox         durable relay queue, FIFO per direction (KD 14)
 *   bridge_message_links  src→dst id map (edit/delete relay + echo gate)
 *   bridge_src_snapshots  edit-coalescing content hashes (§10.10)
 *   bridge_connect_attempts  well-formed-miss rate limit (§10.1)
 *
 * The DDL is the spec's, verbatim, table for table, with `IF NOT EXISTS`
 * added for the house idempotency rule (migrations re-run on every boot).
 * `REFERENCES` clauses document intent only — foreign keys are treated as
 * documentation here (spec § Background & Motivation), so every delete path
 * is an explicit child-then-parent transaction in
 * src/db/repositories/bridges.js, never a bare parent delete (the 034 lesson:
 * an orphan end pins UNIQUE (community_id, channel_id) forever).
 *
 * `up` refuses to run without the `communities` table (034): bridge ends are
 * (community_id, channel_id) pairs, and a bridge schema created on a DB where
 * 034 never ran would hold unscoped rows that no adapter can ever resolve.
 * A mis-ordered migration must fail loudly, not create an unfixable schema.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function }} helpers
 */

const CREATE_BRIDGES_SQL = `
CREATE TABLE IF NOT EXISTS bridges (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'broken')),
  direction TEXT NOT NULL DEFAULT 'both'
    CHECK (direction IN ('both', 'a_to_b', 'b_to_a')),   -- a = create side (KD 19)
  created_at INTEGER NOT NULL,
  expires_at INTEGER,               -- connect enforces this itself; sweeper GCs pending rows
  connected_at INTEGER,
  code_hash BLOB,                   -- SHA-256(canonical code); kept on active rows until disconnect
  created_by_user_id TEXT NOT NULL, -- external id, scoped by end A community; display-only
  last_error TEXT,
  broken_reason TEXT
);
`;

const CREATE_BRIDGE_ENDS_SQL = `
CREATE TABLE IF NOT EXISTS bridge_ends (
  bridge_id INTEGER NOT NULL REFERENCES bridges(id),
  position TEXT NOT NULL CHECK (position IN ('a', 'b')),
  community_id INTEGER NOT NULL REFERENCES communities(id),
  channel_id TEXT NOT NULL,
  webhook_id TEXT,
  webhook_token_enc TEXT,           -- AES-256-GCM envelope; never plaintext
  upload_limit_bytes INTEGER,
  nsfw INTEGER NOT NULL DEFAULT 0,
  everyone_denied_view INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bridge_id, position),
  UNIQUE (community_id, channel_id) -- a channel is in at most one bridge
);
`;

const CREATE_BRIDGE_OUTBOX_SQL = `
CREATE TABLE IF NOT EXISTS bridge_outbox (
  id INTEGER PRIMARY KEY,
  bridge_id INTEGER NOT NULL REFERENCES bridges(id),
  direction TEXT NOT NULL CHECK (direction IN ('a_to_b', 'b_to_a')),
  kind TEXT NOT NULL DEFAULT 'create'
    CHECK (kind IN ('create', 'edit', 'delete')),
  src_message_id TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  state TEXT NOT NULL,              -- pending | sending | done | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,       -- metadata + attachment descriptors; no CDN URLs,
                                    -- no tokens, no credential
  dest_message_id TEXT,             -- first destination execute only; full set in links
  last_error TEXT,
  UNIQUE (bridge_id, direction, src_message_id, kind)
);
`;

const CREATE_BRIDGE_MESSAGE_LINKS_SQL = `
CREATE TABLE IF NOT EXISTS bridge_message_links (
  bridge_id INTEGER NOT NULL,
  src_community_id INTEGER NOT NULL,
  src_message_id TEXT NOT NULL,
  part_index INTEGER NOT NULL,      -- 0-based chunk / overflow-file execute
  dst_message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bridge_id, src_community_id, src_message_id, part_index)
);
`;

const CREATE_BRIDGE_SRC_SNAPSHOTS_SQL = `
CREATE TABLE IF NOT EXISTS bridge_src_snapshots (
  bridge_id INTEGER NOT NULL,
  src_message_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,       -- SHA-256 of the canonical relay payload
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bridge_id, src_message_id)
);
`;

const CREATE_BRIDGE_CONNECT_ATTEMPTS_SQL = `
CREATE TABLE IF NOT EXISTS bridge_connect_attempts (
  community_id INTEGER PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  failures INTEGER NOT NULL
);
`;

// Claim-path support: the worker reads FIFO per (bridge_id, direction) over
// queued rows only (spec §10.10 "FIFO per direction"); the covering order
// (state first) keeps the hot claim query an index scan.
const BRIDGE_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_bridge_outbox_queue
  ON bridge_outbox (bridge_id, direction, state, enqueued_at);
`;

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function }} helpers
 * @returns {{ migrated: boolean }}
 */
function up(db, { tableExists }) {
  if (!tableExists("communities")) {
    throw new Error(
      "035_bridges: the 'communities' table is missing — migration 034_communities must run first; " +
        "bridge ends are (community_id, channel_id) pairs and must never be created unscoped",
    );
  }

  // One transaction: the six tables land together or not at all, so a crash
  // mid-migration cannot leave a half-schema for a later boot to trip over.
  const run = db.transaction(() => {
    db.exec(CREATE_BRIDGES_SQL);
    db.exec(CREATE_BRIDGE_ENDS_SQL);
    db.exec(CREATE_BRIDGE_OUTBOX_SQL);
    db.exec(CREATE_BRIDGE_MESSAGE_LINKS_SQL);
    db.exec(CREATE_BRIDGE_SRC_SNAPSHOTS_SQL);
    db.exec(CREATE_BRIDGE_CONNECT_ATTEMPTS_SQL);
    db.exec(BRIDGE_INDEXES_SQL);
  });
  run();

  return { migrated: true };
}

module.exports = { id: "035_bridges", up };
