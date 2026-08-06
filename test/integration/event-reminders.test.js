const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { GuildScheduledEventStatus } = require("discord.js");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  createScheduledEvent,
  createModalSubmitInteraction,
  lastReplyContent,
} = require("../helpers/discord");
const { assertReplyContains, assertEphemeralReply } = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: event reminders", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let runEventReminderTick;

  before(async () => {
    env = await createIntegrationEnv();
    runEventReminderTick =
      require("../../src/features/eventReminders/ticker").runEventReminderTick;
  });

  it("migration created event reminder tables", () => {
    const tables = env.db.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'event_reminder%'`
      )
      .all()
      .map((r) => r.name)
      .sort();
    assert.deepEqual(tables, [
      "event_reminder_configs",
      "event_reminder_event_optouts",
      "event_reminder_offsets",
      "event_reminder_optouts",
    ]);
    const cols = env.db.db
      .prepare(`PRAGMA table_info(guild_settings)`)
      .all()
      .map((c) => c.name);
    assert.ok(cols.includes("event_reminder_channel_id"));
  });

  it("/eventreminder setchannel sets guild default", async () => {
    const interaction = await env.runCommand({
      commandName: "eventreminder",
      subcommand: "setchannel",
      admin: true,
      options: { channel: env.channels.notify },
    });
    assertEphemeralReply(interaction);
    assertReplyContains(interaction, /default/i);
    assert.equal(
      env.db.getGuildSettings(env.guild.id).event_reminder_channel_id,
      IDS.channelNotify
    );
  });

  it("/eventreminder optout and status", async () => {
    const out = await env.runCommand({
      commandName: "eventreminder",
      subcommand: "optout",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(out);
    assert.equal(
      env.db.isEventReminderOptedOut(env.guild.id, IDS.member),
      true
    );

    const status = await env.runCommand({
      commandName: "eventreminder",
      subcommand: "status",
      admin: false,
      user: env.users.memberUser,
    });
    assertReplyContains(status, /opted out:\s*\*\*yes\*\*/i);
  });

  it("/eventreminder optin clears opt-out", async () => {
    env.db.setEventReminderOptOut(env.guild.id, IDS.member);
    const interaction = await env.runCommand({
      commandName: "eventreminder",
      subcommand: "optin",
      admin: false,
      user: env.users.memberUser,
    });
    assert.equal(
      env.db.isEventReminderOptedOut(env.guild.id, IDS.member),
      false
    );
    assert.ok(interaction.replies.length >= 1);
  });

  it("/eventreminder create opens modal for admin", async () => {
    const start = Date.now() + 2 * 24 * 60 * 60 * 1000;
    const event = createScheduledEvent({
      guild: env.guild,
      id: "evt-create-1",
      name: "Friday Raid",
      scheduledStartTimestamp: start,
      creatorId: IDS.admin,
      subscriberIds: [IDS.member, IDS.member2],
    });
    env.guild.addScheduledEvent(event);

    const interaction = await env.runCommand({
      commandName: "eventreminder",
      subcommand: "create",
      admin: true,
      options: { event: "evt-create-1" },
    });
    assert.equal(interaction.modals.length, 1);
    const modal = interaction.modals[0];
    const json = typeof modal.toJSON === "function" ? modal.toJSON() : modal;
    assert.match(json.custom_id || json.customId, /^er:create:evt-create-1$/);
  });

  it("modal create persists config, role, and offsets", async () => {
    const start = Date.now() + 3 * 24 * 60 * 60 * 1000;
    const event = createScheduledEvent({
      guild: env.guild,
      id: "evt-modal-1",
      name: "Boss Night",
      scheduledStartTimestamp: start,
      creatorId: IDS.admin,
      subscriberIds: [IDS.member],
    });
    env.guild.addScheduledEvent(event);

    env.db.updateGuildSettings(env.guild.id, {
      event_reminder_channel_id: IDS.channelNotify,
    });

    const modalIx = createModalSubmitInteraction({
      customId: "er:create:evt-modal-1",
      guild: env.guild,
      user: env.users.adminUser,
      member: env.members.adminMember,
      admin: true,
      client: env.client,
      fields: {
        shortname: "boss-night",
        offsets: ["1440", "60", "15"],
        offsets_custom: "",
        message: "",
        channel: null,
      },
    });

    await env.handleInteraction(modalIx, env.ctx);
    assert.ok(modalIx.deferred || modalIx.replies.length >= 1);

    const config = env.db.getConfigByScheduledEventId(
      env.guild.id,
      "evt-modal-1"
    );
    assert.ok(config);
    assert.equal(config.shortname, "boss-night");
    assert.ok(config.role_id);
    assert.ok(config.offsets.length >= 1);
    assert.ok(env.guild.roles.cache.has(config.role_id));

    // Interested non-opted-out member should have role
    assert.ok(env.members.member.roles.cache.has(config.role_id));
  });

  it("ticker delivers due offset as embed once", async () => {
    const start = Date.now() + 60 * 60 * 1000; // 1h from now
    const event = createScheduledEvent({
      guild: env.guild,
      id: "evt-tick-1",
      name: "Ticker Event",
      scheduledStartTimestamp: start,
      creatorId: IDS.admin,
      subscriberIds: [],
    });
    env.guild.addScheduledEvent(event);

    env.db.updateGuildSettings(env.guild.id, {
      event_reminder_channel_id: IDS.channelNotify,
    });

    const role = await env.guild.roles.create({ name: "event-tick-test" });
    const fireAt = Date.now() - 1000; // already due
    env.db.createEventReminderConfig({
      guildId: env.guild.id,
      scheduledEventId: "evt-tick-1",
      shortname: "tick-test",
      roleId: role.id,
      channelId: null,
      messageTemplate: "Custom body for {event}",
      offsets: [{ offsetMinutes: 60, fireAt }],
      createdBy: IDS.admin,
    });

    env.channels.notify.sent.length = 0;
    await runEventReminderTick(env.client, { now: Date.now() });

    assert.ok(
      env.channels.notify.sent.length >= 1,
      "expected a reminder message"
    );
    const payload = env.channels.notify.sent[0];
    assert.ok(payload && typeof payload === "object");
    assert.match(payload.content || "", new RegExp(`<@&${role.id}>`));
    assert.ok(Array.isArray(payload.embeds) && payload.embeds.length >= 1);
    const embed = payload.embeds[0];
    const embedData = typeof embed.toJSON === "function" ? embed.toJSON() : embed.data || embed;
    assert.match(embedData.title || "", /Ticker Event/);
    assert.match(embedData.description || "", /Custom body for Ticker Event/);

    // Second tick should not re-send
    const countAfterFirst = env.channels.notify.sent.length;
    await runEventReminderTick(env.client, { now: Date.now() });
    assert.equal(env.channels.notify.sent.length, countAfterFirst);
  });

  it("/eventreminder list shows config", async () => {
    const interaction = await env.runCommand({
      commandName: "eventreminder",
      subcommand: "list",
      admin: true,
    });
    assertEphemeralReply(interaction);
    assert.ok(lastReplyContent(interaction).length > 0);
  });

  it("/eventreminder clear removes config and role", async () => {
    const event = createScheduledEvent({
      guild: env.guild,
      id: "evt-clear-1",
      name: "Clear Me",
      scheduledStartTimestamp: Date.now() + 86_400_000,
      creatorId: IDS.admin,
    });
    env.guild.addScheduledEvent(event);
    const role = await env.guild.roles.create({ name: "event-clear-me" });
    env.db.createEventReminderConfig({
      guildId: env.guild.id,
      scheduledEventId: "evt-clear-1",
      shortname: "clear-me",
      roleId: role.id,
      offsets: [
        {
          offsetMinutes: 60,
          fireAt: Date.now() + 80_000_000,
        },
      ],
      createdBy: IDS.admin,
    });

    const interaction = await env.runCommand({
      commandName: "eventreminder",
      subcommand: "clear",
      admin: true,
      options: { event: "evt-clear-1" },
    });
    assertReplyContains(interaction, /cleared/i);
    assert.equal(
      env.db.getConfigByScheduledEventId(env.guild.id, "evt-clear-1"),
      null
    );
    assert.equal(env.guild.roles.cache.has(role.id), false);
  });

  it("repo claimDueReminders + markReminderSent", () => {
    const roleId = "role-claim-1";
    const fireAt = Date.now() - 5000;
    const config = env.db.createEventReminderConfig({
      guildId: env.guild.id,
      scheduledEventId: "evt-claim-1",
      shortname: "claim-1",
      roleId,
      offsets: [{ offsetMinutes: 15, fireAt }],
      createdBy: IDS.admin,
    });
    const due = env.db.claimDueReminders(Date.now(), 10);
    const mine = due.find((d) => d.config_id === config.id);
    assert.ok(mine);
    env.db.markReminderSent(mine.offset_id, "msg-1");
    const due2 = env.db.claimDueReminders(Date.now(), 10);
    assert.equal(
      due2.find((d) => d.offset_id === mine.offset_id),
      undefined
    );
  });

  it("suggestShortname appends suffix on collision", () => {
    const {
      suggestShortname,
    } = require("../../src/features/eventReminders/service");
    const roleId = "role-suggest-1";
    env.db.createEventReminderConfig({
      guildId: env.guild.id,
      scheduledEventId: "evt-suggest-1",
      shortname: "friday-raid",
      roleId,
      offsets: [
        { offsetMinutes: 60, fireAt: Date.now() + 3_600_000 },
      ],
      createdBy: IDS.admin,
    });
    assert.equal(
      suggestShortname(env.guild.id, "Friday Raid!!!"),
      "friday-raid-2"
    );
    assert.equal(
      suggestShortname(env.guild.id, "Unique Event Name"),
      "unique-event-name"
    );
  });

  it("mute strips role; unmute restores when Interested", async () => {
    const start = Date.now() + 2 * 24 * 60 * 60 * 1000;
    const event = createScheduledEvent({
      guild: env.guild,
      id: "evt-mute-1",
      name: "Mute Me",
      scheduledStartTimestamp: start,
      creatorId: IDS.admin,
      subscriberIds: [IDS.member],
    });
    env.guild.addScheduledEvent(event);

    const role = await env.guild.roles.create({ name: "event-mute-me" });
    env.db.createEventReminderConfig({
      guildId: env.guild.id,
      scheduledEventId: "evt-mute-1",
      shortname: "mute-me",
      roleId: role.id,
      offsets: [
        { offsetMinutes: 60, fireAt: Date.now() + 80_000_000 },
      ],
      createdBy: IDS.admin,
    });
    await env.members.member.roles.add(role.id);
    assert.ok(env.members.member.roles.cache.has(role.id));

    const muteIx = await env.runCommand({
      commandName: "eventreminder",
      subcommand: "mute",
      admin: false,
      user: env.users.memberUser,
      options: { event: "evt-mute-1" },
    });
    assertEphemeralReply(muteIx);
    assert.equal(
      env.db.isEventReminderMuted(env.guild.id, IDS.member, "evt-mute-1"),
      true
    );
    assert.equal(env.members.member.roles.cache.has(role.id), false);
    assert.equal(
      env.db.isUserBlockedFromEventReminders(
        env.guild.id,
        IDS.member,
        "evt-mute-1"
      ),
      true
    );

    const status = await env.runCommand({
      commandName: "eventreminder",
      subcommand: "status",
      admin: false,
      user: env.users.memberUser,
    });
    assertReplyContains(status, /mute-me|muted events/i);

    const unmuteIx = await env.runCommand({
      commandName: "eventreminder",
      subcommand: "unmute",
      admin: false,
      user: env.users.memberUser,
      options: { event: "evt-mute-1" },
    });
    assert.equal(
      env.db.isEventReminderMuted(env.guild.id, IDS.member, "evt-mute-1"),
      false
    );
    assert.ok(env.members.member.roles.cache.has(role.id));
    assertReplyContains(unmuteIx, /unmuted|restored/i);
  });

  it("guild opt-out blocks grants even after unmute", async () => {
    const event = createScheduledEvent({
      guild: env.guild,
      id: "evt-mute-opt-1",
      name: "Opt Mute",
      scheduledStartTimestamp: Date.now() + 86_400_000,
      creatorId: IDS.admin,
      subscriberIds: [IDS.member2],
    });
    env.guild.addScheduledEvent(event);
    const role = await env.guild.roles.create({ name: "event-opt-mute" });
    env.db.createEventReminderConfig({
      guildId: env.guild.id,
      scheduledEventId: "evt-mute-opt-1",
      shortname: "opt-mute",
      roleId: role.id,
      offsets: [
        { offsetMinutes: 30, fireAt: Date.now() + 80_000_000 },
      ],
      createdBy: IDS.admin,
    });

    env.db.setEventReminderMute(env.guild.id, IDS.member2, "evt-mute-opt-1");
    env.db.setEventReminderOptOut(env.guild.id, IDS.member2);

    await env.runCommand({
      commandName: "eventreminder",
      subcommand: "unmute",
      admin: false,
      user: env.users.member2User,
      options: { event: "evt-mute-opt-1" },
    });

    assert.equal(
      env.db.isEventReminderMuted(env.guild.id, IDS.member2, "evt-mute-opt-1"),
      false
    );
    assert.equal(
      env.db.isEventReminderOptedOut(env.guild.id, IDS.member2),
      true
    );
    assert.equal(env.members.member2.roles.cache.has(role.id), false);
  });

  it("clearing config drops mute rows for that event", () => {
    const roleId = "role-mute-clear";
    env.db.createEventReminderConfig({
      guildId: env.guild.id,
      scheduledEventId: "evt-mute-clear",
      shortname: "mute-clear",
      roleId,
      offsets: [
        { offsetMinutes: 15, fireAt: Date.now() + 60_000 },
      ],
      createdBy: IDS.admin,
    });
    env.db.setEventReminderMute(env.guild.id, IDS.member, "evt-mute-clear");
    assert.equal(
      env.db.isEventReminderMuted(env.guild.id, IDS.member, "evt-mute-clear"),
      true
    );
    env.db.clearEventReminderConfig(env.guild.id, "evt-mute-clear");
    assert.equal(
      env.db.isEventReminderMuted(env.guild.id, IDS.member, "evt-mute-clear"),
      false
    );
  });
});
