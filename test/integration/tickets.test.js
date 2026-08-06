const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Events } = require("discord.js");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertReplyContains,
  assertEphemeralReply,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");
const {
  createMember,
  createUser,
  createTextChannel,
} = require("../helpers/discord");

describe("integration: tickets", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  /** @type {import("discord.js").Client | object} */
  let clientWithEvents;

  before(async () => {
    env = await createIntegrationEnv();
    process.env.DATA_DIR = env.tmpDir;
    env.db.addStaffRole(env.guild.id, IDS.roleExempt, "senior");
    env.db.updateGuildSettings(env.guild.id, {
      ticket_archive_channel_id: IDS.channelLog,
      ticket_rate_limit_minutes: 60,
    });

    // Wire ticket ChannelDelete handler
    const ticketsFeature = require("../../src/features/tickets");
    ticketsFeature.registerEvents(env.client, env.ctx);
    clientWithEvents = env.client;
  });

  after(() => {
    // leave env as-is; process exit cleans temp dirs
  });

  /**
   * Open a ticket via staff /for (bypasses rate limit).
   * @param {object} [opts]
   * @param {object} [opts.user]
   * @param {string} [opts.reason]
   */
  async function openViaStaff(opts = {}) {
    const user = opts.user || env.users.memberUser;
    const reason = opts.reason || `ticket-${Date.now()}`;
    const res = await env.runCommand({
      commandName: "ticket",
      subcommand: "for",
      admin: true,
      options: { user, reason },
    });
    const text = env.lastReplyContent(res);
    assert.match(text, /opened|Ticket/i);
    const open = env.db.listOpenTickets(env.guild.id, {
      userId: user.id,
      limit: 10,
    });
    const ticket = open.find((t) => t.reason === reason) || open[0];
    assert.ok(ticket, "expected open ticket");
    return ticket;
  }

  it("/ticket settings is visible to members", async () => {
    const interaction = await env.runCommand({
      commandName: "ticket",
      subcommand: "settings",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(interaction);
    assertReplyContains(interaction, /Ticket settings/i);
    assertReplyContains(interaction, /rate limit/i);
  });

  it("/ticket for denies non-staff", async () => {
    const interaction = await env.runCommand({
      commandName: "ticket",
      subcommand: "for",
      admin: false,
      user: env.users.memberUser,
      options: { user: env.users.member2User, reason: "hi" },
    });
    assertEphemeralReply(interaction, /permission/i);
  });

  it("/ticket create + claim + info + list + close (soft) + archive", async () => {
    // Ensure member can self-create (reset rate limit window for this user)
    env.db.updateGuildSettings(env.guild.id, {
      ticket_rate_limit_minutes: 0,
    });

    const create = await env.runCommand({
      commandName: "ticket",
      subcommand: "create",
      admin: false,
      user: env.users.memberUser,
      options: { reason: "Cannot join voice" },
    });
    const createText = env.lastReplyContent(create);
    assert.match(createText, /Ticket\s*#?|#|opened/i);

    const open = env.db.listOpenTickets(env.guild.id, {
      userId: IDS.member,
      limit: 5,
    });
    const row = open.find((t) => t.reason === "Cannot join voice");
    assert.ok(row);
    assert.equal(row.status, "open");
    assert.equal(row.creator_user_id, IDS.member);
    assert.ok(row.channel_id);

    const ticketChannel = env.guild.channels.cache.get(row.channel_id);
    assert.ok(ticketChannel);
    assert.match(ticketChannel.name, /ticket-/);

    ticketChannel.addMessage({
      id: "user-msg-1",
      content: "I cannot hear anyone",
      author: {
        id: IDS.member,
        username: "member",
        tag: "member#0000",
      },
      createdTimestamp: Date.now() - 5000,
    });

    const claim = await env.runCommand({
      commandName: "ticket",
      subcommand: "claim",
      admin: true,
      channelId: row.channel_id,
    });
    assertEphemeralReply(claim);
    assertReplyContains(claim, /claimed/i);
    assert.equal(env.db.getTicketById(row.id).staff_owner_id, IDS.admin);

    const info = await env.runCommand({
      commandName: "ticket",
      subcommand: "info",
      admin: true,
      channelId: row.channel_id,
    });
    assertEphemeralReply(info);
    assertReplyContains(info, /Ticket|#/);
    assertReplyContains(info, /Cannot join voice|voice/i);

    const list = await env.runCommand({
      commandName: "ticket",
      subcommand: "list",
      admin: true,
    });
    assertEphemeralReply(list);
    assertReplyContains(list, /Open tickets|#/i);

    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: row.channel_id,
      options: { reason: "Restarted client" },
    });
    const closeText = env.lastReplyContent(close);
    assert.match(closeText, /closed/i);
    assert.match(closeText, /archive/i);

    const afterClose = env.db.getTicketById(row.id);
    assert.equal(afterClose.status, "closed");
    assert.equal(afterClose.archived, 0);
    assert.equal(afterClose.channel_id, row.channel_id); // channel kept
    assert.ok(env.guild.channels.cache.get(row.channel_id)); // not deleted

    // archive before close should fail — already closed path uses archive next
    const archive = await env.runCommand({
      commandName: "ticket",
      subcommand: "archive",
      admin: true,
      channelId: row.channel_id,
    });
    const archiveText = env.lastReplyContent(archive);
    assert.match(archiveText, /archived|transcript/i);

    const after = env.db.getTicketById(row.id);
    assert.equal(after.status, "closed");
    assert.equal(after.archived, 1);
    assert.ok(after.transcript_token);
    assert.ok(after.transcript_path);
    assert.equal(after.channel_id, null);
    assert.ok(env.db.listTicketMessages(row.id).length >= 1);
    assert.ok(env.channels.log.sent.length >= 1);

    // restore rate limit for later tests
    env.db.updateGuildSettings(env.guild.id, {
      ticket_rate_limit_minutes: 60,
    });
  });

  it("/ticket create rate limit after self-create", async () => {
    env.db.updateGuildSettings(env.guild.id, {
      ticket_rate_limit_minutes: 60,
    });
    // member2 may already have a self-create from a previous run — force by creating
    const c1 = await env.runCommand({
      commandName: "ticket",
      subcommand: "create",
      admin: false,
      user: env.users.member2User,
      options: { reason: "rate-limit-first" },
    });
    const t1 = env.lastReplyContent(c1);
    // either opened or already rate-limited from prior test data
    if (/opened|Ticket/i.test(t1)) {
      const c2 = await env.runCommand({
        commandName: "ticket",
        subcommand: "create",
        admin: false,
        user: env.users.member2User,
        options: { reason: "second too soon" },
      });
      assertEphemeralReply(c2);
      assertReplyContains(c2, /too quickly|rate limit|minute/i);
    } else {
      assert.match(t1, /too quickly|rate limit|minute/i);
    }
  });

  it("/ticket for adds staff opener as exclusive named owner + bypasses rate limit", async () => {
    env.db.updateGuildSettings(env.guild.id, { ticket_rate_limit_minutes: 60 });

    const ticket = await openViaStaff({
      user: env.users.memberUser,
      reason: "Staff pull-in sensitive",
    });
    const chId = ticket.channel_id;

    // Staff who opened on behalf of the member is claimed as staff owner
    // and listed as named staff (user overwrite access).
    const row = env.db.getTicketById(ticket.id);
    assert.equal(row.opened_by_staff_id, IDS.admin);
    assert.equal(row.staff_owner_id, IDS.admin);
    assert.ok(
      env.db.listTicketStaff(ticket.id).some(
        (s) => s.user_id === IDS.admin && s.is_owner === 1
      ),
      "opener must be named staff owner on the ticket"
    );

    const sens = await env.runCommand({
      commandName: "ticket",
      subcommand: "sensitive",
      admin: true,
      channelId: chId,
    });
    assertEphemeralReply(sens);
    assertReplyContains(sens, /sensitive/i);
    assert.equal(env.db.getTicketById(ticket.id).is_sensitive, 1);
    assert.ok(env.db.getTicketById(ticket.id).staff_owner_id);

    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: chId,
      options: { reason: "resolved privately" },
    });
    assert.match(env.lastReplyContent(close), /closed/i);

    const afterClose = env.db.getTicketById(ticket.id);
    assert.equal(afterClose.status, "closed");
    assert.equal(afterClose.archived, 0);
    assert.equal(afterClose.channel_id, chId);

    const logBefore = env.channels.log.sent.length;
    const archive = await env.runCommand({
      commandName: "ticket",
      subcommand: "archive",
      admin: true,
      channelId: chId,
    });
    assert.match(env.lastReplyContent(archive), /archived|sensitive/i);

    const after = env.db.getTicketById(ticket.id);
    assert.equal(after.status, "closed");
    assert.equal(after.archived, 0); // sensitive never content-archives
    assert.equal(after.transcript_token, null);
    assert.equal(after.channel_id, null);
    assert.equal(env.db.listTicketMessages(ticket.id).length, 0);
    assert.ok(env.channels.log.sent.length > logBefore); // stub post
  });

  it("/ticket adduser + removeuser + addstaff + removestaff + transfer", async () => {
    const ticket = await openViaStaff({
      user: env.users.memberUser,
      reason: "lifecycle people",
    });

    const addUser = await env.runCommand({
      commandName: "ticket",
      subcommand: "adduser",
      admin: true,
      channelId: ticket.channel_id,
      options: { user: env.users.member2User },
    });
    assertEphemeralReply(addUser);
    assertReplyContains(addUser, /Added|already/i);
    assert.ok(
      env.db
        .listTicketMembers(ticket.id)
        .some((m) => m.user_id === IDS.member2)
    );

    const removeUser = await env.runCommand({
      commandName: "ticket",
      subcommand: "removeuser",
      admin: true,
      channelId: ticket.channel_id,
      options: { user: env.users.member2User },
    });
    assertEphemeralReply(removeUser);
    assertReplyContains(removeUser, /Removed/i);
    assert.ok(
      !env.db
        .listTicketMembers(ticket.id)
        .some((m) => m.user_id === IDS.member2)
    );

    // cannot remove creator
    const removeCreator = await env.runCommand({
      commandName: "ticket",
      subcommand: "removeuser",
      admin: true,
      channelId: ticket.channel_id,
      options: { user: env.users.memberUser },
    });
    assertEphemeralReply(removeCreator);
    assertReplyContains(removeCreator, /creator/i);

    await env.runCommand({
      commandName: "ticket",
      subcommand: "claim",
      admin: true,
      channelId: ticket.channel_id,
    });

    const addStaff = await env.runCommand({
      commandName: "ticket",
      subcommand: "addstaff",
      admin: true,
      channelId: ticket.channel_id,
      options: { user: env.users.member2User },
    });
    assertEphemeralReply(addStaff);
    assert.ok(
      env.db.listTicketStaff(ticket.id).some((s) => s.user_id === IDS.member2)
    );

    const removeStaff = await env.runCommand({
      commandName: "ticket",
      subcommand: "removestaff",
      admin: true,
      channelId: ticket.channel_id,
      options: { user: env.users.member2User },
    });
    assertEphemeralReply(removeStaff);
    assertReplyContains(removeStaff, /Removed/i);

    // cannot remove owner without transfer
    const removeOwner = await env.runCommand({
      commandName: "ticket",
      subcommand: "removestaff",
      admin: true,
      channelId: ticket.channel_id,
      options: { user: env.users.adminUser },
    });
    assertEphemeralReply(removeOwner);
    assertReplyContains(removeOwner, /owner|Transfer/i);

    const transfer = await env.runCommand({
      commandName: "ticket",
      subcommand: "transfer",
      admin: true,
      channelId: ticket.channel_id,
      options: { staff: env.users.member2User },
    });
    assertEphemeralReply(transfer);
    assertReplyContains(transfer, /Transferred|transfer/i);
    assert.equal(
      env.db.getTicketById(ticket.id).staff_owner_id,
      IDS.member2
    );
  });

  it("/ticket sensitive denied for non-owner staff; unsensitive works", async () => {
    const ticket = await openViaStaff({
      user: env.users.memberUser,
      reason: "sensitive gate",
    });

    // Admin claims as owner
    await env.runCommand({
      commandName: "ticket",
      subcommand: "claim",
      admin: true,
      channelId: ticket.channel_id,
    });

    // Staff member with staff role but not ManageGuild, not owner
    const staffUser = createUser({ id: "user-staff-mod", username: "staffmod" });
    const staffMember = createMember({
      guild: env.guild,
      user: staffUser,
      admin: false,
      roleIds: [IDS.roleExempt],
    });
    env.guild.addMember(staffMember);

    const denied = await env.runCommand({
      commandName: "ticket",
      subcommand: "sensitive",
      admin: false,
      user: staffUser,
      member: staffMember,
      channelId: ticket.channel_id,
    });
    assertEphemeralReply(denied);
    assertReplyContains(denied, /owner|admin|permission|sensitive/i);

    // Admin can still mark sensitive
    const ok = await env.runCommand({
      commandName: "ticket",
      subcommand: "sensitive",
      admin: true,
      channelId: ticket.channel_id,
    });
    assertEphemeralReply(ok);
    assert.equal(env.db.getTicketById(ticket.id).is_sensitive, 1);

    const un = await env.runCommand({
      commandName: "ticket",
      subcommand: "unsensitive",
      admin: true,
      channelId: ticket.channel_id,
    });
    assertEphemeralReply(un);
    assertReplyContains(un, /no longer sensitive|sensitive/i);
    assert.equal(env.db.getTicketById(ticket.id).is_sensitive, 0);
  });

  it("lifecycle commands fail outside ticket channel", async () => {
    const claim = await env.runCommand({
      commandName: "ticket",
      subcommand: "claim",
      admin: true,
      channelId: IDS.channelGeneral,
    });
    assertEphemeralReply(claim);
    assertReplyContains(claim, /open ticket|ticket channel/i);

    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: IDS.channelGeneral,
    });
    assertEphemeralReply(close);
    assertReplyContains(close, /open ticket|ticket channel/i);

    const info = await env.runCommand({
      commandName: "ticket",
      subcommand: "info",
      admin: true,
      channelId: IDS.channelGeneral,
    });
    assertEphemeralReply(info);
    assertReplyContains(info, /ticket/i);
  });

  it("rejects bot targets on for / adduser", async () => {
    const forBot = await env.runCommand({
      commandName: "ticket",
      subcommand: "for",
      admin: true,
      options: { user: env.users.botUser, reason: "nope" },
    });
    assertEphemeralReply(forBot);
    assertReplyContains(forBot, /bot/i);

    const ticket = await openViaStaff({
      reason: "bot-add-test",
    });
    const addBot = await env.runCommand({
      commandName: "ticket",
      subcommand: "adduser",
      admin: true,
      channelId: ticket.channel_id,
      options: { user: env.users.botUser },
    });
    assertEphemeralReply(addBot);
    assertReplyContains(addBot, /bot/i);
  });

  it("/ticket setcategory / setarchive / setratelimit require admin", async () => {
    const denied = await env.runCommand({
      commandName: "ticket",
      subcommand: "setratelimit",
      admin: false,
      user: env.users.memberUser,
      options: { minutes: 30 },
    });
    assertEphemeralReply(denied, /permission/i);

    const ok = await env.runCommand({
      commandName: "ticket",
      subcommand: "setratelimit",
      admin: true,
      options: { minutes: 30 },
    });
    assertEphemeralReply(ok);
    assert.equal(
      env.db.getTicketSettings(env.guild.id).ticket_rate_limit_minutes,
      30
    );

    const cat = createTextChannel({
      id: "channel-ticket-cat",
      guild: env.guild,
      name: "Tickets",
      type: 4, // GuildCategory
    });
    env.guild.addChannel(cat);

    const setCat = await env.runCommand({
      commandName: "ticket",
      subcommand: "setcategory",
      admin: true,
      options: { category: cat },
    });
    assertEphemeralReply(setCat);
    assert.equal(
      env.db.getTicketSettings(env.guild.id).ticket_category_id,
      cat.id
    );

    const setArch = await env.runCommand({
      commandName: "ticket",
      subcommand: "setarchive",
      admin: true,
      options: { channel: env.channels.log },
    });
    assertEphemeralReply(setArch);
    assert.equal(
      env.db.getTicketSettings(env.guild.id).ticket_archive_channel_id,
      IDS.channelLog
    );

    // restore rate limit used by other tests
    env.db.updateGuildSettings(env.guild.id, {
      ticket_rate_limit_minutes: 60,
    });
  });

  it("allows /ticket lifecycle inside ticket channel when command channels restricted", async () => {
    const ticket = await openViaStaff({
      reason: "cmd-channel-exception",
    });

    env.db.addAllowedCommandChannel(env.guild.id, IDS.channelCmds);

    // XP blocked in general
    const xpBlocked = await env.runCommand({
      commandName: "xp",
      channelId: IDS.channelGeneral,
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(xpBlocked, /aren't enabled/);

    // ticket claim still works inside open ticket channel
    const claim = await env.runCommand({
      commandName: "ticket",
      subcommand: "claim",
      admin: true,
      channelId: ticket.channel_id,
    });
    assertEphemeralReply(claim);
    assertReplyContains(claim, /claimed/i);

    // ticket create outside allow-list is blocked
    const createBlocked = await env.runCommand({
      commandName: "ticket",
      subcommand: "create",
      admin: false,
      user: env.users.memberUser,
      channelId: IDS.channelGeneral,
      options: { reason: "should block" },
    });
    assertEphemeralReply(createBlocked, /aren't enabled/);

    // cleanup allow-list
    env.db.removeAllowedCommandChannel(env.guild.id, IDS.channelCmds);
  });

  it("ChannelDelete marks open ticket closed without archive", async () => {
    const ticket = await openViaStaff({
      reason: "external-delete",
    });
    const channel = env.guild.channels.cache.get(ticket.channel_id);
    assert.ok(channel);

    // Simulate Discord channel delete event
    env.client.emit(Events.ChannelDelete, channel);

    const after = env.db.getTicketById(ticket.id);
    assert.equal(after.status, "closed");
    assert.equal(after.archived, 0);
    assert.equal(after.channel_id, null);
    assert.match(after.close_reason || "", /deleted outside/i);
  });

  it("/ticket list can filter by user", async () => {
    await openViaStaff({
      user: env.users.memberUser,
      reason: "list-filter-a",
    });
    const list = await env.runCommand({
      commandName: "ticket",
      subcommand: "list",
      admin: true,
      options: { user: env.users.memberUser },
    });
    assertEphemeralReply(list);
    // either open tickets for user or empty if all closed — should not error
    const content = env.lastReplyContent(list);
    assert.ok(
      /Open tickets|No open tickets/i.test(content),
      `unexpected list reply: ${content}`
    );
  });

  it("close without archive channel still soft-closes; archive still works", async () => {
    const ticket = await openViaStaff({
      reason: "no-archive-channel",
    });
    env.db.updateGuildSettings(env.guild.id, {
      ticket_archive_channel_id: null,
    });

    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: ticket.channel_id,
      options: { reason: "done anyway" },
    });
    const text = env.lastReplyContent(close);
    assert.match(text, /closed/i);

    const afterClose = env.db.getTicketById(ticket.id);
    assert.equal(afterClose.status, "closed");
    assert.equal(afterClose.channel_id, ticket.channel_id);

    const archive = await env.runCommand({
      commandName: "ticket",
      subcommand: "archive",
      admin: true,
      channelId: ticket.channel_id,
    });
    const archText = env.lastReplyContent(archive);
    assert.match(archText, /archived|Warnings|transcript/i);

    const after = env.db.getTicketById(ticket.id);
    assert.equal(after.status, "closed");
    assert.equal(after.channel_id, null);

    // restore archive channel
    env.db.updateGuildSettings(env.guild.id, {
      ticket_archive_channel_id: IDS.channelLog,
    });
  });

  it("/ticket archive requires close first", async () => {
    const ticket = await openViaStaff({
      reason: "archive-before-close",
    });
    const archive = await env.runCommand({
      commandName: "ticket",
      subcommand: "archive",
      admin: true,
      channelId: ticket.channel_id,
    });
    assertEphemeralReply(archive);
    assertReplyContains(archive, /close/i);
    assert.equal(env.db.getTicketById(ticket.id).status, "open");
  });
});
