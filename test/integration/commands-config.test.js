const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertEphemeralReply,
  assertReplyContains,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: config commands", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  after(() => {
    // Close SQLite handles and remove the temp dir created for this env.
    env?.cleanup();
  });

  before(async () => {
    env = await createIntegrationEnv();
  });

  it("/setcommandchannel add/list/remove", async () => {
    const ch = env.channels.cmds;
    let interaction = await env.runCommand({
      commandName: "setcommandchannel",
      subcommand: "add",
      admin: true,
      options: { channel: ch },
    });
    assertReplyContains(interaction, "allowed");
    const rows = env.db.listAllowedCommandChannels(env.communityId);
    assert.ok(rows.some((r) => r.channel_id === ch.id));

    interaction = await env.runCommand({
      commandName: "setcommandchannel",
      subcommand: "list",
      admin: true,
    });
    assertReplyContains(interaction, ch.id);

    interaction = await env.runCommand({
      commandName: "setcommandchannel",
      subcommand: "remove",
      admin: true,
      options: { channel: ch },
    });
    assertReplyContains(interaction, "Removed");
    assert.equal(env.db.listAllowedCommandChannels(env.communityId).length, 0);
  });

  it("/setdecay updates settings and scales percent", async () => {
    const interaction = await env.runCommand({
      commandName: "setdecay",
      admin: true,
      options: {
        enabled: true,
        messages: 5,
        days: 7,
        percent: 10,
      },
    });
    assertReplyContains(interaction, /Updated decay|decay settings/i);
    const s = env.db.getGuildSettings(env.communityId);
    assert.equal(s.decay_enabled, 1);
    assert.equal(s.decay_min_messages, 5);
    assert.equal(s.decay_window_days, 7);
    assert.ok(Math.abs(s.decay_percent - 0.1) < 1e-9);
  });

  it("/leveltorole set/list/remove", async () => {
    const role = { id: IDS.roleLevel5, toString: () => `<@&${IDS.roleLevel5}>` };
    let interaction = await env.runCommand({
      commandName: "leveltorole",
      subcommand: "set",
      admin: true,
      options: { role, level: 3, dropdays: 2 },
    });
    assertReplyContains(interaction, "Mapped");
    let rows = env.db.listLevelRoles(env.communityId);
    assert.ok(rows.some((r) => r.role_id === IDS.roleLevel5 && r.level_required === 3));

    interaction = await env.runCommand({
      commandName: "leveltorole",
      subcommand: "list",
      admin: true,
    });
    assertReplyContains(interaction, "Lvl 3");

    interaction = await env.runCommand({
      commandName: "leveltorole",
      subcommand: "remove",
      admin: true,
      options: { role },
    });
    assertReplyContains(interaction, "Removed mapping");
    rows = env.db.listLevelRoles(env.communityId);
    assert.ok(!rows.some((r) => r.role_id === IDS.roleLevel5));
  });

  it("/setlog audit/message/show", async () => {
    let interaction = await env.runCommand({
      commandName: "setlog",
      subcommand: "audit",
      admin: true,
      options: { channel: env.channels.log },
    });
    assertReplyContains(interaction, /audit|log/i);
    assert.equal(
      env.db.getGuildSettings(env.communityId).audit_log_channel_id,
      IDS.channelLog
    );

    interaction = await env.runCommand({
      commandName: "setlog",
      subcommand: "message",
      admin: true,
      options: { channel: env.channels.log },
    });
    assert.equal(
      env.db.getGuildSettings(env.communityId).message_log_channel_id,
      IDS.channelLog
    );

    interaction = await env.runCommand({
      commandName: "setlog",
      subcommand: "show",
      admin: true,
    });
    assertReplyContains(interaction, IDS.channelLog);
  });

  // ── #445 (audit INT-10): /setlog must VERIFY the stream delivers ─────────
  // The old code checked only VISIBILITY, then LIED ("Audit will be sent
  // to <#…>") while an undeliverable stream (no Send Messages, category,
  // race-deleted) died silently forever.

  it("/setlog refuses + rolls back when the channel cannot receive (#445)", async () => {
    const before = env.db.getGuildSettings(env.communityId).audit_log_channel_id;
    assert.equal(before, IDS.channelLog, "baseline from the previous /setlog test");
    const broken = env.channels.notify;
    const originalSend = broken.send;
    broken.send = async () => {
      const err = new Error("Missing Permissions");
      err.code = 50013;
      throw err;
    };
    try {
      const interaction = await env.runCommand({
        commandName: "setlog",
        subcommand: "audit",
        admin: true,
        options: { channel: broken },
      });
      assertReplyContains(interaction, /can't post|not changed/i);
      assertReplyContains(
        interaction,
        /Missing Permissions|Send Messages/,
        "the reply carries the SPECIFIC cause, never a dead end",
      );
      assert.equal(
        env.db.getGuildSettings(env.communityId).audit_log_channel_id,
        before,
        "the undeliverable channel was NOT persisted (RED: old code persisted + lied)",
      );
    } finally {
      broken.send = originalSend;
    }
  });

  it("/setlog rejects a non-text channel with the specific cause (#445)", async () => {
    const before = env.db.getGuildSettings(env.communityId).message_log_channel_id;
    const fakeCategory = env.channels.honeypot;
    const original = fakeCategory.isTextBased;
    fakeCategory.isTextBased = () => false;
    try {
      const interaction = await env.runCommand({
        commandName: "setlog",
        subcommand: "message",
        admin: true,
        options: { channel: fakeCategory },
      });
      assertReplyContains(interaction, /not text-based/, "cause names the real defect");
      assert.equal(
        env.db.getGuildSettings(env.communityId).message_log_channel_id,
        before,
        "setting rolled back (RED: old code persisted it)",
      );
    } finally {
      fakeCategory.isTextBased = original;
    }
  });

  it("undeliverable log streams log their cause instead of dying silent (#445)", async () => {
    env.db.updateGuildSettings(env.communityId, {
      audit_log_channel_id: IDS.channelLog,
    });
    const auditLog = require("../../src/features/logs/auditLog");
    const { getDiscordOutbound } = require("../../src/platform/discord/outbound");
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(" "));
    try {
      // Wrong-shape outbound (raw client — the exact reactionRoles
      // logConfigChange(message.client, …) class): used to be a COMPLETE
      // no-op with zero log lines.
      const r1 = await auditLog.sendAuditLog({ user: {} }, env.communityId, {
        content: "x",
      });
      assert.equal(r1, false, "boolean contract kept for existing consumers");
      assert.ok(
        warns.some((w) => /not an OutboundClient/.test(w)),
        `raw-client no-op must be VISIBLE in the log (got: ${JSON.stringify(warns)})`,
      );

      // Healthy path now hands back a delivery receipt (RED on old: undefined).
      const receipt = await auditLog.logConfigChange(
        getDiscordOutbound(env.client),
        env.communityId,
        {
          title: "T",
          command: "/t",
          actor: env.users.adminUser,
          changes: ["a → b"],
        },
      );
      assert.equal(receipt.ok, true, "delivery receipt on success");
    } finally {
      console.warn = origWarn;
    }
  });

  it("config commands deny non-staff", async () => {
    for (const commandName of [
      "setcommandchannel",
      "setdecay",
      "leveltorole",
      "setlog",
    ]) {
      const interaction = await env.runCommand({
        commandName,
        subcommand: commandName === "setlog" ? "show" : commandName === "setcommandchannel" ? "list" : commandName === "leveltorole" ? "list" : undefined,
        admin: false,
        user: env.users.memberUser,
        options: commandName === "setdecay" ? { enabled: true } : {},
      });
      assertEphemeralReply(interaction, /permission|administrators/i);
    }
  });

  it("staff can use setdecay but not setcommandchannel", async () => {
    env.db.addStaffRole(env.communityId, IDS.roleExempt, "junior");
    const staffMember = env.createMember({
      guild: env.guild,
      user: env.users.memberUser,
      admin: false,
      roleIds: [IDS.roleExempt],
    });
    env.guild.addMember(staffMember);

    const decay = await env.runCommand({
      commandName: "setdecay",
      admin: false,
      user: env.users.memberUser,
      member: staffMember,
      options: { enabled: true },
    });
    assertEphemeralReply(decay);
    assertReplyContains(decay, /Decay|enabled|updated/i);

    const setcmd = await env.runCommand({
      commandName: "setcommandchannel",
      subcommand: "list",
      admin: false,
      user: env.users.memberUser,
      member: staffMember,
    });
    assertEphemeralReply(setcmd, /administrators|permission/i);
  });

  // ── #446 (audit INT-11): staff list surfaces never die on size ──────────

  it("/settings embed caps the channel field at 1024 on channel floods", async () => {
    // Fresh start, then a flood that INCLUDES the running channel (the
    // allow-list gate applies to /settings itself — admins only have an
    // override for /setcommandchannel).
    for (const row of env.db.listAllowedCommandChannels(env.communityId)) {
      env.db.removeAllowedCommandChannel(env.communityId, row.channel_id);
    }
    const ids = Array.from({ length: 80 }, (_, i) => `chan-446-s-${i}`);
    ids.push(IDS.channelGeneral);
    for (const id of ids) env.db.addAllowedCommandChannel(env.communityId, id);
    try {
      const interaction = await env.runCommand({
        commandName: "settings",
        admin: true,
      });
      const reply = interaction.replies[interaction.replies.length - 1];
      const rawEmbed = reply?.embeds?.[0];
      assert.ok(rawEmbed, "/settings replies with an embed");
      const embedData =
        typeof rawEmbed.toJSON === "function"
          ? rawEmbed.toJSON()
          : rawEmbed.data || rawEmbed;
      const field = (embedData.fields || []).find(
        (f) => f.name === "Commands allowed in",
      );
      assert.ok(field, "channel field present");
      // RED on old code: 80 mentions ≈ 1.6 KB — Discord rejects the whole
      // embed with "Invalid Form Body" (the router's generic dead-end).
      assert.ok(field.value.length <= 1024, `field value ${field.value.length} chars`);
      assert.match(field.value, /\(\+\d+ more\)$/, "hidden count stays honest");
    } finally {
      for (const id of ids) env.db.removeAllowedCommandChannel(env.communityId, id);
    }
  });

  it("/setcommandchannel list caps a channel flood under 2000 chars", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `chan-446-l-${i}`);
    for (const id of ids) env.db.addAllowedCommandChannel(env.communityId, id);
    try {
      const interaction = await env.runCommand({
        commandName: "setcommandchannel",
        subcommand: "list",
        admin: true,
      });
      const reply = interaction.replies[interaction.replies.length - 1];
      const content = typeof reply === "string" ? reply : reply?.content || "";
      assert.ok(content.length <= 2000, `content ${content.length} chars`);
      assert.match(content, /\(\+\d+ more\)$/, "hidden count stays honest");
      assert.match(content, /^• <#chan-446-l-0>/m, "first entries shown");
    } finally {
      for (const id of ids) env.db.removeAllowedCommandChannel(env.communityId, id);
    }
  });
});
