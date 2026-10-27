const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const {
  loadDb,
  communityKey,
  createTempDbPath,
  resetSrcModules,
  FAKE_TOKEN_ENCRYPTION_KEY,
} = require("./helpers/env");

/**
 * Migration 041_heal_partial_community_cutover (audit-2026-10 #285): the
 * self-healing repair for legacy DBs stuck in the HISTORICAL PARTIAL 034
 * cutover (users cut over by a pre-fix migration file → 034's users-gate
 * never re-evaluates → stragglers like youtube_channels keep `guild_id TEXT`
 * while every repository query needs `community_id`; #202's user_version
 * fast-skip makes that state permanent).
 *
 * The fixture below reproduces the drill copy's shape EXACTLY (verified on a
 * real DB by the #283 boot drill): users already on community_id + the 040
 * CHECK, communities partially populated, `youtube_channels` on the
 * historical guild_id shape (PRIMARY KEY (guild_id, id) +
 * UNIQUE(guild_id, channel_name), staged + RENAME'd so sqlite_master holds the
 * QUOTED `"youtube_channels"` DDL spelling that crashed prod 2026-10-01), and
 * a second synthetic straggler (gork_memories) proving the repair is generic.
 */

const GUILD_A = "1554590611015729152"; // pre-existing communities row (drill-style)
const GUILD_B = "1600000000000000001"; // appears ONLY on the gork_memories straggler
const GUILD_C = "1600000000000000002"; // appears ONLY on the youtube straggler
const FIXTURE_NOW = 1700000000000;

/**
 * Historical youtube_channels shape — the 001/003-era body verbatim (041's
 * output must land on the SAME DDL a fresh 001→041 chain produces, so the
 * source text here must match the migrations' exactly).
 * `nullableGuild` exists only for the fail-loud fixture (the pre-003 legacy
 * shape let guild_id be NULL; the drill copy's shape is NOT NULL).
 */
function youtubeStragglerDdl(tableName, { nullableGuild = false } = {}) {
  return `
CREATE TABLE ${tableName} (
  guild_id ${nullableGuild ? "TEXT" : "TEXT NOT NULL"},
  id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  channel_url TEXT NOT NULL,
  thumbnail_url TEXT,
  last_video_id TEXT,
  last_checked INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, id),
  UNIQUE(guild_id, channel_name)
);`;
}

/** Historical gork_memories shape — the 023-era body + named index verbatim. */
const GORK_MEMORIES_STRAGGLER_DDL = `
  CREATE TABLE gork_memories (
    id INTEGER PRIMARY KEY,                 -- rowid alias = the /gork memory "#id" handle
    guild_id TEXT NOT NULL,
    subject_user_id TEXT NOT NULL,
    mem_date TEXT NOT NULL,                 -- YYYY-MM-DD UTC, server-stamped
    title TEXT NOT NULL,                    -- display (model casing)
    title_key TEXT NOT NULL,                -- normalizeTitle() output (key half)
    body TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'profile',   -- profile|preference|project|relationship|event
    importance INTEGER NOT NULL DEFAULT 3,  -- 1..5
    source_message_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    UNIQUE(guild_id, subject_user_id, mem_date, title_key)
  );
  CREATE INDEX IF NOT EXISTS idx_gork_memories_subject
    ON gork_memories(guild_id, subject_user_id);
`;

const norm = (sql) => String(sql ?? "").replace(/\s+/g, " ").trim();

/** Normalized sqlite_master snapshot of every object belonging to a table. */
function tableObjects(db, table) {
  return db
    .prepare(
      "SELECT type, name, COALESCE(sql,'') AS sql FROM sqlite_master WHERE tbl_name=? ORDER BY type, name"
    )
    .all(table)
    .map((r) => ({ type: r.type, name: r.name, sql: norm(r.sql) }));
}

/** PRAGMA table_info rows (the shape every repository reads). */
function tableInfo(db, table) {
  return db.prepare(`PRAGMA table_info("${table}")`).all();
}

/** Whole-DB schema snapshot (rootpage excluded: a replay may move pages). */
function fullSchema(db) {
  return db
    .prepare(
      "SELECT type, name, tbl_name, COALESCE(sql,'') AS sql FROM sqlite_master ORDER BY type, name"
    )
    .all()
    .map((r) => ({ type: r.type, name: r.name, tbl_name: r.tbl_name, sql: norm(r.sql) }));
}

/**
 * Build a DB frozen in the exact partial-cutover state.
 *
 * @param {{ nullableYoutubeGuild?: boolean, withGorkStraggler?: boolean }} [opts]
 */
function createPartialCutoverFixture({ nullableYoutubeGuild = false, withGorkStraggler = true } = {}) {
  const env = createTempDbPath();
  process.env.DB_PATH = env.dbPath;
  process.env.DATA_DIR = env.tmpDir;
  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    process.env.TOKEN_ENCRYPTION_KEY = FAKE_TOKEN_ENCRYPTION_KEY;
  }
  resetSrcModules();
  const connection = require("../src/db/connection");
  env.dbs.push(connection.db);
  const db = connection.db;

  const helpers = {
    now: connection.now,
    tableExists: connection.tableExists,
    getColumns: connection.getColumns,
    addColumnIfMissing: connection.addColumnIfMissing,
    getPrimaryKeyColumns: connection.getPrimaryKeyColumns,
  };

  // 1. Full modern chain 001→040 (skipping only the subject 041): users on
  //    community_id WITH the 040 CHECK, communities table present and empty.
  const { migrations } = require("../src/db/migrate");
  for (const m of migrations) {
    if (String(m.id ?? "") >= "041") continue;
    m.up(db, helpers);
  }

  // 2. Communities PARTIALLY populated: only the guild the pre-crash backfill
  //    had already registered (drill copy: 6 rows existed; the stragglers'
  //    other guild values did not).
  db.prepare(
    `INSERT INTO communities (platform, instance_key, external_guild_id, created_at)
     VALUES ('discord', 'discord', ?, ?)`
  ).run(GUILD_A, FIXTURE_NOW);

  // 3. Demolish youtube_channels back to the historical shape: recreate the
  //    001/003-era table under a staged name and ALTER … RENAME it, exactly
  //    like the 003 rebuild did — the rename leaves sqlite_master holding the
  //    QUOTED `CREATE TABLE "youtube_channels"` spelling (034's crash comment).
  const yt = youtubeStragglerDdl("youtube_channels_003_stage", { nullableGuild: nullableYoutubeGuild });
  db.exec("DROP TABLE youtube_channels");
  db.exec(yt);
  const insYt = db.prepare(
    `INSERT INTO youtube_channels_003_stage
       (guild_id, id, channel_name, channel_url, thumbnail_url, last_video_id, last_checked, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insYt.run(GUILD_A, "UCalpha", "Channel Alpha", "https://youtu.example/alpha", "https://img/alpha", "vid-1", 1700000001000, 1690000000000, 1699000000000);
  insYt.run(GUILD_A, "UCbeta", "Channel Beta", "https://youtu.example/beta", null, null, null, 1690000000001, 1699000000001);
  insYt.run(GUILD_C, "UCgamma", "Channel Gamma", "https://youtu.example/gamma", "https://img/gamma", "vid-9", 1700000002000, 1690000000002, 1699000000002);
  if (nullableYoutubeGuild) {
    // Fail-loud fixture only: a row that cannot map to ANY community.
    insYt.run(null, "UC-null", "Orphan Channel", "https://youtu.example/orphan", null, null, null, 1690000000003, 1699000000003);
  }
  db.exec("ALTER TABLE youtube_channels_003_stage RENAME TO youtube_channels");

  // 4. Second synthetic straggler (gork_memories, 023-era shape + named index)
  //    — proves the repair is generic, not youtube-only.
  if (withGorkStraggler) {
    db.exec("DROP TABLE gork_memories");
    db.exec(GORK_MEMORIES_STRAGGLER_DDL);
    const insMem = db.prepare(
      `INSERT INTO gork_memories
         (id, guild_id, subject_user_id, mem_date, title, title_key, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insMem.run(601, GUILD_B, "user-bob", "2026-09-01", "Deploy ritual", "deploy ritual", "Fridays.", 1690000000004, 1699000000004);
    insMem.run(602, GUILD_C, "user-carol", "2026-09-02", "Standup notes", "standup notes", "Async.", 1690000000005, 1699000000005);
  }

  // 5. Pre-repair snapshots for byte-equality + rollback assertions.
  const youtubeRows = db
    .prepare("SELECT rowid AS __rowid, * FROM youtube_channels ORDER BY rowid")
    .all();
  const memoryRows = withGorkStraggler
    ? db.prepare("SELECT * FROM gork_memories ORDER BY id").all()
    : [];
  const communities = db.prepare("SELECT * FROM communities ORDER BY id").all();

  return { env, db, connection, helpers, youtubeRows, memoryRows, communities };
}

describe("migration 041 heals the real partial 034 cutover (#285 drill state)", () => {
  let fixture;
  let migrate;
  let heal041;
  let hygiene040;
  let ytRepo;
  let fresh; // fresh-chain reference DB for parity (built lazily, AFTER repo work)

  before(() => {
    fixture = createPartialCutoverFixture();
    migrate = require("../src/db/migrate");
    heal041 = require("../src/db/migrations/041_heal_partial_community_cutover");
    hygiene040 = require("../src/db/migrations/040_schema_hygiene");
    // Bind the repository to THIS fixture connection before any later
    // loadDb() resets the require cache.
    ytRepo = require("../src/db/repositories/youtube");
  });

  after(() => {
    fixture?.env?.cleanup();
    fresh?.cleanup?.();
  });

  it("fixture matches the drill copy: users cut over + CHECK, youtube on quoted-name guild_id DDL, communities partial", () => {
    const { db } = fixture;
    const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get().sql;
    assert.doesNotMatch(usersSql, /guild_id/, "users must already be on community_id");
    assert.match(usersSql, /CHECK \(xp BETWEEN 0 AND 9007199254740991\)/, "users carries the 040 CHECK");

    const ytSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='youtube_channels'").get().sql;
    assert.match(ytSql, /^CREATE TABLE "youtube_channels"/, "the RENAME produced the QUOTED-name spelling (034's crash shape)");
    assert.match(ytSql, /PRIMARY KEY \(guild_id, id\)/);
    assert.match(ytSql, /UNIQUE\(guild_id, channel_name\)/);

    const communities = db.prepare("SELECT external_guild_id FROM communities").all().map((r) => r.external_guild_id);
    assert.deepEqual(communities, [GUILD_A], "communities is partially populated");

    assert.deepEqual(
      heal041.findStragglers(db, fixture.helpers).map((s) => s.table),
      ["youtube_channels", "gork_memories"],
      "detection follows 034's GUILD_SCOPED_TABLES order and finds BOTH stragglers, nothing else"
    );
  });

  it("040's users CHECK rebuild is a no-op on the straggler-era users table (assert, not assumed)", () => {
    const summary = hygiene040.up(fixture.db, { tableExists: fixture.connection.tableExists });
    assert.deepEqual(summary.rebuilt, [], "040 must NOT rebuild users in the partial state");
    assert.ok(summary.skipped.includes("users:already-checked"), `users must land in the already-checked bucket: ${summary.skipped}`);
    assert.ok(summary.skipped.includes("gork_budget_rules:already-checked"));
  });

  it("full migrate() boot on the partial DB heals both stragglers and stamps the current version", () => {
    const result = migrate.runMigrations(); // user_version is 0 → full replay path
    assert.equal(result.skipped, false);
    assert.equal(result.version, 66);

    const stragglers = heal041.findStragglers(fixture.db, fixture.helpers);
    assert.deepEqual(stragglers, [], "no straggler may survive the repair");
    const ytCols = tableInfo(fixture.db, "youtube_channels").map((c) => c.name);
    assert.ok(ytCols.includes("community_id"), "youtube_channels is on community_id");
    assert.ok(!ytCols.includes("guild_id"), "guild_id is gone");
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '%_041_new'").get().n,
      0,
      "staging tables must not linger"
    );
  });

  it("youtube_channels + gork_memories schemas PARITY-match a fresh-built DB", () => {
    fresh = loadDb(); // fresh 001→041 chain as reference
    for (const table of ["youtube_channels", "gork_memories"]) {
      assert.deepEqual(
        tableObjects(fixture.db, table),
        tableObjects(fresh.api.db, table),
        `${table} sqlite_master objects must match the fresh build exactly`
      );
      assert.deepEqual(
        tableInfo(fixture.db, table),
        tableInfo(fresh.api.db, table),
        `${table} PRAGMA table_info (columns/types/defaults/PK) must match the fresh build exactly`
      );
    }
    // PK + UNIQUE shape pins (the pre-repair historical constraints re-keyed)
    const pk = tableInfo(fixture.db, "youtube_channels").filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    assert.deepEqual(pk.map((c) => c.name), ["community_id", "id"], "PK(guild_id,id) → PK(community_id,id)");
    const ytSql = fixture.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='youtube_channels'").get().sql;
    assert.match(ytSql, /UNIQUE\(community_id, channel_name\)/, "table-level UNIQUE re-keyed");
    const memIdx = fixture.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_gork_memories_subject'").get();
    assert.match(memIdx.sql, /ON gork_memories\s*\(\s*community_id,\s*subject_user_id\s*\)/, "named straggler index re-issued on community_id");
  });

  it("rows survive byte-equal with guild values mapped through communities (existing id reused, missing ones backfilled)", () => {
    const { db, youtubeRows, memoryRows, communities } = fixture;
    const idA = communities.find((c) => c.external_guild_id === GUILD_A).id; // pre-existing row
    const rows = db.prepare("SELECT * FROM youtube_channels ORDER BY id").all();
    assert.equal(rows.length, 3);

    const byId = Object.fromEntries(youtubeRows.map((r) => [r.id, r]));
    for (const row of rows) {
      const pre = byId[row.id];
      const expectedGuild = row.community_id === idA ? GUILD_A : undefined;
      // Every column except the key must be byte-equal with the pre-repair row.
      // 046/047 append columns to the schema; the repair must leave them NULL
      // (never fabricate values), so they are asserted separately.
      const { guild_id: _g, __rowid: _r, ...preRest } = pre;
      const { community_id: _c, last_live_id: postLive, last_checked_at: postCheckedAt, ...postRest } = row;
      assert.equal(postLive ?? null, null, `youtube row ${row.id}: appended 046 column stays NULL through repair`);
      assert.equal(postCheckedAt ?? null, null, `youtube row ${row.id}: appended 047 column stays NULL through repair`);
      assert.deepEqual(postRest, preRest, `youtube row ${row.id} preserved byte-for-byte`);
      const srcGuild = expectedGuild ?? GUILD_C;
      const comm = db
        .prepare("SELECT * FROM communities WHERE platform='discord' AND instance_key='discord' AND external_guild_id=?")
        .get(srcGuild);
      assert.ok(comm, `communities row for ${srcGuild} backfilled`);
      assert.equal(row.community_id, comm.id, `guild ${srcGuild} mapped to its community id`);
      // guild → community mapping is consistent the other way, too
      assert.equal(comm.external_guild_id, srcGuild);
    }
    // Existing community reused unchanged; missing guilds backfilled exactly once.
    const allCommunities = db.prepare("SELECT * FROM communities ORDER BY id").all();
    assert.equal(allCommunities.length, 3, "two new discord rows backfilled (GUILD_B, GUILD_C)");
    const reused = allCommunities.find((c) => c.external_guild_id === GUILD_A);
    assert.equal(reused.id, idA, "the pre-existing communities row keeps its id");
    assert.equal(reused.created_at, communities.find((c) => c.id === idA).created_at, "…and its created_at");

    // gork_memories: integer PKs copied unchanged, guilds mapped.
    const mems = db.prepare("SELECT * FROM gork_memories ORDER BY id").all();
    assert.deepEqual(mems.map((m) => [m.id, m.subject_user_id, m.body, m.kind, m.importance, m.source_message_ids]),
      memoryRows.map((m) => [m.id, m.subject_user_id, m.body, m.kind, m.importance, m.source_message_ids]),
      "gork_memories data rode the rebuild unchanged");
    const idB = db.prepare("SELECT id FROM communities WHERE external_guild_id=?").get(GUILD_B).id;
    const idC = db.prepare("SELECT id FROM communities WHERE external_guild_id=?").get(GUILD_C).id;
    assert.equal(mems.find((m) => m.id === 601).community_id, idB);
    assert.equal(mems.find((m) => m.id === 602).community_id, idC);
  });

  it("youtube repository queries run against the healed DB — the exact runtime failure #285 caused", () => {
    const { db } = fixture;
    // Pre-repair, every repository statement threw `no such column: community_id`
    // on this DB; post-repair they all work through the real repository code.
    const idA = db.prepare("SELECT id FROM communities WHERE external_guild_id=?").get(GUILD_A).id;
    const idC = db.prepare("SELECT id FROM communities WHERE external_guild_id=?").get(GUILD_C).id;

    const listA = ytRepo.getYoutubeChannels(idA);
    assert.deepEqual(listA.map((r) => r.id).sort(), ["UCalpha", "UCbeta"]);
    assert.deepEqual(ytRepo.getAllYoutubeChannels().length, 3, "ticker-path read works");

    const added = ytRepo.addYoutubeChannel(idC, "@UCdelta", "@UCdelta", "https://youtu.example/delta", null);
    assert.equal(added.community_id, idC);
    assert.deepEqual(ytRepo.getYoutubeChannels(idC).map((r) => r.id), ["UCgamma", "UCdelta"], "created_at ASC order");

    ytRepo.updateYoutubeChannelLastChecked(idC, "UCdelta", 1700000009000, "vid-new");
    assert.equal(db.prepare("SELECT last_video_id, last_checked FROM youtube_channels WHERE id='UCdelta'").get().last_video_id, "vid-new");
    ytRepo.removeYoutubeChannel(idC, "UCdelta"); // (return value rides a `changes()` column-name quirk — see web/routes/integrations.js)
    assert.equal(fixture.db.prepare("SELECT COUNT(*) n FROM youtube_channels WHERE id='UCdelta'").get().n, 0);
    assert.deepEqual(ytRepo.getYoutubeChannels(idC).map((r) => r.id), ["UCgamma"]);

    // UNIQUE(community_id, channel_name) is community-scoped after the heal:
    // the SAME channel_name under a DIFFERENT community must be insertable.
    // (Raw communities insert — communityKey would bind through the require
    // cache, which the parity test's loadDb() has since rebound.)
    const gNew = Number(
      db.prepare(
        `INSERT INTO communities (platform, instance_key, external_guild_id, created_at)
         VALUES ('discord', 'discord', '1700000000000000003', ?)`
      ).run(FIXTURE_NOW).lastInsertRowid
    );
    ytRepo.addYoutubeChannel(gNew, "UCalpha", "Channel Alpha", "https://youtu.example/alpha-other", null);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM youtube_channels WHERE channel_name='Channel Alpha'").get().n, 2);
    // …and a true duplicate within one community still conflicts via upsert (repo path).
    ytRepo.addYoutubeChannel(gNew, "UCalpha", "Channel Alpha", "https://youtu.example/alpha-other2", null);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM youtube_channels WHERE channel_name='Channel Alpha' AND community_id=?").get(gNew).n, 1);
  });

  it("direct re-run of 041 after the repair is a pure no-op", () => {
    const summary = heal041.up(fixture.db, fixture.helpers);
    assert.deepEqual(summary, { migrated: false, healed: [] });
  });

  it("re-running the full migrate() converges: user_version skip first, full replay second, zero schema drift", () => {
    const skip = migrate.runMigrations(); // #202 guard: version already 41
    assert.deepEqual(skip, { skipped: true, version: 66, latest: 66 });

    const beforeSchema = fullSchema(fixture.db);
    const beforeCommunities = fixture.db.prepare("SELECT * FROM communities ORDER BY id").all();
    fixture.db.pragma("user_version = 0"); // force the FULL replay incl. 041
    const replay = migrate.runMigrations();
    assert.equal(replay.skipped, false);
    assert.equal(replay.version, 66);
    assert.deepEqual(fullSchema(fixture.db), beforeSchema, "replay must not drift the healed schema");
    assert.deepEqual(fixture.db.prepare("SELECT * FROM communities ORDER BY id").all(), beforeCommunities,
      "replay must not add communities rows");
  });
});

describe("migration 041 is a pure no-op on a healthy DB", () => {
  let api;
  let cleanup;
  let heal041;
  let connection;
  let helpers;

  before(() => {
    ({ api, cleanup } = loadDb());
    // AFTER loadDb (which resets the src require cache) so helpers and
    // communityKey all bind to THIS describe's fresh connection.
    heal041 = require("../src/db/migrations/041_heal_partial_community_cutover");
    connection = require("../src/db/connection");
    helpers = {
      now: connection.now,
      tableExists: connection.tableExists,
      getColumns: connection.getColumns,
      addColumnIfMissing: connection.addColumnIfMissing,
      getPrimaryKeyColumns: connection.getPrimaryKeyColumns,
    };
  });

  after(() => cleanup?.());

  it("findStragglers finds nothing on the fresh 001→041 chain", () => {
    assert.deepEqual(heal041.findStragglers(api.db, helpers), [], "every guild-scoped table carries community_id");
  });

  it("041.up() is a no-op: zero schema change, zero new communities rows", () => {
    const g = communityKey("g-041-healthy"); // one known community row (proves "no NEW rows")
    const schemaBefore = fullSchema(api.db);
    const communitiesBefore = api.db.prepare("SELECT * FROM communities ORDER BY id").all();

    const summary = heal041.up(api.db, { now: connection.now, tableExists: connection.tableExists, getColumns: connection.getColumns });
    assert.deepEqual(summary, { migrated: false, healed: [] });
    assert.deepEqual(fullSchema(api.db), schemaBefore, "sqlite_master must not move at all");
    assert.deepEqual(api.db.prepare("SELECT * FROM communities ORDER BY id").all(), communitiesBefore);
    assert.ok(g >= 1);
  });

  it("a full replay pass through runMigrations() also keeps a healthy DB byte-stable and re-stamps the current version", () => {
    const schemaBefore = fullSchema(api.db);
    const communitiesBefore = api.db.prepare("SELECT * FROM communities ORDER BY id").all();
    const { runMigrations } = require("../src/db/migrate");
    api.db.pragma("user_version = 0");
    assert.equal(runMigrations().skipped, false);
    assert.equal(Number(api.db.pragma("user_version", { simple: true })), 66);
    assert.deepEqual(fullSchema(api.db), schemaBefore);
    assert.deepEqual(api.db.prepare("SELECT * FROM communities ORDER BY id").all(), communitiesBefore);
  });
});

describe("migration 041 fails loud on un-mappable straggler rows (#285 honest-choice policy)", () => {
  let fixture;
  let heal041;

  before(() => {
    // Same partial state, but on the oldest (pre-003) NULLable guild_id shape
    // with one orphan row — 034's backfill skipped NULL guild_ids and a NULL
    // cannot map into INTEGER NOT NULL community_id, so 041 must REFUSE by
    // name instead of dropping the row the way 034's JOIN silently did.
    fixture = createPartialCutoverFixture({ nullableYoutubeGuild: true, withGorkStraggler: false });
    heal041 = require("../src/db/migrations/041_heal_partial_community_cutover");
  });

  after(() => fixture?.env?.cleanup());

  it("a NULL-guild straggler row refuses the repair, naming table + row + condition", () => {
    const communitiesBefore = fixture.db.prepare("SELECT COUNT(*) n FROM communities").get().n;
    const ytBefore = fixture.db.prepare("SELECT COUNT(*) n FROM youtube_channels").get().n;

    assert.throws(
      () => heal041.up(fixture.db, fixture.helpers),
      (err) =>
        /Migration 041_heal_partial_community_cutover refused/.test(err.message) &&
        /youtube_channels\[guild_id=NULL, id='UC-null'\]/.test(err.message) &&
        /rowid=\d+/.test(err.message) &&
        /NULL guild_id cannot map to an INTEGER NOT NULL community_id/.test(err.message) &&
        /gork_memories/.test(err.message) === false,
      "error must name the exact row (ids + rowid) and the ambiguous condition"
    );

    // Full rollback: the communities backfill is undone, the straggler keeps
    // its historical shape, no staging debris, data untouched.
    assert.equal(fixture.db.prepare("SELECT COUNT(*) n FROM communities").get().n, communitiesBefore,
      "the rolled-back pass adds no communities rows");
    assert.equal(fixture.db.prepare("SELECT COUNT(*) n FROM youtube_channels").get().n, ytBefore);
    assert.ok(fixture.helpers.getColumns("youtube_channels").includes("guild_id"), "pre-state intact: straggler still on guild_id");
    assert.equal(fixture.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '%_041_new'").get().n, 0);
    assert.ok(!fixture.helpers.getColumns("gork_memories").includes("guild_id"), "non-straggler gork_memories untouched");
  });

  it("once the orphan row is fixed out-of-band, the same repair applies cleanly", () => {
    fixture.db.prepare("DELETE FROM youtube_channels WHERE id='UC-null'").run();
    const summary = heal041.up(fixture.db, fixture.helpers);
    assert.deepEqual(summary, { migrated: true, healed: ["youtube_channels"] });
    assert.ok(fixture.helpers.getColumns("youtube_channels").includes("community_id"));
    assert.deepEqual(heal041.up(fixture.db, fixture.helpers), { migrated: false, healed: [] });
  });
});

describe("migration 041 fails loud on ambiguous straggler shapes (synthetic, healthy DB)", () => {
  let env;
  let heal041;

  /** Fresh healthy DB + one synthetic weirdness, isolated per case. */
  function sandbox(mutate) {
    const loaded = loadDb();
    env = loaded;
    const connection = require("../src/db/connection");
    const helpers = {
      now: connection.now,
      tableExists: connection.tableExists,
      getColumns: connection.getColumns,
      addColumnIfMissing: connection.addColumnIfMissing,
      getPrimaryKeyColumns: connection.getPrimaryKeyColumns,
    };
    mutate(loaded.api.db);
    return { db: loaded.api.db, helpers, cleanup: loaded.cleanup };
  }

  before(() => {
    heal041 = require("../src/db/migrations/041_heal_partial_community_cutover");
  });

  it("a straggler missing BOTH columns is refused by name", () => {
    const run = sandbox((db) => {
      db.exec("DROP TABLE activity_ignore");
      db.exec("CREATE TABLE activity_ignore (id INTEGER PRIMARY KEY, target_id TEXT)");
    });
    try {
      assert.throws(
        () => heal041.up(run.db, run.helpers),
        (err) =>
          /Migration 041_heal_partial_community_cutover refused — ambiguous/.test(err.message) &&
          /activity_ignore is missing BOTH the guild_id and community_id columns/.test(err.message)
      );
      assert.deepEqual(run.helpers.getColumns("activity_ignore"), ["id", "target_id"]);
    } finally {
      run.cleanup();
    }
  });

  it("a straggler carrying BOTH columns is refused (no authoritative half)", () => {
    const run = sandbox((db) => {
      db.exec("ALTER TABLE staff_roles ADD COLUMN guild_id TEXT");
    });
    try {
      assert.throws(
        () => heal041.up(run.db, run.helpers),
        (err) =>
          /Migration 041_heal_partial_community_cutover refused — ambiguous/.test(err.message) &&
          /staff_roles carries BOTH guild_id and community_id/.test(err.message)
      );
    } finally {
      run.cleanup();
    }
  });

  it("a WITHOUT ROWID straggler is refused with a specific error (no rowid labelling guesswork)", () => {
    const run = sandbox((db) => {
      db.exec("DROP TABLE guild_activity_settings");
      db.exec(`CREATE TABLE guild_activity_settings (
        guild_id TEXT NOT NULL,
        collect_from_ms INTEGER,
        PRIMARY KEY (guild_id)
      ) WITHOUT ROWID`);
    });
    try {
      assert.throws(
        () => heal041.up(run.db, run.helpers),
        (err) => /WITHOUT ROWID table/.test(err.message) && /guild_activity_settings/.test(err.message)
      );
    } finally {
      run.cleanup();
    }
  });

  it("stragglers without the 034 communities table are refused with the 034 prerequisite named", () => {
    const run = sandbox((db) => {
      // A guild-ONLY straggler (the repairable shape, so the ambiguity gate
      // passes and the communities guard is the thing that fires).
      db.exec("DROP TABLE honeypot_ban_roles");
      db.exec(`CREATE TABLE honeypot_ban_roles (
        guild_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, role_id)
      )`);
      db.exec("DROP TABLE communities");
    });
    try {
      assert.throws(
        () => heal041.up(run.db, run.helpers),
        (err) =>
          /communities table is missing/.test(err.message) &&
          /034 cutover never ran/.test(err.message)
      );
    } finally {
      run.cleanup();
    }
  });
});

describe("migration 041 refuses to half-repair a tickets straggler (transcript-path artifacts)", () => {
  it("a tickets guild_id straggler is refused BEFORE any mutation, naming transcript_path", () => {
    const loaded = loadDb();
    const connection = require("../src/db/connection");
    const helpers = {
      now: connection.now,
      tableExists: connection.tableExists,
      getColumns: connection.getColumns,
      addColumnIfMissing: connection.addColumnIfMissing,
      getPrimaryKeyColumns: connection.getPrimaryKeyColumns,
    };
    const db = loaded.api.db;
    const heal041 = require("../src/db/migrations/041_heal_partial_community_cutover");
    // Historical tickets shape: guild_id WITHOUT community_id (the repairable
    // column shape — only the transcript-artifact capability gate may fire).
    // Children (ticket_members/…) are referenced by name and stay untouched;
    // FKs off for the swap exactly like 034's rebuild toggles them.
    db.pragma("foreign_keys = OFF");
    db.exec("DROP TABLE tickets");
    db.exec(`CREATE TABLE tickets (
      guild_id TEXT NOT NULL,
      id TEXT NOT NULL,
      channel_id TEXT UNIQUE,
      transcript_path TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, id)
    )`);
    db.pragma("foreign_keys = ON");
    try {
      assert.throws(
        () => heal041.up(db, helpers),
        (err) =>
          /Migration 041_heal_partial_community_cutover refused/.test(err.message) &&
          /tickets is a guild_id straggler/.test(err.message) &&
          /transcript_path/.test(err.message)
      );
      // Refused BEFORE mutating: still on the historical shape, no staging
      // table, no communities side-effects from the backfill step.
      assert.ok(helpers.getColumns("tickets").includes("guild_id"));
      assert.ok(!helpers.getColumns("tickets").includes("community_id"));
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE '%_041_new'").get(),
        undefined
      );
    } finally {
      loaded.cleanup();
    }
  });
});

describe("migration 041 registry wiring", () => {
  it("registry wiring is append-only: 041 stays directly after 040, new migrations extend the tail", () => {
    const { migrations, LATEST_VERSION } = require("../src/db/migrate");
    assert.equal(migrations.length, 66);
    assert.equal(LATEST_VERSION, 66);
    assert.equal(migrations[39].id, "040_schema_hygiene");
    assert.equal(migrations[40].id, "041_heal_partial_community_cutover");
    assert.equal(migrations[41].id, "042_events_core");
    assert.equal(migrations[44].id, "045_event_integrations");
    assert.equal(migrations[45].id, "046_youtube_live_pointer");
    assert.equal(migrations[46].id, "047_youtube_checked_at");
    assert.equal(migrations[47].id, "048_gork_log_channel");
    assert.equal(migrations[48].id, "049_honeypot_pause");
    assert.equal(migrations[49].id, "050_xp_cooldown_clamp");
  });

  it("reuses 034's GUILD_SCOPED_TABLES + transformCreateTableSql (single source of truth)", () => {
    const c34 = require("../src/db/migrations/034_communities");
    assert.ok(Array.isArray(c34.GUILD_SCOPED_TABLES) && c34.GUILD_SCOPED_TABLES.includes("youtube_channels"));
    assert.equal(typeof c34.transformCreateTableSql, "function");
  });
});
