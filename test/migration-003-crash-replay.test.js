/**
 * #458 (B2-9): migration 003's crash-window replay. The pass used to run
 * bare (no transaction, no staging cleanup): a process death between the
 * INSERT and the DROP left `youtube_channels_new` behind, and the replay —
 * CREATE IF NOT EXISTS keeping the stale table, INSERT…SELECT colliding
 * with its own half-written rows — threw UNIQUE constraint failed out of
 * runMigrations, so LOGIN NEVER HAPPENED until a human ran manual SQL.
 * (Crash after the DROP left the data renamed-away: the early return meant
 * the table stayed missing.)
 *
 * The suite drives the migration's real `up()` against the loaded test DB
 * (helpers from connection.js, same wiring migrate.js uses), across every
 * crash-residue shape.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");
const { cleanup } = loadDb(); // CONTRACT: fresh DB before any src/ require

const { db, tableExists, getPrimaryKeyColumns } = require("../src/db/connection");
const { up } = require("../src/db/migrations/003_youtube_composite_pk");

after(cleanup);

const helpers = { tableExists, getPrimaryKeyColumns };

/** Pre-003 legacy shape: same column ORDER, PK on id alone. */
const LEGACY_DDL = `
CREATE TABLE youtube_channels (
  guild_id TEXT NOT NULL,
  id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  channel_url TEXT NOT NULL,
  thumbnail_url TEXT,
  last_video_id TEXT,
  last_checked INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (id)
)`;

/** 003's target shape. */
const COMPOSITE_DDL = `
CREATE TABLE youtube_channels_new (
  guild_id TEXT NOT NULL,
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
)`;

function wipe() {
  db.exec("DROP TABLE IF EXISTS youtube_channels; DROP TABLE IF EXISTS youtube_channels_new;");
}

function seed(table, id, name = `chan-${id}`) {
  db.prepare(
    `INSERT INTO ${table} (guild_id, id, channel_name, channel_url, created_at, updated_at)
     VALUES ('g1', ?, ?, 'https://example/x', 1, 1)`
  ).run(id, name);
}

const rows = () =>
  db.prepare("SELECT id FROM youtube_channels ORDER BY id").all().map((r) => r.id);

describe("migration 003 crash-window replay (#458)", () => {
  before(wipe);

  it("plain legacy DB rebuilds to the composite PK and re-runs are inert", () => {
    wipe();
    db.exec(LEGACY_DDL);
    seed("youtube_channels", "100");
    seed("youtube_channels", "200");

    up(db, helpers);
    assert.deepEqual(rows(), ["100", "200"]);
    assert.deepEqual(getPrimaryKeyColumns("youtube_channels"), ["guild_id", "id"]);

    up(db, helpers); // "re-running migrations is safe"
    assert.deepEqual(rows(), ["100", "200"], "idempotent");
  });

  it("REPLAY after a crash between INSERT and DROP completes instead of throwing (boot loop RED)", () => {
    wipe();
    db.exec(LEGACY_DDL); // old table still live (old PK — 003 still detected)
    seed("youtube_channels", "100");
    seed("youtube_channels", "200");
    db.exec(COMPOSITE_DDL); // stale staging table from the crashed pass…
    seed("youtube_channels_new", "100"); // …holding its half-written rows

    // Old code: CREATE IF NOT EXISTS kept the staging table, INSERT…SELECT
    // collided with the seeded twin → UNIQUE constraint failed → boot loop.
    up(db, helpers);

    assert.equal(tableExists("youtube_channels_new"), false, "staging consumed");
    assert.deepEqual(rows(), ["100", "200"], "the OLD table's rows are the truth — no duplicates");
    assert.deepEqual(getPrimaryKeyColumns("youtube_channels"), ["guild_id", "id"]);
  });

  it("REPLAY after a crash between DROP and RENAME heals by finishing the rename", () => {
    wipe();
    db.exec(COMPOSITE_DDL); // the DROP landed; the RENAME died
    seed("youtube_channels_new", "300");

    up(db, helpers);

    assert.equal(tableExists("youtube_channels"), true, "the table is BACK — data not orphaned");
    assert.deepEqual(rows(), ["300"], "the staged rows survive the heal");
    assert.deepEqual(getPrimaryKeyColumns("youtube_channels"), ["guild_id", "id"]);
    assert.equal(tableExists("youtube_channels_new"), false);
  });

  it("composite PK + leftover staging (post-fix residue) drops the staging only", () => {
    wipe();
    db.exec(COMPOSITE_DDL.replace("youtube_channels_new", "youtube_channels_temp_guard"));
    db.exec("ALTER TABLE youtube_channels_temp_guard RENAME TO youtube_channels");
    seed("youtube_channels", "400");
    db.exec(COMPOSITE_DDL);
    seed("youtube_channels_new", "junk");

    up(db, helpers);

    assert.deepEqual(rows(), ["400"], "the completed table is untouched");
    assert.equal(tableExists("youtube_channels_new"), false, "residue dropped, not resurrected");
  });

  it("no table at all stays a no-op", () => {
    wipe();
    up(db, helpers);
    assert.equal(tableExists("youtube_channels"), false);
  });
});
