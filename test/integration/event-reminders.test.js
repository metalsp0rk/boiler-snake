const { describe, it, before, after } = require("node:test");
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

  after(() => {
    // Close SQLite handles and remove the temp dir created for this env.
    env?.cleanup();
  });

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
      env.db.getGuildSettings(env.communityId).event_reminder_channel_id,
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
      env.db.isEventReminderOptedOut(env.communityId, IDS.member),
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
    env.db.setEventReminderOptOut(env.communityId, IDS.member);
    const interaction = await env.runCommand({
      commandName: "eventreminder",
      subcommand: "optin",
      admin: false,
      user: env.users.memberUser,
    });
    assert.equal(
      env.db.isEventReminderOptedOut(env.communityId, IDS.member),
      false
    );
    assert.ok(interaction.replies.length >= 1);
  });

  it("/eventreminder create is retired: points at /event and persists nothing", async () => {
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
    // Retirement (issue #225): no modal, no persistence — an honest redirect
    const texts = interaction.replies
      .flatMap((r) => [r?.content, ...(r?.embeds || [])])
      .map(String)
      .join(" ");
    assert.match(texts, /\/event create/);
    assert.match(texts, /\/event adopt/);
    assert.equal(interaction.modals.length, 0);
    assert.equal(
      env.db.getConfigByScheduledEventId(env.communityId, "evt-create-1"),
      null,
    );
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

    env.db.updateGuildSettings(env.communityId, {
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
      env.communityId,
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

  it("modal keeps exactly 5 label components (Discord modal cap)", () => {
    const feature = require("../../src/features/eventReminders/index.js");
    for (const mode of ["create", "edit"]) {
      const json = feature
        .buildReminderModal({
          mode,
          eventId: "evt-cap-1",
          eventName: "Cap Test",
        })
        .toJSON();
      assert.ok(
        json.components.length <= 5,
        `${mode} modal has ${json.components.length} components (max 5)`,
      );
      assert.equal(json.components.length, 5);
    }
  });

  it("create persistent option encodes modal customId and persists", async () => {
    const start = Date.now() + 4 * 24 * 60 * 60 * 1000;
    const event = createScheduledEvent({
      guild: env.guild,
      id: "evt-persist-1",
      name: "Weekly Raid",
      scheduledStartTimestamp: start,
      creatorId: IDS.admin,
      subscriberIds: [],
    });
    env.guild.addScheduledEvent(event);
    env.db.updateGuildSettings(env.communityId, {
      event_reminder_channel_id: IDS.channelNotify,
    });

    // Command create is retired; the modal flow itself stays alive for
    // in-flight `er:create:*…:p1` submissions — build it the way the
    // pre-retirement command used to.
    const feature = require("../../src/features/eventReminders/index.js");
    const modal = feature.buildReminderModal({
      mode: "create",
      persistent: true,
      eventId: "evt-persist-1",
      eventName: "Weekly Raid",
    });
    const json = modal.toJSON();
    assert.match(
      json.custom_id || json.customId,
      /^er:create:evt-persist-1:p1$/,
    );

    const modalIx = createModalSubmitInteraction({
      customId: "er:create:evt-persist-1:p1",
      guild: env.guild,
      user: env.users.adminUser,
      member: env.members.adminMember,
      admin: true,
      client: env.client,
      fields: {
        shortname: "weekly-raid",
        offsets: ["1440", "60"],
        offsets_custom: "",
        message: "",
        channel: null,
      },
    });
    await env.handleInteraction(modalIx, env.ctx);

    const config = env.db.getConfigByScheduledEventId(
      env.communityId,
      "evt-persist-1",
    );
    assert.ok(config);
    assert.equal(config.persistent, 1);

    const confirm = modalIx.replies[modalIx.replies.length - 1];
    const compJson = JSON.stringify(
      (confirm.components || []).map((r) =>
        typeof r.toJSON === "function" ? r.toJSON() : r,
      ),
    );
    assert.match(compJson, /er-recur:evt-persist-1/);
  });

  it("recurring toggle button flips persistent both ways", async () => {
    const event = createScheduledEvent({
      guild: env.guild,
      id: "evt-recur-1",
      name: "Recur Toggle",
      scheduledStartTimestamp: Date.now() + 86_400_000,
      creatorId: IDS.admin,
    });
    env.guild.addScheduledEvent(event);
    const role = await env.guild.roles.create({ name: "event-recur-toggle" });
    env.db.createEventReminderConfig({
      communityId: env.communityId,
      scheduledEventId: "evt-recur-1",
      shortname: "recur-toggle",
      roleId: role.id,
      persistent: false,
      offsets: [{ offsetMinutes: 60, fireAt: Date.now() + 80_000_000 }],
      createdBy: IDS.admin,
    });

    const btn = await env.runButton({
      customId: "er-recur:evt-recur-1",
      admin: true,
    });
    assert.equal(
      env.db.getConfigByScheduledEventId(env.communityId, "evt-recur-1")
        .persistent,
      1,
    );
    assert.equal(btn.updates.length, 1);
    assert.match(btn.updates[0].content, /\*\*Recurring: on\*\*/);

    await env.runButton({ customId: "er-recur:evt-recur-1", admin: true });
    assert.equal(
      env.db.getConfigByScheduledEventId(env.communityId, "evt-recur-1")
        .persistent,
      0,
    );
  });

  it("edit modal submit preserves existing persistent", async () => {
    const event = createScheduledEvent({
      guild: env.guild,
      id: "evt-edit-persist",
      name: "Edit Persist",
      scheduledStartTimestamp: Date.now() + 3 * 86_400_000,
      creatorId: IDS.admin,
    });
    env.guild.addScheduledEvent(event);
    const role = await env.guild.roles.create({ name: "event-edit-persist" });
    env.db.createEventReminderConfig({
      communityId: env.communityId,
      scheduledEventId: "evt-edit-persist",
      shortname: "edit-persist",
      roleId: role.id,
      persistent: true,
      offsets: [{ offsetMinutes: 60, fireAt: Date.now() + 80_000_000 }],
      createdBy: IDS.admin,
    });

    const modalIx = createModalSubmitInteraction({
      customId: "er:edit:evt-edit-persist",
      guild: env.guild,
      user: env.users.adminUser,
      member: env.members.adminMember,
      admin: true,
      client: env.client,
      fields: {
        shortname: "edit-persist",
        offsets: ["60"],
        offsets_custom: "",
        message: "",
        channel: null,
      },
    });
    await env.handleInteraction(modalIx, env.ctx);

    assert.equal(
      env.db.getConfigByScheduledEventId(env.communityId, "evt-edit-persist")
        .persistent,
      1,
    );
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

    env.db.updateGuildSettings(env.communityId, {
      event_reminder_channel_id: IDS.channelNotify,
    });

    const role = await env.guild.roles.create({ name: "event-tick-test" });
    const fireAt = Date.now() - 1000; // already due
    env.db.createEventReminderConfig({
      communityId: env.communityId,
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
      communityId: env.communityId,
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
      env.db.getConfigByScheduledEventId(env.communityId, "evt-clear-1"),
      null
    );
    assert.equal(env.guild.roles.cache.has(role.id), false);
  });

  it("repo claimDueReminders + markReminderSent", () => {
    const roleId = "role-claim-1";
    const fireAt = Date.now() - 5000;
    const config = env.db.createEventReminderConfig({
      communityId: env.communityId,
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
      communityId: env.communityId,
      scheduledEventId: "evt-suggest-1",
      shortname: "friday-raid",
      roleId,
      offsets: [
        { offsetMinutes: 60, fireAt: Date.now() + 3_600_000 },
      ],
      createdBy: IDS.admin,
    });
    assert.equal(
      suggestShortname(env.communityId, "Friday Raid!!!"),
      "friday-raid-2"
    );
    assert.equal(
      suggestShortname(env.communityId, "Unique Event Name"),
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
      communityId: env.communityId,
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
      env.db.isEventReminderMuted(env.communityId, IDS.member, "evt-mute-1"),
      true
    );
    assert.equal(env.members.member.roles.cache.has(role.id), false);
    assert.equal(
      env.db.isUserBlockedFromEventReminders(
        env.communityId,
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
      env.db.isEventReminderMuted(env.communityId, IDS.member, "evt-mute-1"),
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
      communityId: env.communityId,
      scheduledEventId: "evt-mute-opt-1",
      shortname: "opt-mute",
      roleId: role.id,
      offsets: [
        { offsetMinutes: 30, fireAt: Date.now() + 80_000_000 },
      ],
      createdBy: IDS.admin,
    });

    env.db.setEventReminderMute(env.communityId, IDS.member2, "evt-mute-opt-1");
    env.db.setEventReminderOptOut(env.communityId, IDS.member2);

    await env.runCommand({
      commandName: "eventreminder",
      subcommand: "unmute",
      admin: false,
      user: env.users.member2User,
      options: { event: "evt-mute-opt-1" },
    });

    assert.equal(
      env.db.isEventReminderMuted(env.communityId, IDS.member2, "evt-mute-opt-1"),
      false
    );
    assert.equal(
      env.db.isEventReminderOptedOut(env.communityId, IDS.member2),
      true
    );
    assert.equal(env.members.member2.roles.cache.has(role.id), false);
  });

  it("clearing config drops mute rows for that event", () => {
    const roleId = "role-mute-clear";
    env.db.createEventReminderConfig({
      communityId: env.communityId,
      scheduledEventId: "evt-mute-clear",
      shortname: "mute-clear",
      roleId,
      offsets: [
        { offsetMinutes: 15, fireAt: Date.now() + 60_000 },
      ],
      createdBy: IDS.admin,
    });
    env.db.setEventReminderMute(env.communityId, IDS.member, "evt-mute-clear");
    assert.equal(
      env.db.isEventReminderMuted(env.communityId, IDS.member, "evt-mute-clear"),
      true
    );
    env.db.clearEventReminderConfig(env.communityId, "evt-mute-clear");
    assert.equal(
      env.db.isEventReminderMuted(env.communityId, IDS.member, "evt-mute-clear"),
      false
    );
  });
});

describe("integration: event reminder delivery state (#196, audit H12)", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let runEventReminderTick;
  /** Claim-state constants live on the repository (facade stays function-only). */
  let repo;

  after(() => {
    env?.cleanup();
  });

  before(async () => {
    env = await createIntegrationEnv();
    // Require AFTER createIntegrationEnv so the ticker binds to this env's DB.
    runEventReminderTick =
      require("../../src/features/eventReminders/ticker").runEventReminderTick;
    repo = require("../../src/db/repositories/eventReminders.js");
  });

  /** Raw offset row by id (bypasses the join/claim layer). */
  function offsetRow(offsetId) {
    return env.db.db
      .prepare(`SELECT * FROM event_reminder_offsets WHERE id=?`)
      .get(offsetId);
  }

  /** Register a live scheduled event so safety cleanup leaves the config alone. */
  async function liveEvent(id, name, startMs) {
    const event = createScheduledEvent({
      guild: env.guild,
      id,
      name,
      scheduledStartTimestamp: startMs,
      creatorId: IDS.admin,
      subscriberIds: [],
    });
    env.guild.addScheduledEvent(event);
    return event;
  }

  /** Config + role row wired to an event; returns the config (with offsets). */
  async function reminderConfig(opts) {
    const role = await env.guild.roles.create({
      name: `event-${opts.shortname}`,
    });
    return env.db.createEventReminderConfig({
      communityId: env.communityId,
      scheduledEventId: opts.eventId,
      shortname: opts.shortname,
      roleId: role.id,
      channelId: opts.channelId ?? null,
      persistent: opts.persistent ?? false,
      offsets: opts.offsets,
      createdBy: IDS.admin,
    });
  }

  it("migration 038 adds claim-state columns and pins sent rows terminal", async () => {
    const cols = env.db.db
      .prepare(`PRAGMA table_info(event_reminder_offsets)`)
      .all()
      .map((c) => c.name);
    for (const col of [
      "status",
      "attempts",
      "next_attempt_at",
      "claimed_at",
      "last_error",
    ]) {
      assert.ok(cols.includes(col), `column ${col} exists`);
    }

    // Backfill rule of 038: a row with sent_at set is terminal 'sent' — even
    // if something clobbered the status. Re-running up() (idempotency contract)
    // must restore it without duplicating columns.
    await liveEvent("evt-196-mig", "Mig", Date.now() + 86_400_000);
    const config = await reminderConfig({
      eventId: "evt-196-mig",
      shortname: "196-mig",
      offsets: [{ offsetMinutes: 60, fireAt: Date.now() - 1000 }],
    });
    const offsetId = config.offsets[0].id;
    env.db.claimDueReminders(Date.now(), 50);
    assert.equal(env.db.markReminderSent(offsetId, "msg-mig"), true);

    env.db.db
      .prepare(`UPDATE event_reminder_offsets SET status='pending' WHERE id=?`)
      .run(offsetId);
    const migration = require("../../src/db/migrations/038_event_reminder_claim_state.js");
    const { addColumnIfMissing } = require("../../src/db/connection");
    migration.up(env.db.db, { addColumnIfMissing });

    assert.equal(offsetRow(offsetId).status, "sent", "backfill pins sent rows");
    const colsAfter = env.db.db
      .prepare(`PRAGMA table_info(event_reminder_offsets)`)
      .all()
      .map((c) => c.name);
    assert.deepEqual(
      colsAfter.filter((c) => c === "status").length,
      1,
      "re-running the migration is a no-op on columns"
    );
  });

  it("repo: claim CAS — one claimer, TTL recovers a dead worker, terminals never re-claim", async () => {
    const T0 = Date.now();
    await liveEvent("evt-196-claim", "Claim CAS", T0 + 24 * 3_600_000);
    const config = await reminderConfig({
      eventId: "evt-196-claim",
      shortname: "196-claim",
      offsets: [{ offsetMinutes: 60, fireAt: T0 - 1000 }],
    });
    const offsetId = config.offsets[0].id;

    // Fresh row defaults: pending, no attempts, unscheduled (COALESCE → fire_at).
    let row = offsetRow(offsetId);
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 0);
    assert.equal(row.next_attempt_at, null);

    // Claim 1: wins, flips to 'sending' with a lease stamp.
    const due1 = env.db.claimDueReminders(T0, 50);
    const mine = due1.find((d) => d.offset_id === offsetId);
    assert.ok(mine, "due row is claimed");
    assert.equal(mine.status, "sending");
    assert.equal(mine.claimed_at, T0);
    assert.equal(typeof mine.attempts, "number");

    // CAS: a second ticker at the same instant claims nothing; the lease is
    // held until TTL expiry, then a crashed worker's row is reclaimable.
    assert.equal(
      env.db
        .claimDueReminders(T0, 50)
        .some((d) => d.offset_id === offsetId),
      false,
      "concurrent claim sees the row as taken"
    );
    assert.equal(
      env.db
        .claimDueReminders(T0 + repo.REMINDER_CLAIM_TTL_MS - 1, 50)
        .some((d) => d.offset_id === offsetId),
      false,
      "lease still fresh inside the TTL"
    );
    assert.ok(
      env.db
        .claimDueReminders(T0 + repo.REMINDER_CLAIM_TTL_MS + 1, 50)
        .some((d) => d.offset_id === offsetId),
      "lease-expired row is reclaimed by the next ticker"
    );

    // Sent is terminal: never claimable again, at any clock.
    assert.equal(env.db.markReminderSent(offsetId, "msg-196"), true);
    assert.equal(offsetRow(offsetId).status, "sent");
    assert.equal(offsetRow(offsetId).sent_at !== null, true);
    for (const t of [T0, T0 + 10 * 60_000, T0 + 99 * 60 * 60_000]) {
      assert.equal(
        env.db
          .claimDueReminders(t, 50)
          .some((d) => d.offset_id === offsetId),
        false,
        "sent row never re-claims"
      );
    }

    // Retired rows are equally invisible to the claim queue.
    env.db.updateEventReminderConfig(config.id, {
      offsets: [{ offsetMinutes: 15, fireAt: T0 - 2000 }],
    });
    const off2 = env.db.getEventReminderConfigById(config.id).offsets.find(
      (o) => o.sent_at == null
    );
    assert.ok(off2);
    env.db.claimDueReminders(T0, 50);
    assert.equal(env.db.retireReminderOffset(off2.id, "channel gone").won, true);
    assert.equal(offsetRow(off2.id).status, "retired");
    assert.equal(offsetRow(off2.id).last_error, "channel gone");
    assert.equal(
      env.db
        .claimDueReminders(T0 + 60 * 60_000, 50)
        .some((d) => d.offset_id === off2.id),
      false,
      "retired row never re-claims"
    );

    // Inactive configs drop out of the queue even with pending rows.
    env.db.updateEventReminderConfig(config.id, {
      offsets: [{ offsetMinutes: 5, fireAt: T0 - 3000 }],
    });
    env.db.db
      .prepare(`UPDATE event_reminder_configs SET active=0 WHERE id=?`)
      .run(config.id);
    assert.equal(
      env.db
        .claimDueReminders(T0 + 60 * 60_000, 50)
        .some((d) => d.config_id === config.id),
      false,
      "inactive config is not claimed"
    );
  });

  it("backoff curve doubles from one tick and caps at 6h", () => {
    const d = env.db.reminderRetryDelayMs;
    assert.equal(d(1), 60_000);
    assert.equal(d(2), 120_000);
    assert.equal(d(3), 240_000);
    assert.equal(d(9), 256 * 60_000);
    assert.equal(d(10), 6 * 60 * 60_000, "2^9·60s exceeds the cap → capped at 6h");
    assert.equal(d(99), 6 * 60 * 60_000);
  });

  it("concurrent tickers deliver a due offset exactly once (latch)", async () => {
    const T0 = Date.now();
    await liveEvent("evt-196-race", "Race", T0 + 24 * 3_600_000);
    const config = await reminderConfig({
      eventId: "evt-196-race",
      shortname: "196-race",
      offsets: [{ offsetMinutes: 60, fireAt: T0 - 1000 }],
    });
    const offsetId = config.offsets[0].id;

    const channel = env.channels.notify;
    env.db.updateGuildSettings(env.communityId, {
      event_reminder_channel_id: IDS.channelNotify,
    });
    const originalSend = channel.send.bind(channel);
    let sendCalls = 0;
    let entered, releaseEntry;
    const enteredP = new Promise((r) => (entered = r));
    const releaseP = new Promise((r) => (releaseEntry = r));
    channel.send = async (payload) => {
      sendCalls += 1;
      if (sendCalls === 1) {
        entered();
        await releaseP; // hold the winner mid-delivery while ticker #2 runs
      }
      return originalSend(payload);
    };

    try {
      const first = channel.sent.length;
      const tick1 = runEventReminderTick(env.client, { now: T0 });
      await enteredP; // ticker #1 owns the claim, stuck inside send

      // Ticker #2 runs fully while the claim is held → claims nothing.
      await runEventReminderTick(env.client, { now: T0 + 5_000 });
      assert.equal(sendCalls, 1, "second ticker never delivers");

      releaseEntry();
      await tick1;

      assert.equal(sendCalls, 1, "exactly one sender for one claim");
      assert.equal(channel.sent.length, first + 1);
      const row = offsetRow(offsetId);
      assert.equal(row.status, "sent");
      assert.equal(row.attempts, 0);
      assert.ok(row.message_id, "sent row records the message id");
    } finally {
      channel.send = originalSend;
      releaseEntry();
    }
  });

  it("gone notify channel RETIRES the offset after first detection — never re-claimed", async () => {
    const T0 = Date.now();
    await liveEvent("evt-196-gone", "Gone Chan", T0 + 48 * 3_600_000);
    const config = await reminderConfig({
      eventId: "evt-196-gone",
      shortname: "196-gone",
      channelId: "channel-deleted-999", // not in cache; mock fetch → null
      offsets: [{ offsetMinutes: 60, fireAt: T0 - 1000 }],
    });
    const offsetId = config.offsets[0].id;
    const before = env.channels.notify.sent.length;

    await runEventReminderTick(env.client, { now: T0 });

    let row = offsetRow(offsetId);
    assert.equal(row.status, "retired", "retired on FIRST detection");
    assert.match(row.last_error, /gone/i);
    assert.equal(row.sent_at, null, "retired ≠ sent — no fake discard");
    assert.equal(env.channels.notify.sent.length, before);

    // The audit bug: minutes of re-claims for up to 30 days. Prove silence.
    for (const dt of [60_000, 300_000, 30 * 60_000]) {
      await runEventReminderTick(env.client, { now: T0 + dt });
    }
    row = offsetRow(offsetId);
    assert.equal(row.status, "retired");
    assert.equal(env.channels.notify.sent.length, before, "no re-fire, no ping storm");
    assert.equal(
      env.db
        .claimDueReminders(T0 + 24 * 3_600_000, 50)
        .some((d) => d.offset_id === offsetId),
      false
    );

    // Row retires; the CONFIG stays active for the operator to fix the channel.
    const cfg = env.db.getEventReminderConfigById(config.id);
    assert.equal(cfg.active, 1, "gone-channel retire keeps the config alive");

    // A 10003 error rejection classifies as gone too (own event → own config;
    // the configs table enforces one config per scheduled event).
    await liveEvent("evt-196-gone-code", "Gone Code", T0 + 48 * 3_600_000);
    const config2 = await reminderConfig({
      eventId: "evt-196-gone-code",
      shortname: "196-gone-code",
      channelId: "channel-10003",
      offsets: [{ offsetMinutes: 15, fireAt: T0 - 1000 }],
    });
    const off2 = config2.offsets[0].id;
    const originalFetch = env.guild.channels.fetch;
    env.guild.channels.fetch = async () => {
      const err = new Error("Unknown Channel");
      err.code = 10003;
      throw err;
    };
    try {
      await runEventReminderTick(env.client, { now: T0 + 60_000 });
    } finally {
      env.guild.channels.fetch = originalFetch;
    }
    const row2 = offsetRow(off2);
    assert.equal(row2.status, "retired", "Discord 10003 → gone, terminal");
    assert.match(row2.last_error, /10003|Unknown Channel/i);
  });

  it("transient send failures back off on the curve, never before fire_at+1 tick, then terminal-fail", async () => {
    const T0 = Date.now();
    // Event far in the future so safety cleanup (start+5min) never touches it
    // while the fake clock walks ~17h of backoff.
    await liveEvent("evt-196-backoff", "Backoff", T0 + 100 * 86_400_000);
    env.db.updateGuildSettings(env.communityId, {
      event_reminder_channel_id: IDS.channelNotify,
    });
    const config = await reminderConfig({
      eventId: "evt-196-backoff",
      shortname: "196-backoff",
      offsets: [{ offsetMinutes: 60, fireAt: T0 - 1000 }],
    });
    const offsetId = config.offsets[0].id;

    const channel = env.channels.notify;
    const originalSend = channel.send.bind(channel);
    const first = channel.sent.length;
    let sendCalls = 0;
    channel.send = async (payload) => {
      sendCalls += 1;
      const err = new Error("500: Internal Server Error");
      err.code = 0;
      throw err; // transient — never a gone code
    };

    try {
      let now = T0;
      let last = null;
      for (let i = 1; i <= repo.MAX_REMINDER_ATTEMPTS; i++) {
        await runEventReminderTick(env.client, { now });
        const row = offsetRow(offsetId);
        assert.equal(row.attempts, i, `attempt ${i} recorded`);
        assert.equal(row.sent_at, null, `row ${i} was NOT discarded-as-sent`);
        assert.equal(sendCalls, i, "one delivery attempt per claim");

        if (i === 1) {
          // Audit floor: the retry is never earlier than the original
          // next-offset plus one ticker tick, even with a 60s first delay.
          assert.ok(
            row.next_attempt_at >= config.offsets[0].fire_at + repo.REMINDER_TICK_MS,
            "retry respects fire_at + 1 tick floor"
          );
          // And it does not fire early: a tick inside the backoff window
          // must not claim the row.
          await runEventReminderTick(env.client, {
            now: row.next_attempt_at - 1000,
          });
          assert.equal(sendCalls, 1, "no early retry");
        }

        if (i < repo.MAX_REMINDER_ATTEMPTS) {
          assert.equal(row.status, "pending", "transient → pending with schedule");
          assert.equal(
            row.next_attempt_at,
            Math.max(
              now + env.db.reminderRetryDelayMs(i),
              config.offsets[0].fire_at + repo.REMINDER_TICK_MS
            ),
            `next_attempt_at = max(now+backoff(${i}), fire_at+tick)`
          );
          last = row.next_attempt_at;
          now = row.next_attempt_at; // clock jumps to the scheduled retry — zero real sleeps
        } else {
          assert.equal(last !== null, true);
          assert.equal(row.status, "failed", "terminal 'failed' after MAX attempts");
          assert.match(row.last_error, /500|Internal Server Error/i);
        }
      }

      // Terminal: even a tick years later produces no delivery attempt.
      await runEventReminderTick(env.client, { now: T0 + 365 * 86_400_000 });
      assert.equal(sendCalls, repo.MAX_REMINDER_ATTEMPTS);
      assert.equal(channel.sent.length, first, "nothing ever reached Discord");
    } finally {
      channel.send = originalSend;
    }
  });

  it("guild-fetch blip retries with backoff instead of permanently discarding (H12 discard bug)", async () => {
    const T0 = Date.now();
    await liveEvent("evt-196-guild", "Guild Blip", T0 + 48 * 3_600_000);
    env.db.updateGuildSettings(env.communityId, {
      event_reminder_channel_id: IDS.channelNotify,
    });
    const config = await reminderConfig({
      eventId: "evt-196-guild",
      shortname: "196-guild",
      offsets: [{ offsetMinutes: 60, fireAt: T0 - 1000 }],
    });
    const offsetId = config.offsets[0].id;

    // Guild disappears (restart cache-cold / fetch failure — mock fetch → null).
    env.client.guilds.cache.delete(env.guildId);
    try {
      await runEventReminderTick(env.client, { now: T0 });
    } finally {
      env.client.guilds.cache.set(env.guildId, env.guild);
    }

    let row = offsetRow(offsetId);
    assert.equal(row.sent_at, null, "NOT discarded via markReminderSent(null)");
    assert.equal(row.status, "pending", "transient → back to pending");
    assert.equal(row.attempts, 1);
    assert.equal(row.next_attempt_at, T0 + env.db.reminderRetryDelayMs(1));

    // Guild back → the scheduled retry delivers normally.
    await runEventReminderTick(env.client, {
      now: T0 + env.db.reminderRetryDelayMs(1),
    });
    row = offsetRow(offsetId);
    assert.equal(row.status, "sent");
    assert.ok(row.message_id);
  });

  it("event gone: non-persistent config cleans up; persistent retires offsets and survives", async () => {
    const T0 = Date.now();
    // No event registered for either config → event-gone branch.
    env.db.updateGuildSettings(env.communityId, {
      event_reminder_channel_id: IDS.channelNotify,
    });
    const transient = await reminderConfig({
      eventId: "evt-196-gone-nonpersist",
      shortname: "196-nonpersist",
      offsets: [{ offsetMinutes: 60, fireAt: T0 - 1000 }],
    });
    const persistent = await reminderConfig({
      eventId: "evt-196-gone-persist",
      shortname: "196-persist",
      persistent: true,
      offsets: [{ offsetMinutes: 60, fireAt: T0 - 1000 }],
    });

    await runEventReminderTick(env.client, { now: T0 });

    assert.equal(
      env.db.getEventReminderConfigById(transient.id),
      null,
      "non-persistent: event gone → full cleanup (role/config deleted)"
    );
    const cfg = env.db.getEventReminderConfigById(persistent.id);
    assert.ok(cfg, "persistent config survives the event instance");
    assert.equal(cfg.active, 1);
    assert.equal(cfg.offsets[0].status, "retired");
    assert.match(cfg.offsets[0].last_error, /not found; persistent config kept/);
    assert.equal(
      env.db
        .claimDueReminders(T0 + 3_600_000, 50)
        .some((d) => d.config_id === persistent.id),
      false,
      "retired offsets of a persistent config never re-claim"
    );

    // Ticker cleanup is an automated mutation → one origin-'system' audit row
    // (pins the noteCleanup wiring, which is otherwise invisible to row state).
    const audited = env.db.db
      .prepare(
        `SELECT COUNT(*) AS c FROM admin_audit
         WHERE action='event_reminders.cleanup' AND target_id=?`
      )
      .get(String(transient.id));
    assert.equal(audited.c, 1, "event-gone cleanup writes the system audit trail");
  });
});
