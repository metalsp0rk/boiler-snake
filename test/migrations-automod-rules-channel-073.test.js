/**
 * Migration 073 guard (rules-channel extraction, epic #723): the additive
 * `guild_settings.automod_rules_channel_id` column lands on boot, reads
 * NULL on every row that predates it, and replays IDEMPOTENTLY — a full
 * migration replay must never throw on the existing column nor clobber a
 * stored rules source. Naming precedent: migrations-heal-event-dates-072.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();
after(cleanup);

const { id, up } = require("../src/db/migrations/073_automod_rules_channel");
const { addColumnIfMissing } = require("../src/db/connection");
const { runMigrations, migrations } = require("../src/db/migrate");

const names = () =>
  db.db.prepare("PRAGMA table_info(guild_settings)").all().map((c) => c.name);

describe(`${id} — guild_settings.automod_rules_channel_id`, () => {
  it("registers in the migrate.js list and lands the column on boot (NULL default)", () => {
    assert.ok(
      migrations.some((m) => m.id === id),
      "the migration is wired into the runner",
    );
    assert.ok(names().includes("automod_rules_channel_id"));

    const cid = communityKey("073-guard-legacy-guild");
    assert.equal(
      db.getGuildSettings(cid).automod_rules_channel_id,
      null,
      "NULL = unset — no backfill, no fake default",
    );
  });

  it("up() is a no-op replay on the already-migrated DB (addColumnIfMissing belt)", () => {
    const before = names();
    assert.doesNotThrow(() => up(db.db, { addColumnIfMissing }));
    assert.deepEqual(names(), before, "no duplicate column, no touch");
  });

  it("full migration replay keeps the stored rules source intact", () => {
    const cid = communityKey("073-guard-source-guild");
    db.updateGuildSettings(cid, { automod_rules_channel_id: "900000000000000073" });

    db.db.pragma("user_version = 0"); // force the idempotent full replay
    assert.doesNotThrow(() => runMigrations());

    const cols = names();
    assert.equal(
      cols.filter((n) => n === "automod_rules_channel_id").length,
      1,
      "replay never adds the column twice",
    );
    assert.equal(
      db.getGuildSettings(cid).automod_rules_channel_id,
      "900000000000000073",
      "the replay preserves the operator's source",
    );
  });
});
