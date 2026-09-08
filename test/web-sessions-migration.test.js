const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Migration 023_web_sessions + webSessions repository helpers
 * (roadmap/web-admin.md §8.3 / §8.5).
 */
describe("web sessions (migration 023 + repo helpers)", () => {
  let api;
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boiler-snake-websess-"));
    dbPath = path.join(tmpDir, "test.sqlite");
    process.env.DB_PATH = dbPath;
    // Fresh require after setting DB_PATH — clear cache for db modules
    for (const key of Object.keys(require.cache)) {
      if (
        key.includes(`${path.sep}src${path.sep}db`) ||
        key.endsWith(`${path.sep}db.js`)
      ) {
        delete require.cache[key];
      }
    }
    api = require("../src/db");
  });

  describe("migration", () => {
    it("023_web_sessions is registered in migrate.js", () => {
      const { migrations } = require("../src/db/migrate");
      assert.ok(
        migrations.some((m) => m.id === "023_web_sessions"),
        "023_web_sessions must be registered in migrate.js"
      );
    });

    it("creates web_sessions with the exact §8.5 column list", () => {
      const cols = api.db.prepare(`PRAGMA table_info(web_sessions)`).all();
      assert.deepEqual(
        cols.map((c) => c.name),
        ["id", "user_id", "discord_tag", "created_at", "last_seen_at", "expires_at"]
      );
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      assert.equal(byName.id.pk, 1, "id is the primary key");
      assert.equal(byName.user_id.notnull, 1);
      assert.equal(byName.created_at.notnull, 1);
      assert.equal(byName.last_seen_at.notnull, 1);
      assert.equal(byName.expires_at.notnull, 1);
      assert.equal(byName.discord_tag.notnull, 0, "discord_tag is nullable display data");
    });

    it("creates both indexes: user lookup + prune on expires_at", () => {
      const indexes = api.db
        .prepare(`PRAGMA index_list(web_sessions)`)
        .all()
        .map((idx) => ({
          name: idx.name,
          columns: api.db
            .prepare(`PRAGMA index_info(${idx.name})`)
            .all()
            .map((c) => c.name),
        }));
      const user = indexes.find((i) => i.name === "idx_web_sessions_user");
      const expires = indexes.find((i) => i.name === "idx_web_sessions_expires_at");
      assert.ok(user, "idx_web_sessions_user must exist");
      assert.deepEqual(user.columns, ["user_id"]);
      assert.ok(expires, "idx_web_sessions_expires_at (prune index) must exist");
      assert.deepEqual(expires.columns, ["expires_at"]);
    });

    it("re-running migrations on an existing DB is safe (idempotent)", () => {
      const { runMigrations } = require("../src/db/migrate");
      api.createWebSession({
        id: "keep-me",
        userId: "u-keep",
        discordTag: "keeper#0001",
        expiresAt: Date.now() + 60_000,
      });
      assert.doesNotThrow(() => runMigrations());
      assert.doesNotThrow(() => runMigrations());
      const row = api.getWebSession("keep-me");
      assert.ok(row, "existing rows survive a re-run");
      assert.equal(row.user_id, "u-keep");
    });

    it("applies to a pre-existing DB that lacks the table (upgrade path)", () => {
      // Simulate an older DB: drop table, then run the full migration set.
      api.db.exec(`DROP TABLE web_sessions`);
      const { runMigrations } = require("../src/db/migrate");
      assert.doesNotThrow(() => runMigrations());
      const table = api.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='web_sessions'`)
        .get();
      assert.ok(table, "web_sessions must be recreated on upgrade");
      assert.equal(api.getWebSession("keep-me"), null, "dropped data is not resurrected");
    });
  });

  describe("repository helpers", () => {
    it("facade exposes the five session helpers", () => {
      for (const name of [
        "createWebSession",
        "getWebSession",
        "touchWebSession",
        "destroyWebSession",
        "pruneWebSessions",
      ]) {
        assert.equal(typeof api[name], "function", `facade must expose ${name}`);
      }
    });

    it("create + get round-trip; timestamps set, tag defaults to null", () => {
      const beforeMs = Date.now();
      const row = api.createWebSession({
        id: "sess-1",
        userId: "u-1",
        discordTag: "alice#0101",
        expiresAt: beforeMs + 3_600_000,
      });
      assert.equal(row.id, "sess-1");
      assert.equal(row.user_id, "u-1");
      assert.equal(row.discord_tag, "alice#0101");
      assert.ok(Number.isInteger(row.created_at) && row.created_at >= beforeMs);
      assert.equal(row.last_seen_at, row.created_at);
      assert.equal(row.expires_at, beforeMs + 3_600_000);

      const fetched = api.getWebSession("sess-1");
      assert.deepEqual(fetched, row);
      assert.equal(api.getWebSession("missing"), null);
      assert.equal(api.getWebSession(null), null, "missing id degrades to null");
    });

    it("create defaults discord_tag to null and rejects duplicate ids", () => {
      const row = api.createWebSession({
        id: "sess-notag",
        userId: "u-notag",
        expiresAt: Date.now() + 60_000,
      });
      assert.equal(row.discord_tag, null);
      assert.throws(
        () =>
          api.createWebSession({
            id: "sess-notag",
            userId: "u-other",
            expiresAt: Date.now() + 60_000,
          }),
        /UNIQUE|PRIMARY/i,
        "session ids are unique — never reused"
      );
    });

    it("create validates required fields at the boundary", () => {
      assert.throws(() => api.createWebSession({ userId: "u", expiresAt: 1 }), TypeError);
      assert.throws(() => api.createWebSession({ id: "x", expiresAt: 1 }), TypeError);
      assert.throws(
        () => api.createWebSession({ id: "x", userId: "u", expiresAt: "soon" }),
        TypeError
      );
    });

    it("touch extends expiry and stamps last_seen_at for a live session", () => {
      api.createWebSession({
        id: "sess-touch",
        userId: "u-touch",
        discordTag: "toucher#1",
        expiresAt: Date.now() + 60_000,
      });
      const created = api.getWebSession("sess-touch").created_at;
      const at = Date.now() + 1_000;
      const newExpiry = Date.now() + 7_200_000;
      assert.equal(api.touchWebSession("sess-touch", newExpiry, at), true);
      const row = api.getWebSession("sess-touch");
      assert.equal(row.last_seen_at, at);
      assert.equal(row.expires_at, newExpiry);
      assert.equal(row.created_at, created, "created_at must not move");
    });

    it("touch cannot revive an expired session nor fabricate one", () => {
      api.createWebSession({
        id: "sess-expired",
        userId: "u-expired",
        expiresAt: Date.now() - 1,
      });
      const expiryBefore = api.getWebSession("sess-expired").expires_at;
      assert.equal(
        api.touchWebSession("sess-expired", Date.now() + 60_000),
        false,
        "expired session must not slide back to life"
      );
      assert.equal(api.getWebSession("sess-expired").expires_at, expiryBefore);
      assert.equal(api.touchWebSession("sess-nope", Date.now() + 60_000), false);
      assert.equal(api.touchWebSession(null, Date.now() + 60_000), false);
    });

    it("destroy removes the row and reports whether one existed", () => {
      api.createWebSession({
        id: "sess-destroy",
        userId: "u-destroy",
        expiresAt: Date.now() + 60_000,
      });
      assert.equal(api.destroyWebSession("sess-destroy"), true);
      assert.equal(api.getWebSession("sess-destroy"), null);
      assert.equal(api.destroyWebSession("sess-destroy"), false, "second destroy is a no-op");
      assert.equal(api.destroyWebSession(null), false);
    });

    it("prune removes only sessions at/before the cutoff and returns the count", () => {
      // Hermetic: start from an empty store so the count is exact.
      api.db.prepare(`DELETE FROM web_sessions`).run();
      const t = Date.now();
      api.createWebSession({ id: "sess-p1", userId: "u-p", expiresAt: t - 5_000 });
      api.createWebSession({ id: "sess-p2", userId: "u-p", expiresAt: t }); // boundary: <=
      api.createWebSession({ id: "sess-p3", userId: "u-p", expiresAt: t + 60_000 });

      assert.equal(api.pruneWebSessions(t), 2);
      assert.equal(api.getWebSession("sess-p1"), null);
      assert.equal(api.getWebSession("sess-p2"), null);
      assert.ok(api.getWebSession("sess-p3"), "live session survives prune");

      assert.equal(api.pruneWebSessions(t), 0, "prune on a clean store is a no-op");
      api.destroyWebSession("sess-p3");
    });

    it("helpers use only bound parameters (no string-concatenated SQL)", () => {
      // A hostile session id must be impossible to trigger as SQL injection:
      const hostile = "x' OR '1'='1";
      api.createWebSession({ id: hostile, userId: "u-hostile", expiresAt: Date.now() + 60_000 });
      assert.ok(api.getWebSession(hostile), "hostile id round-trips as data");
      assert.equal(api.getWebSession("' OR '1'='1"), null);
      assert.equal(api.destroyWebSession(hostile), true);
    });
  });
});
