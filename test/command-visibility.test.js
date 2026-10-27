const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// The registry require in before() opens SQLite at load time (feature
// modules import the db facade), and the src/ requires below may too.
// CONTRACT: loadDb() must stay above every `src/` require in this file — it
// points this process at a private temp DB (fresh DB_PATH + src require-cache
// reset) before those requires load, so this process never races the
// project-root default (xpbot.sqlite) against the other test files that
// node --test runs in parallel.
const { cleanup } = loadDb();

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

// Closes the tracked DB handles and removes the temp dir (idempotent,
// never throws).
after(cleanup);

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
    assert.equal(visibilityTier("bridge"), TIERS.staff);
    // #725 (epic #723): /automod status is the staff-tier read surface.
    assert.equal(visibilityTier("automod"), TIERS.staff);
    // #725: /automodconfig is admin-tier — ManageGuild picker, NO
    // staff_roles allow overwrites (mutations are admin-only in the handler).
    assert.equal(visibilityTier("automodconfig"), TIERS.admin);
    // #599: /staffsettings is the staff-tier read path (role list + settings
    // twin) — the whole point is that it rides the staff picker machinery.
    assert.equal(visibilityTier("staffsettings"), TIERS.staff);
    // #745: context-menu report commands ride the same staff picker posture.
    // Keys are the exact display names (caps + space) — same strings the
    // builders register and the router will dispatch on.
    assert.equal(visibilityTier("Report Post"), TIERS.staff);
    assert.equal(visibilityTier("Report User"), TIERS.staff);
    assert.equal(visibilityTier("staff"), TIERS.admin);
    assert.equal(visibilityTier("setcommandchannel"), TIERS.admin);
  });

  it("staff sync list excludes public and admin", () => {
    const names = staffSyncCommandNames();
    assert.ok(names.includes("note"));
    assert.ok(names.includes("setxp"));
    // #599: the read twin must receive staff_roles allow overwrites on sync.
    assert.ok(names.includes("staffsettings"));
    // #745: the context-menu report names (exact display names) sync too —
    // staffSyncCommandNames() is name-agnostic, and sync.js matches them
    // case-sensitively against the guild command list Discord returns.
    assert.ok(names.includes("Report Post"));
    assert.ok(names.includes("Report User"));
    // #725: the staff-tier status command syncs; the admin config command must not.
    assert.ok(names.includes("automod"));
    assert.ok(!names.includes("automodconfig"));
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

  it("context-menu report commands (#745) carry staff-tier command JSON", () => {
    // The generic loop above already classifies these by name (registry-
    // derived registeredNames includes context-menu builders via
    // toJSON().name); this pins the payload specifics the loop can see:
    // Message/User type + the ManageGuild default_member_permissions string
    // the builder emits (validateDefaultMemberPermissions bigint→string).
    const { PermissionFlagsBits, ApplicationCommandType } = require("discord.js");
    const { buildDefaultRegistry } = require("../src/commands/registry");
    const reg = buildDefaultRegistry();
    const byName = new Map(reg.commands.map((c) => [c.name, c]));
    const manageGuild = BigInt(PermissionFlagsBits.ManageGuild).toString();

    const post = byName.get("Report Post");
    assert.ok(post, "Report Post missing from the default registry");
    assert.equal(post.type, ApplicationCommandType.Message);
    assert.equal(post.default_member_permissions, manageGuild);

    const user = byName.get("Report User");
    assert.ok(user, "Report User missing from the default registry");
    assert.equal(user.type, ApplicationCommandType.User);
    assert.equal(user.default_member_permissions, manageGuild);
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
