/**
 * Tests for the "Open ticket for user" USER context menu (#794) — the staff
 * proxy-ticket Apps-menu twin of `/ticket for` (handleOpenForUserMenu in
 * src/features/tickets/create.js).
 *
 * House style follows test/integration/tickets.test.js: the full router stack
 * over createIntegrationEnv (temp SQLite, real requireStaff gating, real
 * openTicketChannel against the mock Discord graph). The harness runCommand
 * only speaks chat-input, so this file owns a local user-context-menu
 * interaction mock (same shape as ticket-reports-invoke.test.js, extended
 * with the defer/editReply pair) and drives it through env.handleInteraction.
 *
 * Covers (acceptance): staff happy path (ticket row: creator = target,
 * opened_by_staff_id = invoker; ticket channel; DM with the open notice; the
 * same success copy as the slash arm); self-target stays allowed exactly
 * like /ticket for; junior staff_roles leg of the gate (no ManageGuild);
 * non-staff denial with nothing opened; bot refusal; unresolvable member;
 * DM-refused partial-failure note; handler throw → ids logged + generic
 * error reply (never a spinner).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { MessageFlags } = require("discord.js");
const { createIntegrationEnv } = require("../helpers/harness");
const { createUser, createMember } = require("../helpers/discord");
const { IDS } = require("../helpers/fixtures");

const MENU = "Open ticket for user";

describe("integration: ticket Open-ticket-for-user context menu (#794)", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  before(async () => {
    env = await createIntegrationEnv();
    env.db.updateGuildSettings(env.communityId, {
      ticket_archive_channel_id: IDS.channelLog,
    });
  });

  after(() => env?.cleanup());

  /**
   * User-context-menu interaction mock driving the REAL router (env.ctx).
   * `resolved` records the option names the handler asks the resolver for —
   * pinned to the lowercase literal "user" discord.js' targetUser getter
   * passes (verified in node_modules, same contract as the #745 arms).
   *
   * @param {object} opts
   * @param {object} opts.user invoker
   * @param {object} opts.member invoker member
   * @param {object|null} [opts.targetUser] resolved menu target
   * @param {boolean} [opts.admin] ManageGuild picker bit
   * @param {boolean} [opts.throwOnResolve] resolver explosion injection
   */
  function createOpenForMenuInteraction(opts) {
    const replies = [];
    const resolved = [];
    let admin = opts.admin === true;

    const memberPermissions = {
      has: (flag) => {
        if (admin) return true;
        if (opts.member?.permissions) return opts.member.permissions.has(flag);
        return false;
      },
    };

    const interaction = {
      commandName: MENU,
      guild: env.guild,
      guildId: env.guildId,
      channelId: IDS.channelGeneral,
      client: env.client,
      user: opts.user,
      member: opts.member,
      memberPermissions,
      replied: false,
      deferred: false,
      deferOptions: null,
      replies,
      resolved,
      isChatInputCommand: () => false,
      isAutocomplete: () => false,
      isModalSubmit: () => false,
      isButton: () => false,
      isMessageContextMenuCommand: () => false,
      isUserContextMenuCommand: () => true,
      options: {
        getUser: (name) => {
          resolved.push(name);
          if (opts.throwOnResolve) throw new Error("resolver exploded");
          return opts.targetUser ?? null;
        },
      },
      reply: async (payload) => {
        if (interaction.replied || interaction.deferred) {
          const err = new Error("InteractionAlreadyReplied");
          err.code = "InteractionAlreadyReplied";
          throw err;
        }
        interaction.replied = true;
        replies.push(payload);
        return payload;
      },
      followUp: async (payload) => {
        replies.push(payload);
        return payload;
      },
      deferReply: async (payload) => {
        interaction.deferOptions = payload ?? null;
        interaction.deferred = true;
      },
      editReply: async (payload) => {
        if (!interaction.replied && !interaction.deferred) {
          const err = new Error("DiscordAPIError[40060]: not acknowledged");
          err.code = 40060;
          throw err;
        }
        replies.push({ ...payload, _edited: true });
        return payload;
      },
    };
    return interaction;
  }

  /** Register a fresh human member (users cache + guild member) to target. */
  function addHuman(tag) {
    const user = createUser({ id: `openfor-${tag}` });
    const member = createMember({ guild: env.guild, user, admin: false });
    env.guild.addMember(member);
    env.client.users.addUser(user);
    return { user, member };
  }

  /** The newest open ticket row for a user id. */
  function newestOpenTicket(userId) {
    const rows = env.db.listOpenTickets(env.communityId, { userId, limit: 10 });
    return rows.find((t) => t.creator_user_id === userId) ?? null;
  }

  async function invokeOpenFor(interaction) {
    await env.handleInteraction(interaction, env.ctx);
    return interaction;
  }

  it("staff invoke opens the proxy ticket: row, overwrites channel, DM, reply copy", async () => {
    const target = addHuman("target-1");

    const interaction = createOpenForMenuInteraction({
      user: env.users.adminUser,
      member: env.members.adminMember,
      targetUser: target.user,
      admin: true,
    });
    await invokeOpenFor(interaction);

    // Target option resolved through the lowercase literal discord.js uses.
    assert.deepEqual(interaction.resolved, ["user"]);
    // Deferred EPHEMERALLY (staff-facing confirmation).
    assert.equal(interaction.deferred, true);
    assert.equal(interaction.deferOptions?.flags, MessageFlags.Ephemeral);

    // Ticket row: requester = TARGET, opener = invoking staff.
    const ticket = newestOpenTicket(target.user.id);
    assert.ok(ticket, "expected an open ticket for the target");
    assert.equal(ticket.creator_user_id, target.user.id);
    assert.equal(ticket.opened_by_staff_id, env.users.adminUser.id);

    // Real ticket channel created on the mock graph.
    const ticketChannel = env.guild.channels.cache.get(ticket.channel_id);
    assert.ok(ticketChannel, "ticket channel exists");
    assert.match(ticketChannel.name, /^ticket-/);

    // Same success copy shape as the slash arm.
    const edited = interaction.replies.at(-1);
    assert.ok(edited?._edited, "confirmation rides the deferred editReply");
    assert.match(
      edited.content,
      new RegExp(`opened for <@${target.user.id}>`),
    );

    // Target got the open-notice DM.
    assert.equal(target.user.sends.length, 1, "target DMed once");
    assert.match(target.user.sends[0].content, /opened for you in \*\*/i);
  });

  it("self-target stays allowed exactly like /ticket for", async () => {
    const interaction = createOpenForMenuInteraction({
      user: env.users.adminUser,
      member: env.members.adminMember,
      targetUser: env.users.adminUser,
      admin: true,
    });
    await invokeOpenFor(interaction);

    const ticket = newestOpenTicket(env.users.adminUser.id);
    assert.ok(ticket, "staff may open a proxy ticket for themselves");
    assert.equal(ticket.opened_by_staff_id, env.users.adminUser.id);
  });

  it("junior staff_roles leg of the gate (no ManageGuild) is served", async () => {
    env.db.addStaffRole(env.communityId, IDS.roleExempt, "junior");
    const juniorUser = createUser({ id: "openfor-junior" });
    const juniorMember = createMember({
      guild: env.guild,
      user: juniorUser,
      roleIds: [IDS.roleExempt],
    });
    env.guild.addMember(juniorMember);
    const target = addHuman("target-junior");

    const interaction = createOpenForMenuInteraction({
      user: juniorUser,
      member: juniorMember,
      targetUser: target.user,
      admin: false, // no ManageGuild bits — staff_roles row carries the gate
    });
    await invokeOpenFor(interaction);

    const ticket = newestOpenTicket(target.user.id);
    assert.ok(ticket, "junior staff_roles passes the handler gate");
    assert.equal(ticket.opened_by_staff_id, juniorUser.id);
    assert.equal(
      ticket.creator_user_id,
      target.user.id,
      "no self-create slot, no DM back to the invoker — the target is the requester",
    );
  });

  it("non-staff invoke is denied ephemerally and opens nothing", async () => {
    const target = addHuman("target-denied");

    const interaction = createOpenForMenuInteraction({
      user: env.users.memberUser,
      member: env.members.member,
      targetUser: target.user,
      admin: false,
    });
    await invokeOpenFor(interaction);

    assert.equal(interaction.deferred, false, "gate refuses BEFORE the defer");
    const denial = interaction.replies.at(-1);
    assert.ok(denial, "denial reply sent");
    assert.match(env.lastReplyContent(interaction), /permission/i);
    assert.equal(env.lastReplyEphemeral(interaction), true);

    assert.equal(newestOpenTicket(target.user.id), null, "nothing opened");
    assert.equal(target.user.sends.length, 0, "no DM either");
  });

  it("refuses a bot target before anything opens", async () => {
    const interaction = createOpenForMenuInteraction({
      user: env.users.adminUser,
      member: env.members.adminMember,
      targetUser: env.users.botUser,
      admin: true,
    });
    await invokeOpenFor(interaction);

    assert.match(env.lastReplyContent(interaction), /Cannot open a ticket for a bot\./);
    assert.equal(interaction.deferred, false);
  });

  it("unresolvable member gets the specific cause, nothing opens", async () => {
    const interaction = createOpenForMenuInteraction({
      user: env.users.adminUser,
      member: env.members.adminMember,
      targetUser: null,
      admin: true,
    });
    await invokeOpenFor(interaction);

    assert.match(
      env.lastReplyContent(interaction),
      /Could not resolve the member .* Nothing was opened\./,
    );
    assert.equal(interaction.deferred, false);
  });

  it("refused DM keeps the ticket open and surfaces the cause (#5 partial failure)", async () => {
    const target = addHuman("target-nodm");
    target.user.dmsClosed = true;

    const interaction = createOpenForMenuInteraction({
      user: env.users.adminUser,
      member: env.members.adminMember,
      targetUser: target.user,
      admin: true,
    });
    await invokeOpenFor(interaction);

    const ticket = newestOpenTicket(target.user.id);
    assert.ok(ticket, "DM failure never undoes the opened ticket");

    const edited = interaction.replies.at(-1);
    assert.match(edited.content, /opened for/i);
    // The DM-cause copy lands BETWEEN the underscores:
    // "_Could not DM the member: <cause>_"
    assert.match(
      edited.content,
      /_Could not DM the member: .*Cannot send messages to this user/,
      "partial failure surfaced in the staff reply",
    );
  });

  it("resolver throw is logged with ids and answered (rule 1/2, no spinner)", async () => {
    const { MSG_GENERIC_ERROR } = require("../../src/core/theme");
    const original = console.error;
    const lines = [];
    console.error = (...args) => lines.push(args.map(String).join(" "));
    let interaction;
    try {
      interaction = createOpenForMenuInteraction({
        user: env.users.adminUser,
        member: env.members.adminMember,
        targetUser: env.users.member2User,
        admin: true,
        throwOnResolve: true,
      });
      await invokeOpenFor(interaction);
    } finally {
      console.error = original;
    }

    const logged = lines.filter((l) => l.includes("[tickets] open-for menu failed:"));
    assert.equal(logged.length, 1, "handler logged the ids + cause once");
    assert.match(logged[0], /guild=/);
    assert.match(logged[0], /resolver exploded/);

    // The invoker is ANSWERED — never a dead spinner. The resolver throw is
    // not a translatable cause, so the sanctioned router-last-resort generic
    // (rule 4) is the correct copy here.
    assert.equal(env.lastReplyContent(interaction), MSG_GENERIC_ERROR);
    assert.equal(env.lastReplyEphemeral(interaction), true);
  });
});
