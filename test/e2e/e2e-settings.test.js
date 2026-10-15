const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { namespaceIds } = require("./helpers/mockenv");

const MSG_DENIED = "You don't have permission to use this.";
const MSG_GENERIC_ERROR =
  "Something went wrong handling that command (check bot logs).";

/**
 * Tier-4 settings / command-channels / command-permissions coverage
 * (issue #315). Namespace 6.
 *
 * Already covered elsewhere (not repeated here):
 *  - ns3 e2e-gates: empty allow-list → open, allow-list deny outside /
 *    allow inside, /grantxp junior-staff denial + ManageGuild arc.
 * This file: the /setcommandchannel surface itself (add/list/remove via
 * CHANNEL options — resolved by the vendored patch), the admin lockout
 * exemption, gate-before-permission ordering, /settings staff view,
 * the /staff syncpermissions dark path, and register PUT fidelity
 * (tier defaultMemberPermissions persisted on the mock).
 */
describe(
  "e2e: settings, command channels & permission surfaces",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;

    const ids = namespaceIds(6);

    before(async () => {
      env = await createE2eEnv({
        ns: 6,
        channels: [
          { id: ids.general, name: "general" },
          { id: ids.channel2, name: "e2e-two" },
        ],
      });
      // human carries ManageGuild (admin path); outsider has nothing.
      const adminRole = await env.mock.createRole("E2ESetupAdmin", {
        permissions: String(PermissionFlagsBits.ManageGuild),
      });
      await env.mock.grantRole(env.ids.human, adminRole.id);
    });

    after(async () => {
      await env?.cleanup();
    });

    const chanSub = (name, channelId = env.ids.channel2) => ({
      name,
      type: 1,
      options: [{ name: "channel", type: 7, value: channelId }],
    });
    const allowed = () =>
      env.dbmod
        .listAllowedCommandChannels(env.communityId)
        .map((r) => r.channel_id);
    const auditRow = (action) =>
      env.dbmod.db
        .prepare(
          "SELECT * FROM admin_audit WHERE community_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
        )
        .get(env.communityId, action);

    it("/setcommandchannel add persists the allow-list, echoes and flips the gate", async () => {
      const inter = await env.mock.slash({
        command: "setcommandchannel",
        options: [chanSub("add")],
      });
      const reply = await env.mock.awaitReply(inter);
      assert.equal(
        String(reply.content),
        `Commands are now allowed in <#${env.ids.channel2}>.`,
      );
      assert.ok(allowed().includes(env.ids.channel2), "allow-list row stored");

      const audit = auditRow("command_channels.add");
      assert.ok(audit, "command_channels.add audit row");
      assert.equal(audit.actor_user_id, env.ids.human);
      assert.equal(audit.target_id, env.ids.channel2);

      // Gate flips: outsider denied outside the allow-list…
      const denied = await env.mock.slash({
        command: "xp",
        userId: env.ids.outsider,
        channelId: env.ids.general,
      });
      assert.equal(
        String((await env.mock.awaitReply(denied)).content),
        "Commands aren't enabled in this channel.",
      );
      // …and served inside it (public command, non-staff member).
      const inside = await env.mock.slash({
        command: "xp",
        userId: env.ids.outsider,
        channelId: env.ids.channel2,
      });
      assert.match(
        String((await env.mock.awaitReply(inside)).content),
        /E2EOutsider/,
      );
    });

    it("channel gate runs BEFORE the command's own permission gate", async () => {
      // Outsider invokes the admin-only /setcommandchannel from OUTSIDE the
      // allow-list: the channel gate must fire first (they get the channel
      // copy, never the admin copy).
      const inter = await env.mock.slash({
        command: "setcommandchannel",
        options: [chanSub("add")],
        userId: env.ids.outsider,
        channelId: env.ids.general,
      });
      assert.equal(
        String((await env.mock.awaitReply(inter)).content),
        "Commands aren't enabled in this channel.",
      );
    });

    it("/setcommandchannel denies a non-admin inside the allow-list with the exact copy", async () => {
      // Same user passes the channel gate here (channel2) — now the
      // command's own ManageGuild gate answers.
      const inter = await env.mock.slash({
        command: "setcommandchannel",
        options: [chanSub("add")],
        userId: env.ids.outsider,
        channelId: env.ids.channel2,
      });
      assert.equal(
        String((await env.mock.awaitReply(inter)).content),
        "Only server administrators can configure command channels.",
      );
      assert.deepEqual(allowed(), [env.ids.channel2], "still one entry");
    });

    it("admins keep lockout-proof access to /setcommandchannel from gated channels", async () => {
      // commandsAllowedFromIds exception: /setcommandchannel itself stays
      // available to admins anywhere so a bad allow-list can be repaired.
      const inter = await env.mock.slash({
        command: "setcommandchannel",
        options: [{ name: "list", type: 1 }],
        userId: env.ids.human,
        channelId: env.ids.general, // outside the allow-list on purpose
      });
      const content = String((await env.mock.awaitReply(inter)).content);
      assert.match(content, /Allowed command channels/i);
      assert.match(content, new RegExp(env.ids.channel2), "entry listed");
    });

    it("an unresolvable CHANNEL option fails loudly without persisting anything", async () => {
      // Real Discord pickers only yield resolvable ids; a hand-built
      // interaction with an unknown id throws inside discord.js option
      // reads, and the router's last-resort reply answers it. Locks the
      // never-silent-drop contract, not the specific copy choice.
      const inter = await env.mock.slash({
        command: "setcommandchannel",
        options: [chanSub("add", env.ids.ghost)],
      });
      const reply = await env.mock.awaitReply(inter);
      assert.equal(String(reply.content), MSG_GENERIC_ERROR);
      assert.deepEqual(
        allowed(),
        [env.ids.channel2],
        "no phantom channel entered the allow-list",
      );
      assert.notEqual(
        auditRow("command_channels.add").target_id,
        env.ids.ghost,
        "the failed add left no audit entry either",
      );
    });

    it("/setcommandchannel remove restores the open state and audits", async () => {
      const inter = await env.mock.slash({
        command: "setcommandchannel",
        options: [chanSub("remove")],
      });
      assert.equal(
        String((await env.mock.awaitReply(inter)).content),
        `Removed <#${env.ids.channel2}> from allowed command channels.`,
      );
      assert.deepEqual(allowed(), [], "allow-list emptied");
      const audit = auditRow("command_channels.remove");
      assert.ok(audit, "command_channels.remove audit row");
      assert.equal(audit.target_id, env.ids.channel2);

      // Open again for everyone, general included.
      const open = await env.mock.slash({
        command: "xp",
        userId: env.ids.outsider,
        channelId: env.ids.general,
      });
      assert.match(
        String((await env.mock.awaitReply(open)).content),
        /E2EOutsider/,
      );
    });

    it("/settings renders the live staff view; non-staff are denied", async () => {
      const settings = env.dbmod.getGuildSettings(env.communityId);
      const inter = await env.mock.slash({ command: "settings" });
      const reply = await env.mock.awaitReply(inter);
      const embed = reply.embeds?.[0];
      assert.ok(embed, "/settings replies with an embed");
      assert.equal(embed.title, "Boiler Snake Settings");
      const field = (name) =>
        (embed.fields ?? []).find((f) => f.name === name)?.value;
      assert.equal(
        field("XP awards"),
        `Message **${settings.msg_xp}** · Reaction **${settings.reaction_xp}** · Voice/min **${settings.voice_xp_per_min}**`,
      );
      assert.equal(
        field("Commands allowed in"),
        "All channels (no restriction set)",
      );

      const denied = await env.mock.slash({
        command: "settings",
        userId: env.ids.outsider,
      });
      assert.equal(
        String((await env.mock.awaitReply(denied)).content),
        MSG_DENIED,
      );
    });

    it("/staff syncpermissions without OAuth config answers operator guidance (dark path)", async () => {
      const inter = await env.mock.slash({
        command: "staff",
        options: [{ name: "syncpermissions", type: 1 }],
      });
      const content = String((await env.mock.awaitReply(inter)).content);
      assert.match(content, /Command visibility sync is not configured/i);
      assert.match(content, /CLIENT_SECRET/, "missing env named for operators");
      assert.match(content, /Handlers still enforce staff permissions/);

      const denied = await env.mock.slash({
        command: "staff",
        options: [{ name: "syncpermissions", type: 1 }],
        userId: env.ids.outsider,
      });
      assert.equal(
        String((await env.mock.awaitReply(denied)).content),
        "Only server administrators (Manage Server) can sync command visibility.",
      );
    });

    it("registered guild commands carry tier defaultMemberPermissions (PUT fidelity)", async () => {
      const cmds = await env.mock.listGuildCommands();
      const byName = new Map(cmds.map((c) => [c.name, c]));
      const manageGuild = String(PermissionFlagsBits.ManageGuild);

      for (const tiered of ["setxp", "settings", "setcommandchannel", "staff"]) {
        assert.equal(
          byName.get(tiered)?.default_member_permissions,
          manageGuild,
          `${tiered}: staff/admin tier → ManageGuild picker gate`,
        );
      }
      for (const pub of ["xp", "leaderboard"]) {
        assert.ok(
          byName.get(pub),
          `${pub} registered`,
        );
        assert.equal(
          byName.get(pub).default_member_permissions ?? null,
          null,
          `${pub}: public tier → no picker gate`,
        );
      }
    });
  },
);
