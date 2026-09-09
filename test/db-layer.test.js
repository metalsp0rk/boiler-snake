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

  describe("gork settings (migration 021 + clamps)", () => {
    before(() => {
      // 021 is not yet in the migrate.js registry; apply it directly so the
      // gork columns exist for this suite. addColumnIfMissing is idempotent,
      // so this stays a no-op once 021 is registered.
      const { addColumnIfMissing } = require("../src/db/connection");
      require("../src/db/migrations/021_gork").up(api.db, { addColumnIfMissing });
    });

    it("migration 021 adds the 5 gork columns to guild_settings", () => {
      const cols = new Set(
        api.db.prepare(`PRAGMA table_info(guild_settings)`).all().map((c) => c.name)
      );
      for (const name of [
        "gork_keyword",
        "gork_context_window",
        "gork_extra_rules",
        "gork_search_enabled",
        "gork_cooldown_sec",
      ]) {
        assert.ok(cols.has(name), `missing column: ${name}`);
      }
    });

    it("fresh guild row gets the gork column defaults", () => {
      const s = api.getGuildSettings("g-gork-fresh");
      assert.equal(s.gork_keyword, "@gork");
      assert.equal(s.gork_context_window, 10);
      assert.equal(s.gork_extra_rules, "");
      assert.equal(s.gork_search_enabled, 1);
      assert.equal(s.gork_cooldown_sec, 180);
    });

    it("gork_context_window clamps to 1-50 (invalid -> 10)", () => {
      const g = "g-gork-window";
      const expectWindow = (value, expected) => {
        const s = api.updateGuildSettings(g, { gork_context_window: value });
        assert.equal(s.gork_context_window, expected, `window ${value} -> ${expected}`);
      };
      expectWindow(0, 1);
      expectWindow(1, 1);
      expectWindow(25, 25);
      expectWindow(50, 50);
      expectWindow(51, 50);
      expectWindow(2.9, 2);
      expectWindow("abc", 10);
      expectWindow(null, 10);
    });

    it("gork_cooldown_sec clamps to 0-3600 (invalid -> 180)", () => {
      const g = "g-gork-cooldown";
      const expectCooldown = (value, expected) => {
        const s = api.updateGuildSettings(g, { gork_cooldown_sec: value });
        assert.equal(s.gork_cooldown_sec, expected, `cooldown ${value} -> ${expected}`);
      };
      expectCooldown(-5, 0);
      expectCooldown(0, 0);
      expectCooldown(180, 180);
      expectCooldown(3600, 3600);
      expectCooldown(3601, 3600);
      expectCooldown(90.5, 90);
      expectCooldown("soon", 180);
      expectCooldown(null, 180);
    });

    it("gork_extra_rules is truncated at 500 chars", () => {
      const g = "g-gork-rules";
      const exact = api.updateGuildSettings(g, { gork_extra_rules: "r".repeat(500) });
      assert.equal(exact.gork_extra_rules, "r".repeat(500));
      const long = api.updateGuildSettings(g, {
        gork_extra_rules: "a".repeat(300) + "b".repeat(300),
      });
      assert.equal(long.gork_extra_rules, "a".repeat(300) + "b".repeat(200));
      const short = api.updateGuildSettings(g, { gork_extra_rules: "be nice" });
      assert.equal(short.gork_extra_rules, "be nice");
    });

    it("gork_keyword: empty/whitespace clears to NULL (disabled)", () => {
      const g = "g-gork-keyword-clear";
      const set = api.updateGuildSettings(g, { gork_keyword: "@gork" });
      assert.equal(set.gork_keyword, "@gork");
      const emptied = api.updateGuildSettings(g, { gork_keyword: "" });
      assert.equal(emptied.gork_keyword, null);
      const blanked = api.updateGuildSettings(g, { gork_keyword: "   " });
      assert.equal(blanked.gork_keyword, null);
      const nulled = api.updateGuildSettings(g, { gork_keyword: null });
      assert.equal(nulled.gork_keyword, null);
    });

    it("gork_keyword stores trimmed 1-50 char keywords; over-length keeps prior value", () => {
      const g = "g-gork-keyword";
      const kw50 = "k".repeat(50);
      const s50 = api.updateGuildSettings(g, { gork_keyword: kw50 });
      assert.equal(s50.gork_keyword, kw50);
      const trimmed = api.updateGuildSettings(g, { gork_keyword: " @gork2 " });
      assert.equal(trimmed.gork_keyword, "@gork2");
      const rejected = api.updateGuildSettings(g, { gork_keyword: "k".repeat(51) });
      assert.equal(rejected.gork_keyword, "@gork2");
      const single = api.updateGuildSettings(g, { gork_keyword: "?" });
      assert.equal(single.gork_keyword, "?");
    });

    it("gork_search_enabled coerces to 0/1", () => {
      const g = "g-gork-search";
      const expectSearch = (value, expected) => {
        const s = api.updateGuildSettings(g, { gork_search_enabled: value });
        assert.equal(s.gork_search_enabled, expected, `search ${value} -> ${expected}`);
      };
      expectSearch(1, 1);
      expectSearch(0, 0);
      expectSearch("on", 1);
      expectSearch("off", 0);
      expectSearch("1", 1);
      expectSearch("0", 0);
      expectSearch(true, 1);
      expectSearch(false, 0);
    });

    it("all five gork keys round-trip in one patch", () => {
      const g = "g-gork-roundtrip";
      const s = api.updateGuildSettings(g, {
        gork_keyword: "@gork",
        gork_context_window: 20,
        gork_extra_rules: "keep it short",
        gork_search_enabled: 0,
        gork_cooldown_sec: 60,
      });
      assert.equal(s.gork_keyword, "@gork");
      assert.equal(s.gork_context_window, 20);
      assert.equal(s.gork_extra_rules, "keep it short");
      assert.equal(s.gork_search_enabled, 0);
      assert.equal(s.gork_cooldown_sec, 60);
    });
  });

  describe("gork access control (migration 022 + blocks repo)", () => {
    it("migration 022 is registered and adds gork_enabled + gork_user_blocks", () => {
      const { migrations } = require("../src/db/migrate");
      assert.ok(
        migrations.some((m) => m.id === "022_gork_access"),
        "022_gork_access must be registered in migrate.js"
      );
      const cols = api.db
        .prepare(`PRAGMA table_info(guild_settings)`)
        .all()
        .map((c) => c.name);
      assert.ok(cols.includes("gork_enabled"));
      const table = api.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='gork_user_blocks'`
        )
        .get();
      assert.ok(table, "gork_user_blocks table must exist");
    });

    it("re-running all migrations (incl. 022) stays safe", () => {
      const { runMigrations } = require("../src/db/migrate");
      assert.doesNotThrow(() => runMigrations());
    });

    it("fresh guild row defaults gork_enabled to 1", () => {
      const s = api.getGuildSettings("g-gork-enabled-fresh");
      assert.equal(s.gork_enabled, 1);
    });

    it("gork_enabled coerces to 0/1 and round-trips", () => {
      const g = "g-gork-enabled";
      const expectEnabled = (value, expected) => {
        const s = api.updateGuildSettings(g, { gork_enabled: value });
        assert.equal(s.gork_enabled, expected, `gork_enabled ${value} -> ${expected}`);
      };
      expectEnabled(1, 1);
      expectEnabled(0, 0);
      expectEnabled("on", 1);
      expectEnabled("off", 0);
      expectEnabled(true, 1);
      expectEnabled(false, 0);
      const s = api.getGuildSettings(g);
      assert.equal(s.gork_enabled, 0, "value must persist across reads");
    });

    it("adding a block preserves keyword and other settings", () => {
      const g = "g-gork-enable-preserves";
      api.updateGuildSettings(g, { gork_keyword: "@ask", gork_cooldown_sec: 45 });
      api.updateGuildSettings(g, { gork_enabled: 0 });
      const s = api.getGuildSettings(g);
      assert.equal(s.gork_enabled, 0);
      assert.equal(s.gork_keyword, "@ask", "disable must preserve the keyword");
      assert.equal(s.gork_cooldown_sec, 45, "disable must preserve the cooldown");
    });

    it("addGorkBlock / isGorkBlocked / listGorkBlocks / removeGorkBlock round-trip", () => {
      const g = "g-gork-blocks";
      const other = "g-gork-blocks-other";
      assert.equal(api.isGorkBlocked(g, "u1"), false);

      api.addGorkBlock(g, "u1", "staff-1");
      api.addGorkBlock(g, "u2", null);
      assert.equal(api.isGorkBlocked(g, "u1"), true);
      assert.equal(api.isGorkBlocked(other, "u1"), false, "blocks are per-guild");

      api.addGorkBlock(g, "u1", "staff-X"); // idempotent re-add keeps first row
      const rows = api.listGorkBlocks(g);
      assert.equal(rows.length, 2);
      const u1 = rows.find((r) => r.user_id === "u1");
      assert.equal(u1.created_by, "staff-1", "re-add must not clobber the audit fields");
      assert.ok(Number.isInteger(u1.created_at));

      assert.equal(api.removeGorkBlock(g, "u1"), true);
      assert.equal(api.removeGorkBlock(g, "u1"), false, "second remove is a no-op");
      assert.equal(api.isGorkBlocked(g, "u1"), false);
      assert.equal(api.listGorkBlocks(other).length, 0);
    });

    it("isGorkBlocked degrades to false for missing identity", () => {
      assert.equal(api.isGorkBlocked(null, "u1"), false);
      assert.equal(api.isGorkBlocked("g-gork-blocks", ""), false);
    });
  });

  describe("gork memory settings (migration 023 + clamps)", () => {
    before(() => {
      // Mirror the 021 pattern above: apply 023.up directly so the memory
      // columns exist for this suite. 023 is registered in migrate.js too,
      // and every statement is idempotent, so this is a no-op there.
      const { addColumnIfMissing } = require("../src/db/connection");
      require("../src/db/migrations/023_gork_memory").up(api.db, { addColumnIfMissing });
    });

    it("023_gork_memory is registered and adds the table, index and columns", () => {
      const { migrations } = require("../src/db/migrate");
      assert.ok(
        migrations.some((m) => m.id === "023_gork_memory"),
        "023_gork_memory must be registered in migrate.js"
      );
      const cols = new Set(
        api.db.prepare(`PRAGMA table_info(guild_settings)`).all().map((c) => c.name)
      );
      assert.ok(cols.has("gork_memory_enabled"), "missing column: gork_memory_enabled");
      assert.ok(cols.has("gork_memory_chars"), "missing column: gork_memory_chars");
      const table = api.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='gork_memories'`
        )
        .get();
      assert.ok(table, "gork_memories table must exist");
      const index = api.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_gork_memories_subject'`
        )
        .get();
      assert.ok(index, "idx_gork_memories_subject must exist");
    });

    it("fresh guild row defaults the memory keys to 0 / 12000", () => {
      const s = api.getGuildSettings("g-gork-mem-fresh");
      assert.equal(s.gork_memory_enabled, 0, "memory is default-OFF");
      assert.equal(s.gork_memory_chars, 12000);
    });

    it("gork_memory_enabled coerces to 0/1 and persists", () => {
      const g = "g-gork-mem-enabled";
      const expectEnabled = (value, expected) => {
        const s = api.updateGuildSettings(g, { gork_memory_enabled: value });
        assert.equal(
          s.gork_memory_enabled,
          expected,
          `gork_memory_enabled ${value} -> ${expected}`
        );
      };
      expectEnabled(1, 1);
      expectEnabled(0, 0);
      expectEnabled("on", 1);
      expectEnabled("off", 0);
      expectEnabled(true, 1);
      expectEnabled(false, 0);
      const s = api.getGuildSettings(g);
      assert.equal(s.gork_memory_enabled, 0, "value must persist across reads");
    });

    it("gork_memory_chars clamps 0-64000 with 0 VALID (garbage -> 12000)", () => {
      const g = "g-gork-mem-chars";
      const expectChars = (value, expected) => {
        const s = api.updateGuildSettings(g, { gork_memory_chars: value });
        assert.equal(s.gork_memory_chars, expected, `gork_memory_chars ${value} -> ${expected}`);
      };
      expectChars(5000, 5000);
      expectChars(0, 0); // 0 is VALID here: unlimited budget — never default-ify it
      expectChars(100000, 64000);
      expectChars(-5, 12000);
      expectChars("abc", 12000);
      expectChars(null, 12000);
    });

    it("memory keys round-trip alongside the other gork settings", () => {
      const g = "g-gork-mem-roundtrip";
      const s = api.updateGuildSettings(g, {
        gork_memory_enabled: 1,
        gork_memory_chars: 4000,
        gork_enabled: 1,
        gork_keyword: "@gork",
      });
      assert.equal(s.gork_memory_enabled, 1);
      assert.equal(s.gork_memory_chars, 4000);
      assert.equal(s.gork_enabled, 1);
      assert.equal(s.gork_keyword, "@gork");
    });
  });
});
