const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { loadDb, communityKey } = require("./helpers/env");
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
    dbApi.upsertCommandPermissionOauth(communityKey("guild-cp-1"), {
      refreshToken: "rt-1",
      accessToken: "at-1",
      accessExpiresAt: Date.now() + 60_000,
      authorizedByUserId: "user-1",
    });
    const row = dbApi.getCommandPermissionOauth(communityKey("guild-cp-1"));
    assert.ok(row);
    assert.equal(row.refresh_token, "rt-1");
    assert.equal(row.access_token, "at-1");
    assert.equal(row.authorized_by_user_id, "user-1");
    assert.ok(dbApi.hasCommandPermissionOauth(communityKey("guild-cp-1")));
  });

  it("records sync result", () => {
    dbApi.upsertCommandPermissionOauth(communityKey("guild-cp-2"), {
      refreshToken: "rt-2",
    });
    const at = Date.now();
    dbApi.setCommandPermissionSyncResult(communityKey("guild-cp-2"), {
      lastSyncAt: at,
      lastSyncError: null,
    });
    const row = dbApi.getCommandPermissionOauth(communityKey("guild-cp-2"));
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
    dbApi.upsertCommandPermissionOauth(communityKey("guild-cp-del"), {
      refreshToken: "x",
    });
    assert.ok(dbApi.deleteCommandPermissionOauth(communityKey("guild-cp-del")));
    assert.equal(dbApi.getCommandPermissionOauth(communityKey("guild-cp-del")), null);
  });

  // #471 (INT-16): an abort at the first 401 must ACCOUNT for every
  // never-attempted command — before the fix they vanished from all three
  // ledgers and a 1-of-N sync rendered as near-total success.
  it("aborted auth failure accounts for never-attempted commands", async () => {
    const prevEnv = {
      CLIENT_ID: process.env.CLIENT_ID,
      DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    };
    process.env.CLIENT_ID = "app-1";
    process.env.DISCORD_TOKEN = "dt";
    const { applyGuildCommandPermissions } = require("../src/features/commandPermissions/sync");
    const { staffSyncCommandNames } = require("../src/core/commandVisibility");
    const names = staffSyncCommandNames();
    const cid = communityKey("guild-cp-abort");

    // The PUT path is plain global fetch (stubbed); discord.js REST binds
    // its OWN undici fetch, so the id-map read is stubbed at the prototype.
    const { REST } = require("discord.js");
    const originalFetch = global.fetch;
    const originalRequest = REST.prototype.request;
    REST.prototype.request = async () =>
      names.map((n) => ({ name: n, id: `cmd-${n}` }));
    let putCount = 0;
    global.fetch = async () => {
      putCount += 1;
      return new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const result = await applyGuildCommandPermissions(cid, { accessToken: "at" });
      assert.equal(putCount, 1, "the sync aborts at the first 401 — no further PUTs");
      assert.deepEqual(
        result.failed.map((f) => f.name),
        [names[0]],
        "the failed command itself is on the ledger"
      );
      assert.deepEqual(
        result.skippedAfterAbort,
        names.slice(1),
        "EVERY untried command rides the ledger as skipped (rule 5)"
      );
      assert.deepEqual(result.updated, []);
      assert.deepEqual(result.missingCommands, []);
    } finally {
      global.fetch = originalFetch;
      REST.prototype.request = originalRequest;
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
