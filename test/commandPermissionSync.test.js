const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { loadDb } = require("./helpers/env");
const {
  buildStaffRoleAllowPermissions,
} = require("../src/features/commandPermissions/permissionsPayload");

describe("command permission OAuth storage + put", () => {
  /** @type {ReturnType<typeof loadDb>} */
  let loaded;
  let dbApi;

  before(() => {
    loaded = loadDb();
    dbApi = loaded.api;
  });

  after(() => {
    if (loaded?.tmpDir) {
      try {
        require("fs").rmSync(loaded.tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("stores and reads oauth row", () => {
    dbApi.upsertCommandPermissionOauth("guild-cp-1", {
      refreshToken: "rt-1",
      accessToken: "at-1",
      accessExpiresAt: Date.now() + 60_000,
      authorizedByUserId: "user-1",
    });
    const row = dbApi.getCommandPermissionOauth("guild-cp-1");
    assert.ok(row);
    assert.equal(row.refresh_token, "rt-1");
    assert.equal(row.access_token, "at-1");
    assert.equal(row.authorized_by_user_id, "user-1");
    assert.ok(dbApi.hasCommandPermissionOauth("guild-cp-1"));
  });

  it("records sync result", () => {
    dbApi.upsertCommandPermissionOauth("guild-cp-2", {
      refreshToken: "rt-2",
    });
    const at = Date.now();
    dbApi.setCommandPermissionSyncResult("guild-cp-2", {
      lastSyncAt: at,
      lastSyncError: null,
    });
    const row = dbApi.getCommandPermissionOauth("guild-cp-2");
    assert.equal(row.last_sync_at, at);
    assert.equal(row.last_sync_error, null);
  });

  it("putCommandPermissions sends Bearer PUT", async () => {
    const { putCommandPermissions } = require("../src/features/commandPermissions/sync");
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method, body: opts.body, headers: opts.headers });
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "",
        headers: { get: () => null },
      };
    };

    try {
      await putCommandPermissions({
        applicationId: "app-1",
        guildId: "g-1",
        commandId: "cmd-note",
        accessToken: "tok",
        permissions: buildStaffRoleAllowPermissions(["role-staff-a"]),
      });
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /applications\/app-1\/guilds\/g-1\/commands\/cmd-note\/permissions/);
      assert.equal(calls[0].method, "PUT");
      assert.equal(calls[0].headers.Authorization, "Bearer tok");
      assert.match(calls[0].body, /role-staff-a/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("deletes oauth row", () => {
    dbApi.upsertCommandPermissionOauth("guild-cp-del", {
      refreshToken: "x",
    });
    assert.ok(dbApi.deleteCommandPermissionOauth("guild-cp-del"));
    assert.equal(dbApi.getCommandPermissionOauth("guild-cp-del"), null);
  });
});
