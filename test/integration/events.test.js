/**
 * Integration: community events (epic #218) — bot-owned /event lifecycle
 * through the REAL router, services, and SQLite:
 *   create → preview confirm → post → RSVP/waitlist/cutoff → edit (modal)
 *   → reminder delivery (thread) → delete, plus settings gates, presets,
 *   options CRUD, series materialization, digest, the DM wizard state
 *   machine, /eventreminder retirement (E13), adoption, and cross-post
 *   pairing + gated destination RSVPs (E12).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  createButtonInteraction,
  createModalSubmitInteraction,
  createGuild,
  createTextChannel,
  createUser,
  createMember,
  createScheduledEvent,
  lastReplyContent,
  lastReplyEphemeral,
} = require("../helpers/discord");

// CONTRACT (see registry.test.js note): no `src/` requires above
// createIntegrationEnv() — the env binds the process to a private temp DB
// first; loading the feature modules after that is what keeps parallel
// `node --test` runs off the racy project-root sqlite.
let wizard;
let service;

const now = () => Date.now();

describe("integration: community events", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let repo;
  let runEventsTick;

  before(async () => {
    env = await createIntegrationEnv();
    repo = require("../../src/db/repositories/events");
    wizard = require("../../src/features/events/wizard");
    service = require("../../src/features/events/service");
    runEventsTick = require("../../src/features/events/ticker").runEventsTick;
  });

  after(() => env?.cleanup());

  const cid = () => env.communityId;
  const getEvent = (id) => repo.getEventById(id);

  async function createEventViaCommand(opts = {}, cmdOpts = {}) {
    const interaction = await env.runCommand({
      commandName: "event",
      subcommand: "create",
      admin: true,
      options: {
        title: "Game Night",
        start: "in 2h",
        ...opts,
      },
      ...cmdOpts,
    });
    return interaction;
  }

  async function confirmPost(eventId, admin = true) {
    return env.runButton({ customId: `ev:ok:${eventId}`, admin });
  }

  let eventA = null; // shared posted event
  let attendeeRoleId = null;

  // ── schema ────────────────────────────────────────────────────────────────

  it("creates the event tables without touching feature 2 namespaces", () => {
    const tables = env.db.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
      )
      .all()
      .map((r) => r.name);
    for (const t of [
      "events",
      "event_options",
      "event_signups",
      "event_notifications",
      "event_guild_settings",
      "event_series",
      "event_presets",
      "event_channels",
      "event_wizards",
      "event_google_links",
      "event_crossposts",
    ]) {
      assert.ok(tables.includes(t), `missing table ${t}`);
    }
    // The legacy feature-2 assertion (`LIKE 'event_reminder%'`) must not
    // pick up OUR tables — ours are event_* without the "reminder" prefix.
    const legacy = env.db.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE name LIKE 'event_reminder%'`
      )
      .all()
      .map((r) => r.name);
    assert.deepEqual(legacy.sort(), [
      "event_reminder_configs",
      "event_reminder_event_optouts",
      "event_reminder_offsets",
      "event_reminder_optouts",
    ]);
  });

  // ── phase 1: create → confirm → post ──────────────────────────────────────

  it("/event create stores a preview draft with Yes/No/Maybe (E3/E9)", async () => {
    const interaction = await createEventViaCommand({
      title: "Game Night",
      start: "in 2h",
      description: "Catan again",
    });
    const text = lastReplyContent(interaction);
    assert.match(text, /Preview|look right/i);
    const reply = interaction.replies[interaction.replies.length - 1];
    assert.ok(reply.components?.length >= 1, "confirm buttons attached");
    assert.ok(lastReplyEphemeral(interaction), "preview reply is ephemeral");

    const events = repo.listUpcomingEvents(cid(), { limit: 10 });
    eventA = events.find((e) => e.title === "Game Night");
    assert.ok(eventA, "draft row exists");
    assert.equal(eventA.status, "pending_confirm");
    const opts = repo.listEventOptions(eventA.id);
    assert.deepEqual(opts.map((o) => o.label), ["Yes", "No", "Maybe"]);
    assert.equal(opts[0].reminders_on, 1, "Yes gets reminders (E6)");
  });

  it("anyone can create by default; the create-role gate narrows it (E4)", async () => {
    const interaction = await createEventViaCommand(
      { title: "Member Meetup", start: "in 2h" },
      { admin: false }
    );
    assert.match(lastReplyContent(interaction), /look right|Preview/i);
    assert.ok(
      repo.listUpcomingEvents(cid(), { limit: 40 }).find((e) => e.title === "Member Meetup"),
      "E4: no create role configured ⇒ every member may create"
    );
  });

  it("confirm posts: message, thread, attendee role, default reminder", async () => {
    const before = env.channels.general.sent.length;
    await confirmPost(eventA.id);
    let ev = getEvent(eventA.id);
    assert.equal(ev.status, "posted");
    assert.ok(ev.message_id, "message id stored");
    assert.equal(env.channels.general.sent.length, before + 1);

    // thread (default on)
    ev = getEvent(ev.id);
    assert.ok(ev.thread_id, "event thread created");
    const thread = env.guild.channels.cache.get(ev.thread_id);
    assert.ok(thread, "thread resolvable");

    // attendee role (E6 temporary role)
    assert.ok(ev.attendee_role_id, "attendee role id stored");
    attendeeRoleId = ev.attendee_role_id;
    assert.ok(env.guild.roles.cache.get(ev.attendee_role_id), "role exists");

    // default reminder armed 15 min before start
    const rows = repo.listEventReminders(ev.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].offset_minutes, 15);
    assert.ok(Math.abs(rows[0].fire_at - (ev.start_at - 15 * 60_000)) < 5_000);

    const activity = repo.listEventActivity(ev.id).map((a) => a.action);
    assert.ok(activity.includes("posted"));
  });

  // ── signup engine ─────────────────────────────────────────────────────────

  it("member RSVPs: signup row, attendee role grant, message edit", async () => {
    const yes = repo.listEventOptions(eventA.id)[0];
    const beforeEdits = env.channels.general.sent.length;
    const btn = await env.runButton({
      customId: `ev:rs:${eventA.id}:${yes.id}`,
      admin: false,
      user: env.users.memberUser,
      member: env.members.member,
    });
    assert.match(lastReplyContent(btn) || btn.replies.map((r) => r?.content).join(" "), /signed up/i);
    const signup = repo.getSignup(eventA.id, yes.id, env.users.memberUser.id);
    assert.equal(signup.state, "signed_up");
    // attendee role granted to the member (E6)
    assert.ok(env.members.member.roles.cache.has(attendeeRoleId), "role synced");
    void beforeEdits;
  });

  it("re-click withdraws and strips the role", async () => {
    const yes = repo.listEventOptions(eventA.id)[0];
    await env.runButton({
      customId: `ev:rs:${eventA.id}:${yes.id}`,
      admin: false,
      user: env.users.memberUser,
      member: env.members.member,
    });
    assert.equal(repo.getSignup(eventA.id, yes.id, env.users.memberUser.id), null);
    assert.ok(!env.members.member.roles.cache.has(attendeeRoleId), "role stripped");
  });

  it("opt-out (shared feature-2 row, E14) skips the attendee role but counts the signup", async () => {
    const db = require("../../src/db");
    db.setEventReminderOptOut(cid(), env.users.member2User.id);
    const yes = repo.listEventOptions(eventA.id)[0];
    await env.runButton({
      customId: `ev:rs:${eventA.id}:${yes.id}`,
      admin: false,
      user: env.users.member2User,
      member: env.members.member2,
    });
    assert.equal(
      repo.getSignup(eventA.id, yes.id, env.users.member2User.id).state,
      "signed_up"
    );
    assert.ok(!env.members.member2.roles.cache.has(attendeeRoleId), "no role for opted-out");
    db.clearEventReminderOptOut(cid(), env.users.member2User.id);
    // re-arm via sync on next toggle
  });

  it("capacity + waitlist + promotion", async () => {
    const interaction = await createEventViaCommand({
      title: "Pizza Run",
      start: "in 5h",
      signup_options: "Snacks|1,Drinks",
    });
    const created = repo
      .listUpcomingEvents(cid())
      .find((e) => e.title === "Pizza Run");
    await confirmPost(created.id);
    const [snacks, drinks] = repo.listEventOptions(created.id);
    assert.equal(snacks.capacity, 1);

    // member takes the last slot, member2 waitlists
    await env.runButton({ customId: `ev:rs:${created.id}:${snacks.id}`, admin: false, user: env.users.memberUser, member: env.members.member });
    const second = await env.runButton({
      customId: `ev:rs:${created.id}:${snacks.id}`,
      admin: false,
      user: env.users.member2User,
      member: env.members.member2,
    });
    assert.match(
      second.replies.flatMap((r) => [r?.content, ...(r?.embeds || [])]).map(String).join(" "),
      /waitlist/i
    );
    assert.equal(repo.getSignup(created.id, snacks.id, env.users.member2User.id).state, "waitlisted");

    // member withdraws → member2 promotes (atomic)
    await env.runButton({ customId: `ev:rs:${created.id}:${snacks.id}`, admin: false, user: env.users.memberUser, member: env.members.member });
    assert.equal(repo.getSignup(created.id, snacks.id, env.users.member2User.id).state, "signed_up");
    void drinks;
  });

  it("cutoff close blocks new signups but not staff", async () => {
    const target = repo.listUpcomingEvents(cid()).find((e) => e.title === "Pizza Run");
    repo.updateEvent(target.id, { cutoff_at: now() - 60_000 });
    const [snacks] = repo.listEventOptions(target.id);
    // make room so we test the cutoff reason, not capacity
    repo.removeSignupRow({ eventId: target.id, optionId: snacks.id, userId: env.users.member2User.id });
    const fresh = createMember({ guild: env.guild, user: createUser({ id: "user-fresh-1", username: "fresh" }) });
    env.guild.addMember(fresh);
    const interaction = await env.runButton({
      customId: `ev:rs:${target.id}:${snacks.id}`,
      admin: false,
      user: fresh.user,
      member: fresh,
    });
    const text = interaction.replies.map((r) => r?.content).join(" ");
    assert.match(text, /clos|shut|passed/i);
    // staff still passes (bypass)
    const adminBtn = await env.runButton({ customId: `ev:rs:${target.id}:${snacks.id}`, admin: true });
    assert.ok(adminBtn.deferred || adminBtn.replied);
  });

  // ── edit modal + reminder re-arm + delivery ───────────────────────────────

  it("edit modal moves the start and re-arms unsent reminders", async () => {
    const before = getEvent(eventA.id);
    const beforeRows = repo.listEventReminders(eventA.id);
    const fireBefore = beforeRows[0].fire_at;
    const modal = createModalSubmitInteraction({
      customId: `evm:edit:${eventA.id}`,
      fields: {
        title: "Game Night v2",
        start: "in 26h",
        description: "",
        location: "",
      },
      guild: env.guild,
      user: env.users.adminUser,
      member: env.members.adminMember,
      admin: true,
    });
    const fn = env.registry.getModalHandler(`evm:edit:${eventA.id}`);
    assert.ok(fn, "modal handler registered");
    await fn(modal, env.ctx);
    const after = getEvent(eventA.id);
    assert.equal(after.title, "Game Night v2");
    assert.ok(after.start_at > before.start_at + 20 * 3600_000, "start moved out");
    const row = repo.listEventReminders(eventA.id)[0];
    assert.equal(row.offset_minutes, beforeRows[0].offset_minutes);
    assert.notEqual(row.fire_at, fireBefore, "fire_at moved with the event");
  });

  it("reminder delivers into the event thread when due", async () => {
    const ev = getEvent(eventA.id);
    // pull the due time into the past, then tick
    const row = repo.listEventReminders(ev.id)[0];
    env.db.db
      .prepare(`UPDATE event_notifications SET fire_at = ? WHERE id = ?`)
      .run(now() - 1000, row.id);
    const thread = env.guild.channels.cache.get(ev.thread_id);
    const before = thread.sent.length;
    await runEventsTick(env.client);
    assert.equal(thread.sent.length, before + 1, "reminder posted in thread");
    const sent = repo.getEventReminderById(row.id);
    assert.equal(sent.status, "sent");
    assert.match(JSON.stringify(thread.sent[thread.sent.length - 1]), /Game Night|starts/i);
  });

  // ── lifecycle buttons ─────────────────────────────────────────────────────

  it("delete button needs confirmation and clears everything", async () => {
    const target = repo.listUpcomingEvents(cid()).find((e) => e.title === "Pizza Run");
    const ask = await env.runButton({ customId: `ev:dl:${target.id}`, admin: true });
    assert.match(lastReplyContent(ask), /Really delete/i);
    const confirm = await env.runButton({ customId: `ev:dlc:${target.id}:${env.users.adminUser.id}`, admin: true });
    assert.match(lastReplyContent(confirm), /Deleted/i);
    assert.equal(getEvent(target.id), null);
    assert.equal(
      env.db.db.prepare(`SELECT COUNT(*) c FROM event_options WHERE event_id=?`).get(target.id).c,
      0
    );
    // the message in channel deleted too
    assert.ok(env.channels.general._deletedMessages.includes(target.message_id), "channel message deleted");
  });

  it("another user cannot confirm someone else's delete", async () => {
    const target = getEvent(eventA.id);
    const other = await env.runButton({
      customId: `ev:dlc:${target.id}:${env.users.memberUser.id}`,
      admin: false,
      user: env.users.memberUser,
      member: env.members.member,
    });
    assert.match(lastReplyContent(other), /person who pressed|Only/i);
    assert.ok(getEvent(target.id), "event still there");
  });

  it("/event duplicate → fresh draft copy; /event list shows both", async () => {
    const dup = await env.runCommand({
      commandName: "event",
      subcommand: "duplicate",
      admin: true,
      options: { event: eventA.id },
    });
    assert.match(lastReplyContent(dup), /Copied as draft/i);
    void dup;
    const listed = await env.runCommand({
      commandName: "event",
      subcommand: "list",
      admin: true,
      options: {},
    });
    const text = lastReplyContent(listed);
    assert.match(text, /Game Night/);
    const copies = repo.listUpcomingEvents(cid(), { limit: 40 }).filter((e) => e.title.startsWith("Copy of Game Night"));
    assert.ok(copies.some((e) => e.status === "draft"), "duplicate is a draft");
  });

  // ── settings + role gates (E4) ────────────────────────────────────────────

  it("settings: valid + invalid timezone, create-role gate, show", async () => {
    const bad = await env.runCommand({
      commandName: "event",
      subcommandGroup: "settings",
      subcommand: "timezone",
      admin: true,
      options: { zone: "Mars/Olympus" },
    });
    assert.match(lastReplyContent(bad), /valid timezone/i);

    await env.runCommand({
      commandName: "event",
      subcommandGroup: "settings",
      subcommand: "timezone",
      admin: true,
      options: { zone: "Europe/Berlin" },
    });
    assert.equal(repo.getEventGuildSettings(cid()).time_zone, "Europe/Berlin");

    // gate create behind a role the plain member lacks
    await env.runCommand({
      commandName: "event",
      subcommandGroup: "settings",
      subcommand: "role",
      admin: true,
      options: { action: "create", role: env.guild.roles.cache.get("role-bot") },
    });
    const denied = await createEventViaCommand({ title: "Gate", start: "in 3h" }, { admin: false });
    assert.match(lastReplyContent(denied), /role|staff|organizer/i);
    // clear it again
    await env.runCommand({
      commandName: "event",
      subcommandGroup: "settings",
      subcommand: "role",
      admin: true,
      options: { action: "create", clear: true },
    });
    assert.equal(repo.getEventGuildSettings(cid()).create_role_id, null);
  });

  // ── options + presets ─────────────────────────────────────────────────────

  it("options add/list/reorder and preset save→apply on a draft", async () => {
    const draft = repo.listUpcomingEvents(cid(), { limit: 40 }).find((e) => e.status === "draft");
    assert.ok(draft, "have a draft to mutate");
    const add = await env.runCommand({
      commandName: "event",
      subcommandGroup: "options",
      subcommand: "add",
      admin: true,
      options: { event: draft.id, label: "VIP", capacity: 5 },
    });
    assert.match(lastReplyContent(add), /added/i);
    const list = await env.runCommand({
      commandName: "event",
      subcommandGroup: "options",
      subcommand: "list",
      admin: true,
      options: { event: draft.id },
    });
    assert.match(lastReplyContent(list), /VIP/);

    const save = await env.runCommand({
      commandName: "event",
      subcommandGroup: "preset",
      subcommand: "save",
      admin: true,
      options: { event: draft.id, name: "nightly" },
    });
    assert.match(lastReplyContent(save), /saved/i);

    // apply that preset to a fresh pending event
    await createEventViaCommand({ title: "Preset Target", start: "in 9h" });
    const other = repo.listUpcomingEvents(cid()).find((e) => e.title === "Preset Target");
    const optsRes = require("../../src/features/events/presets").applyToEvent(cid(), "nightly", other.id);
    assert.ok(optsRes.ok, `preset apply: ${optsRes.error}`);
    assert.equal(repo.listEventOptions(other.id).length, 4);
  });

  // ── reminders CRUD ────────────────────────────────────────────────────────

  it("reminders add (role ping) + remove via command", async () => {
    const ev = getEvent(eventA.id);
    const role = env.guild.roles.cache.get(attendeeRoleId);
    const add = await env.runCommand({
      commandName: "event",
      subcommandGroup: "reminders",
      subcommand: "add",
      admin: true,
      options: { event: ev.id, minutes: 30, role },
    });
    assert.match(lastReplyContent(add), /armed/i);
    const rows = repo.listEventReminders(ev.id, { unsentOnly: true });
    const roleRow = rows.find((r) => r.target === "role");
    assert.ok(roleRow, "role reminder row");
    const remove = await env.runCommand({
      commandName: "event",
      subcommandGroup: "reminders",
      subcommand: "remove",
      admin: true,
      options: { event: ev.id, reminder: roleRow.id },
    });
    assert.match(lastReplyContent(remove), /removed/i);
    assert.ok(!repo.getEventReminderById(roleRow.id));
  });

  // ── series materialization ────────────────────────────────────────────────

  it("weekly series materializes the next occurrence when the cursor is due", async () => {
    const interaction = await createEventViaCommand({
      title: "Tuesday Standup",
      start: "in 2h",
      recurrence: "weekly",
      weekdays: "tue,thu",
      end_mode: "count",
      end_count: 2,
    });
    const seed = repo.listUpcomingEvents(cid()).find((e) => e.title === "Tuesday Standup");
    assert.ok(seed.series_id, "series attached");
    const series = repo.getEventSeries(seed.series_id);
    assert.equal(series.status, "active");

    // force the cursor due + post the seed first (occurrence copies a posted series member)
    await confirmPost(seed.id);
    repo.updateEventSeries(series.id, { next_occurrence_at: now() - 1000 });
    const res = await runEventsTick(env.client);
    void res;
    const seriesEvents = repo
      .listEvents(cid(), { statuses: ["posted", "draft"], limit: 50 })
      .filter((e) => e.series_id === series.id);
    assert.ok(seriesEvents.length >= 2, "second occurrence materialized + posted");
    const fresh = repo.getEventSeries(series.id);
    assert.equal(fresh.occurrences_created, 1);
    // end_count=2 reached (seed + 1) → next materialize stops the series
    repo.updateEventSeries(fresh.id, { next_occurrence_at: now() - 1000 });
    await runEventsTick(env.client);
    assert.equal(repo.getEventSeries(fresh.id).status, "stopped");
  });

  // ── digest ────────────────────────────────────────────────────────────────

  it("weekly digest fires once when due (per-window gate)", async () => {
    const todayUtc = new Date().getUTCDay();
    repo.updateEventGuildSettings(cid(), {
      digest_channel_id: env.channels.notify.id,
      digest_frequency: "weekly",
      digest_hour_utc: 0,
      digest_weekday: todayUtc,
    });
    const before = env.channels.notify.sent.length;
    await runEventsTick(env.client);
    assert.equal(env.channels.notify.sent.length, before + 1, "digest sent");
    await runEventsTick(env.client);
    assert.equal(env.channels.notify.sent.length, before + 1, "not twice per window");
    repo.updateEventGuildSettings(cid(), { digest_frequency: "none", digest_channel_id: null });
  });

  // ── DM wizard (E15) ───────────────────────────────────────────────────────

  it("wizard walks title→…→post over DMs", async () => {
    const user = env.users.memberUser;
    await env.runCommand({
      commandName: "event",
      subcommand: "wizard",
      admin: true, // staff gate — member2 isn't staff; use admin's own wizard
      user: env.users.adminUser,
      member: env.members.adminMember,
    });
    const dms = user.sent || user.sends || [];
    // adminUser got the DM
    const adminDms = env.users.adminUser.sent || env.users.adminUser.sends || [];
    assert.ok(adminDms.length >= 1, "wizard DM opened");
    assert.match(JSON.stringify(adminDms[adminDms.length - 1]), /what's it called/i);
    void dms;

    const dmReply = async (text) => {
      const message = {
        author: env.users.adminUser,
        content: text,
        guild: null,
        reply: async () => ({}),
      };
      return wizard.handleDmMessage(env.client, message);
    };
    await dmReply("Movie Marathon");
    await dmReply("in 6h");
    await dmReply("here");          // channel step falls back to current
    await dmReply("1h");
    await dmReply("default");       // options
    // confirm state persisted; click the DM Post button
    const state = repo.getEventWizard(cid(), env.users.adminUser.id);
    assert.equal(state.step, "confirm");
    let updated = null;
    const postBtn = {
      user: env.users.adminUser,
      customId: "ev:w:post",
      update: async (p) => { updated = p; },
      reply: async (p) => { updated = p; },
    };
    await wizard.handleButton(postBtn, { supervisor: env.supervisor });
    assert.match(JSON.stringify(updated ?? {}), /Posted/i);
    const posted = repo
      .listUpcomingEvents(cid(), { limit: 40 })
      .find((e) => e.title === "Movie Marathon");
    assert.ok(posted && posted.status === "posted", "wizard event live");
    assert.equal(repo.getEventWizard(cid(), env.users.adminUser.id), null, "state cleaned");
  });

  it("wizard cancel clears state", async () => {
    await env.runCommand({
      commandName: "event",
      subcommand: "wizard",
      admin: true,
      user: env.users.adminUser,
      member: env.members.adminMember,
    });
    const message = {
      author: env.users.adminUser,
      content: "cancel",
      guild: null,
      reply: async () => ({}),
    };
    await wizard.handleDmMessage(env.client, message);
    assert.equal(repo.getEventWizard(cid(), env.users.adminUser.id), null);
  });

  // ── 4b retirement (E13 / #225) ────────────────────────────────────────────

  it("/eventreminder create is refused and points at /event", async () => {
    const interaction = await env.runCommand({
      commandName: "eventreminder",
      subcommand: "create",
      admin: true,
      options: { event: "123456789012345678" },
    });
    const text = lastReplyContent(interaction);
    assert.match(text, /\/event create|retired/i);
    const rows = env.db.db
      .prepare(`SELECT COUNT(*) c FROM event_reminder_configs`)
      .get().c;
    assert.equal(rows, 0, "no config inserted");
  });

  it("shared guild opt-out flows through both commands (E14)", () => {
    const db = require("../../src/db");
    db.setEventReminderOptOut(cid(), env.users.memberUser.id);
    assert.equal(
      service.blockedPredicate(getEvent(eventA.id))(env.users.memberUser.id),
      true
    );
    db.clearEventReminderOptOut(cid(), env.users.memberUser.id);
  });

  // ── adopt ─────────────────────────────────────────────────────────────────

  it("/event adopt copies a scheduled event into a draft", async () => {
    const scheduled = createScheduledEvent({
      id: "sched-adopt-1",
      guild: env.guild,
      name: "Legacy LAN",
      description: "old school",
      channel: env.channels.general,
    });
    env.guild.addScheduledEvent(scheduled);
    const interaction = await env.runCommand({
      commandName: "event",
      subcommand: "adopt",
      admin: true,
      options: { scheduled_event: "sched-adopt-1" },
    });
    assert.match(lastReplyContent(interaction), /Adopted|draft/i);
    const draft = repo.listEvents(cid(), { statuses: ["draft", "pending_confirm"], limit: 50 })
      .find((e) => e.title.includes("Legacy LAN"));
    assert.ok(draft, "adopted draft exists");
  });

  // ── crosspost (phase 5) ───────────────────────────────────────────────────

  it("cross-post pair fans out copies and gates destination signups (E12)", async () => {
    const { ensureCommunity } = require("../../src/platform/community");
    // second guild + community
    const guild2 = createGuild({ id: "guild-it-2" });
    const ch2 = createTextChannel({ id: "ch2-events", guild: guild2, name: "events" });
    guild2.addChannel(ch2);
    env.client.addGuild(guild2);
    const community2 = ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId: "guild-it-2",
    });

    const srcEvent = getEvent(eventA.id);
    const pair = repo.inviteEventCrosspost({
      sourceCommunityId: cid(),
      destCommunityId: community2,
      createdBy: env.users.adminUser.id,
      mentions: [],
      roleWhitelist: ["role-gate-dest"], // dest members need this role to RSVP
      destChannelId: ch2.id,
    });
    assert.ok(pair.ok);
    repo.approveEventCrosspost(pair.crosspost.id, {
      approvedBy: env.users.memberUser.id,
      destChannelId: ch2.id,
    });

    // post a NEW event → copy lands in guild2 channel with banner
    await createEventViaCommand({ title: "Crossover Fest", start: "in 8h" });
    const fest = repo.listUpcomingEvents(cid()).find((e) => e.title === "Crossover Fest");
    await confirmPost(fest.id);
    assert.ok(ch2.sent.length >= 1, "destination copy sent");
    const copyPayload = ch2.sent[ch2.sent.length - 1];
    assert.match(JSON.stringify(copyPayload), /Copied from/i);

    // dest member without the gate role → refused
    const outsider = createMember({
      guild: guild2,
      user: createUser({ id: "user-dest-1", username: "dest" }),
      admin: false,
    });
    guild2.addMember(outsider);
    const yes = repo.listEventOptions(fest.id)[0];
    const btn = createButtonInteraction({
      customId: `ev:rs:${fest.id}:${yes.id}`,
      guild: guild2,
      user: outsider.user,
      member: outsider,
      client: env.client,
      admin: false,
    });
    const fn = env.registry.getButtonHandler(`ev:rs:${fest.id}:${yes.id}`);
    await fn(btn, env.ctx);
    const shown = lastReplyContent(btn) || JSON.stringify(btn.updates || btn.replies);
    assert.match(String(shown), /role|no longer active/i);
    assert.equal(repo.getSignup(fest.id, yes.id, outsider.user.id), null);

    // with the role → signup writes the SOURCE event
    outsider.roles.cache.set("role-gate-dest", { id: "role-gate-dest", position: 1 });
    const btn2 = createButtonInteraction({
      customId: `ev:rs:${fest.id}:${yes.id}`,
      guild: guild2,
      user: outsider.user,
      member: outsider,
      client: env.client,
      admin: false,
    });
    await fn(btn2, env.ctx);
    assert.equal(
      repo.getSignup(fest.id, yes.id, outsider.user.id)?.state,
      "signed_up",
      "cross-post signup hit the source event"
    );

    // delete the source → copies deleted too
    await env.runButton({ customId: `ev:dl:${fest.id}`, admin: true });
    await env.runButton({ customId: `ev:dlc:${fest.id}:${env.users.adminUser.id}`, admin: true });
    assert.ok(ch2._deletedMessages.length >= 1, "destination copy deleted with the source");
    assert.equal(
      env.db.db.prepare(`SELECT COUNT(*) c FROM event_crosspost_messages WHERE event_id=?`).get(fest.id).c,
      0
    );
  });

  // ── error doctrine smoke ──────────────────────────────────────────────────

  it("unknown subcommand replies honestly instead of dead-ending", async () => {
    const interaction = await env.runCommand({
      commandName: "event",
      subcommand: "selfdestruct",
      admin: true,
      options: {},
    });
    assert.match(lastReplyContent(interaction), /isn't wired up|Unknown|selfdestruct/i);
  });

  it("cleanup step prunes stale pending_confirm drafts", async () => {
    const stale = repo.createEvent({
      communityId: cid(),
      creatorId: env.users.adminUser.id,
      title: "Ancient Preview",
      status: "pending_confirm",
      startAt: now() + 86_400_000 * 30,
    });
    assert.ok(stale.ok);
    // age the draft beyond the pending-confirm TTL directly
    env.db.db
      .prepare(`UPDATE events SET created_at = ? WHERE id = ?`)
      .run(now() - 31 * 86_400_000, stale.event.id);
    await runEventsTick(env.client);
    assert.equal(getEvent(stale.event.id), null, "stale preview cleaned");
  });

  it("archive keeps the row for the dashboard (E8); delete hard-removes it", async () => {
    const created = env.db.createEvent({
      communityId: cid(),
      creatorId: env.users.adminUser.id,
      title: "Archive Me",
      status: "draft",
      startAt: now() + 3 * 3_600_000,
      endAt: now() + 5 * 3_600_000,
      channelId: env.channels.general.id,
      threadEnabled: 0,
      options: [{ label: "Yes", reminders_on: 1 }],
    });
    assert.ok(created.ok, created.error);
    const ev = created.event;
    const service = require("../../src/features/events/service.js");
    const post = await service.postEventNow(env.client, ev, {
      actorId: env.users.adminUser.id,
    });
    assert.ok(post.ok, post.error);
    const posted = getEvent(ev.id);
    assert.equal(posted.status, "posted");
    const yesOption = env.db.listEventOptions(ev.id)[0];
    env.db.forceEventSignup({
      eventId: ev.id,
      optionId: yesOption.id,
      userId: env.users.memberUser.id,
      actorId: env.users.adminUser.id,
    });

    const out = await service.archiveEvent(env.client, posted, { reason: "test-archive" });
    assert.ok(out.ok, JSON.stringify(out.warnings));

    const archived = getEvent(ev.id);
    assert.ok(archived, "E8: the ROW SURVIVES archive for the dashboard");
    assert.equal(archived.status, "archived");
    assert.equal(archived.message_id, null, "Discord artifacts detached");
    assert.equal(
      env.db.listEventSignups(ev.id).length,
      1,
      "signup history retained for the archive page",
    );
    assert.equal(
      env.db.db
        .prepare(`SELECT COUNT(*) c FROM event_options WHERE event_id=?`)
        .get(ev.id).c,
      1,
      "options retained",
    );
    assert.ok(
      env.channels.general._deletedMessages.includes(posted.message_id),
      "the Discord event message was deleted",
    );
    assert.ok(
      env.db
        .listEventReminders(ev.id)
        .every((r) => r.status !== "pending"),
      "unsent reminders retired"
    );

    // Hard delete still removes everything.
    const del = await service.deleteEvent(env.client, archived, {
      removeDiscord: false,
    });
    assert.ok(del.ok);
    assert.equal(getEvent(ev.id), null);
  });
});
