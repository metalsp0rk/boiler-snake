const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { loadDb } = require("./helpers/env");

describe("staff roles levels", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let db;

  before(() => {
    db = loadDb().api;
  });

  it("defaults add to senior and supports junior", () => {
    db.addStaffRole("g1", "role-a");
    let row = db.getStaffRole("g1", "role-a");
    assert.equal(row.level, "senior");

    db.addStaffRole("g1", "role-b", "junior");
    row = db.getStaffRole("g1", "role-b");
    assert.equal(row.level, "junior");

    const all = db.listStaffRoles("g1");
    assert.equal(all.length, 2);

    const seniors = db.listSeniorStaffRoles("g1");
    assert.equal(seniors.length, 1);
    assert.equal(seniors[0].role_id, "role-a");

    const juniors = db.listStaffRoles("g1", { level: "junior" });
    assert.equal(juniors.length, 1);
    assert.equal(juniors[0].role_id, "role-b");
  });

  it("memberHasStaffRole is any level; senior check is senior only", () => {
    db.addStaffRole("g2", "sr", "senior");
    db.addStaffRole("g2", "jr", "junior");

    assert.equal(db.memberHasStaffRole("g2", ["jr"]), true);
    assert.equal(db.memberHasStaffRole("g2", ["sr"]), true);
    assert.equal(db.memberHasStaffRole("g2", ["other"]), false);

    assert.equal(db.memberHasSeniorStaffRole("g2", ["jr"]), false);
    assert.equal(db.memberHasSeniorStaffRole("g2", ["sr"]), true);
    assert.equal(db.memberHasSeniorStaffRole("g2", ["jr", "sr"]), true);
  });

  it("setStaffRoleLevel and upsert on add", () => {
    db.addStaffRole("g3", "r1", "junior");
    assert.equal(db.getStaffRole("g3", "r1").level, "junior");

    assert.equal(db.setStaffRoleLevel("g3", "r1", "senior"), true);
    assert.equal(db.getStaffRole("g3", "r1").level, "senior");

    db.addStaffRole("g3", "r1", "junior"); // upsert
    assert.equal(db.getStaffRole("g3", "r1").level, "junior");

    assert.equal(db.setStaffRoleLevel("g3", "missing", "senior"), false);
  });

  it("normalizeStaffLevel", () => {
    assert.equal(db.normalizeStaffLevel("junior"), "junior");
    assert.equal(db.normalizeStaffLevel("JR"), "junior");
    assert.equal(db.normalizeStaffLevel("senior"), "senior");
    assert.equal(db.normalizeStaffLevel("nope"), "senior");
    assert.equal(db.normalizeStaffLevel(null), "senior");
  });

  it("add records added_by; get/list expose it; omitted actor stays NULL", () => {
    db.addStaffRole("g4", "r-seed", "senior", "admin-4");
    assert.equal(db.getStaffRole("g4", "r-seed").added_by, "admin-4");
    const listed = db.listStaffRoles("g4").find((r) => r.role_id === "r-seed");
    assert.equal(listed.added_by, "admin-4");

    db.addStaffRole("g4", "r-anon", "junior");
    assert.equal(db.getStaffRole("g4", "r-anon").added_by, null);

    // re-add with actor refreshes provenance; actorless re-add preserves it
    db.addStaffRole("g4", "r-seed", "junior", "admin-5");
    assert.equal(db.getStaffRole("g4", "r-seed").added_by, "admin-5");
    db.addStaffRole("g4", "r-seed", "senior");
    assert.equal(db.getStaffRole("g4", "r-seed").added_by, "admin-5");
  });
});

// ---------- /staff role handlers: added_by + audit embeds ----------

const {
  createChatInputInteraction,
  createClient,
  createGuild,
  createMember,
  createTextChannel,
  createUser,
  lastReplyContent,
  lastReplyEphemeral,
} = require("./helpers/discord");

describe("/staff role handlers (added_by + audit embeds)", () => {
  /** @type {object} db facade bound to the feature instance below */
  let envApi;
  /** @type {typeof import("../src/features/staffRoles/index.js")} */
  let staffRoles;

  before(() => {
    // Fresh db + feature instance: loadDb resets the src require cache, so the
    // feature binds to THIS db (mirrors test/gork-memory-commands.test.js).
    envApi = loadDb().api;
    staffRoles = require("../src/features/staffRoles/index.js");
  });

  /**
   * Per-test guild with its audit channel wired into settings, so the REAL
   * logConfigChange path lands embeds in `auditChannel.sent`.
   */
  function makeStaffEnv(guildId) {
    const guild = createGuild({ id: guildId });
    const auditChannel = createTextChannel({
      id: `audit-${guildId}`,
      guild,
      name: "audit",
    });
    guild.addChannel(auditChannel);
    const client = createClient();
    client.addGuild(guild);
    envApi.updateGuildSettings(guildId, {
      audit_log_channel_id: auditChannel.id,
    });

    const adminUser = createUser({ id: `admin-${guildId}` });
    const adminMember = createMember({ guild, user: adminUser, admin: true });
    guild.addMember(adminMember);

    return { guild, auditChannel, client, adminUser, adminMember };
  }

  function fakeRole(id) {
    return { id, name: `role-${id}`, toString: () => `<@&${id}>` };
  }

  async function runRoleSub(env, sub, options) {
    const interaction = createChatInputInteraction({
      commandName: "staff",
      subcommandGroup: "role",
      subcommand: sub,
      guild: env.guild,
      user: env.adminUser,
      member: env.adminMember,
      options,
      client: env.client,
    });
    await staffRoles.handlers.staff(interaction, { client: env.client });
    return interaction;
  }

  /** Audit embeds the REAL logConfigChange path posted, as plain JSON. */
  function auditEmbeds(env) {
    return env.auditChannel.sent
      .flatMap((p) => (p && p.embeds) || [])
      .map((e) => (e && typeof e.toJSON === "function" ? e.toJSON() : e));
  }

  function fieldValue(embed, name) {
    const f = (embed.fields || []).find((x) => x.name === name);
    return f ? f.value : undefined;
  }

  describe("add", () => {
    it("stores the actor in added_by and posts a 'Staff role added' embed", async () => {
      const G = "g-staff-add";
      const env = makeStaffEnv(G);

      const interaction = await runRoleSub(env, "add", {
        role: fakeRole("role-new"),
        level: "senior",
      });
      assert.ok(lastReplyEphemeral(interaction));
      assert.match(
        lastReplyContent(interaction),
        /Added <@&role-new> as \*\*senior\*\*/,
      );

      const row = envApi.getStaffRole(G, "role-new");
      assert.equal(row.added_by, env.adminUser.id, "actor recorded on add");

      const embeds = auditEmbeds(env);
      assert.equal(embeds.length, 1, "one audit embed");
      assert.equal(embeds[0].title, "Staff role added");
      assert.equal(fieldValue(embeds[0], "Command"), "`/staff role add`");
      assert.match(fieldValue(embeds[0], "Changed by"), /`admin-g-staff-add`/);
      const changes = fieldValue(embeds[0], "Changes");
      assert.ok(
        changes.includes("<@&role-new>") && changes.includes("role-new"),
        changes,
      );
      assert.ok(changes.includes("**senior**"), changes);
    });

    it("re-adding an existing role audits 'Staff role level updated'", async () => {
      const G = "g-staff-add-again";
      const env = makeStaffEnv(G);

      await runRoleSub(env, "add", { role: fakeRole("role-x"), level: "junior" });
      const second = await runRoleSub(env, "add", {
        role: fakeRole("role-x"),
        level: "senior",
      });
      assert.match(
        lastReplyContent(second),
        /Updated <@&role-x> to \*\*senior\*\*/,
      );

      const embeds = auditEmbeds(env);
      assert.equal(embeds.length, 2);
      assert.equal(embeds[1].title, "Staff role level updated");
      assert.match(
        fieldValue(embeds[1], "Changes"),
        /Level: \*\*junior\*\* → \*\*senior\*\*/,
      );
      assert.equal(
        envApi.getStaffRole(G, "role-x").added_by,
        env.adminUser.id,
        "re-add keeps recording the acting admin",
      );
    });
  });

  describe("remove", () => {
    it("posts a 'Staff role removed' embed with command and actor", async () => {
      const G = "g-staff-remove";
      const env = makeStaffEnv(G);
      envApi.addStaffRole(G, "role-gone", "senior", env.adminUser.id);

      const interaction = await runRoleSub(env, "remove", {
        role: fakeRole("role-gone"),
      });
      assert.match(lastReplyContent(interaction), /Removed <@&role-gone>/);
      assert.equal(envApi.getStaffRole(G, "role-gone"), null);

      const embeds = auditEmbeds(env);
      assert.equal(embeds.length, 1);
      assert.equal(embeds[0].title, "Staff role removed");
      assert.equal(fieldValue(embeds[0], "Command"), "`/staff role remove`");
      assert.match(
        fieldValue(embeds[0], "Changed by"),
        /`admin-g-staff-remove`/,
      );
      assert.ok(fieldValue(embeds[0], "Changes").includes("role-gone"));
    });

    it("removing a non-staff role is a friendly no-op with NO embed", async () => {
      const G = "g-staff-remove-miss";
      const env = makeStaffEnv(G);

      const interaction = await runRoleSub(env, "remove", {
        role: fakeRole("role-none"),
      });
      assert.match(lastReplyContent(interaction), /not a configured staff role/);
      assert.equal(auditEmbeds(env).length, 0, "misses are not audited");
    });
  });

  describe("setlevel", () => {
    it("posts a 'Staff role level changed' embed showing the level diff", async () => {
      const G = "g-staff-setlevel";
      const env = makeStaffEnv(G);
      envApi.addStaffRole(G, "role-lvl", "senior", "admin-seed");

      const interaction = await runRoleSub(env, "setlevel", {
        role: fakeRole("role-lvl"),
        level: "junior",
      });
      assert.match(
        lastReplyContent(interaction),
        /Set <@&role-lvl> to \*\*junior\*\*/,
      );
      assert.equal(envApi.getStaffRole(G, "role-lvl").level, "junior");

      const embeds = auditEmbeds(env);
      assert.equal(embeds.length, 1);
      assert.equal(embeds[0].title, "Staff role level changed");
      assert.equal(fieldValue(embeds[0], "Command"), "`/staff role setlevel`");
      assert.match(
        fieldValue(embeds[0], "Changes"),
        /Level: \*\*senior\*\* → \*\*junior\*\*/,
      );
    });
  });

  describe("list", () => {
    it("shows 'added by' for rows with provenance and omits it for legacy NULLs", async () => {
      const G = "g-staff-list";
      const env = makeStaffEnv(G);
      envApi.addStaffRole(G, "role-known", "senior", "known-actor");
      envApi.addStaffRole(G, "role-legacy", "senior"); // NULL added_by (pre-migration row)

      const interaction = await runRoleSub(env, "list", {});
      const text = lastReplyContent(interaction);
      assert.ok(lastReplyEphemeral(interaction));
      assert.ok(text.includes("- <@&role-known> (added by <@known-actor>)"), text);
      assert.ok(text.includes("- <@&role-legacy>"), text);
      assert.ok(
        !/role-legacy> \(added by/.test(text),
        "NULL provenance omits the suffix",
      );
    });
  });
});
