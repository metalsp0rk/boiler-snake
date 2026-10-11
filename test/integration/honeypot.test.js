const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertBanned,
  assertNotBanned,
  assertReplyContains,
  assertEphemeralReply,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: honeypot", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let handleHoneypotBanRole;
  let handleHoneypotMessage;
  let executeHoneypotBan;

  after(() => {
    // Close SQLite handles and remove the temp dir created for this env.
    env?.cleanup();
  });

  before(async () => {
    env = await createIntegrationEnv();
    const hp = require("../../src/features/honeypot");
    handleHoneypotBanRole = hp.handleHoneypotBanRole;
    handleHoneypotMessage = hp.handleHoneypotMessage;
    executeHoneypotBan = hp.executeHoneypotBan;
  });

  it("/honeypot channel add/list", async () => {
    const interaction = await env.runCommand({
      commandName: "honeypot",
      subcommandGroup: "channel",
      subcommand: "add",
      admin: true,
      options: { channel: env.channels.honeypot },
    });
    assertReplyContains(interaction, /honeypot/i);
    assert.ok(env.db.isHoneypotChannel(env.communityId, IDS.channelHoneypot));

    const list = await env.runCommand({
      commandName: "honeypot",
      subcommandGroup: "channel",
      subcommand: "list",
      admin: true,
    });
    assertReplyContains(list, IDS.channelHoneypot);
  });

  it("/honeypot channel denies non-staff", async () => {
    const interaction = await env.runCommand({
      commandName: "honeypot",
      subcommandGroup: "channel",
      subcommand: "list",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(interaction, /permission/i);
  });

  it("/honeypot exempt denies staff without ManageGuild", async () => {
    env.db.addStaffRole(env.communityId, IDS.roleExempt, "senior");
    const staffMember = env.createMember({
      guild: env.guild,
      user: env.users.memberUser,
      admin: false,
      roleIds: [IDS.roleExempt],
    });
    env.guild.addMember(staffMember);

    const interaction = await env.runCommand({
      commandName: "honeypot",
      subcommandGroup: "exempt",
      subcommand: "list",
      admin: false,
      user: env.users.memberUser,
      member: staffMember,
    });
    assertEphemeralReply(interaction, /administrators|permission/i);
  });

  it("ban-role grant triggers ban", async () => {
    env.db.addHoneypotBanRole(env.communityId, IDS.roleBan);
    const user = env.createUser({ id: "user-banrole-1", username: "raider" });
    const oldMember = env.createMember({ guild: env.guild, user, roleIds: [] });
    const newMember = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleBan],
    });
    env.guild.addMember(newMember);
    env.guild._bans.length = 0;
    await handleHoneypotBanRole(oldMember, newMember);
    assertBanned(env.guild, user.id);
  });

  it("ban-role skips exempt members", async () => {
    env.db.addHoneypotBanRole(env.communityId, IDS.roleBan);
    env.db.addHoneypotExemptRole(env.communityId, IDS.roleExempt);
    const user = env.createUser({ id: "user-banrole-exempt", username: "staff2" });
    const oldMember = env.createMember({ guild: env.guild, user, roleIds: [IDS.roleExempt] });
    const newMember = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleExempt, IDS.roleBan],
    });
    env.guild._bans.length = 0;
    await handleHoneypotBanRole(oldMember, newMember);
    assertNotBanned(env.guild, user.id);
  });

  it("executeHoneypotBan DMs, deletes, bans", async () => {
    const user = env.createUser({ id: "user-exec-ban", username: "spam" });
    const message = env.makeMessage({ author: user });
    env.guild._bans.length = 0;
    await executeHoneypotBan(env.guild, user, {
      reason: "test ban",
      deleteMessage: message,
      trigger: "channel",
      channelId: IDS.channelHoneypot,
    });
    assert.equal(message.deleted, true);
    assert.ok(user.sends.length >= 1);
    assertBanned(env.guild, user.id);
  });

  // ── Issue #184 (audit C3/C4): never ban on unknown state ────────────────

  /** Run fn with console[kind] captured; resolves to { result, logs }. */
  async function withCapturedLogs(kind, fn) {
    const orig = console[kind];
    const logs = [];
    console[kind] = (...args) => logs.push(args.join(" "));
    try {
      const result = await fn();
      return { result, logs };
    } finally {
      console[kind] = orig;
    }
  }

  function ensureHoneypotChannel() {
    if (!env.db.isHoneypotChannel(env.communityId, IDS.channelHoneypot)) {
      env.db.addHoneypotChannel(env.communityId, IDS.channelHoneypot);
    }
  }

  it("C3: uncached oldMember never bans — role diff unknown (delete-and-log only)", async () => {
    env.db.addHoneypotBanRole(env.communityId, IDS.roleBan);
    // Member ALREADY holds the ban role (e.g. staff testing per docs); after a
    // gateway resume/restart a profile edit arrives with oldMember === null.
    const user = env.createUser({ id: "user-c3-uncached", username: "holder" });
    const newMember = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleBan],
    });
    env.guild.addMember(newMember);
    env.guild._bans.length = 0;

    const { logs } = await withCapturedLogs("warn", () =>
      handleHoneypotBanRole(null, newMember),
    );
    assertNotBanned(env.guild, user.id);
    assert.equal(user.sends.length, 0, "no ban DM when the diff is unknown");
    assert.ok(
      logs.some(
        (l) =>
          l.includes("[honeypot]") &&
          l.includes(user.id) &&
          l.includes(env.guildId) &&
          /unknown|skip/i.test(l),
      ),
      `expected a skip log naming member and guild, got ${JSON.stringify(logs)}`,
    );

    // oldMember present but WITHOUT a role cache is also an unknown diff.
    const { logs: logs2 } = await withCapturedLogs("warn", () =>
      handleHoneypotBanRole({ roles: {} }, newMember),
    );
    assertNotBanned(env.guild, user.id);
    assert.equal(logs2.length, 1, "one skip log per unknown-diff update");
  });

  it("C3: known old state with newly-granted ban role still bans", async () => {
    env.db.addHoneypotBanRole(env.communityId, IDS.roleBan);
    const user = env.createUser({ id: "user-c3-fresh", username: "raider3" });
    // oldMember cached and ban role ABSENT from it → genuine new grant.
    const oldMember = env.createMember({
      guild: env.guild,
      user,
      roleIds: [],
    });
    const newMember = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleBan],
    });
    env.guild._bans.length = 0;
    await handleHoneypotBanRole(oldMember, newMember);
    assertBanned(env.guild, user.id);
  });

  it("C3: ban role already present in a known old state is not treated as new", async () => {
    env.db.addHoneypotBanRole(env.communityId, IDS.roleBan);
    const user = env.createUser({ id: "user-c3-known", username: "holder2" });
    const oldMember = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleBan],
    });
    // The update only adds an unrelated role — the ban role is pre-existing.
    const newMember = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleBan, IDS.roleLevel5],
    });
    env.guild._bans.length = 0;
    await handleHoneypotBanRole(oldMember, newMember);
    assertNotBanned(env.guild, user.id);
  });

  it("C3: staff member with uncached oldMember is never banned", async () => {
    env.db.addHoneypotBanRole(env.communityId, IDS.roleBan);
    env.db.addStaffRole(env.communityId, IDS.roleExempt);
    const user = env.createUser({ id: "user-c3-staff", username: "staffc3" });
    const newMember = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleExempt, IDS.roleBan],
    });
    env.guild._bans.length = 0;
    const { logs } = await withCapturedLogs("warn", () =>
      handleHoneypotBanRole(null, newMember),
    );
    assertNotBanned(env.guild, user.id);
    assert.equal(logs.length, 1, "skipped via the unknown-diff guard");
  });

  it("C4: rejected members.fetch deletes and logs but does not ban", async () => {
    ensureHoneypotChannel();
    // Author deliberately NOT in guild.members.cache — the mock members.fetch
    // rejects ("Member <id> not found"), simulating the transient API error.
    const user = env.createUser({ id: "user-c4-fetch", username: "ghost" });
    const message = env.createMessage({
      guild: env.guild,
      channel: env.channels.honeypot,
      author: user,
      member: null,
      content: "raid link",
    });
    env.guild._bans.length = 0;

    const { result, logs } = await withCapturedLogs("error", () =>
      handleHoneypotMessage(message),
    );
    assert.equal(result, true, "message still consumed as honeypot traffic");
    assertNotBanned(env.guild, user.id);
    assert.equal(user.sends.length, 0, "no ban DM when exemption state unknown");
    assert.equal(message.deleted, true, "delete-and-log keeps the channel empty");
    assert.ok(
      logs.some(
        (l) =>
          l.includes("[honeypot]") &&
          l.includes(user.id) &&
          l.includes(env.guildId) &&
          l.includes("members.fetch failed") &&
          l.includes("not found"),
      ),
      `expected an error log naming guild, user and the fetch cause, got ${JSON.stringify(logs)}`,
    );
  });

  it("C4: staff exempt when message.member is uncached but members.fetch succeeds", async () => {
    ensureHoneypotChannel();
    env.db.addStaffRole(env.communityId, IDS.roleExempt);
    const user = env.createUser({ id: "user-c4-staff", username: "staffc4" });
    const staffMember = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleExempt],
    });
    env.guild.addMember(staffMember); // resolvable via members.fetch
    const message = env.createMessage({
      guild: env.guild,
      channel: env.channels.honeypot,
      author: user,
      member: null,
      content: "testing the honeypot",
    });
    env.guild._bans.length = 0;
    const result = await handleHoneypotMessage(message);
    assert.equal(result, true);
    assertNotBanned(env.guild, user.id);
    assert.equal(message.deleted, true, "exempt message still deleted");
  });

  it("C4: non-exempt author with a healthy member fetch still bans", async () => {
    ensureHoneypotChannel();
    const user = env.createUser({ id: "user-c4-ban", username: "raider4" });
    const plainMember = env.createMember({ guild: env.guild, user });
    env.guild.addMember(plainMember);
    const message = env.createMessage({
      guild: env.guild,
      channel: env.channels.honeypot,
      author: user,
      member: null,
      content: "posted in the trap",
    });
    env.guild._bans.length = 0;
    const result = await handleHoneypotMessage(message);
    assert.equal(result, true);
    assertBanned(env.guild, user.id);
    assert.equal(message.deleted, true);
  });
});
