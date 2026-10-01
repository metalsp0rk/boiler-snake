const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { createPre034Fixture } = require("../helpers/seed-pre034");

/**
 * Migration 034_communities (roadmap/fluxer.md § Data Model Changes).
 *
 * Applies the cutover to a populated pre-034 fixture (migrations 001-033 +
 * seeded rows across every guild-scoped table) and verifies, from the OTHER
 * side of the transaction: communities DDL, discord backfill, every rebuild,
 * every spec-listed index (PRAGMA + sqlite_master SQL diff), every table-level
 * UNIQUE replacement, unchanged integer PKs, surviving child joins, the
 * transcript_path rewrite, the post-commit directory move, web_sessions
 * identity columns, and fluxer_oauth_transactions.
 */

/** Spec § "Guild-scoped tables" — the 35 tables re-keyed to community_id. */
const GUILD_SCOPED_TABLES = [
  "users", "activity_log", "voice_sessions", "guild_settings", "level_roles",
  "role_drop_state", "allowed_command_channels", "youtube_channels",
  "honeypot_channels", "staff_roles", "honeypot_ban_roles",
  "reaction_role_panels", "reaction_role_options", "event_reminder_configs",
  "event_reminder_optouts", "event_reminder_event_optouts", "staff_notes",
  "warnings", "tickets", "ticket_panels", "user_channel_message_daily",
  "activity_ignore", "user_activity_meta", "guild_activity_settings",
  "user_channel_backfill_cursor", "guild_channel_backfill_cursor",
  "guild_command_permission_oauth", "twitch_channels", "gork_user_blocks",
  "gork_memories", "gork_budget_rules", "gork_usage", "gork_interactions",
  "github_watches", "admin_audit",
];

/** Spec § Cutover step 3 — the index list to copy (names preserved verbatim). */
const SPEC_INDEXES = [
  "idx_activity_recent", "idx_activity_created_at", "idx_warnings_user",
  "idx_warnings_active", "idx_warnings_expires", "idx_tickets_guild_status",
  "idx_tickets_creator", "idx_tickets_creator_created", "idx_tickets_channel",
  "idx_ticket_messages_ticket", "idx_staff_notes_user", "idx_staff_notes_active",
  "idx_staff_notes_guild_recent", "idx_gork_interactions_guild",
  "idx_gork_interactions_msg", "idx_gork_interactions_kind",
  "idx_gork_interactions_uid", "idx_gork_interactions_created",
  "idx_gork_memories_subject", "idx_admin_audit_guild_created",
  "idx_ucmd_user_day", "idx_ucmd_user_channel", "idx_activity_ignore_guild",
  "idx_github_watches_channel", "idx_twitch_channels_broadcaster",
  "idx_event_reminder_due", "idx_event_reminder_offsets_config",
  "idx_er_event_optouts_user", "idx_er_event_optouts_event",
  "idx_ticket_panels_guild",
];

/** Post-034 PRIMARY KEY column lists for every rebuilt table. */
const EXPECTED_PK = {
  users: ["community_id", "user_id"],
  activity_log: [],
  voice_sessions: ["community_id", "user_id"],
  guild_settings: ["community_id"],
  level_roles: ["community_id", "role_id"],
  role_drop_state: ["community_id", "user_id", "role_id"],
  allowed_command_channels: ["community_id", "channel_id"],
  youtube_channels: ["community_id", "id"],
  honeypot_channels: ["community_id", "channel_id"],
  staff_roles: ["community_id", "role_id"],
  honeypot_ban_roles: ["community_id", "role_id"],
  reaction_role_panels: ["community_id", "message_id"],
  reaction_role_options: ["community_id", "message_id", "emoji_key"],
  event_reminder_configs: ["id"],
  event_reminder_optouts: ["community_id", "user_id"],
  event_reminder_event_optouts: ["community_id", "user_id", "scheduled_event_id"],
  staff_notes: ["id"],
  warnings: ["id"],
  tickets: ["id"],
  ticket_panels: ["community_id", "message_id"],
  user_channel_message_daily: ["community_id", "user_id", "channel_id", "day"],
  activity_ignore: ["community_id", "target_id"],
  user_activity_meta: ["community_id", "user_id"],
  guild_activity_settings: ["community_id"],
  user_channel_backfill_cursor: ["community_id", "user_id", "channel_id"],
  guild_channel_backfill_cursor: ["community_id", "channel_id"],
  guild_command_permission_oauth: ["community_id"],
  twitch_channels: ["community_id", "broadcaster_id"],
  gork_user_blocks: ["community_id", "user_id"],
  gork_memories: ["id"],
  gork_budget_rules: ["community_id", "scope_kind", "target_id"],
  gork_usage: ["community_id", "user_id", "scope_kind", "scope_id", "day"],
  gork_interactions: ["id"],
  github_watches: ["community_id", "repo"],
  admin_audit: ["id"],
};

/** Spec § "Global uniqueness that must die" + Cutover 3 UNIQUE replacements. */
const EXPECTED_UNIQUE = {
  tickets: ["community_id,channel_id", "community_id,ticket_number", "transcript_token"],
  warnings: ["community_id,warning_number"],
  staff_notes: ["community_id,note_number"],
  gork_interactions: ["uid"],
  event_reminder_configs: ["community_id,scheduled_event_id", "community_id,shortname"],
  youtube_channels: ["community_id,channel_name"],
  twitch_channels: ["community_id,login"],
};

const normalizeSql = (sql) => String(sql).replace(/\s+/g, " ").trim();

function captureConsole(fn) {
  const lines = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => lines.push(`log: ${args.join(" ")}`);
  console.error = (...args) => lines.push(`error: ${args.join(" ")}`);
  try {
    const value = fn();
    return { value, lines };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

describe("migration 034_communities (spec § Data Model Changes cutover)", () => {
  /** @type {ReturnType<typeof createPre034Fixture>} */
  let fixture;
  let db;
  let migration;
  /** @type {Record<string, number>} communities.id per external guild id */
  let communityId;

  before(() => {
    fixture = createPre034Fixture();
    db = fixture.db;
    migration = require("../../src/db/migrations/034_communities");
    const result = migration.up(fixture.db, fixture.helpers);
    assert.equal(result.migrated, true, "fixture must be pre-034 so up() runs the cutover");
    communityId = {};
    for (const row of db.prepare("SELECT id, external_guild_id FROM communities").all()) {
      communityId[row.external_guild_id] = row.id;
    }
  });

  after(() => {
    fixture?.cleanup();
  });

  it("registers as id 034_communities in migrate.js (never 031)", () => {
    const { migrations } = require("../../src/db/migrate");
    const ids = migrations.map((m) => m.id);
    assert.ok(ids.includes("034_communities"), "034_communities must be registered");
    assert.equal(
      ids.filter((id) => String(id ?? "").startsWith("031")).length,
      1,
      "the gork STE migration stays the only 031",
    );
    assert.ok(
      ids.indexOf("034_communities") > ids.indexOf("033_gork_summarize_input_tokens"),
      "034 runs after 033",
    );
  });

  it("communities table matches the spec DDL exactly", () => {
    const cols = Object.fromEntries(
      db.prepare("PRAGMA table_info(communities)").all().map((c) => [c.name, c]),
    );
    assert.deepEqual(
      Object.keys(cols),
      [
        "id", "platform", "instance_key", "external_guild_id",
        "elevated_permissions", "voice_states_complete", "created_at",
      ],
    );
    assert.equal(cols.id.type, "INTEGER");
    assert.equal(cols.id.pk, 1, "id is the INTEGER PRIMARY KEY (AUTOINCREMENT rowid alias)");
    for (const name of ["platform", "instance_key", "external_guild_id", "created_at"]) {
      assert.equal(cols[name].notnull, 1, `${name} NOT NULL`);
    }
    for (const flag of ["elevated_permissions", "voice_states_complete"]) {
      assert.equal(cols[flag].notnull, 1, `${flag} NOT NULL`);
      assert.equal(cols[flag].dflt_value, "0", `${flag} defaults to 0`);
    }
    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='communities'")
      .get().sql;
    assert.match(sql, /CHECK \(platform IN \('discord', 'fluxer'\)\)/);
    assert.match(sql, /UNIQUE \(platform, instance_key, external_guild_id\)/);
  });

  it("backfills exactly one discord row per distinct seeded guild_id (no fluxer rows)", () => {
    const rows = db.prepare("SELECT * FROM communities ORDER BY external_guild_id").all();
    assert.equal(rows.length, 2, "one row per distinct guild_id, not one per table");
    assert.deepEqual(rows.map((r) => r.external_guild_id).sort(), [fixture.guildIds.a, fixture.guildIds.b].sort());
    for (const row of rows) {
      assert.equal(row.platform, "discord");
      assert.equal(row.instance_key, "discord");
      assert.equal(row.elevated_permissions, 0, "Discord rows default both flags to 0");
      assert.equal(row.voice_states_complete, 0);
      assert.ok(Number.isSafeInteger(row.created_at) && row.created_at > 0);
      assert.notEqual(row.platform, "fluxer");
    }
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM communities WHERE platform='fluxer'").get().n,
      0,
      "spec § Cutover 6: this PR writes no platform='fluxer' row",
    );
  });

  it("replaces guild_id with community_id INTEGER NOT NULL on every guild-scoped table", () => {
    for (const table of GUILD_SCOPED_TABLES) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      const names = cols.map((c) => c.name);
      assert.ok(!names.includes("guild_id"), `${table} must not keep a guild_id column`);
      const cid = cols.find((c) => c.name === "community_id");
      assert.ok(cid, `${table} must gain a community_id column`);
      assert.equal(cid.type, "INTEGER", `${table}.community_id INTEGER`);
      assert.equal(cid.notnull, 1, `${table}.community_id NOT NULL`);
      const ddl = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(table).sql;
      assert.ok(!/\bguild_id\b/.test(ddl), `${table} DDL must not mention guild_id`);
    }
  });

  it("preserves every table-level PRIMARY KEY (guild_id slot becomes community_id)", () => {
    for (const [table, pk] of Object.entries(EXPECTED_PK)) {
      const cols = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
      assert.deepEqual(cols, pk, `${table} PRIMARY KEY`);
    }
  });

  it("re-issues every spec § Cutover-3 index with community_id and preserved partial WHERE clauses", () => {
    for (const name of SPEC_INDEXES) {
      const pre = fixture.preIndexSql[name];
      assert.ok(pre, `pre-migration index ${name} must exist in the fixture`);
      const post = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
        .get(name);
      assert.ok(post, `post-migration index ${name} must exist`);
      const expected = /\bguild_id\b/.test(pre)
        ? pre.replace(/\bguild_id\b/g, "community_id")
        : pre; // indexes that never mention guild_id are recreated verbatim
      assert.equal(
        normalizeSql(post.sql),
        normalizeSql(expected),
        `index ${name} SQL must match the pre-migration definition with community_id substituted`,
      );
    }
    // Spot-check the partial clauses survived as data, not just text.
    const partial = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_warnings_active'")
      .get().sql;
    assert.match(partial, /WHERE voided_at IS NULL/);
    const expires = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_warnings_expires'")
      .get().sql;
    assert.match(expires, /WHERE voided_at IS NULL AND expires_at IS NOT NULL/);
  });

  it("carries every table-level UNIQUE into the rebuilt tables", () => {
    for (const [table, expected] of Object.entries(EXPECTED_UNIQUE)) {
      const uniques = db
        .prepare(`PRAGMA index_list(${table})`)
        .all()
        .filter((i) => i.origin === "u")
        .map((i) =>
          db.prepare(`PRAGMA index_info(${i.name})`).all().map((c) => c.name).join(","),
        )
        .sort();
      assert.deepEqual(uniques, [...expected].sort(), `${table} table-level UNIQUE set`);
    }
    const ticketsUniques = db
      .prepare("PRAGMA index_list(tickets)")
      .all()
      .filter((i) => i.origin === "u")
      .map((i) => db.prepare(`PRAGMA index_info(${i.name})`).all().map((c) => c.name).join(","));
    assert.ok(
      !ticketsUniques.includes("channel_id"),
      "legacy global UNIQUE tickets.channel_id must be gone",
    );
  });

  it("allows the same channel_id in two communities and rejects duplicates within one", () => {
    const ids = Object.values(communityId);
    const [cidA, cidB] = [communityId[fixture.guildIds.a], communityId[fixture.guildIds.b]];
    assert.equal(ids.length, 2);
    const insert = db.prepare(
      `INSERT INTO tickets (id, community_id, ticket_number, channel_id, creator_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // A channel snowflake reused by a SECOND community is legal now.
    insert.run(500, cidA, 900, "998000000000000001", "user-a-9", 1700000000001);
    insert.run(501, cidB, 900, "998000000000000001", "user-b-9", 1700000000001);
    // The same (community, channel) pair is the unique key.
    assert.throws(
      () => insert.run(502, cidA, 901, "998000000000000001", "user-a-9", 1700000000001),
      /UNIQUE constraint failed: tickets\.community_id, tickets\.channel_id/,
    );
    db.prepare("DELETE FROM tickets WHERE id IN (500, 501)").run();
  });

  it("copies every integer PK unchanged so child rows keep their joins", () => {
    for (const [table, ids] of Object.entries(fixture.ids)) {
      const after = db.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map((r) => r.id);
      assert.deepEqual(after, [...ids].sort((a, b) => a - b), `${table}.id values preserved`);
    }
    const joinCount = (sql) => db.prepare(sql).get().n;
    assert.equal(
      joinCount("SELECT COUNT(*) AS n FROM ticket_messages tm JOIN tickets t ON t.id = tm.ticket_id"),
      3,
      "ticket_messages rows still join their tickets",
    );
    assert.equal(
      joinCount("SELECT COUNT(*) AS n FROM ticket_members tm JOIN tickets t ON t.id = tm.ticket_id"),
      1,
      "ticket_members rows still join their tickets",
    );
    assert.equal(
      joinCount("SELECT COUNT(*) AS n FROM ticket_staff ts JOIN tickets t ON t.id = ts.ticket_id"),
      1,
      "ticket_staff rows still join their tickets",
    );
    assert.equal(
      joinCount("SELECT COUNT(*) AS n FROM event_reminder_offsets o JOIN event_reminder_configs c ON c.id = o.config_id"),
      2,
      "event_reminder_offsets rows still join their configs",
    );
    assert.equal(
      joinCount("SELECT COUNT(*) AS n FROM warnings w JOIN staff_notes n ON n.id = w.related_note_id"),
      2,
      "warnings.related_note_id still points at real staff notes",
    );
  });

  it("leaves no dangling foreign keys after the rebuild", () => {
    // The cutover runs with PRAGMA foreign_keys OFF; this proves it left every
    // declared FK (006 offsets, 009 warnings.related_note_id, 010 ticket
    // children) pointing at an existing parent row.
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    assert.deepEqual(violations, [], "PRAGMA foreign_key_check is clean post-migration");
  });

  it("preserves every seeded row (no data lost to the rebuild)", () => {
    for (const [table, n] of Object.entries(fixture.counts)) {
      const after = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      assert.equal(after, n, `${table} row count preserved`);
    }
    // Row-to-community mapping followed the guild → community map.
    const cidA = communityId[fixture.guildIds.a];
    const cidB = communityId[fixture.guildIds.b];
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE community_id = ?").get(cidA).n,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE community_id = ?").get(cidB).n,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM users WHERE community_id = ?").get(cidA).n,
      2,
    );
  });

  it("rewrites tickets.transcript_path from guild dirs to communityId dirs", () => {
    const cidA = communityId[fixture.guildIds.a];
    const cidB = communityId[fixture.guildIds.b];
    const t101 = db.prepare("SELECT transcript_path FROM tickets WHERE id=101").get();
    const t102 = db.prepare("SELECT transcript_path FROM tickets WHERE id=102").get();
    assert.equal(
      t101.transcript_path,
      path.join("ticket-transcripts", String(cidA), "tok-a-1", "index.html"),
      "nested layout rewritten inside the transaction",
    );
    assert.equal(
      t102.transcript_path,
      path.join("ticket-transcripts", String(cidB), "tok-b-1.html"),
      "legacy flat layout rewritten too",
    );
  });

  it("moves transcript directories only AFTER the commit (files readable at new paths)", () => {
    const cidA = communityId[fixture.guildIds.a];
    const cidB = communityId[fixture.guildIds.b];
    const root = path.join(fixture.dataDir, "ticket-transcripts");
    assert.ok(fs.existsSync(path.join(root, String(cidA), "tok-a-1", "index.html")));
    assert.equal(
      fs.readFileSync(path.join(root, String(cidA), "tok-a-1", "assets", "shot.png"), "utf8"),
      "png-bytes",
      "assets subdirectory came along with the dir",
    );
    assert.equal(fs.readFileSync(path.join(root, String(cidB), "tok-b-1.html"), "utf8"), "<html>ticket 102</html>");
    assert.ok(!fs.existsSync(path.join(root, fixture.guildIds.a)), "old guild dir no longer exists");
    assert.ok(!fs.existsSync(path.join(root, fixture.guildIds.b)), "old guild dir no longer exists");
  });

  it("adds web_sessions identity columns with discord defaults and nullable refresh columns", () => {
    const cols = Object.fromEntries(
      db.prepare("PRAGMA table_info(web_sessions)").all().map((c) => [c.name, c]),
    );
    assert.equal(cols.platform.notnull, 1);
    assert.equal(cols.platform.dflt_value, "'discord'");
    assert.equal(cols.instance_key.notnull, 1);
    assert.equal(cols.instance_key.dflt_value, "'discord'");
    assert.equal(cols.refresh_token_enc.notnull, 0, "refresh_token_enc is nullable");
    assert.equal(cols.refresh_token_enc.type, "TEXT");
    assert.equal(cols.refresh_expires_at.notnull, 0, "refresh_expires_at is nullable");
    assert.equal(cols.refresh_expires_at.type, "INTEGER");

    const row = db.prepare("SELECT * FROM web_sessions WHERE id='sess-pre-1'").get();
    assert.equal(row.platform, "discord", "existing rows backfilled to discord");
    assert.equal(row.instance_key, "discord");
    assert.equal(row.refresh_token_enc, null, "Discord rows keep refresh columns NULL");
    assert.equal(row.refresh_expires_at, null);
    // Pre-030 token columns survive the rebuild-free ALTER path.
    assert.ok("access_token_enc" in cols && "token_expires_at" in cols);
  });

  it("creates fluxer_oauth_transactions per spec lines 919-924", () => {
    const cols = Object.fromEntries(
      db.prepare("PRAGMA table_info(fluxer_oauth_transactions)").all().map((c) => [c.name, c]),
    );
    assert.deepEqual(Object.keys(cols), ["nonce", "code_verifier", "instance_key", "expires_at"]);
    assert.equal(cols.nonce.type, "TEXT");
    assert.equal(cols.nonce.pk, 1);
    assert.equal(cols.code_verifier.notnull, 1);
    assert.equal(cols.instance_key.notnull, 1);
    assert.equal(cols.expires_at.type, "INTEGER");
    assert.equal(cols.expires_at.notnull, 1);

    const insert = db.prepare(
      "INSERT INTO fluxer_oauth_transactions (nonce, code_verifier, instance_key, expires_at) VALUES (?, ?, ?, ?)",
    );
    insert.run("n-1", "verifier-1", "https://chat.example", 1700000600000);
    assert.throws(() => insert.run("n-1", "verifier-2", "https://chat.example", 1700000600000), /PRIMARY|UNIQUE/i);
    const row = db.prepare("SELECT * FROM fluxer_oauth_transactions WHERE nonce='n-1'").get();
    assert.equal(row.code_verifier, "verifier-1");
    db.prepare("DELETE FROM fluxer_oauth_transactions WHERE nonce='n-1'").run();
  });

  it("is idempotent: re-running up() is a no-op and writes no second set of communities", () => {
    const communitiesBefore = db.prepare("SELECT COUNT(*) AS n FROM communities").get().n;
    const indexesBefore = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index'").get().n;
    const result = migration.up(fixture.db, fixture.helpers);
    assert.equal(result.migrated, false, "re-run detects the completed cutover and skips the rebuild");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM communities").get().n, communitiesBefore);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index'").get().n, indexesBefore);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tickets").get().n, 2);
  });

  it("moveTranscriptDirs never throws: logs both paths on a failed move and skips missing dirs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "boiler-snake-034-move-"));
    try {
      // movable → ok; colliding → destination dir exists with content; missing → skipped.
      fs.mkdirSync(path.join(root, "ticket-transcripts", "9000000001", "tok"), { recursive: true });
      fs.writeFileSync(path.join(root, "ticket-transcripts", "9000000001", "tok", "index.html"), "ok", "utf8");
      fs.mkdirSync(path.join(root, "ticket-transcripts", "9000000002"), { recursive: true });
      fs.writeFileSync(path.join(root, "ticket-transcripts", "9000000002", "x.html"), "src", "utf8");
      fs.mkdirSync(path.join(root, "ticket-transcripts", "42"), { recursive: true });
      fs.writeFileSync(path.join(root, "ticket-transcripts", "42", "existing.html"), "dst", "utf8");

      const { value: res, lines } = captureConsole(() =>
        migration.moveTranscriptDirs(
          [
            { guildId: "9000000001", communityId: 7 },
            { guildId: "9000000002", communityId: 42 },
            { guildId: "9000000003", communityId: 99 },
          ],
          root,
        ),
      );

      assert.equal(res.moved.length, 1);
      assert.equal(res.moved[0].from, path.join(root, "ticket-transcripts", "9000000001"));
      assert.equal(res.moved[0].to, path.join(root, "ticket-transcripts", "7"));
      assert.equal(res.failed.length, 1, "destination collision is reported as a failed move");
      assert.equal(res.failed[0].guildId, "9000000002");
      assert.equal(res.failed[0].communityId, "42");
      assert.equal(res.skipped.length, 1, "missing source dirs are skipped quietly");
      assert.equal(res.skipped[0].guildId, "9000000003");

      // Spec: a partial move is logged with BOTH paths.
      const failLog = lines.find((l) => l.startsWith("error:") && l.includes(res.failed[0].from));
      assert.ok(failLog, "failure must be logged, not thrown");
      assert.ok(failLog.includes(res.failed[0].to), "failure log line carries both paths");
      const okLog = lines.find((l) => l.startsWith("log:") && l.includes(res.moved[0].from));
      assert.ok(okLog, "successful moves are logged with both paths too");

      // Nothing was clobbered by the failed move.
      assert.equal(fs.readFileSync(path.join(root, "ticket-transcripts", "9000000002", "x.html"), "utf8"), "src");
      assert.equal(fs.readFileSync(path.join(root, "ticket-transcripts", "42", "existing.html"), "utf8"), "dst");
      assert.ok(fs.existsSync(path.join(root, "ticket-transcripts", "7", "tok", "index.html")));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("migration 034_communities: quoted legacy DDL (2026-10-01 prod regression)", () => {
  let fixture;
  let db;
  let migration;

  before(() => {
    fixture = createPre034Fixture();
    db = fixture.db;
    migration = require("../../src/db/migrations/034_communities");
  });

  after(() => {
    fixture?.cleanup();
  });

  it("rebuilds youtube_channels when migration 003 left a quoted table name", () => {
    // Legacy installs (pre-001 composite PK) had youtube_channels keyed on
    // `id` alone; migration 003 rebuilt it with a composite PK, and SQLite's
    // ALTER TABLE ... RENAME rewrote the stored DDL with a QUOTED identifier:
    // `CREATE TABLE IF NOT EXISTS "youtube_channels"`. 034's rename transform
    // must match that spelling — prod boot-crashed when it only accepted the
    // bare name (the rebuilt CREATE hit the ORIGINAL name: "already exists").
    const LEGACY_GUILD = "1699000000000000999";
    db.exec("DROP TABLE youtube_channels");
    db.exec(`
      CREATE TABLE youtube_channels (
        guild_id TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        channel_name TEXT NOT NULL,
        channel_url TEXT NOT NULL,
        thumbnail_url TEXT,
        last_video_id TEXT,
        last_checked INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.prepare(
      "INSERT INTO youtube_channels (guild_id, id, channel_name, channel_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(LEGACY_GUILD, "UClegacy", "Legacy Name", "https://yt.example/legacy", 1700000000000, 1700000000000);

    // Replay 003 over the legacy shape to produce the exact prod DDL artifact.
    require("../../src/db/migrations/003_youtube_composite_pk").up(db, fixture.helpers);
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='youtube_channels'")
      .get().sql;
    assert.match(
      ddl,
      /CREATE TABLE (?:IF NOT EXISTS )?"youtube_channels"/i,
      "003's RENAME must yield the quoted DDL shape the prod incident hit",
    );

    const result = migration.up(db, fixture.helpers);
    assert.equal(result.migrated, true, "034 must run the cutover, not throw");

    const cols = new Set(db.prepare("PRAGMA table_info(youtube_channels)").all().map((c) => c.name));
    assert.ok(cols.has("community_id"), "youtube_channels rebuilt with community_id");
    assert.ok(!cols.has("guild_id"), "guild_id column must be gone after the cutover");

    const row = db.prepare("SELECT community_id, channel_name FROM youtube_channels WHERE id = ?").get("UClegacy");
    assert.ok(row, "legacy row survives the rebuild");
    assert.equal(row.channel_name, "Legacy Name");
    const cid = db
      .prepare("SELECT id FROM communities WHERE platform='discord' AND instance_key='discord' AND external_guild_id = ?")
      .get(LEGACY_GUILD);
    assert.ok(cid, "legacy guild backfilled into communities");
    assert.equal(row.community_id, cid.id, "row is re-keyed to its community id");
  });
});
