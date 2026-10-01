/**
 * Communities table + internal guild key cutover (roadmap/fluxer.md § Data
 * Model Changes, § Cutover "exact, one PR, no dual-read", § PKCE and state).
 *
 * Everything below runs inside ONE db.transaction. Foreign keys are ON by
 * default (better-sqlite3 enables them; src/db/connection.js only sets WAL —
 * the spec's claim that they are off is a verified divergence, see § Cutover),
 * so `up()` toggles PRAGMA foreign_keys OFF around the transaction: a
 * `DROP TABLE` under FK enforcement fires ON DELETE CASCADE/SET NULL on the
 * child tables (ticket_members, ticket_staff, ticket_messages,
 * event_reminder_offsets, warnings.related_note_id) and silently deletes or
 * unlinks their rows. With FK off the rebuild is safe — and every integer PK
 * MUST be copied unchanged (INSERT…SELECT carries `id` through verbatim) so
 * child rows keep pointing at the same real rows without a second mapping.
 * Child tables that have no guild_id (ticket_members, ticket_staff,
 * ticket_messages, event_reminder_offsets) are NOT rebuilt; they stay valid
 * only because parent ids are preserved.
 *
 * Inside the transaction:
 *  1. CREATE TABLE communities — the spec DDL verbatim (platform CHECK,
 *     UNIQUE (platform, instance_key, external_guild_id), both flag columns
 *     NOT NULL DEFAULT 0).
 *  2. Backfill: one row per distinct guild_id found across every guild-scoped
 *     table, platform='discord', instance_key='discord'.
 *  3. Rebuild every guild-scoped table: `guild_id TEXT` becomes
 *     `community_id INTEGER NOT NULL`. The new CREATE TABLE text is derived
 *     from the live sqlite_master DDL, so every column constraint, every
 *     column-level CHECK, every table-level UNIQUE, every default, and the
 *     PK shape is preserved by construction. The legacy global
 *     `tickets.channel_id UNIQUE` dies here, replaced by
 *     `UNIQUE (community_id, channel_id)`. Every named index is re-issued with
 *     community_id substituted; partial WHERE clauses ride along verbatim
 *     because the original index SQL is replayed.
 *  4. Rewrite tickets.transcript_path from `ticket-transcripts/{guild_id}/…`
 *     to `ticket-transcripts/{communityId}/…` (spec § "Global uniqueness that
 *     must die": two deployments must not share a transcript folder).
 *  5. web_sessions identity columns: platform / instance_key NOT NULL DEFAULT
 *     'discord' (existing rows backfill via the default) plus nullable
 *     refresh_token_enc / refresh_expires_at. No Discord refresh flow.
 *  6. fluxer_oauth_transactions (spec lines 919-924) — created here so a later
 *     web PR does not reopen guild identity.
 *
 * AFTER the commit (never inside it) the filesystem side runs:
 * moveTranscriptDirs(mappings) relocates {DATA_DIR}/ticket-transcripts/{guild}
 * → {DATA_DIR}/ticket-transcripts/{communityId}. A failed move for one
 * directory is logged with both paths and NEVER thrown — the DB cutover is
 * already committed and canonical (spec: a partial move is logged, not fatal).
 *
 * This migration never writes a platform='fluxer' row (spec § Cutover 6).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ now: Function, tableExists: Function, getColumns: Function,
 *            addColumnIfMissing: Function }} helpers
 */

const fs = require("fs");
const path = require("path");
const { dataDir: defaultDataDir } = require("../connection");

/**
 * Every table the spec § "Guild-scoped tables" re-keys from guild_id TEXT to
 * community_id INTEGER NOT NULL. Order is irrelevant; each rebuild is fully
 * derived from that table's live DDL.
 */
const GUILD_SCOPED_TABLES = [
  "users",
  "activity_log",
  "voice_sessions",
  "guild_settings",
  "level_roles",
  "role_drop_state",
  "allowed_command_channels",
  "youtube_channels",
  "honeypot_channels",
  "staff_roles",
  "honeypot_ban_roles",
  "reaction_role_panels",
  "reaction_role_options",
  "event_reminder_configs",
  "event_reminder_optouts",
  "event_reminder_event_optouts",
  "staff_notes",
  "warnings",
  "tickets",
  "ticket_panels",
  "user_channel_message_daily",
  "activity_ignore",
  "user_activity_meta",
  "guild_activity_settings",
  "user_channel_backfill_cursor",
  "guild_channel_backfill_cursor",
  "guild_command_permission_oauth",
  "twitch_channels",
  "gork_user_blocks",
  "gork_memories",
  "gork_budget_rules",
  "gork_usage",
  "gork_interactions",
  "github_watches",
  "admin_audit",
];

// Spec § Data Model Changes: DDL copied verbatim (flags default 0 for every
// row including Discord; only the Fluxer outbound ever reads them).
const CREATE_COMMUNITIES_SQL = `
CREATE TABLE IF NOT EXISTS communities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL CHECK (platform IN ('discord', 'fluxer')),
  instance_key TEXT NOT NULL,          -- 'discord', or the normalized Fluxer origin
  external_guild_id TEXT NOT NULL,     -- snowflake that deployment issued
  elevated_permissions INTEGER NOT NULL DEFAULT 0,  -- Phase 0 MFA result, per instance, copied onto rows
  voice_states_complete INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (platform, instance_key, external_guild_id)
);
`;

// Spec § PKCE and state, lines 919-924 (verifier persistence for the future
// Fluxer web login; lands with this migration so no later PR reopens it).
const CREATE_FLUXER_OAUTH_SQL = `
CREATE TABLE IF NOT EXISTS fluxer_oauth_transactions (
  nonce TEXT PRIMARY KEY,          -- the nonce already inside the signed state
  code_verifier TEXT NOT NULL,
  instance_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL      -- min(state exp, now + 10 minutes)
);
`;

/** Temp mapping table (guild snowflake → communities.id), dropped on success. */
const GUILD_MAP_TABLE = "comm034_guild_map";

const quoteIdent = (name) => `"${name}"`;

/**
 * Derive the rebuild CREATE TABLE from the live DDL text so every column
 * constraint, table-level UNIQUE, column CHECK, and default survives verbatim
 * (a DROP TABLE destroys them all otherwise — spec § Cutover 3).
 *
 * @param {string} sql original CREATE TABLE text from sqlite_master
 * @param {string} table current table name
 * @param {string} newName staging name ("{table}_034_new")
 * @returns {string} DDL for the rebuilt table
 */
function transformCreateTableSql(sql, table, newName) {
  // Legacy DBs store some CREATE statements with a QUOTED table name: SQLite's
  // ALTER TABLE ... RENAME rewrites sqlite_master.sql with the target name as
  // a quoted identifier (migration 003's youtube_channels rebuild produces
  // `CREATE TABLE IF NOT EXISTS "youtube_channels"`, which crashed prod on
  // 2026-10-01 because the bare-name regex missed it and the CREATE then hit
  // the ORIGINAL name — "table already exists"). Match every accepted spelling.
  const ident = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const createRe = new RegExp(
    `CREATE TABLE (?:IF NOT EXISTS )?(?:${ident}\\b|"${ident}"|'${ident}'|\`${ident}\`|\\[${ident}\\])`,
    "i",
  );
  let out = sql
    .replace(
      createRe,
      (match) =>
        `${match.replace(table, newName).replace(/ IF NOT EXISTS/i, "")}`,
    )
    // Column definitions. The spec requires community_id NOT NULL on every
    // guild-scoped table, so NOT NULL is added where the source omitted it —
    // including the rowid-alias PKs (`guild_id TEXT PRIMARY KEY`), which
    // SQLite would otherwise let see NULLs auto-assigned a fresh rowid.
    .replace(/\bguild_id\s+TEXT\s+NOT NULL\b/g, "community_id INTEGER NOT NULL")
    .replace(/\bguild_id\s+TEXT\b/g, "community_id INTEGER NOT NULL")
    // Constraint references (PRIMARY KEY / UNIQUE lists)
    .replace(/\bguild_id\b/g, "community_id");

  if (table === "tickets") {
    // Legacy global uniqueness dies (spec § "Global uniqueness that must die"):
    // `channel_id TEXT UNIQUE` → plain column + UNIQUE (community_id, channel_id).
    out = out.replace(/\bchannel_id\s+TEXT\s+UNIQUE\b/, "channel_id TEXT");
    const lastParen = out.lastIndexOf(")");
    out =
      out.slice(0, lastParen) +
      ",\n  UNIQUE (community_id, channel_id)\n" +
      out.slice(lastParen);
  }
  return out;
}

/**
 * Substitute the guild-snowflake directory segment of a stored transcript path.
 * Handles both separators and absolute/relative prefixes because the path is
 * stored as `ticket-transcripts/{guild_id}/{token}/…` (see transcript.js).
 *
 * @param {string} value stored tickets.transcript_path
 * @param {string|number} guildId old directory segment
 * @param {string|number} communityId new directory segment
 * @returns {string}
 */
function rewriteTranscriptPath(value, guildId, communityId) {
  let out = value;
  for (const sep of ["/", "\\"]) {
    const needle = `ticket-transcripts${sep}${guildId}${sep}`;
    const replacement = `ticket-transcripts${sep}${communityId}${sep}`;
    out = out.split(needle).join(replacement);
  }
  return out;
}

/**
 * Post-commit filesystem hook: move each
 * `{baseDir}/ticket-transcripts/{guildId}` directory to
 * `{baseDir}/ticket-transcripts/{communityId}`.
 *
 * Runs AFTER the DB transaction commits. Every move outcome is recorded; a
 * failed (or collision-skipped) move is logged with BOTH paths and never
 * thrown, so one unwritable directory cannot poison a committed cutover.
 *
 * @param {Array<{ guildId: string|number, communityId: string|number }>} mappings
 * @param {string} [baseDir] DATA_DIR override for tests/tooling
 * @returns {{ moved: object[], skipped: object[], failed: object[] }}
 */
function moveTranscriptDirs(mappings, baseDir = defaultDataDir) {
  const result = { moved: [], skipped: [], failed: [] };
  const root = path.join(String(baseDir), "ticket-transcripts");
  for (const mapping of mappings || []) {
    const guildId = String(mapping.guildId);
    const communityId = String(mapping.communityId);
    const from = path.join(root, guildId);
    const to = path.join(root, communityId);
    if (from === to) continue;
    if (!fs.existsSync(from)) {
      // No transcript dir for this guild — nothing on disk to relocate.
      result.skipped.push({ guildId, communityId, from, to, reason: "source dir missing" });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      console.log(`[db] 034_communities: moved transcript dir ${from} -> ${to}`);
      result.moved.push({ guildId, communityId, from, to });
    } catch (err) {
      // Partial moves are reported with both paths, never thrown (spec).
      console.error(
        `[db] 034_communities: transcript dir move failed ${from} -> ${to}: ${err?.message || err}`,
      );
      result.failed.push({
        guildId,
        communityId,
        from,
        to,
        error: String(err?.message || err),
      });
    }
  }
  return result;
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ now: Function, tableExists: Function, getColumns: Function,
 *            addColumnIfMissing: Function }} helpers
 * @returns {{ migrated: boolean, moves: object | null }}
 */
function up(db, { now, tableExists, getColumns, addColumnIfMissing }) {
  // Idempotency guard: once `users` has lost its guild_id column the cutover
  // already ran (migrations re-run on every boot).
  const needsRebuild = tableExists("users") && getColumns("users").includes("guild_id");
  const ts = now();

  /** @type {Array<{ guildId: string, communityId: number }>} */
  const mappings = [];

  const run = db.transaction(() => {
    // 1. communities — spec DDL verbatim.
    db.exec(CREATE_COMMUNITIES_SQL);

    // Sections 2-4 reference guild_id columns that only exist pre-cutover, so
    // the whole block is gated — a re-run on a migrated DB is a pure no-op.
    let ticketTranscripts = [];
    if (needsRebuild) {
      // 2. Backfill: one discord row per distinct guild_id across every
      //    guild-scoped table. UNION dedupes; ORDER BY keeps ids deterministic
      //    (AUTOINCREMENT assigns in select order).
      const sources = GUILD_SCOPED_TABLES.filter((t) => tableExists(t));
      if (sources.length > 0) {
        const union = sources.map((t) => `SELECT guild_id FROM ${t}`).join("\nUNION\n");
        db.prepare(
          `INSERT OR IGNORE INTO communities (platform, instance_key, external_guild_id, created_at)
           SELECT 'discord', 'discord', guild_id, ?
           FROM (${union})
           WHERE guild_id IS NOT NULL
           ORDER BY guild_id`,
        ).run(ts);
      }

      db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS ${GUILD_MAP_TABLE} (
          guild_id TEXT PRIMARY KEY,
          community_id INTEGER NOT NULL
        );
        INSERT OR REPLACE INTO ${GUILD_MAP_TABLE} (guild_id, community_id)
          SELECT external_guild_id, id FROM communities
          WHERE platform = 'discord' AND instance_key = 'discord';
      `);

      // Pre-capture transcript paths (needs the pre-rebuild tickets shape).
      ticketTranscripts = db
        .prepare(
          "SELECT id, guild_id AS guildId, transcript_path AS transcriptPath FROM tickets WHERE transcript_path IS NOT NULL",
        )
        .all();

      // 3. Rebuild every guild-scoped table.
      for (const table of GUILD_SCOPED_TABLES) {
        if (!tableExists(table)) continue;

        const newTable = `${table}_034_new`;
        const ddlRow = db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
          .get(table);
        // Named indexes (and their partial WHERE clauses) are replayed verbatim
        // with the guild_id token swapped; auto-indexes return with the DDL.
        const indexes = db
          .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
          )
          .all(table);
        const dataCols = db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((c) => c.name)
          .filter((name) => name !== "guild_id");

        db.exec(transformCreateTableSql(ddlRow.sql, table, newTable));

        // Explicit column list: INSERT…SELECT copies every integer PK unchanged.
        db.prepare(
          `INSERT INTO ${newTable} (community_id, ${dataCols.map(quoteIdent).join(", ")})
           SELECT m.community_id, ${dataCols.map(quoteIdent).join(", ")}
           FROM ${table} s
           JOIN ${GUILD_MAP_TABLE} m ON m.guild_id = s.guild_id`,
        ).run();

        db.exec(`DROP TABLE ${table}`);
        db.exec(`ALTER TABLE ${newTable} RENAME TO ${table}`);

        for (const idx of indexes) {
          db.exec(idx.sql.replace(/\bguild_id\b/g, "community_id"));
        }
      }

      // 4. tickets.transcript_path: guild-snowflake dir → communityId dir.
      const updatePath = db.prepare("UPDATE tickets SET transcript_path = ? WHERE id = ?");
      const lookupCommunity = db.prepare(
        `SELECT community_id AS communityId FROM ${GUILD_MAP_TABLE} WHERE guild_id = ?`,
      );
      for (const row of ticketTranscripts) {
        const mapping = lookupCommunity.get(row.guildId);
        if (!mapping) continue; // guild vanished from the map — leave the path untouched
        updatePath.run(
          rewriteTranscriptPath(row.transcriptPath, row.guildId, mapping.communityId),
          row.id,
        );
      }

      // Mappings for the post-commit filesystem move.
      mappings.push(
        ...db
          .prepare(`SELECT guild_id AS guildId, community_id AS communityId FROM ${GUILD_MAP_TABLE}`)
          .all(),
      );
      db.exec(`DROP TABLE IF EXISTS ${GUILD_MAP_TABLE}`);
    }

    // 5. web_sessions identity columns (spec § Identity outside a guild).
    // NOT NULL DEFAULT backfills every existing row to 'discord'.
    if (tableExists("web_sessions")) {
      addColumnIfMissing(
        "web_sessions",
        "platform",
        "platform TEXT NOT NULL DEFAULT 'discord'",
      );
      addColumnIfMissing(
        "web_sessions",
        "instance_key",
        "instance_key TEXT NOT NULL DEFAULT 'discord'",
      );
      addColumnIfMissing(
        "web_sessions",
        "refresh_token_enc",
        "refresh_token_enc TEXT",
      );
      addColumnIfMissing(
        "web_sessions",
        "refresh_expires_at",
        "refresh_expires_at INTEGER",
      );
    }

    // 6. Fluxer web-login PKCE verifier store (spec lines 919-924).
    db.exec(CREATE_FLUXER_OAUTH_SQL);
  });

  // PRAGMA foreign_keys is a no-op INSIDE a transaction, so it toggles here,
  // outside run(). Restored in `finally` — even on a rolled-back cutover the
  // connection keeps the pragma it had. SQLite documents exactly this pattern
  // for table rebuilds (https://sqlite.org/lang_altertable.html § 5).
  const fkWasOn = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  try {
    run();
  } finally {
    db.pragma(`foreign_keys = ${fkWasOn ? "ON" : "OFF"}`);
  }

  // Filesystem side: strictly AFTER the commit (spec § Global uniqueness).
  let moves = null;
  if (needsRebuild && mappings.length > 0) {
    moves = moveTranscriptDirs(mappings);
  }

  return { migrated: needsRebuild, moves };
}

module.exports = { id: "034_communities", up, moveTranscriptDirs };
