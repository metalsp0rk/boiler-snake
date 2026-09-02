const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const {
  TIERS,
  visibilityTier,
  staffSyncCommandNames,
  assertVisibilityCoversCommands,
  isStaffSyncCommand,
} = require("../src/core/commandVisibility");
const {
  buildStaffRoleAllowPermissions,
  MAX_PERMISSIONS,
} = require("../src/features/commandPermissions/permissionsPayload");
const {
  createOAuthState,
  verifyOAuthState,
  _resetNoncesForTests,
} = require("../src/features/commandPermissions/oauthState");

describe("commandVisibility", () => {
  /** @type {string[]} */
  let registeredNames;

  before(() => {
    const { buildDefaultRegistry } = require("../src/commands/registry");
    const reg = buildDefaultRegistry();
    registeredNames = reg.commands.map((c) => c.name);
  });

  it("covers every registered slash command", () => {
    assert.doesNotThrow(() =>
      assertVisibilityCoversCommands(registeredNames)
    );
  });

  it("classifies public, staff, and admin tiers", () => {
    assert.equal(visibilityTier("xp"), TIERS.public);
    assert.equal(visibilityTier("warn"), TIERS.public);
    assert.equal(visibilityTier("ticket"), TIERS.public);
    assert.equal(visibilityTier("eventreminder"), TIERS.public);
    assert.equal(visibilityTier("play"), TIERS.public);
    assert.equal(visibilityTier("music"), TIERS.public);
    assert.equal(visibilityTier("note"), TIERS.staff);
    assert.equal(visibilityTier("setxp"), TIERS.staff);
    assert.equal(visibilityTier("honeypot"), TIERS.staff);
    assert.equal(visibilityTier("staff"), TIERS.admin);
    assert.equal(visibilityTier("setcommandchannel"), TIERS.admin);
  });

  it("staff sync list excludes public and admin", () => {
    const names = staffSyncCommandNames();
    assert.ok(names.includes("note"));
    assert.ok(names.includes("setxp"));
    assert.ok(!names.includes("xp"));
    assert.ok(!names.includes("staff"));
    assert.ok(!names.includes("setcommandchannel"));
    assert.ok(isStaffSyncCommand("activityconfig"));
    assert.ok(!isStaffSyncCommand("leaderboard"));
  });

  it("staff-tier builders set ManageGuild defaultMemberPermissions", () => {
    const { buildDefaultRegistry } = require("../src/commands/registry");
    const reg = buildDefaultRegistry();
    for (const cmd of reg.commands) {
      const tier = visibilityTier(cmd.name);
      if (tier === TIERS.public) {
        assert.equal(
          cmd.default_member_permissions ?? null,
          null,
          `/${cmd.name} should not set default_member_permissions`
        );
      } else {
        assert.ok(
          cmd.default_member_permissions != null &&
            cmd.default_member_permissions !== "0",
          `/${cmd.name} should set ManageGuild default_member_permissions`
        );
      }
    }
  });
});

describe("command permission payloads", () => {
  it("builds role allow overwrites", () => {
    const perms = buildStaffRoleAllowPermissions(["r1", "r2", "r1"]);
    assert.deepEqual(perms, [
      { id: "r1", type: 1, permission: true },
      { id: "r2", type: 1, permission: true },
    ]);
  });

  it("allows empty list", () => {
    assert.deepEqual(buildStaffRoleAllowPermissions([]), []);
  });

  it("rejects more than MAX_PERMISSIONS roles", () => {
    const ids = Array.from({ length: MAX_PERMISSIONS + 1 }, (_, i) => `r${i}`);
    assert.throws(() => buildStaffRoleAllowPermissions(ids), /Too many/);
  });
});

describe("OAuth state", () => {
  before(() => {
    process.env.CLIENT_SECRET = process.env.CLIENT_SECRET || "test-secret-for-hmac";
    _resetNoncesForTests();
  });

  it("round-trips and rejects reuse", () => {
    _resetNoncesForTests();
    const state = createOAuthState({
      guildId: "g1",
      userId: "u1",
    });
    const once = verifyOAuthState(state);
    assert.ok(once);
    assert.equal(once.guildId, "g1");
    assert.equal(once.userId, "u1");
    assert.equal(verifyOAuthState(state), null);
  });

  it("rejects tampered state", () => {
    _resetNoncesForTests();
    const state = createOAuthState({ guildId: "g1", userId: "u1" });
    const bad = state.slice(0, -4) + "xxxx";
    assert.equal(verifyOAuthState(bad), null);
  });

  it("rejects expired state", () => {
    _resetNoncesForTests();
    const state = createOAuthState({
      guildId: "g1",
      userId: "u1",
      exp: Date.now() - 1000,
    });
    assert.equal(verifyOAuthState(state), null);
  });
});
