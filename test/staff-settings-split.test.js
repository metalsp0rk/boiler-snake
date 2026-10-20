/**
 * #599 — `/staffsettings`: the staff-visible read-only twin of
 * `/staff role list` + `/staff settings`.
 *
 * Pins three things:
 *  1. Registration + tier wiring (builder shape, staff-tier posture, context
 *     handler) — the picker half of the split.
 *  2. The handler gate on BOTH subcommands: junior and senior staff roles
 *     pass WITHOUT ManageGuild (requireStaff, same gate as the existing read
 *     subcommands); non-staff without ManageGuild is denied; ManageGuild
 *     alone still passes.
 *  3. Byte-parity with the /staff read subcommands — ONE renderer per view
 *     (test/staff-visibility-copy.test.js pins the registration truth).
 *
 * Live Discord picker behaviour after `/staff syncpermissions` is owed
 * separately (recorded on the issue); this file pins server-side truth.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");

// The registry/feature requires below open SQLite at load time (feature
// modules import the db facade). CONTRACT: loadDb() must stay above every
// `src/` require in this file — it points this process at a private temp DB
// (fresh DB_PATH + src require-cache reset) before those requires load, so
// this process never races the project-root default (xpbot.sqlite) against
// the other test files that node --test runs in parallel
// (mirrors test/command-visibility.test.js).
const loaded = loadDb();
const envApi = loaded.api;
after(loaded.cleanup);

const { PermissionFlagsBits } = require("discord.js");
const {
  TIERS,
  visibilityTier,
  isStaffSyncCommand,
} = require("../src/core/commandVisibility");
const { MSG_DENIED } = require("../src/core/theme");
const staffRoles = require("../src/features/staffRoles/index.js");
const { buildDefaultRegistry } = require("../src/commands/registry");
const { buildDiscordCommandContext } = require("../src/platform/discord/context");
const {
  createChatInputInteraction,
  createClient,
  createGuild,
  createMember,
  createUser,
  lastReplyContent,
  lastReplyEphemeral,
} = require("./helpers/discord");

describe("/staffsettings registration + tier wiring (#599)", () => {
  const registry = buildDefaultRegistry();
  const json = registry.commands.find((c) => c.name === "staffsettings");

  it("registered exactly once with the read-only subcommands only", () => {
    assert.ok(json, "/staffsettings is in the default registry");
    assert.equal(
      registry.commands.filter((c) => c.name === "staffsettings").length,
      1,
    );
    // Flat subcommands (no groups): exactly roles + overview — nothing that
    // mutates lives on this command (mutations stay /staff-only).
    // Flat top-level subcommands (type 1); tolerate the grouped shape too
    // (a type-1 group whose children are type-1 subcommands).
    const subcommands = json.options.flatMap((opt) => {
      if (opt.type !== 1) return [];
      const children = (opt.options || [])
        .filter((o) => o.type === 1)
        .map((o) => o.name);
      return children.length ? children : [opt.name];
    });
    assert.deepEqual(subcommands.sort(), ["overview", "roles"]);
  });

  it("is staff tier: picker defaults to ManageGuild, sync adds staff overwrites", () => {
    assert.equal(visibilityTier("staffsettings"), TIERS.staff);
    assert.equal(isStaffSyncCommand("staffsettings"), true);
    // Staff-tier posture (command-visibility.test.js enforces non-null for
    // every staff/admin command; here pin the exact bit).
    assert.equal(
      BigInt(json.default_member_permissions) &
        BigInt(PermissionFlagsBits.ManageGuild),
      BigInt(PermissionFlagsBits.ManageGuild),
    );
  });

  it("handler is registered on the context arm", () => {
    assert.equal(typeof registry.getHandler("staffsettings"), "function");
    assert.equal(registry.getHandlerApi("staffsettings"), "context");
  });

  it("/staff is unchanged: still registered, still admin tier", () => {
    assert.ok(registry.commands.find((c) => c.name === "staff"));
    assert.equal(visibilityTier("staff"), TIERS.admin);
  });
});

describe("/staffsettings handlers (#599)", () => {
  /**
   * Per-test guild + client. Admin carries ManageGuild; callers pass in
   * members explicitly for the gate cases.
   */
  function makeEnv(guildId) {
    const guild = createGuild({ id: guildId });
    const client = createClient();
    client.addGuild(guild);
    const adminUser = createUser({ id: `admin-${guildId}` });
    const adminMember = createMember({ guild, user: adminUser, admin: true });
    guild.addMember(adminMember);
    return { guild, client, adminUser, adminMember };
  }

  /** Run one command through the real feature handler (router's context arm). */
  async function run(env, opts) {
    const interaction = createChatInputInteraction({
      commandName: opts.commandName,
      subcommandGroup: opts.subcommandGroup ?? null,
      subcommand: opts.subcommand,
      guild: env.guild,
      user: opts.user,
      member: opts.member,
      options: {},
      client: env.client,
    });
    const handler = staffRoles.handlers[opts.commandName];
    assert.ok(handler, `handler for /${opts.commandName} exists`);
    await handler(
      buildDiscordCommandContext(interaction, { client: env.client }),
      { client: env.client },
    );
    return interaction;
  }

  /** Junior/senior-role member WITHOUT ManageGuild. */
  function staffMember(env, userId, roleId) {
    const user = createUser({ id: userId });
    const member = createMember({
      guild: env.guild,
      user,
      admin: false,
      roleIds: [roleId],
    });
    env.guild.addMember(member);
    return { user, member };
  }

  it("junior staff role WITHOUT ManageGuild reads /staffsettings roles", async () => {
    const G = "g-split-junior";
    const env = makeEnv(G);
    envApi.addStaffRole(communityKey(G), "role-junior", "junior");
    const { user, member } = staffMember(env, "jr-user", "role-junior");

    const interaction = await run(env, {
      commandName: "staffsettings",
      subcommand: "roles",
      user,
      member,
    });
    const text = lastReplyContent(interaction);
    assert.ok(lastReplyEphemeral(interaction), "reply is ephemeral");
    assert.notEqual(text, MSG_DENIED, "junior staff passes the staff gate");
    assert.ok(text.includes("**Staff roles**"), text);
    assert.ok(text.includes("- <@&role-junior>"), text);
  });

  it("senior staff role WITHOUT ManageGuild reads /staffsettings overview", async () => {
    const G = "g-split-senior";
    const env = makeEnv(G);
    envApi.addStaffRole(communityKey(G), "role-senior", "senior");
    const { user, member } = staffMember(env, "sr-user", "role-senior");

    const interaction = await run(env, {
      commandName: "staffsettings",
      subcommand: "overview",
      user,
      member,
    });
    const text = lastReplyContent(interaction);
    assert.ok(lastReplyEphemeral(interaction), "reply is ephemeral");
    assert.notEqual(text, MSG_DENIED, "senior staff passes the staff gate");
    assert.ok(text.includes("**Staff roles settings**"), text);
    assert.ok(
      text.includes(
        "Command visibility sync: **not authorized** — admin: `/staff syncpermissions`",
      ),
      text,
    );
  });

  it("non-staff member without ManageGuild is DENIED on both subcommands", async () => {
    const G = "g-split-denied";
    const env = makeEnv(G);
    // A staff table exists — the member simply is not on it.
    envApi.addStaffRole(communityKey(G), "role-real", "senior");
    const user = createUser({ id: "civilian" });
    const member = createMember({ guild: env.guild, user, admin: false });
    env.guild.addMember(member);

    for (const sub of ["roles", "overview"]) {
      const interaction = await run(env, {
        commandName: "staffsettings",
        subcommand: sub,
        user,
        member,
      });
      assert.equal(
        lastReplyContent(interaction),
        MSG_DENIED,
        `/staffsettings ${sub}: standard staff-gate denial`,
      );
      assert.ok(lastReplyEphemeral(interaction), "denial is ephemeral");
    }
  });

  it("ManageGuild alone (no staff role) still passes — gate parity with /staff", async () => {
    const G = "g-split-admin";
    const env = makeEnv(G); // admin member carries ManageGuild only
    const interaction = await run(env, {
      commandName: "staffsettings",
      subcommand: "roles",
      user: env.adminUser,
      member: env.adminMember,
    });
    assert.notEqual(lastReplyContent(interaction), MSG_DENIED);
    assert.ok(lastReplyContent(interaction).includes("No staff roles configured."));
  });

  it("roles output is BYTE-identical to /staff role list (shared renderer)", async () => {
    const G = "g-split-parity-list";
    const env = makeEnv(G);
    const cid = communityKey(G);
    envApi.addStaffRole(cid, "role-senior", "senior", "boss-1"); // provenance
    envApi.addStaffRole(cid, "role-junior", "junior"); // NULL added_by → omitted
    const { user, member } = staffMember(env, "parity-jr", "role-junior");

    const oldView = await run(env, {
      commandName: "staff",
      subcommandGroup: "role",
      subcommand: "list",
      user: env.adminUser,
      member: env.adminMember,
    });
    const newView = await run(env, {
      commandName: "staffsettings",
      subcommand: "roles",
      user,
      member,
    });
    assert.equal(lastReplyContent(newView), lastReplyContent(oldView));
    assert.ok(
      lastReplyContent(newView).includes("- <@&role-senior> (added by <@boss-1>)"),
      "sanity: provenance line rendered",
    );
  });

  it("empty-list reply is identical on both commands", async () => {
    const G = "g-split-parity-empty";
    const env = makeEnv(G);

    const oldView = await run(env, {
      commandName: "staff",
      subcommandGroup: "role",
      subcommand: "list",
      user: env.adminUser,
      member: env.adminMember,
    });
    const newView = await run(env, {
      commandName: "staffsettings",
      subcommand: "roles",
      user: env.adminUser,
      member: env.adminMember,
    });
    assert.equal(lastReplyContent(newView), lastReplyContent(oldView));
    assert.ok(
      lastReplyContent(newView).includes("No staff roles configured."),
      "sanity: empty-state text rendered",
    );
  });

  it("overview output is BYTE-identical to /staff settings (shared renderer)", async () => {
    const G = "g-split-parity-settings";
    const env = makeEnv(G);
    const cid = communityKey(G);
    envApi.addStaffRole(cid, "role-senior", "senior");
    envApi.addStaffRole(cid, "role-junior", "junior");
    const { user, member } = staffMember(env, "parity-jr-2", "role-junior");

    const oldView = await run(env, {
      commandName: "staff",
      subcommand: "settings",
      user: env.adminUser,
      member: env.adminMember,
    });
    const newView = await run(env, {
      commandName: "staffsettings",
      subcommand: "overview",
      user,
      member,
    });
    assert.equal(lastReplyContent(newView), lastReplyContent(oldView));
    assert.ok(
      lastReplyContent(newView).includes(
        "Total roles: **2** · senior **1** · junior **1**",
      ),
      "sanity: counts line rendered",
    );
  });

  it("unknown subcommand answers honestly (same posture as /staff)", async () => {
    const G = "g-split-unknown";
    const env = makeEnv(G);
    const interaction = await run(env, {
      commandName: "staffsettings",
      subcommand: "delete",
      user: env.adminUser,
      member: env.adminMember,
    });
    assert.ok(lastReplyEphemeral(interaction));
    assert.match(
      lastReplyContent(interaction),
      /Unknown subcommand: `\/staffsettings delete`/,
    );
  });
});
