const fs = require("fs");
const path = require("path");
const os = require("os");

const { resetSrcModules, createCleanup } = require("./env");

/**
 * Populated pre-034 fixture builder (roadmap/fluxer.md § Data Model Changes).
 *
 * Builds a throwaway SQLite DB with migrations 001-033 applied (NOT 034 — the
 * integration test applies the cutover itself) and seeds guild-scoped rows for
 * TWO Discord guilds across all 35 guild-scoped tables, plus the child tables
 * (ticket_members, ticket_staff, ticket_messages, event_reminder_offsets),
 * warnings.related_note_id links, a web_sessions row, and real transcript
 * directories on disk (nested + legacy flat layouts) so the integration test
 * can prove the transcript_path rewrite and the post-commit directory move.
 *
 * All inserts are plain SQL — no repository calls — so this fixture stays
 * stable while repository signatures move to community ids (subtasks 03-05).
 *
 * @returns {{
 *   db: object, tmpDir: string, dbPath: string, dataDir: string,
 *   cleanup: () => void,
 *   helpers: object,
 *   guildIds: { a: string, b: string },
 *   ids: object,
 *   transcriptPaths: { a: string, b: string },
 *   counts: Record<string, number>,
 *   preIndexSql: Record<string, string>,
 * }}
 */
function createPre034Fixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boiler-snake-034-"));
  const dbPath = path.join(tmpDir, "test.sqlite");
  process.env.DB_PATH = dbPath;
  process.env.DATA_DIR = tmpDir;
  resetSrcModules();

  const connection = require("../../src/db/connection");
  const { migrations } = require("../../src/db/migrate");
  const db = connection.db;

  // 1. Apply migrations 001-033 only (skip 034 — the subject under test).
  const helpers = {
    now: connection.now,
    tableExists: connection.tableExists,
    getColumns: connection.getColumns,
    addColumnIfMissing: connection.addColumnIfMissing,
    getPrimaryKeyColumns: connection.getPrimaryKeyColumns,
  };
  for (const migration of migrations) {
    const id = String(migration.id ?? "");
    if (id.startsWith("034")) continue;
    migration.up(db, helpers);
  }

  // 2. Seed data. Two guilds so the backfill must produce two communities.
  const NOW = 1700000000000;
  const GUILD_A = "1554590611015729152";
  const GUILD_B = "1600000000000000001";

  const INSERTS = [
    ["users", `(guild_id, user_id, xp, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`],
    ["activity_log", `(guild_id, user_id, kind, amount, created_at) VALUES (?, ?, ?, ?, ?)`],
    ["voice_sessions", `(guild_id, user_id, channel_id, joined_at) VALUES (?, ?, ?, ?)`],
    [
      "guild_settings",
      `(guild_id, updated_at, msg_xp, gork_keyword) VALUES (?, ?, ?, ?)`,
    ],
    ["level_roles", `(guild_id, role_id, level_required, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`],
    ["role_drop_state", `(guild_id, user_id, role_id, below_since, updated_at) VALUES (?, ?, ?, ?, ?)`],
    ["allowed_command_channels", `(guild_id, channel_id, created_at) VALUES (?, ?, ?)`],
    ["youtube_channels", `(guild_id, id, channel_name, channel_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`],
    ["honeypot_channels", `(guild_id, channel_id, warning_message_id, created_at) VALUES (?, ?, ?, ?)`],
    ["staff_roles", `(guild_id, role_id, created_at) VALUES (?, ?, ?)`],
    ["honeypot_ban_roles", `(guild_id, role_id, created_at) VALUES (?, ?, ?)`],
    ["reaction_role_panels", `(guild_id, channel_id, message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`],
    [
      "reaction_role_options",
      `(guild_id, message_id, emoji_key, emoji_display, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ],
    ["event_reminder_optouts", `(guild_id, user_id, opted_out_at) VALUES (?, ?, ?)`],
    ["event_reminder_event_optouts", `(guild_id, user_id, scheduled_event_id, muted_at) VALUES (?, ?, ?, ?)`],
    ["user_channel_message_daily", `(guild_id, user_id, channel_id, day, count) VALUES (?, ?, ?, ?, ?)`],
    ["activity_ignore", `(guild_id, target_id, kind, created_at) VALUES (?, ?, ?, ?)`],
    ["user_activity_meta", `(guild_id, user_id, tracking_since_ms) VALUES (?, ?, ?)`],
    ["guild_activity_settings", `(guild_id, collect_from_ms, created_at) VALUES (?, ?, ?)`],
    ["user_channel_backfill_cursor", `(guild_id, user_id, channel_id, complete) VALUES (?, ?, ?, ?)`],
    ["guild_channel_backfill_cursor", `(guild_id, channel_id, complete) VALUES (?, ?, ?)`],
    ["guild_command_permission_oauth", `(guild_id, refresh_token, created_at, updated_at) VALUES (?, ?, ?, ?)`],
    ["twitch_channels", `(guild_id, broadcaster_id, login, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`],
    ["gork_user_blocks", `(guild_id, user_id, created_by, created_at) VALUES (?, ?, ?, ?)`],
    ["gork_budget_rules", `(guild_id, scope_kind, target_id, daily_limit, created_at) VALUES (?, ?, ?, ?, ?)`],
    ["gork_usage", `(guild_id, user_id, scope_kind, scope_id, day, count) VALUES (?, ?, ?, ?, ?, ?)`],
    ["github_watches", `(guild_id, repo, repo_display, channel_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`],
  ];

  for (const [table, values] of INSERTS) {
    for (const g of ["a", "b"]) {
      const guild = g === "a" ? GUILD_A : GUILD_B;
      const p = (suffix) => `${suffix}-${g}`;
      switch (table) {
        case "users":
          db.prepare(
            `INSERT INTO users ${values}`,
          ).run(guild, p("user-1"), g === "a" ? 100 : 70, NOW, NOW);
          if (g === "a") {
            db.prepare(`INSERT INTO users ${values}`).run(guild, p("user-2"), 50, NOW, NOW);
          }
          break;
        case "activity_log":
          db.prepare(
            `INSERT INTO activity_log ${values}`,
          ).run(guild, p("user-1"), "message", 1, NOW);
          db.prepare(
            `INSERT INTO activity_log ${values}`,
          ).run(guild, p("user-1"), "reaction", 2, NOW + 1000);
          break;
        case "voice_sessions":
          db.prepare(`INSERT INTO voice_sessions ${values}`).run(guild, p("user-1"), p("channel-voice"), NOW);
          break;
        case "guild_settings":
          db.prepare(`INSERT INTO guild_settings ${values}`).run(guild, NOW, 5, g === "a" ? "@gork" : null);
          break;
        case "level_roles":
          db.prepare(`INSERT INTO level_roles ${values}`).run(guild, p("role-lvl5"), 5, NOW, NOW);
          break;
        case "role_drop_state":
          db.prepare(`INSERT INTO role_drop_state ${values}`).run(guild, p("user-1"), p("role-lvl5"), NOW, NOW);
          break;
        case "allowed_command_channels":
          db.prepare(`INSERT INTO allowed_command_channels ${values}`).run(guild, p("channel-cmds"), NOW);
          break;
        case "youtube_channels":
          db.prepare(
            `INSERT INTO youtube_channels ${values}`,
          ).run(guild, p("UC"), `Channel ${g.toUpperCase()}`, `https://youtu.example/${g}`, NOW, NOW);
          break;
        case "honeypot_channels":
          db.prepare(`INSERT INTO honeypot_channels ${values}`).run(guild, p("channel-honey"), p("msg-honey"), NOW);
          break;
        case "staff_roles":
        case "honeypot_ban_roles":
          db.prepare(`INSERT INTO ${table} ${values}`).run(guild, p("role-staff"), NOW);
          break;
        case "reaction_role_panels":
          db.prepare(
            `INSERT INTO reaction_role_panels ${values}`,
          ).run(guild, p("channel-rr"), p("msg-rr"), NOW, NOW);
          break;
        case "reaction_role_options":
          db.prepare(
            `INSERT INTO reaction_role_options ${values}`,
          ).run(guild, p("msg-rr"), "👍", "👍", p("role-rr"), NOW, NOW);
          break;
        case "event_reminder_optouts":
          db.prepare(`INSERT INTO event_reminder_optouts ${values}`).run(guild, p("user-2"), NOW);
          break;
        case "event_reminder_event_optouts":
          db.prepare(
            `INSERT INTO event_reminder_event_optouts ${values}`,
          ).run(guild, p("user-2"), p("event-1"), NOW);
          break;
        case "user_channel_message_daily":
          db.prepare(
            `INSERT INTO user_channel_message_daily ${values}`,
          ).run(guild, p("user-1"), p("channel-general"), "2026-09-29", 7);
          break;
        case "activity_ignore":
          db.prepare(`INSERT INTO activity_ignore ${values}`).run(guild, p("channel-archive"), "channel", NOW);
          break;
        case "user_activity_meta":
          db.prepare(`INSERT INTO user_activity_meta ${values}`).run(guild, p("user-1"), NOW);
          break;
        case "guild_activity_settings":
          db.prepare(`INSERT INTO guild_activity_settings ${values}`).run(guild, NOW, NOW);
          break;
        case "user_channel_backfill_cursor":
          db.prepare(
            `INSERT INTO user_channel_backfill_cursor ${values}`,
          ).run(guild, p("user-1"), p("channel-general"), 0);
          break;
        case "guild_channel_backfill_cursor":
          db.prepare(`INSERT INTO guild_channel_backfill_cursor ${values}`).run(guild, p("channel-general"), 0);
          break;
        case "guild_command_permission_oauth":
          db.prepare(
            `INSERT INTO guild_command_permission_oauth ${values}`,
          ).run(guild, `refresh-token-${g}`, NOW, NOW);
          break;
        case "twitch_channels":
          db.prepare(
            `INSERT INTO twitch_channels ${values}`,
          ).run(guild, p("broadcaster"), `streamer-${g}`, `Streamer ${g.toUpperCase()}`, NOW, NOW);
          break;
        case "gork_user_blocks":
          db.prepare(`INSERT INTO gork_user_blocks ${values}`).run(guild, p("user-2"), p("user-1"), NOW);
          break;
        case "gork_budget_rules":
          db.prepare(
            `INSERT INTO gork_budget_rules ${values}`,
          ).run(guild, "channel", p("channel-general"), 5, NOW);
          break;
        case "gork_usage":
          db.prepare(
            `INSERT INTO gork_usage ${values}`,
          ).run(guild, p("user-1"), "channel", p("channel-general"), "2026-09-29", 3);
          break;
        case "github_watches":
          db.prepare(
            `INSERT INTO github_watches ${values}`,
          ).run(guild, `owner/repo-${g}`, `Owner Repo ${g.toUpperCase()}`, p("channel-rel"), NOW, NOW);
          break;
        default:
          throw new Error(`seed-pre034: unhandled table ${table}`);
      }
    }
  }

  // Tables with explicit integer ids (so the PK-identity assertions are exact).
  db.prepare(
    `INSERT INTO event_reminder_configs (id, guild_id, scheduled_event_id, shortname, role_id, channel_id, message_template, active, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(701, GUILD_A, "event-a-1", "launch", "role-a-staff", "channel-a-rr", "ping {event}", NOW, "user-a-1");
  db.prepare(
    `INSERT INTO event_reminder_configs (id, guild_id, scheduled_event_id, shortname, role_id, channel_id, message_template, active, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(702, GUILD_B, "event-b-1", "launch", "role-b-staff", "channel-b-rr", "ping {event}", NOW, "user-b-1");
  db.prepare(
    `INSERT INTO event_reminder_offsets (id, config_id, offset_minutes, fire_at, sent_at, message_id)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
  ).run(801, 701, 15, NOW + 900_000);
  db.prepare(
    `INSERT INTO event_reminder_offsets (id, config_id, offset_minutes, fire_at, sent_at, message_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(802, 701, 60, NOW + 3_600_000, NOW + 3_600_000, "msg-fired-1");

  db.prepare(
    `INSERT INTO staff_notes (id, guild_id, note_number, user_id, author_id, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(201, GUILD_A, 1, "user-a-2", "user-a-1", "Coaching note A", NOW);
  db.prepare(
    `INSERT INTO staff_notes (id, guild_id, note_number, user_id, author_id, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(202, GUILD_B, 1, "user-b-2", "user-b-1", "Coaching note B", NOW);

  db.prepare(
    `INSERT INTO warnings (id, guild_id, warning_number, user_id, issuer_id, reason, created_at, related_note_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(301, GUILD_A, 1, "user-a-2", "user-a-1", "Spam", NOW, 201);
  db.prepare(
    `INSERT INTO warnings (id, guild_id, warning_number, user_id, issuer_id, reason, created_at, related_note_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(302, GUILD_B, 1, "user-b-2", "user-b-1", "Spam", NOW, 202);

  // Transcript paths in both stored layouts (nested index.html + legacy flat).
  const transcriptPathA = path.join("ticket-transcripts", GUILD_A, "tok-a-1", "index.html");
  const transcriptPathB = path.join("ticket-transcripts", GUILD_B, "tok-b-1.html");
  db.prepare(
    `INSERT INTO tickets (id, guild_id, ticket_number, channel_id, creator_user_id, status, created_at, transcript_token, transcript_path)
     VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?)`,
  ).run(101, GUILD_A, 1, "1200000000000000001", "user-a-1", NOW, "tok-a-1", transcriptPathA);
  db.prepare(
    `INSERT INTO tickets (id, guild_id, ticket_number, channel_id, creator_user_id, status, created_at, transcript_token, transcript_path)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
  ).run(102, GUILD_B, 1, "1200000000000000999", "user-b-1", NOW, "tok-b-1", transcriptPathB);
  db.prepare(`INSERT INTO ticket_members (ticket_id, user_id, added_at) VALUES (?, ?, ?)`).run(101, "user-a-2", NOW);
  db.prepare(`INSERT INTO ticket_staff (ticket_id, user_id, is_owner, added_at) VALUES (?, ?, 1, ?)`).run(101, "user-a-1", NOW);
  db.prepare(
    `INSERT INTO ticket_messages (id, ticket_id, message_id, author_id, author_tag, content, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(901, 101, "msg-a-1", "user-a-1", "alice", "opening", NOW);
  db.prepare(
    `INSERT INTO ticket_messages (id, ticket_id, message_id, author_id, author_tag, content, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(902, 101, "msg-a-2", "user-a-2", "bob", "help", NOW + 1000);
  db.prepare(
    `INSERT INTO ticket_messages (id, ticket_id, message_id, author_id, author_tag, content, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(903, 102, "msg-b-1", "user-b-1", "carol", "hello", NOW);

  db.prepare(
    `INSERT INTO ticket_panels (guild_id, channel_id, message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(GUILD_A, "channel-panel-a", "msg-panel-a", NOW, NOW);
  db.prepare(
    `INSERT INTO ticket_panels (guild_id, channel_id, message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(GUILD_B, "channel-panel-b", "msg-panel-b", NOW, NOW);

  db.prepare(
    `INSERT INTO gork_memories (id, guild_id, subject_user_id, mem_date, title, title_key, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(601, GUILD_A, "user-a-2", "2026-09-01", "Deploy ritual", "deploy ritual", "Fridays.", NOW, NOW);
  db.prepare(
    `INSERT INTO gork_memories (id, guild_id, subject_user_id, mem_date, title, title_key, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(602, GUILD_B, "user-b-2", "2026-09-01", "Deploy ritual", "deploy ritual", "Mondays.", NOW, NOW);

  db.prepare(
    `INSERT INTO gork_interactions (id, uid, kind, guild_id, channel_id, message_id, user_id, status, started_at, created_at)
     VALUES (?, ?, 'qa', ?, ?, ?, ?, 'shipped', ?, ?)`,
  ).run(501, "gork-uid-a-1", GUILD_A, "channel-a-general", "msg-a-1", "user-a-1", NOW, NOW);
  db.prepare(
    `INSERT INTO gork_interactions (id, uid, kind, guild_id, channel_id, message_id, user_id, status, started_at, created_at)
     VALUES (?, ?, 'qa', ?, ?, ?, ?, 'shipped', ?, ?)`,
  ).run(502, "gork-uid-b-1", GUILD_B, "channel-b-general", "msg-b-1", "user-b-1", NOW, NOW);

  db.prepare(
    `INSERT INTO admin_audit (id, guild_id, actor_user_id, origin, action, target_type, target_id, created_at)
     VALUES (?, ?, ?, 'web', 'settings.update', 'guild', ?, ?)`,
  ).run(401, GUILD_A, "user-a-1", GUILD_A, NOW);
  db.prepare(
    `INSERT INTO admin_audit (id, guild_id, actor_user_id, origin, action, target_type, target_id, created_at)
     VALUES (?, ?, ?, 'system', 'settings.update', 'guild', ?, ?)`,
  ).run(402, GUILD_B, null, GUILD_B, NOW);

  db.prepare(
    `INSERT INTO web_sessions (id, user_id, discord_tag, created_at, last_seen_at, expires_at)
     VALUES ('sess-pre-1', 'user-a-1', 'alice#0001', ?, ?, ?)`,
  ).run(NOW, NOW, NOW + 604_800_000);

  // 3. Transcript dirs + files on disk (under DATA_DIR = tmpDir).
  const dirA = path.join(tmpDir, "ticket-transcripts", GUILD_A, "tok-a-1");
  fs.mkdirSync(path.join(dirA, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dirA, "index.html"), "<html>ticket 101</html>", "utf8");
  fs.writeFileSync(path.join(dirA, "assets", "shot.png"), "png-bytes", "utf8");
  const dirB = path.join(tmpDir, "ticket-transcripts", GUILD_B);
  fs.mkdirSync(dirB, { recursive: true });
  fs.writeFileSync(path.join(dirB, "tok-b-1.html"), "<html>ticket 102</html>", "utf8");

  // 4. Pre-migration snapshots for exact post-migration comparisons.
  const ALL_TABLES = [
    "users", "activity_log", "voice_sessions", "guild_settings", "level_roles",
    "role_drop_state", "allowed_command_channels", "youtube_channels",
    "honeypot_channels", "staff_roles", "honeypot_ban_roles",
    "reaction_role_panels", "reaction_role_options", "event_reminder_configs",
    "event_reminder_offsets", "event_reminder_optouts",
    "event_reminder_event_optouts", "staff_notes", "warnings", "tickets",
    "ticket_members", "ticket_staff", "ticket_messages", "ticket_panels",
    "user_channel_message_daily", "activity_ignore", "user_activity_meta",
    "guild_activity_settings", "user_channel_backfill_cursor",
    "guild_channel_backfill_cursor", "guild_command_permission_oauth",
    "twitch_channels", "gork_user_blocks", "gork_memories",
    "gork_budget_rules", "gork_usage", "gork_interactions", "github_watches",
    "admin_audit", "web_sessions",
  ];
  const counts = {};
  for (const t of ALL_TABLES) {
    counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  }
  const preIndexSql = {};
  for (const row of db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
    .all()) {
    preIndexSql[row.name] = row.sql;
  }

  const dbs = [db];
  return {
    db,
    tmpDir,
    dbPath,
    dataDir: connection.dataDir,
    cleanup: createCleanup({ tmpDir, dbs }),
    helpers,
    guildIds: { a: GUILD_A, b: GUILD_B },
    ids: {
      tickets: [101, 102],
      staff_notes: [201, 202],
      warnings: [301, 302],
      admin_audit: [401, 402],
      gork_interactions: [501, 502],
      gork_memories: [601, 602],
      event_reminder_configs: [701, 702],
      ticket_messages: [901, 902, 903],
      event_reminder_offsets: [801, 802],
    },
    transcriptPaths: { a: transcriptPathA, b: transcriptPathB },
    counts,
    preIndexSql,
  };
}

module.exports = { createPre034Fixture };
