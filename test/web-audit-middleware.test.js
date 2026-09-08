/**
 * src/web/middleware/audit.js — subtask web-admin-09.
 *
 * DB-first admin_audit writer (fail closed) + best-effort channel-embed
 * mirror (roadmap/web-admin.md §8.1 decision 7, §8.5, §8.6, §8.7).
 * Real SQLite (ephemeral tmp DB), stubbed embed poster; node --test only.
 */

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

/** Let queued microtasks + one macrotask turn run (mirror dispatch timing). */
const flush = () => new Promise((resolve) => setImmediate(resolve));
const flushTwice = async () => {
  await flush();
  await flush();
};

const USER = { userId: "111", discordTag: "mod#0001" };

function makeReq(overrides = {}) {
  return { user: USER, params: {}, ...overrides };
}

function stubLogger() {
  const warns = [];
  return { warns, warn: (...args) => warns.push(args.join(" ")) };
}

function stubAuditLog(behavior = {}) {
  const calls = [];
  let built = 0;
  return {
    calls,
    get builtCount() {
      return built;
    },
    buildConfigChangeEmbed: (opts) => {
      built += 1;
      if (behavior.throwOnBuild) throw new Error("embed build boom");
      return { received: opts };
    },
    sendAuditLog: async (client, guildId, payload) => {
      calls.push({ kind: "audit", client, guildId, payload });
      if (behavior.rejectSend) throw new Error("send boom");
      return true;
    },
    sendWarnLog: async (client, guildId, payload) => {
      calls.push({ kind: "warn", client, guildId, payload });
      return true;
    },
  };
}

describe("web audit middleware (req.audit — DB-first + best-effort mirror)", () => {
  let dbApi;
  let audit;

  before(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boiler-snake-webaudit-"));
    process.env.DB_PATH = path.join(tmpDir, "test.sqlite");
    // Fresh db binding under DB_PATH, then require the middleware against it.
    for (const key of Object.keys(require.cache)) {
      if (
        key.includes(`${path.sep}src${path.sep}db`) ||
        key.endsWith(`${path.sep}db.js`)
      ) {
        delete require.cache[key];
      }
    }
    dbApi = require("../src/db");
    audit = require("../src/web/middleware/audit");
  });

  /** Build middleware + a req with req.audit attached (deps stubbed). */
  function setup({ req = {}, mw = {}, mirrorBehavior = {} } = {}) {
    const logger = stubLogger();
    const auditLogStub = stubAuditLog(mirrorBehavior);
    const client = { __fakeClient: true };
    const middleware = audit.createAuditMiddleware({
      auditLog: auditLogStub,
      logger,
      getClient: () => client,
      ...mw,
    });
    const attached = makeReq(req);
    const res = {};
    let nextCalls = 0;
    middleware(attached, res, () => {
      nextCalls += 1;
    });
    return { req: attached, res, logger, auditLogStub, client, nextCalls };
  }

  describe("middleware wiring", () => {
    it("attaches req.audit and calls next() without touching res", () => {
      const { req, nextCalls } = setup();
      assert.equal(typeof req.audit, "function");
      assert.equal(nextCalls, 1);
    });
  });

  describe("DB-first write (one row, correct fields, §8.5/§8.6)", () => {
    it("writes exactly one row with actor/guild/origin web and returns it", () => {
      const guild = "g-web-audit-happy";
      const { req } = setup({ req: { params: { guildId: guild } } });

      const row = req.audit({
        action: "warnings.void",
        targetType: "warning",
        targetId: "42",
        details: { reason: "false positive", warning_id: 42 },
      });

      assert.ok(Number.isInteger(row.id));
      assert.equal(row.guild_id, guild);
      assert.equal(row.actor_user_id, USER.userId);
      assert.equal(row.origin, "web", "web layer defaults to origin 'web'");
      assert.equal(row.action, "warnings.void");
      assert.equal(row.target_type, "warning");
      assert.equal(row.target_id, "42");
      assert.deepEqual(JSON.parse(row.details_json), {
        reason: "false positive",
        warning_id: 42,
      });
      assert.equal(dbApi.countAdminAudit(guild), 1, "exactly one row per call");
    });

    it("resolves guild id in order: entry > req.guildId > req.params.guildId", () => {
      const { req } = setup({ req: { guildId: "g-mw", params: { guildId: "g-params" } } });
      const viaReq = req.audit({ action: "a.viaReq" });
      assert.equal(viaReq.guild_id, "g-mw");

      const viaEntry = req.audit({ action: "a.viaEntry", guildId: "g-entry" });
      assert.equal(viaEntry.guild_id, "g-entry");

      const paramsOnly = setup({ req: { params: { guildId: "g-params2" } } });
      assert.equal(paramsOnly.req.audit({ action: "a.viaParams" }).guild_id, "g-params2");
    });

    it("unresolvable guild → AUDIT_NO_GUILD and no row", () => {
      const { req } = setup({ req: { params: {} } });
      assert.throws(
        () => req.audit({ action: "a.orphan" }),
        (err) => err.code === "AUDIT_NO_GUILD"
      );
      assert.equal(dbApi.listAdminAudit("").length, 0);
    });

    it("anonymous req.user → AUDIT_ANONYMOUS (null and missing)", () => {
      const nullish = setup({ req: { user: null, params: { guildId: "g-web-audit-anon" } } });
      assert.throws(
        () => nullish.req.audit({ action: "a.anon" }),
        (err) => err.code === "AUDIT_ANONYMOUS"
      );

      const missing = setup({ req: { user: undefined, params: { guildId: "g-web-audit-anon" } } });
      assert.throws(
        () => missing.req.audit({ action: "a.anon" }),
        (err) => err.code === "AUDIT_ANONYMOUS"
      );
      assert.equal(dbApi.countAdminAudit("g-web-audit-anon"), 0);
    });

    it("rejects non-object entries and missing action before any DB write", () => {
      const { req } = setup({ req: { params: { guildId: "g-web-audit-entry" } } });
      assert.throws(
        () => req.audit(null),
        (err) => err.code === "AUDIT_INVALID_ENTRY"
      );
      assert.throws(
        () => req.audit("settings.x"),
        (err) => err.code === "AUDIT_INVALID_ENTRY"
      );
      assert.throws(
        () => req.audit({ action: "   " }),
        (err) => err.code === "AUDIT_INVALID_ACTION"
      );
      assert.equal(dbApi.countAdminAudit("g-web-audit-entry"), 0);
    });

    it("origin: defaults to web, accepts validated overrides, rejects garbage", () => {
      const guild = "g-web-audit-origin";
      const { req } = setup({ req: { params: { guildId: guild } } });

      assert.equal(req.audit({ action: "a.default" }).origin, "web");
      assert.equal(
        req.audit({ action: "a.override", origin: "slash" }).origin,
        "slash",
        "slash reuse path keeps origin labels truthful (§8.6)"
      );

      assert.throws(
        () => req.audit({ action: "a.bad", origin: "cli" }),
        (err) => err.code === "AUDIT_INVALID_ORIGIN"
      );
      assert.equal(dbApi.countAdminAudit(guild), 2, "invalid origin wrote nothing");
    });
  });

  describe("fail closed — DB errors propagate (unaudited mutation never succeeds)", () => {
    it("DB insert failure propagates as-is and the mirror is NOT dispatched", async () => {
      const boom = new Error("SQLITE_BUSY: database is locked");
      const { req, auditLogStub } = setup({
        req: { params: { guildId: "g-web-audit-dbfail" } },
        mw: {
          insertAdminAudit: () => {
            throw boom;
          },
        },
      });

      assert.throws(
        () => req.audit({ action: "a.dbfail", mirror: { title: "never sent" } }),
        (err) => err === boom
      );
      await flushTwice();
      assert.equal(auditLogStub.calls.length, 0, "DB first: no embed after failed row");
    });

    it("real repository guard (oversize details) throws through req.audit, no row", () => {
      const { req } = setup({ req: { params: { guildId: "g-web-audit-oversize" } } });
      assert.throws(
        () =>
          req.audit({
            action: "a.big",
            details: { blob: "x".repeat(dbApi.MAX_AUDIT_DETAILS_JSON) },
          }),
        (err) => err.code === "INVALID_DETAILS"
      );
      assert.equal(dbApi.countAdminAudit("g-web-audit-oversize"), 0);
    });
  });

  describe("details redaction (§8.7)", () => {
    it("strips token/secret/password/cookie keys recursively; nothing persists", () => {
      const guild = "g-web-audit-redact";
      const { req } = setup({ req: { params: { guildId: guild } } });

      const row = req.audit({
        action: "settings.update",
        details: {
          keep: "keep-me",
          api_token: "SEKRIT1",
          nested: { clientSecret: "SEKRIT2", password: "SEKRIT3", session_cookie: "SEKRIT4", keep: 1 },
          list: [{ Token: "SEKRIT5", ok: true }],
        },
      });

      assert.doesNotMatch(row.details_json, /SEKRIT/, "no secret value persists");
      assert.deepEqual(JSON.parse(row.details_json), {
        keep: "keep-me",
        nested: { keep: 1 },
        list: [{ ok: true }],
      });

      const stored = dbApi.getAdminAuditById(row.id);
      assert.equal(stored.details_json.includes("api_token"), false);
    });

    it("redacts already-serialized JSON strings too", () => {
      const { req } = setup({ req: { params: { guildId: "g-web-audit-redact-str" } } });
      const row = req.audit({
        action: "a.str",
        details: '{"refresh_token":"rt-value","ok":true}',
      });
      assert.deepEqual(JSON.parse(row.details_json), { ok: true });
    });

    it("unparseable string details still rejected by the repo guard, no row", () => {
      const { req } = setup({ req: { params: { guildId: "g-web-audit-badjson" } } });
      assert.throws(
        () => req.audit({ action: "a.badjson", details: "not json at all" }),
        (err) => err.code === "INVALID_DETAILS"
      );
      assert.equal(dbApi.countAdminAudit("g-web-audit-badjson"), 0);
    });

    it("redactSensitive: pure, arrays kept, Dates kept, cycles collapse to null", () => {
      const frozen = Object.freeze({ token: "t", keep: "k" });
      assert.deepEqual(audit.redactSensitive(frozen), { keep: "k" });
      assert.deepEqual(audit.redactSensitive([{ cookie: "c" }, "s", 1, null]), [{}, "s", 1, null]);

      const when = new Date(1700000000000);
      const kept = audit.redactSensitive({ when });
      assert.ok(kept.when instanceof Date);
      assert.equal(kept.when.getTime(), 1700000000000);

      const circular = { a: 1 };
      circular.self = circular;
      assert.deepEqual(audit.redactSensitive(circular), { a: 1, self: null });

      assert.equal(audit.redactSensitive(undefined), undefined);
      assert.equal(audit.redactSensitive("text"), "text");
    });
  });

  describe("channel mirror — best-effort, never affects the response (§8.1-7)", () => {
    it("dispatches after the row, via buildConfigChangeEmbed + sendAuditLog", async () => {
      const guild = "g-web-audit-mirror";
      const { req, auditLogStub, client } = setup({ req: { params: { guildId: guild } } });

      const row = req.audit({
        action: "staff.role.add",
        targetType: "role",
        targetId: "r1",
        mirror: { title: "Staff role added", changes: ["• moderator"] },
      });
      assert.ok(row.id, "row returned synchronously");
      assert.equal(auditLogStub.calls.length, 0, "dispatch is async, not inline");

      await flushTwice();
      assert.equal(auditLogStub.calls.length, 1);
      const call = auditLogStub.calls[0];
      assert.equal(call.kind, "audit");
      assert.equal(call.client, client);
      assert.equal(call.guildId, guild);
      assert.deepEqual(call.payload.embeds[0].received.changes, ["• moderator"]);
      assert.deepEqual(call.payload.embeds[0].received.actor, {
        id: USER.userId,
        tag: USER.discordTag,
      });
    });

    it("kind 'warn' routes to the warn poster; raw payload bypasses the builder", async () => {
      const { req, auditLogStub } = setup({ req: { params: { guildId: "g-web-audit-warn" } } });
      req.audit({ action: "w.a", mirror: { kind: "warn", title: "warn issued" } });
      req.audit({ action: "w.b", mirror: { payload: { embeds: ["prebuilt"] } } });

      await flushTwice();
      assert.deepEqual(auditLogStub.calls.map((c) => c.kind), ["warn", "audit"]);
      assert.equal(auditLogStub.builtCount, 1, "raw payload must not build an embed");
      assert.deepEqual(auditLogStub.calls[1].payload, { embeds: ["prebuilt"] });
    });

    it("no client bound → mirror skipped silently, response path unaffected", async () => {
      const { req, auditLogStub, logger } = setup({
        req: { params: { guildId: "g-web-audit-noclient" } },
        mw: { getClient: () => null },
      });
      const row = req.audit({ action: "a.noclient", mirror: { title: "t" } });
      assert.ok(row.id);
      await flushTwice();
      assert.equal(auditLogStub.calls.length, 0);
      assert.equal(logger.warns.length, 0, "dark/no-client is not a warning condition");
    });

    it("rejecting poster is caught: row returned, warning logged, NO unhandled rejection", async () => {
      const seen = [];
      const onUnhandled = (reason) => seen.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const { req, auditLogStub, logger } = setup({
          req: { params: { guildId: "g-web-audit-mirrorfail" } },
          mirrorBehavior: { rejectSend: true },
        });
        const row = req.audit({
          action: "a.mirrorfail",
          mirror: { title: "posted anyway" },
        });
        assert.ok(row.id, "mirror failure never fails the mutation");

        await flushTwice();
        assert.equal(auditLogStub.calls.length, 1, "dispatch was attempted");
        assert.equal(logger.warns.length, 1);
        assert.match(logger.warns[0], /mirror dispatch failed/);
        assert.deepEqual(seen, [], "Node 22 would kill the process on this rejection");
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("synchronous throws (embed build, broken getClient) are contained too", async () => {
      const seen = [];
      const onUnhandled = (reason) => seen.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const buildBoom = setup({
          req: { params: { guildId: "g-web-audit-buildboom" } },
          mirrorBehavior: { throwOnBuild: true },
        });
        assert.ok(buildBoom.req.audit({ action: "a.buildboom", mirror: { title: "t" } }).id);

        const clientBoom = setup({
          req: { params: { guildId: "g-web-audit-clientboom" } },
          mw: {
            getClient: () => {
              throw new Error("client exploded");
            },
          },
        });
        assert.ok(clientBoom.req.audit({ action: "a.clientboom", mirror: { title: "t" } }).id);

        await flushTwice();
        assert.deepEqual(seen, []);
        assert.equal(buildBoom.logger.warns.length, 1);
        assert.equal(clientBoom.logger.warns.length, 1);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("invalid (non-object) mirror descriptor: row kept, warning logged", async () => {
      const { req, logger } = setup({ req: { params: { guildId: "g-web-audit-badmirror" } } });
      assert.ok(req.audit({ action: "a.badmirror", mirror: "embed me" }).id);
      await flushTwice();
      assert.equal(logger.warns.length, 1);
      assert.match(logger.warns[0], /ignored mirror descriptor/);
    });
  });

  describe("boot-bound client (default getClient)", () => {
    it("uses bindAuditClient when no getClient is injected", async () => {
      const bound = { __bound: true };
      audit.bindAuditClient(bound);
      try {
        const { req, auditLogStub } = setup({
          req: { params: { guildId: "g-web-audit-bound" } },
          mw: { getClient: undefined },
        });
        req.audit({ action: "a.bound", mirror: { title: "t" } });
        await flushTwice();
        assert.equal(auditLogStub.calls[0].client, bound);
      } finally {
        audit.bindAuditClient(null);
      }
    });
  });

  describe("attachAudit (standalone, documented signature) + list/count passthrough", () => {
    it("attachAudit writes through the real facade without the middleware", () => {
      const req = makeReq({ params: { guildId: "g-web-audit-standalone" } });
      const row = audit.attachAudit(req, {}, { action: "a.standalone", origin: "web" });
      assert.equal(row.guild_id, "g-web-audit-standalone");
      assert.equal(row.actor_user_id, USER.userId);
    });

    it("listAudit/countAudit expose the Phase 1 System viewer queries", () => {
      const guild = "g-web-audit-viewer";
      const { req } = setup({ req: { params: { guildId: guild } } });
      req.audit({ action: "v.one", origin: "web" });
      req.audit({ action: "v.two", origin: "system" });
      dbApi.insertAdminAudit({ guildId: "g-web-audit-other", origin: "web", action: "v.noise" });

      const rows = audit.listAudit(guild, { limit: 10 });
      assert.equal(rows.length, 2, "guild-scoped");
      assert.deepEqual(
        rows.map((r) => r.action),
        ["v.two", "v.one"],
        "newest first"
      );
      assert.equal(audit.countAudit(guild), 2);
      assert.equal(audit.countAudit(guild, { origin: "web" }), 1);
      assert.deepEqual(audit.listAudit(guild, { origin: "web" }).map((r) => r.action), ["v.one"]);

      assert.throws(
        () => audit.listAudit(guild, { origin: "nope" }),
        (err) => err.code === "INVALID_ORIGIN",
        "repo validation reaches consumers through the passthrough"
      );
    });
  });
});
