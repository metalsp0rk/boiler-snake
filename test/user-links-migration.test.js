const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { communityKey } = require("./helpers/env");

/**
 * Migration 036_user_links (roadmap/account-linking.md T1): the user_links /
 * user_link_codes schema, reverse-lookup indexes, and idempotency.
 */
describe("user links (migration 036_user_links)", () => {
  let api;
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boiler-snake-userlinks-"));
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

  describe("migration registration + schema", () => {
    it("036_user_links is registered in migrate.js", () => {
      const { migrations } = require("../src/db/migrate");
      assert.ok(
        migrations.some((m) => m.id === "036_user_links"),
        "036_user_links must be registered in migrate.js"
      );
    });

    it("refuses to run without the communities table (034 ordering guard)", () => {
      const migration = require("../src/db/migrations/036_user_links");
      assert.throws(
        () => migration.up(api.db, { tableExists: () => false }),
        /036_user_links: the 'communities' table is missing/
      );
    });

    it("creates user_links with the bundle columns, defaults, and NOT NULLs", () => {
      const cols = api.db.prepare(`PRAGMA table_info(user_links)`).all();
      assert.deepEqual(
        cols.map((c) => c.name),
        [
          "id",
          "community_id_a",
          "user_id_a",
          "community_id_b",
          "user_id_b",
          "mirror_a_to_b_pct",
          "mirror_b_to_a_pct",
          "mirror_memory",
          "created_at",
        ]
      );
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      assert.equal(byName.id.pk, 1, "id is the primary key");
      for (const col of [
        "community_id_a",
        "user_id_a",
        "community_id_b",
        "user_id_b",
        "mirror_a_to_b_pct",
        "mirror_b_to_a_pct",
        "mirror_memory",
        "created_at",
      ]) {
        assert.equal(byName[col].notnull, 1, `${col} is NOT NULL`);
      }
      // Defaults from the locked DDL: full-rate mirrors, memory mirror on.
      assert.equal(byName.mirror_a_to_b_pct.dflt_value, "100");
      assert.equal(byName.mirror_b_to_a_pct.dflt_value, "100");
      assert.equal(byName.mirror_memory.dflt_value, "1");
    });

    it("enforces UNIQUE (community_id_a, user_id_a) and UNIQUE (community_id_b, user_id_b) at the schema level", () => {
      const cidA = communityKey("g-036-discord");
      const cidB = communityKey("g-036-fluxer", "fluxer", "fluxer.test");
      api.db
        .prepare(
          `INSERT INTO user_links (community_id_a, user_id_a, community_id_b, user_id_b, created_at)
           VALUES (?, 'u-1', ?, 'f-1', 1700000000000)`
        )
        .run(cidA, cidB);
      // Same side-a identity, any other peer → UNIQUE violation.
      assert.throws(
        () =>
          api.db
            .prepare(
              `INSERT INTO user_links (community_id_a, user_id_a, community_id_b, user_id_b, created_at)
               VALUES (?, 'u-1', ?, 'f-2', 1700000000001)`
            )
            .run(cidA, cidB),
        /UNIQUE/i
      );
      // Same side-b identity in the opposite orientation → UNIQUE violation.
      assert.throws(
        () =>
          api.db
            .prepare(
              `INSERT INTO user_links (community_id_a, user_id_a, community_id_b, user_id_b, created_at)
               VALUES (?, 'u-9', ?, 'f-1', 1700000000002)`
            )
            .run(communityKey("g-036-other"), cidB),
        /UNIQUE/i
      );
      // One user on each side is the one legal pair — it succeeds.
      assert.doesNotThrow(() =>
        api.db
          .prepare(
            `INSERT INTO user_links (community_id_a, user_id_a, community_id_b, user_id_b, created_at)
             VALUES (?, 'u-2', ?, 'f-2', 1700000000003)`
          )
          .run(cidA, cidB)
      );
    });

    it("creates user_link_codes: code_hash UNIQUE, used_at nullable", () => {
      const cols = api.db.prepare(`PRAGMA table_info(user_link_codes)`).all();
      assert.deepEqual(
        cols.map((c) => c.name),
        ["id", "code_hash", "community_id", "user_id", "created_at", "expires_at", "used_at"]
      );
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      assert.equal(byName.code_hash.notnull, 1);
      assert.equal(byName.used_at.notnull, 0, "used_at is NULL until redeemed");

      const cid = communityKey("g-036-discord");
      api.db
        .prepare(
          `INSERT INTO user_link_codes (code_hash, community_id, user_id, created_at, expires_at)
           VALUES ('aa', ?, 'u-1', 1, 2)`
        )
        .run(cid);
      assert.throws(
        () =>
          api.db
            .prepare(
              `INSERT INTO user_link_codes (code_hash, community_id, user_id, created_at, expires_at)
               VALUES ('aa', ?, 'u-2', 1, 2)`
            )
            .run(cid),
        /UNIQUE/i,
        "code_hash is UNIQUE — a minted digest can never exist twice"
      );
      const row = api.db
        .prepare(`SELECT used_at FROM user_link_codes WHERE code_hash = 'aa'`)
        .get();
      assert.equal(row.used_at, null, "fresh code is unconsumed");
    });

    it("creates the three indexes: a/b reverse lookups + code expiry sweep", () => {
      const indexCols = (name) =>
        api.db.prepare(`PRAGMA index_info(${name})`).all().map((c) => c.name);
      const names = api.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`)
        .all()
        .map((r) => r.name);
      for (const [name, expected] of [
        ["idx_user_links_a_lookup", ["user_id_a", "community_id_a"]],
        ["idx_user_links_b_lookup", ["user_id_b", "community_id_b"]],
        ["idx_user_link_codes_expires_at", ["expires_at"]],
      ]) {
        assert.ok(names.includes(name), `${name} must exist`);
        assert.deepEqual(indexCols(name), expected, `${name} column order`);
      }
    });
  });

  describe("idempotency + upgrade + reopen", () => {
    it("re-running all migrations (incl. 036) on an existing DB is safe", () => {
      const { runMigrations } = require("../src/db/migrate");
      const cidA = communityKey("g-036-keep-a");
      const cidB = communityKey("g-036-keep-b", "fluxer", "fluxer.test");
      const created = api.createUserLink({
        communityIdA: cidA,
        userIdA: "u-keep",
        communityIdB: cidB,
        userIdB: "f-keep",
      });
      assert.equal(created.ok, true);

      assert.doesNotThrow(() => runMigrations());
      assert.doesNotThrow(() => runMigrations());

      const row = api.getUserLinkFor(cidA, "u-keep");
      assert.ok(row, "existing links survive a re-run");
      assert.equal(row.user_id_b, "f-keep");
    });

    it("applies to a pre-existing DB that lacks the tables (upgrade path)", () => {
      // Simulate an older DB: drop both tables, then run the full migration set.
      api.db.exec(`DROP TABLE user_links`);
      api.db.exec(`DROP TABLE user_link_codes`);
      const { runMigrations } = require("../src/db/migrate");
      assert.doesNotThrow(() => runMigrations());
      for (const table of ["user_links", "user_link_codes"]) {
        const t = api.db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
          .get(table);
        assert.ok(t, `${table} must be recreated on upgrade`);
      }
      assert.equal(
        api.getUserLinkFor(communityKey("g-036-keep-a"), "u-keep"),
        null,
        "dropped data is not resurrected"
      );
    });

    it("reopen from disk shows both tables; the 036 up() is idempotent on the reopened handle", () => {
      // The full reopen: a fresh handle on the same file (like a bot restart).
      const Database = require("better-sqlite3");
      const reopened = new Database(dbPath);
      try {
        const names = reopened
          .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'index')`)
          .all()
          .map((r) => r.name);
        for (const n of [
          "user_links",
          "user_link_codes",
          "idx_user_links_a_lookup",
          "idx_user_links_b_lookup",
          "idx_user_link_codes_expires_at",
        ]) {
          assert.ok(names.includes(n), `${n} survives the reopen`);
        }
        // Re-run the migration itself against the reopened handle: IF NOT
        // EXISTS idempotency must hold at the raw-connection level too.
        const migration = require("../src/db/migrations/036_user_links");
        const tableExists = (name) =>
          !!reopened
            .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
            .get(name);
        assert.doesNotThrow(() => migration.up(reopened, { tableExists }));
        assert.doesNotThrow(() => migration.up(reopened, { tableExists }));
      } finally {
        reopened.close();
      }
    });
  });
});
