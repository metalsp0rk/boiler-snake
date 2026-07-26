const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

describe("db layer", () => {
  let api;
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boiler-snake-db-"));
    dbPath = path.join(tmpDir, "test.sqlite");
    process.env.DB_PATH = dbPath;
    // Fresh require after setting DB_PATH — clear cache for db modules
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}src${path.sep}db`) || key.endsWith(`${path.sep}db.js`)) {
        delete require.cache[key];
      }
    }
    api = require("../src/db");
  });

  it("opens DB and runs migrations (users table exists)", () => {
    const row = api.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`)
      .get();
    assert.ok(row);
    assert.ok(fs.existsSync(dbPath));
  });

  it("youtube_channels has composite primary key (guild_id, id)", () => {
    const pk = api.db
      .prepare(`PRAGMA table_info(youtube_channels)`)
      .all()
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    assert.deepEqual(pk, ["guild_id", "id"]);
  });

  it("addXp / getXp / topUsers round-trip", () => {
    const guildId = "g-test";
    const userId = "u-test";
    const xp = api.addXp(guildId, userId, 150);
    assert.equal(xp, 150);
    assert.equal(api.getXp(guildId, userId), 150);
    const top = api.topUsers(guildId, 5);
    assert.equal(top[0].user_id, userId);
    assert.equal(top[0].xp, 150);
  });

  it("getGuildSettings returns defaults and accepts patch", () => {
    const guildId = "g-settings";
    const s = api.getGuildSettings(guildId);
    assert.equal(s.msg_xp, 5);
    const updated = api.updateGuildSettings(guildId, { msg_xp: 10 });
    assert.equal(updated.msg_xp, 10);
  });

  it("re-running migrations is safe (idempotent)", () => {
    const { runMigrations } = require("../src/db/migrate");
    assert.doesNotThrow(() => runMigrations());
  });
});
