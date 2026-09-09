const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

describe("admin_audit (migration 024 + repo helpers)", () => {
  let api;
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boiler-snake-audit-"));
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
    it("024_admin_audit is registered in migrate.js", () => {
      const { migrations } = require("../src/db/migrate");
      assert.ok(
        migrations.some((m) => m.id === "024_admin_audit"),
        "024_admin_audit must be registered in migrate.js"
      );
    });

    it("creates admin_audit with the §8.5 columns", () => {
      const cols = api.db
        .prepare(`PRAGMA table_info(admin_audit)`)
        .all()
        .map((c) => c.name);
      assert.deepEqual(
        [...cols].sort(),
        [
          "action",
          "actor_user_id",
          "created_at",
          "details_json",
          "guild_id",
          "id",
          "origin",
          "target_id",
          "target_type",
        ].sort()
      );
    });

    it("creates idx_admin_audit_guild_created on (guild_id, created_at)", () => {
      const idx = api.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_admin_audit_guild_created'`
        )
        .get();
      assert.ok(idx, "idx_admin_audit_guild_created must exist");
      const cols = api.db
        .prepare(`PRAGMA index_info('idx_admin_audit_guild_created')`)
        .all()
        .map((c) => c.name);
      assert.deepEqual(cols, ["guild_id", "created_at"]);
    });

    it("re-running all migrations (incl. 024) on an existing DB stays safe", () => {
      const { runMigrations } = require("../src/db/migrate");
      assert.doesNotThrow(() => runMigrations());
    });
  });

  describe("insert + round-trip", () => {
    it("insertAdminAudit round-trips all fields incl. details_json", () => {
      const row = api.insertAdminAudit({
        guildId: "g-audit-rt",
        actorUserId: "u-actor",
        origin: "Web", // normalized to lowercase
        action: "settings.command_channel.add",
        targetType: "channel",
        targetId: "c-1",
        details: { channel_id: "c-1", position: 3 },
        createdAt: 1700000000000,
      });
      assert.ok(Number.isInteger(row.id));
      assert.equal(row.guild_id, "g-audit-rt");
      assert.equal(row.actor_user_id, "u-actor");
      assert.equal(row.origin, "web");
      assert.equal(row.action, "settings.command_channel.add");
      assert.equal(row.target_type, "channel");
      assert.equal(row.target_id, "c-1");
      assert.equal(row.created_at, 1700000000000);
      assert.deepEqual(JSON.parse(row.details_json), {
        channel_id: "c-1",
        position: 3,
      });
      assert.deepEqual(api.getAdminAuditById(row.id), row);
    });

    it("details default to NULL; already-JSON strings are stored as-is", () => {
      const bare = api.insertAdminAudit({
        guildId: "g-audit-d",
        origin: "system",
        action: "sessions.prune",
      });
      assert.equal(bare.details_json, null);
      assert.equal(bare.actor_user_id, null, "system rows may omit the actor");

      const asText = api.insertAdminAudit({
        guildId: "g-audit-d",
        origin: "system",
        action: "x",
        details: '{"ok":true}',
      });
      assert.equal(asText.details_json, '{"ok":true}');
    });

    it("inserted rows get created_at from the clock when not supplied", () => {
      const before = Date.now();
      const row = api.insertAdminAudit({
        guildId: "g-audit-now",
        origin: "slash",
        actorUserId: "u1",
        action: "warn.issue",
      });
      assert.ok(row.created_at >= before && row.created_at <= Date.now());
    });
  });

  describe("origin + input validation", () => {
    it("normalizeAuditOrigin accepts only web|slash|system", () => {
      assert.deepEqual(api.normalizeAuditOrigin(" web "), { ok: true, origin: "web" });
      assert.deepEqual(api.normalizeAuditOrigin("SLASH"), { ok: true, origin: "slash" });
      assert.deepEqual(api.normalizeAuditOrigin("system"), { ok: true, origin: "system" });
      assert.equal(api.normalizeAuditOrigin("cli").ok, false);
      assert.equal(api.normalizeAuditOrigin(null).ok, false);
      assert.equal(api.normalizeAuditOrigin("").ok, false);
    });

    it("insert rejects invalid origin with INVALID_ORIGIN", () => {
      assert.throws(
        () =>
          api.insertAdminAudit({
            guildId: "g-audit-bad-origin",
            origin: "cli",
            action: "a.b",
          }),
        (err) => err.code === "INVALID_ORIGIN"
      );
      assert.equal(api.countAdminAudit("g-audit-bad-origin"), 0);
    });

    it("insert rejects missing guild / action", () => {
      assert.throws(
        () => api.insertAdminAudit({ origin: "web", action: "a.b" }),
        (err) => err.code === "INVALID_GUILD"
      );
      assert.throws(
        () => api.insertAdminAudit({ guildId: "g-audit-x", origin: "web" }),
        (err) => err.code === "INVALID_ACTION"
      );
    });

    it("details guard: circular, non-JSON string, and oversize are rejected", () => {
      const circular = { a: 1 };
      circular.self = circular;
      assert.throws(
        () =>
          api.insertAdminAudit({
            guildId: "g-audit-det",
            origin: "web",
            actorUserId: "u1",
            action: "a.b",
            details: circular,
          }),
        (err) => err.code === "INVALID_DETAILS"
      );
      assert.throws(
        () =>
          api.insertAdminAudit({
            guildId: "g-audit-det",
            origin: "web",
            actorUserId: "u1",
            action: "a.b",
            details: "not json at all",
          }),
        (err) => err.code === "INVALID_DETAILS"
      );
      assert.throws(
        () =>
          api.insertAdminAudit({
            guildId: "g-audit-det",
            origin: "web",
            actorUserId: "u1",
            action: "a.b",
            details: { blob: "x".repeat(api.MAX_AUDIT_DETAILS_JSON) },
          }),
        (err) => err.code === "INVALID_DETAILS"
      );
      assert.equal(api.countAdminAudit("g-audit-det"), 0);
    });

    it("schema CHECK constraint also rejects bad origins at the DB level", () => {
      assert.throws(() =>
        api.db
          .prepare(
            `INSERT INTO admin_audit (guild_id, origin, action, created_at)
             VALUES ('g-check', 'evil', 'a.b', 1)`
          )
          .run()
      );
    });
  });

  describe("list: guild scoping, cap, paging", () => {
    const GUILD_A = "g-audit-list-a";
    const GUILD_B = "g-audit-list-b";

    before(() => {
      // 105 rows in A, 3 rows in B (explicit distinct created_at).
      for (let i = 1; i <= 105; i++) {
        api.insertAdminAudit({
          guildId: GUILD_A,
          actorUserId: "u-a",
          origin: i % 2 === 0 ? "web" : "slash",
          action: `act.${i}`,
          details: { i },
          createdAt: 1_000_000 + i,
        });
      }
      for (let i = 1; i <= 3; i++) {
        api.insertAdminAudit({
          guildId: GUILD_B,
          origin: "system",
          action: `sys.${i}`,
          createdAt: 2_000_000 + i,
        });
      }
    });

    it("list is guild-scoped — no cross-guild leakage", () => {
      const a = api.listAdminAudit(GUILD_A, { limit: 100 });
      assert.ok(a.length > 0);
      assert.ok(a.every((r) => r.guild_id === GUILD_A));

      const b = api.listAdminAudit(GUILD_B);
      assert.equal(b.length, 3);
      assert.ok(b.every((r) => r.guild_id === GUILD_B));

      assert.equal(api.countAdminAudit(GUILD_A), 105);
      assert.equal(api.countAdminAudit(GUILD_B), 3);
    });

    it("list with missing/blank guild returns empty (never unscoped)", () => {
      assert.deepEqual(api.listAdminAudit(null), []);
      assert.deepEqual(api.listAdminAudit("  "), []);
      assert.equal(api.countAdminAudit(""), 0);
    });

    it("hard-caps LIMIT at 100 even when asked for more (§8.6)", () => {
      assert.equal(api.MAX_AUDIT_LIST_LIMIT, 100);
      const over = api.listAdminAudit(GUILD_A, { limit: 5000 });
      assert.equal(over.length, 100);
      const defaultPage = api.listAdminAudit(GUILD_A);
      assert.equal(defaultPage.length, 25);
    });

    it("offset paging is newest-first and non-overlapping", () => {
      const page1 = api.listAdminAudit(GUILD_A, { limit: 100, offset: 0 });
      const page2 = api.listAdminAudit(GUILD_A, { limit: 100, offset: 100 });
      assert.equal(page1.length, 100);
      assert.equal(page2.length, 5);
      const ids = new Set([...page1, ...page2].map((r) => r.id));
      assert.equal(ids.size, 105, "pages must not overlap or duplicate");
      const created = page1.map((r) => r.created_at);
      assert.deepEqual(
        created,
        [...created].sort((x, y) => y - x),
        "newest first"
      );
      assert.equal(page1[0].action, "act.105");
      assert.equal(page2[4].action, "act.1");
    });

    it("origin filter narrows the page and count", () => {
      const webOnly = api.listAdminAudit(GUILD_A, { limit: 100, origin: "web" });
      assert.ok(webOnly.length > 0 && webOnly.length <= 53);
      assert.ok(webOnly.every((r) => r.origin === "web"));
      assert.equal(
        webOnly.length,
        api.countAdminAudit(GUILD_A, { origin: "web" })
      );
      assert.throws(
        () => api.listAdminAudit(GUILD_A, { origin: "nope" }),
        (err) => err.code === "INVALID_ORIGIN"
      );
    });

    it("before-cursor paging keeps pages bounded and ordered", () => {
      const first = api.listAdminAudit(GUILD_A, { limit: 10 });
      assert.equal(first.length, 10);
      const next = api.listAdminAudit(GUILD_A, {
        limit: 10,
        before: first[first.length - 1].created_at,
      });
      assert.equal(next.length, 10);
      assert.ok(
        next.every((r) => r.created_at < first[first.length - 1].created_at)
      );
    });

    it("negative/absurd offset or limit clamp safely", () => {
      const rows = api.listAdminAudit(GUILD_A, { limit: -5, offset: -10 });
      assert.equal(rows.length, 1, "limit clamps up to 1, offset clamps to 0");
    });
  });
});
