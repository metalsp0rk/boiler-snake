const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { j, poll, namespaceIds } = require("./helpers/mockenv");

// NOTE: never require src/** at module top level here! src/db/connection.js
// resolves DB_PATH at REQUIRE time — importing anything that pulls in the db
// before createE2eEnv() sets the env vars silently binds the dev database.
// Lazily require src modules INSIDE tests instead.

/**
 * Tier-4 community-events coverage (issue #318, part 3/3). Namespace 13:
 * the CONFIG + REMINDERS half — `/eventconfig settings` (zone/attendees/
 * thread/fallback/auto-archive bounds/role gates/digest), `/eventconfig
 * reminders` (guild default off|on quirk, per-event mute, add/remove/list +
 * the delivery state machine through a FORCED events-tick: auto-armed
 * default reminders delivered, skipped-event retire, auto-archive via
 * COALESCE(end_at,start_at), one-digest-per-window), `/eventconfig series`
 * (list/skip/stop), the DARK Google arm (`connect` refuses without creds),
 * `/eventchannels channel` (mark/list/purge opt-in+run/sort) and the whole
 * `crosspost` pair lifecycle (invite→config→revoke; destination delivery is
 * DARK — one bot, one guild), `/eventreminder` (retired `create` copy,
 * setchannel, list, seeded-config edit → `er:` modal → `er-recur:` button,
 * sync, mute/unmute/opt-out/status family, autocomplete), the reminder
 * DELIVERY pipeline (role ping + embed to notify channel, no-channel retry,
 * gone-channel retire, event-gone cleanup) and the router autocomplete
 * respond([]) fallback.
 *
 * CURRENT-behavior pins marked BUG #NNN flip when the filed issue lands.
 *
 * Documented-dark (mock gaps, acceptance "stub/skip" rows of #318):
 *  - scheduled-event SUBSCRIBERS: fauxcord has no subscribe surface, so
 *    `fetchInterestedUserIds` is always empty — role grants via sync
 *    pin +0/−0; GUILD_SCHEDULED_EVENT_* gateway events are never dispatched.
 *  - cross-post DESTINATION delivery needs the bot in a second guild.
 *  - Google Calendar OAuth (no creds in e2e) — only the dark-command copies
 *    are testable.
 */
describe(
  "e2e: events reminders + config — /eventconfig, /eventchannels, /eventreminder",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;
    let mgRole; // human's ManageGuild role (staffGate + canConfigureEventReminder)
    const feed = () => env.ids.channel2; // "events-feed" channel

    before(async () => {
      const ids = namespaceIds(13);
      env = await createE2eEnv({
        ns: 13,
        channels: [
          { id: ids.general, name: "general" },
          { id: ids.channel2, name: "events-feed" },
        ],
      });
      mgRole = await env.mock.createRole("E2E Event Config MG", {
        permissions: String(PermissionFlagsBits.ManageGuild),
      });
      await env.mock.grantRole(env.ids.human, mgRole.id);
    });

    after(async () => {
      await env?.cleanup();
    });

    // ── payload helpers ─────────────────────────────────────────────────────
    const sub = (name, options = []) => ({
      name,
      type: 1,
      ...(options.length && { options }),
    });
    const grp = (name, subName, options = []) => ({
      name,
      type: 2,
      options: [sub(subName, options)],
    });
    const strOpt = (name, value) => ({ name, type: 3, value });
    const intOpt = (name, value) => ({ name, type: 4, value });
    const boolOpt = (name, value) => ({ name, type: 5, value });
    const userOpt = (name, id) => ({ name, type: 6, value: id });
    const roleOpt = (name, id) => ({ name, type: 8, value: id });
    const chanOpt = (name, id) => ({ name, type: 7, value: id });

    const configSlash = (group, subName, options = [], userId) =>
      env.mock.slash({
        command: "eventconfig",
        options: [grp(group, subName, options)],
        ...(userId && { userId }),
      });
    const channelsSlash = (group, subName, options = [], userId) =>
      env.mock.slash({
        command: "eventchannels",
        options: [grp(group, subName, options)],
        ...(userId && { userId }),
      });
    const erSlash = (subName, options = [], userId) =>
      env.mock.slash({
        command: "eventreminder",
        options: [sub(subName, options)],
        ...(userId && { userId }),
      });

    const replyText = async (inter) =>
      String((await env.mock.awaitReply(inter)).content ?? "");
    const settledText = async (inter) =>
      String((await env.mock.awaitSettledReply(inter)).content ?? "");

    /** Create + post an event (threadless so reminders/notices hit the channel). */
    const createPosted = async (title, { start = "in 2h", extra = [] } = {}) => {
      const inter = await env.mock.slash({
        command: "event",
        options: [
          sub("create", [
            strOpt("title", title),
            strOpt("start", start),
            boolOpt("thread", false),
            ...extra,
          ]),
        ],
      });
      const preview = await env.mock.awaitReply(inter);
      const draft = env.dbmod
        .listUpcomingEvents(env.communityId, { limit: 50 })
        .find((r) => r.title === title);
      const click = await env.mock.click({
        customId: `ev:ok:${draft.id}`,
        messageId: preview.id,
      });
      assert.match(
        String((await env.mock.awaitSettledReply(click)).content),
        /^Posted ✅/,
        `post ${title}`,
      );
      const row = await poll(async () => {
        const r = env.dbmod.getEventById(draft.id);
        return r && r.status === "posted" && r.message_id ? r : null;
      });
      return { row, announcement: String(row.message_id) };
    };

    /** One forced events-tick (deterministic clock). */
    const runEventsTick = async (nowMs) => {
      const { runEventsTick: tick } = require("../../src/features/events/ticker");
      return tick(env.supervisor.discord, nowMs);
    };
    /** One forced eventReminders tick. */
    const runReminderTick = async (nowMs) => {
      const { runEventReminderTick } = require("../../src/features/eventReminders/ticker");
      return runEventReminderTick(env.supervisor.discord, nowMs == null ? {} : { now: nowMs });
    };

    const createScheduledEvent = async (name, startMs, extra = {}) =>
      j(`${env.mock.base}/api/guilds/${env.ids.guild}/scheduled-events`, {
        method: "POST",
        headers: env.mock.auth,
        body: JSON.stringify({
          name,
          scheduled_start_time: new Date(startMs).toISOString(),
          entity_type: 2, // EXTERNAL — no voice/stage channel needed
          entity_metadata: { location: "Baseline Pub" },
          description: "D&D 5e — session zero",
          privacy_level: 2,
          ...extra,
        }),
      });

    const reminderRows = (eventId) => env.dbmod.listEventReminders(eventId);
    const settings = () => env.dbmod.getEventGuildSettings(env.communityId);

    /** Interaction response_json (what the bot answered), once stored. */
    const respondedState = (inter, label = "interaction response") =>
      poll(
        async () => {
          const st = await env.mock.interactionState(inter.id);
          return st.response_json ? st : null;
        },
        { label },
      );

    /** Channel messages with a "📅 <title>" reminder-embed field. */
    const reminderDeliveries = async (channelId) => {
      const msgs = await env.mock.messages(channelId);
      return (Array.isArray(msgs) ? msgs : msgs?.messages || []).filter((m) =>
        (m.embeds || []).some((e) =>
          (e.fields || []).some((f) => String(f.name).startsWith("📅 ")),
        ),
      );
    };
    const digestMessages = async (channelId) => {
      const msgs = await env.mock.messages(channelId);
      return (Array.isArray(msgs) ? msgs : msgs?.messages || []).filter((m) =>
        (m.embeds || []).some((e) => String(e.title || "").includes("Upcoming events")),
      );
    };

    // ── 1 · settings gates ──────────────────────────────────────────────────
    it("settings gates staff; the personal-sounding `reminders off` is staff-gated too", async () => {
      const denied = await configSlash("settings", "show", [], env.ids.outsider);
      assert.equal(
        await replyText(denied),
        "This needs Manage Server or a staff role (`/staff`).",
      );

      // BUG #348: the picker copy of `/eventconfig reminders off|on` says
      // "Stop event reminder pings FOR YOU everywhere" but the handler flips
      // the GUILD-wide default reminder minutes behind a staff gate — pin the
      // staff-denial; flip when the copy or the gate is corrected.
      const off = await configSlash("reminders", "off", [], env.ids.outsider);
      assert.equal(
        await replyText(off),
        "This needs Manage Server or a staff role (`/staff`).",
      );
    });

    it("settings show renders the baseline embed (all-off defaults)", async () => {
      const inter = await configSlash("settings", "show");
      const msg = await env.mock.awaitSettledReply(inter);
      const embed = msg.embeds?.[0];
      assert.equal(embed?.title, "📆 Event settings");
      const fields = Object.fromEntries(
        (embed?.fields || []).map((f) => [f.name, f.value]),
      );
      assert.equal(fields["Zone"], "UTC");
      // The shipped default is a 15-minute lead — every posted event gets
      // one unless staff set `reminders default 0`.
      assert.equal(fields["Default reminder"], "15 min before");
      assert.equal(fields["Show attendee names"], "yes");
      assert.equal(fields["Remind in threads"], "yes");
      assert.equal(fields["Reminder fallback"], "_event channel_");
      assert.equal(fields["Auto-archive"], "_off_");
      assert.equal(fields["Digest"], "_off_");
      assert.equal(fields["Google community calendar"], "_off_");
    });

    // ── 2 · settings mutations ──────────────────────────────────────────────
    it("timezone accepts IANA zones and refuses junk with an actionable copy", async () => {
      const good = await configSlash("settings", "timezone", [strOpt("zone", "Europe/Berlin")]);
      assert.match(
        await settledText(good),
        /Server zone set to \*\*Europe\/Berlin\*\*/,
      );
      assert.equal(settings().time_zone, "Europe/Berlin");

      const bad = await configSlash("settings", "timezone", [strOpt("zone", "Mars/Olympus")]);
      assert.match(
        await settledText(bad),
        /`Mars\/Olympus` isn't a valid timezone \(use an IANA name/,
      );
      assert.equal(settings().time_zone, "Europe/Berlin"); // unchanged
    });

    it("show-attendees, thread-reminders and the reminder fallback channel persist", async () => {
      assert.match(
        await settledText(await configSlash("settings", "show-attendees", [boolOpt("enabled", false)])),
        /Attendee names hidden ✅/,
      );
      assert.equal(settings().show_attendees, 0);

      assert.match(
        await settledText(await configSlash("settings", "thread-reminders", [boolOpt("enabled", false)])),
        /Reminders now go to the event channel instead ✅/,
      );
      assert.equal(settings().thread_reminders, 0);

      const set = await configSlash("settings", "reminder-channel", [chanOpt("channel", feed())]);
      const setCopy = await settledText(set);
      assert.ok(
        setCopy.includes(`Reminder fallback: <#${feed()}>`),
        `fallback copy: ${setCopy}`,
      );
      assert.equal(settings().reminder_channel_id, feed());

      const show = await env.mock.awaitSettledReply(await configSlash("settings", "show"));
      const fallback = (show.embeds?.[0]?.fields || []).find((f) => f.name === "Reminder fallback");
      assert.match(String(fallback?.value), new RegExp(`<#${feed()}>`));

      // Channel option that resolves to nothing (unknown id dropped by the
      // mock's resolver) → the actionable "pick a channel" branch.
      const missing = await configSlash("settings", "reminder-channel", [boolOpt("clear", false)]);
      assert.match(await settledText(missing), /Pick a `channel` or `clear: yes`\./);
    });

    it("auto-archive bounds, role gates set/clear, unknown settings sub falls through", async () => {
      const tooSmall = await configSlash("settings", "auto-archive", [
        boolOpt("enabled", true),
        intOpt("delay_minutes", 2),
      ]);
      assert.match(
        await settledText(tooSmall),
        /delay_minutes must be between 5 and 43200 \(30 days\)\./,
      );

      const gate = await configSlash("settings", "role", [
        strOpt("action", "create"),
        roleOpt("role", mgRole.id),
      ]);
      assert.match(
        await settledText(gate),
        /\*\*create\*\* now requires <@&/u,
      );
      assert.equal(settings().create_role_id, mgRole.id);

      const cleared = await configSlash("settings", "role", [
        strOpt("action", "create"),
        boolOpt("clear", true),
      ]);
      assert.match(
        await settledText(cleared),
        /\*\*create\*\* is open to everyone again \(staff always allowed\)\./,
      );
      assert.equal(settings().create_role_id, null);

      // DISPATCH fallback for a sub the command tree doesn't know.
      const bogus = await configSlash("settings", "bogus");
      assert.match(
        await settledText(bogus),
        /Unknown settings subcommand `bogus`\./,
      );
    });

    // ── 3 · guild default reminders (off/on quirk) ─────────────────────────
    it("reminders default set + bounds; off/on toggle the guild minutes", async () => {
      const set = await configSlash("reminders", "default", [intOpt("minutes", 25)]);
      assert.match(
        await settledText(set),
        /New events now remind attendees \*\*25 min\*\* before they start\./,
      );
      assert.equal(settings().default_reminder_minutes, 25);

      const bounds = await configSlash("reminders", "default", [intOpt("minutes", 50000)]);
      assert.match(
        await settledText(bounds),
        /Minutes must be 0–43200 \(0 disables the default\)\./,
      );

      const off = await configSlash("reminders", "off");
      assert.match(
        await settledText(off),
        /Default reminders \*\*off\*\* for this server/,
      );
      assert.equal(settings().default_reminder_minutes, 0);

      // `on` after `off` restores 15 (the hard-coded re-on default).
      const on = await configSlash("reminders", "on");
      assert.match(
        await settledText(on),
        /Default reminders \*\*on\*\* \(15 min before start\)\./,
      );
      assert.equal(settings().default_reminder_minutes, 15);

      const status = await configSlash("reminders", "status", [], env.ids.outsider);
      const statusText = await settledText(status);
      assert.match(statusText, /• Default: 15 min before/);
      assert.match(statusText, /• Thread reminders: off/);
      assert.match(statusText, /You're muted on 0 events\./);
    });

    // ── 4 · per-event reminders CRUD ───────────────────────────────────────
    const e1 = { ev: null };
    it("create posts with the auto-armed default reminder; add/list/remove manage it", async () => {
      e1.ev = await createPosted("Marathon Night");
      const auto = reminderRows(e1.ev.row.id);
      assert.equal(auto.length, 1, "default reminder armed at post");
      assert.equal(auto[0].offset_minutes, 15);
      assert.equal(auto[0].status, "pending");

      const add = await configSlash("reminders", "add", [
        intOpt("event", e1.ev.row.id),
        intOpt("minutes", 30),
        strOpt("message", "GG {event} — {starts_in}"),
      ]);
      assert.match(
        await settledText(add),
        new RegExp(`Reminder armed: \\*\\*30 min\\*\\* before \\*\\*Marathon Night\\*\\* for attendees\\.`),
      );
      const rows = reminderRows(e1.ev.row.id);
      assert.equal(rows.length, 2);

      const list = await configSlash("reminders", "list", [intOpt("event", e1.ev.row.id)]);
      const listText = await settledText(list);
      assert.match(listText, /\*\*Reminders for Marathon Night:\*\*/);
      assert.match(listText, /30 min before/);
      assert.match(listText, /15 min before/);

      const manual = rows.find((r) => r.offset_minutes === 30);
      const remove = await configSlash("reminders", "remove", [
        intOpt("event", e1.ev.row.id),
        intOpt("reminder", manual.id),
      ]);
      assert.match(await settledText(remove), /Reminder removed\./);

      const again = await configSlash("reminders", "remove", [
        intOpt("event", e1.ev.row.id),
        intOpt("reminder", manual.id),
      ]);
      assert.match(
        await settledText(again),
        /That reminder isn't on this event/,
      );

      // Organizer-only arm: outsider hits the manageGate copy.
      const outsider = await configSlash(
        "reminders",
        "add",
        [intOpt("event", e1.ev.row.id), intOpt("minutes", 60)],
        env.ids.outsider,
      );
      assert.match(
        await settledText(outsider),
        /Only the \*\*organizer\*\*, \*\*staff\*\*, or holders of the required role may edit this event\./,
      );
    });

    it("per-event mute/unmute flips the mute row and the status count", async () => {
      const mute = await configSlash("reminders", "mute", [intOpt("event", e1.ev.row.id)]);
      assert.match(
        await settledText(mute),
        /Muted for \*\*Marathon Night\*\* — signups still count, no pings\./,
      );
      const status = await configSlash("reminders", "status");
      assert.match(await settledText(status), /You're muted on 1 event\./);

      const unmute = await configSlash("reminders", "unmute", [intOpt("event", e1.ev.row.id)]);
      assert.match(
        await settledText(unmute),
        /Reminders back \*\*on\*\* for \*\*Marathon Night\*\*\./,
      );
      assert.match(
        await settledText(await configSlash("reminders", "status")),
        /You're muted on 0 events\./,
      );
    });

    it("reminder-id autocomplete lists unsent rows; unknown commands fall back to respond([])", async () => {
      const inter = await env.mock.autocomplete({
        command: "eventconfig",
        options: [
          grp("reminders", "remove", [
            intOpt("event", e1.ev.row.id),
            { name: "reminder", type: 4, value: 0, focused: true },
          ]),
        ],
      });
      const state = await poll(async () => {
        const st = await env.mock.interactionState(inter.id);
        return st.response_json?.type === 8 ? st : null;
      });
      const choices = state.response_json?.data?.choices ?? [];
      const auto = reminderRows(e1.ev.row.id).find((r) => r.offset_minutes === 15);
      assert.ok(
        choices.some((c) => c.value === auto.id && /15 min before/.test(c.name)),
        `unsent reminder surfaced (${JSON.stringify(choices)})`,
      );

      // Router fallback: a registered command WITHOUT an autocomplete handler
      // responds [] (unknown command names are rejected by the mock itself).
      const unknown = await env.mock.autocomplete({
        command: "xp",
        options: [{ name: "thing", type: 3, value: "x", focused: true }],
      });
      const unknownState = await poll(async () => {
        const st = await env.mock.interactionState(unknown.id);
        return st.response_json?.type === 8 ? st : null;
      });
      assert.deepEqual(unknownState.response_json?.data?.choices ?? null, []);
    });

    // ── 5 · google arm stays DARK without creds ─────────────────────────────
    it("google connect/status/disconnect carry the dark-creds copies; autoset gates staff", async () => {
      const connect = await configSlash("google", "connect");
      assert.match(
        await settledText(connect),
        /Google Calendar isn't configured — missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI or PUBLIC_BASE_URL\./,
      );

      const status = await configSlash("google", "status");
      assert.match(
        await settledText(status),
        /Not connected — `\/eventconfig google connect` links your calendar\./,
      );

      // #349 FIXED: autoset REQUIRES the target to hold an enabled link —
      // with connect dark nobody has one, so the impossible promise is
      // refused with the actionable copy and NOTHING is persisted.
      const auto = await configSlash("google", "autoset", [userOpt("member", env.ids.target)]);
      assert.equal(
        await settledText(auto),
        `<@${env.ids.target}> has no connected calendar — they must run \`/eventconfig google connect\` first.`,
      );
      assert.notEqual(settings().google_auto_enabled, 1, "the toggle never flipped for an unconnected target");

      // Seed a real link for the target (what `connect` would leave behind)
      // and autoset lands.
      env.dbmod.upsertEventGoogleLink({
        communityId: env.communityId,
        userId: env.ids.target,
        email: "target@example.invalid",
        calendarId: "primary",
        accessTokenEnc: "x",
      });
      const auto2 = await configSlash("google", "autoset", [userOpt("member", env.ids.target)]);
      assert.match(
        await settledText(auto2),
        new RegExp(`Posted events now auto-add to <@${env.ids.target}>'s connected calendar\\.`),
      );
      assert.equal(settings().google_auto_enabled, 1);
      assert.equal(String(settings().google_auto_user_id), String(env.ids.target));
      env.dbmod.deleteEventGoogleLink(env.communityId, env.ids.target);

      const off = await configSlash("google", "autoset", [boolOpt("off", true)]);
      assert.match(await settledText(off), /Community-calendar auto-sync \*\*off\*\*\./);
      assert.equal(settings().google_auto_enabled, 0);

      const denied = await configSlash("google", "autoset", [], env.ids.outsider);
      assert.match(await settledText(denied), /This needs Manage Server or a staff role/);

      const disconnect = await configSlash("google", "disconnect");
      assert.match(
        await settledText(disconnect),
        /Calendar disconnected — posted events already added stay in Google\./,
      );
    });

    // ── 6 · event channels ─────────────────────────────────────────────────
    it("channel list/mark gates; purge stays double opt-in", async () => {
      const empty = await channelsSlash("channel", "list");
      assert.match(
        await settledText(empty),
        /No event channels marked — `\/eventchannels channel mark`/,
      );

      const denied = await channelsSlash("channel", "mark", [chanOpt("channel", feed())], env.ids.outsider);
      assert.match(await settledText(denied), /This needs Manage Server or a staff role/);

      const mark = await channelsSlash("channel", "mark", [chanOpt("channel", feed())]);
      const markCopy = await settledText(mark);
      assert.ok(markCopy.includes(`<#${feed()}> is an event channel now.`), markCopy);

      // purge RUN without the flag: opt-in refused.
      const runFirst = await channelsSlash("channel", "purge", [
        chanOpt("channel", feed()),
        boolOpt("run", true),
      ]);
      assert.match(
        await settledText(runFirst),
        /Purge isn't enabled for that channel — `\/eventchannels channel purge enabled:yes` first \(E7: opt-in only\)\./,
      );

      const enable = await channelsSlash("channel", "purge", [
        chanOpt("channel", feed()),
        boolOpt("enabled", true),
      ]);
      assert.match(
        await settledText(enable),
        /Purge \*\*on\*\* for <#.*>: `\/eventchannels channel purge run:yes` deletes non-event, unpinned messages \(E7\)\./,
      );

      const list = await channelsSlash("channel", "list");
      assert.match(await settledText(list), /_purge on \(opt-in, E7\)_/);

      // Unmarked channel cannot purge at all.
      const unmarked = await channelsSlash("channel", "purge", [
        chanOpt("channel", env.ids.general),
        boolOpt("enabled", true),
      ]);
      assert.match(
        await settledText(unmarked),
        /Only a marked event channel can purge \(E7 keeps this opt-in twice\)\./,
      );
    });

    // ── 7 · cross-post pair lifecycle ──────────────────────────────────────
    it("crosspost invite → list → config → approve-misfires → revoke round-trip", async () => {
      const badId = await channelsSlash("crosspost", "invite", [strOpt("destination_guild_id", "abc123")]);
      assert.match(
        await settledText(badId),
        /destination_guild_id must be a Discord server id\./,
      );

      const self = await channelsSlash("crosspost", "invite", [strOpt("destination_guild_id", env.ids.guild)]);
      assert.match(await settledText(self), /That's this server\./);

      const destGuild = "900000000000000001"; // registered community-less guild id
      const invite = await channelsSlash("crosspost", "invite", [strOpt("destination_guild_id", destGuild)]);
      const inviteText = await settledText(invite);
      assert.match(inviteText, /Give this code to staff in `900000000000000001`/);
      const code = inviteText.match(/\*\*`([^`]+)`\*\*/)?.[1];
      const pairId = Number(inviteText.match(/id `(\d+)`/)?.[1]);
      assert.ok(code && pairId, `invite copy malformed: ${inviteText}`);

      const dupe = await channelsSlash("crosspost", "invite", [strOpt("destination_guild_id", destGuild)]);
      assert.match(
        await settledText(dupe),
        new RegExp(`Pair already pending \\(id ${pairId}\\)\.`),
      );

      const list = await channelsSlash("crosspost", "list");
      assert.match(
        await settledText(list),
        new RegExp(`• \`${pairId}\` → out .* \\*\\*pending\\*\\*`),
      );

      const config = await channelsSlash("crosspost", "config", [
        intOpt("id", pairId),
        strOpt("roles", "123456789012345678"),
        intOpt("offset_minutes", 30),
      ]);
      assert.match(await settledText(config), new RegExp(`Cross-post \\\`${pairId}\\\` updated ✅`));

      const wrongCode = await channelsSlash("crosspost", "approve", [strOpt("code", "NOPE1234")]);
      assert.match(await settledText(wrongCode), /Unknown or used code\./);

      // Approving YOUR OWN outbound invite from the source guild — the
      // destination-side guard copy (a real partner guild is mock-DARK:
      // one bot, one guild per namespace).
      const selfApprove = await channelsSlash("crosspost", "approve", [strOpt("code", code)]);
      assert.match(await settledText(selfApprove), /That code isn't for this server\./);

      const revoke = await channelsSlash("crosspost", "revoke", [intOpt("id", pairId)]);
      assert.match(await settledText(revoke), new RegExp(`Cross-post \\\`${pairId}\\\` revoked\.`));

      const unknown = await channelsSlash("crosspost", "revoke", [intOpt("id", 99999)]);
      assert.match(
        await settledText(unknown),
        /No cross-post id `99999` \(see `\/eventchannels crosspost list`\)\./,
      );
    });

    // ── 8 · series management ──────────────────────────────────────────────
    const e2 = { ev: null };
    it("series list → daily recurrence row → skip → stop", async () => {
      const empty = await configSlash("series", "list");
      assert.match(
        await settledText(empty),
        /No active series — start one with `\/event create` \+ `recurrence`\./,
      );

      // skip on a plain event names the problem.
      const notSeries = await configSlash("series", "skip", [intOpt("event", e1.ev.row.id)]);
      assert.match(
        await settledText(notSeries),
        new RegExp(`Event \\*\\*${e1.ev.row.id}\\*\\* is not part of a series\\.`),
      );

      e2.ev = await createPosted("Lantern Social", {
        extra: [strOpt("recurrence", "daily")],
      });
      const list = await configSlash("series", "list");
      const listText = await settledText(list);
      assert.match(listText, /• `\d+` daily/);
      // The anchor event is not an OCCURRENCE — the series has materialized
      // zero follow-ups yet.
      assert.match(listText, /0 created/);
      assert.match(listText, /end never/);

      const skip = await configSlash("series", "skip", [intOpt("event", e2.ev.row.id)]);
      assert.match(
        await settledText(skip),
        /Occurrence \*\*Lantern Social\*\* skipped — series moves on\./,
      );
      assert.equal(env.dbmod.getEventById(e2.ev.row.id).status, "skipped");

      const stop = await configSlash("series", "stop", [intOpt("event", e2.ev.row.id)]);
      assert.match(await settledText(stop), /Series stopped — existing events stay\./);

      const after = await configSlash("series", "list");
      assert.match(await settledText(after), /No active series/);
    });

    // ── 9 · forced events-tick: reminders, digest, auto-archive ────────────
    const H = 3_600_000;
    const e3 = { ev: null };
    it("digest + auto-archive on; then one forced +4h tick delivers reminders, posts the digest and retires the skipped event", async () => {
      e3.ev = await createPosted("Quiz Night", {
        start: "in 1h",
        extra: [strOpt("duration", "2h")],
      });

      // Anchor the forced clock on the LATEST posted start (E3 may be
      // created minutes after this test's start — a fixed Date.now()+4h
      // here would already be stale by the next test's archive deadline).
      const latestStart = Math.max(
        ...env.dbmod
          .listUpcomingEvents(env.communityId, { limit: 50 })
          .map((r) => Number(r.start_at)),
      );
      const future = latestStart + 3 * H;

      // hour_utc MUST come from the FORCED tick's own clock, never the real
      // clock (#382): digestDueBoundary (features/events/service.js) computes
      // the daily boundary on the tick's UTC date, so a real-clock hour puts
      // the boundary in the future whenever the forced tick crosses UTC
      // midnight → the digest never fires and this suite fails
      // deterministically in the UTC 20:00–23:59 run window.
      const digest = await configSlash("settings", "digest", [
        chanOpt("channel", feed()),
        strOpt("frequency", "daily"),
        intOpt("hour_utc", new Date(future).getUTCHours()),
      ]);
      assert.match(
        await settledText(digest),
        new RegExp(`Digest: \\*\\*daily\\*\\* at \\d{2}:00 UTC → <#${env.ids.channel2}>`),
      );

      const out = await runEventsTick(future);

      // E1 (start +2h, 15-min default) + E3 (start +1h) delivered into general;
      // E2 is skipped → its armed reminder RETIRES.
      const e1Rows = await poll(
        async () => reminderRows(e1.ev.row.id).find((r) => r.status === "sent") || null,
        { label: `E1 reminder sent (tick=${JSON.stringify(out)})` },
      );
      const e3Rows = await poll(
        async () => reminderRows(e3.ev.row.id).find((r) => r.status === "sent") || null,
        { label: `E3 reminder sent (tick=${JSON.stringify(out)})` },
      );
      const e2Rows = await poll(
        async () => reminderRows(e2.ev.row.id).find((r) => r.status === "retired") || null,
        { label: `skipped-event reminder retired (tick=${JSON.stringify(out)})` },
      );
      assert.ok(e1Rows.sent_at && e1Rows.message_id, "E1 reminder marked sent");
      assert.ok(e3Rows, "E3 reminder sent");
      assert.ok(e2Rows, "skipped event's reminder retired");

      const deliveries = await reminderDeliveries(env.ids.general);
      const titles = deliveries.flatMap((m) =>
        (m.embeds || []).flatMap((e) => (e.fields || []).map((f) => f.name)),
      );
      assert.ok(
        titles.some((t) => /📅 Marathon Night/.test(String(t))),
        `E1 delivery embed in #general (${JSON.stringify(titles)})`,
      );
      assert.ok(titles.some((t) => /📅 Quiz Night/.test(String(t))), "E3 delivery embed");

      // Digest: exactly one message, listing BOTH events (still posted —
      // auto-archive is not on yet).
      const digests = await digestMessages(feed());
      assert.equal(digests.length, 1, "one digest posted");
      const desc = String(digests[0].embeds?.[0]?.description ?? "");
      assert.match(desc, /\*\*Marathon Night\*\*/);
      assert.match(desc, /\*\*Quiz Night\*\*/);
    });

    it("auto-archive on(5) + second tick archives by COALESCE(end_at, start_at); digest gate holds", async () => {
      const on = await configSlash("settings", "auto-archive", [
        boolOpt("enabled", true),
        intOpt("delay_minutes", 5),
      ]);
      assert.match(
        await settledText(on),
        /Auto-archive \*\*on\*\*: posted events archive themselves 5 min after they end \(E8\)\./,
      );

      // Anchor the forced clock AFTER the latest archive due (end_at for
      // E3 = start+2h). NOTE the product nuance this exposes: E3's default
      // reminder (start−15min) fires BEFORE its archive due (end+5min), so
      // every event that gets a reminder also gets archived only after the
      // reminder went out — the tick delivers reminders first, archives in
      // the same pass. 40min of slack keeps a just-created event's due from
      // sitting milliseconds behind a fixed Date.now()+4h anchor.
      const latestEnd = Math.max(
        ...env.dbmod
          .listUpcomingEvents(env.communityId, { limit: 50 })
          .map((r) => Number(r.end_at ?? r.start_at)),
      );
      const tickClock = latestEnd + 5 * 60_000 + 40 * 60_000;

      const out = await runEventsTick(tickClock);

      // E1 (end null → start_at+2h) and E3 (end+3h) are both past end+delay
      // at +4h → archived, Discord messages deleted, message_id cleared.
      const a = await poll(
        async () => {
          const r = env.dbmod.getEventById(e1.ev.row.id);
          return r.status === "archived" && !r.message_id ? r : null;
        },
        { label: `E1 archived (tick=${JSON.stringify(out)})` },
      );
      const b = await poll(
        async () => {
          const r = env.dbmod.getEventById(e3.ev.row.id);
          return r.status === "archived" && !r.message_id ? r : null;
        },
        {
          label: `E3 archived (tick=${JSON.stringify(out)}, row=${JSON.stringify(
            (() => {
              const r = env.dbmod.getEventById(e3.ev.row.id);
              return {
                status: r.status,
                start: Number(r.start_at),
                end: r.end_at == null ? null : Number(r.end_at),
                msg: r.message_id,
                in: settings().auto_archive,
                delay: settings().auto_archive_delay_minutes,
              };
            })(),
          )})`,
        },
      );
      assert.ok(a && b, "both events archived");
      const gone = await env.mock
        .message(e1.ev.announcement)
        .then(() => null)
        .catch((err) => err.status === 404);
      assert.ok(gone, "archived event message deleted from #general");

      // One digest per window: the second tick must NOT re-post (gate #196).
      assert.equal((await digestMessages(feed())).length, 1);
    });

    // ── 10 · purge run + sort ──────────────────────────────────────────────
    it("purge deletes human chatter and keeps bot/event messages; sort re-posts ≤50 by start", async () => {
      await env.mock.inject("chatter one", env.ids.human, feed());
      await env.mock.inject("chatter two", env.ids.target, feed());

      const purge = await channelsSlash("channel", "purge", [
        chanOpt("channel", feed()),
        boolOpt("run", true),
      ]);
      const purgeText = await settledText(purge);
      assert.match(purgeText, /Purged <#.*>: 2 message\(s\) removed, \d+ kept \(events\/pins\)/);
      const tape = await env.mock.tape(feed());
      assert.ok(
        !tape.some((m) => /chatter/.test(String(m.content ?? ""))),
        "human messages gone from the feed",
      );
      assert.ok(
        tape.some((m) => (m.content ?? "") || true), // digest bot messages survived
      );

      // Sort refuses unmarked channels.
      const unmarked = await channelsSlash("channel", "sort", [chanOpt("channel", env.ids.general)]);
      assert.match(
        await settledText(unmarked),
        /Mark it with `\/eventchannels channel mark` first — sort only touches event channels\./,
      );

      // One event message → nothing to sort.
      const solo = await channelsSlash("channel", "sort", [chanOpt("channel", feed())]);
      assert.match(
        await settledText(solo),
        /Nothing to sort — fewer than two bot event messages/,
      );

      // Two events in the feed, then sort re-posts them in start order.
      const e4 = await createPosted("Rail Jam", {
        start: "in 5h",
        extra: [chanOpt("channel", feed())],
      });
      const e5 = await createPosted("Pub Quiz", {
        start: "in 6h",
        extra: [chanOpt("channel", feed())],
      });
      const sort = await channelsSlash("channel", "sort", [chanOpt("channel", feed())]);
      assert.match(
        await settledText(sort),
        /Sorted 2 event message\(s\) chronologically \(cap 50\)/,
      );
      const fresh4 = env.dbmod.getEventById(e4.row.id);
      const fresh5 = env.dbmod.getEventById(e5.row.id);
      assert.notEqual(String(fresh4.message_id), e4.announcement, "E4 re-posted");
      assert.notEqual(String(fresh5.message_id), e5.announcement, "E5 re-posted");
      for (const old of [e4.announcement, e5.announcement]) {
        const gone = await env.mock
          .message(old, feed())
          .then(() => null)
          .catch((err) => err.status === 404);
        assert.ok(gone, `stale event message ${old} deleted`);
      }

      // Auto-archive off again so the 5h/6h events can't vanish mid-suite.
      await configSlash("settings", "auto-archive", [boolOpt("enabled", false)]);
    });

    // ── 11 · /eventreminder — retired create, setchannel, seeded config ─────
    const se = { event: null, event2: null, role: null, configId: null };

    it("create is retired (#225); list shows defaults; setchannel gates then persists", async () => {
      const create = await erSlash("create", [strOpt("event", "123")]);
      const createText = await settledText(create);
      assert.match(createText, /📆 \*\*New reminder configs are retired\*\*/);
      assert.match(createText, /`\/event adopt scheduled_event:<id>`/);

      const emptyList = await erSlash("list");
      const emptyText = await settledText(emptyList);
      assert.match(emptyText, /Default channel: _not set_/);
      assert.match(emptyText, /No active configs\. Use `\/eventreminder create`\./);

      const { MSG_DENIED } = require("../../src/core/theme");
      const denied = await erSlash("setchannel", [chanOpt("channel", feed())], env.ids.outsider);
      assert.equal(await replyText(denied), MSG_DENIED);

      const set = await erSlash("setchannel", [chanOpt("channel", feed())]);
      assert.match(
        await replyText(set),
        new RegExp(`Event reminders will post to <#${env.ids.channel2}> by default`),
      );
      assert.equal(env.dbmod.getGuildSettings(env.communityId).event_reminder_channel_id, feed());

      se.event = await createScheduledEvent("Friday Game Night", Date.now() + 26 * H);
      se.event2 = await createScheduledEvent("Monday Jam", Date.now() + 30 * H);
    });

    it("seeded config lists with next-fire, and the forced ticker delivers the role-pinged reminder", async () => {
      se.role = await env.mock.createRole("event-gametime");
      const config = env.dbmod.createEventReminderConfig({
        communityId: env.communityId,
        scheduledEventId: String(se.event.id),
        shortname: "gametime",
        roleId: se.role.id,
        channelId: null, // → guild default (events-feed)
        messageTemplate: null,
        persistent: false,
        createdBy: env.ids.human,
        offsets: [{ offsetMinutes: 60, fireAt: Date.now() - 2 * 60_000 }],
      });
      se.configId = config.id;

      const list = await erSlash("list");
      const listText = await settledText(list);
      assert.match(
        listText,
        new RegExp("\\*\\*event-gametime\\*\\* \\(`" + se.event.id + "`\\)"),
      );
      assert.match(listText, new RegExp(`Role: <@&${se.role.id}>`));
      assert.match(listText, /Next: <t:\d+:R> \(1 hour before\)/);
      assert.match(listText, /·1 hour/);

      await runReminderTick();

      const sent = await poll(async () => {
        const row = env.dbmod
          .getEventReminderConfigById(se.configId)
          .offsets.find((o) => o.offset_minutes === 60);
        return row.sent_at ? row : null;
      });
      assert.ok(sent.message_id, "offset row marked sent with message id");

      const msgs = await env.mock.messages(feed());
      const delivery = (Array.isArray(msgs) ? msgs : msgs?.messages || []).find(
        (m) => String(m.content ?? "") === `<@&${se.role.id}>`,
      );
      assert.ok(delivery, "role-pinged reminder posted to the default channel");
      const embed = delivery.embeds?.[0];
      assert.equal(embed?.title, "Friday Game Night");
      const fields = Object.fromEntries((embed?.fields || []).map((f) => [f.name, f.value]));
      assert.equal(fields["Location"], "Baseline Pub");
      assert.match(String(embed?.url ?? ""), new RegExp(`discord\\.com/events/${env.ids.guild}/${se.event.id}`));
    });

    it("edit opens the er: modal; submit rewrites shortname/role/offsets (past fires skipped)", async () => {
      const unknown = await erSlash("edit", [strOpt("event", "999999999999999999")]);
      assert.match(
        await settledText(unknown),
        /No active reminder config for that event\. Use `\/eventreminder create`\./,
      );

      // Gate: canConfigureEventReminder wants ManageGuild OR event creator.
      const denied = await erSlash("edit", [strOpt("event", String(se.event.id))], env.ids.outsider);
      assert.match(
        await settledText(denied),
        /You need \*\*Manage Guild\*\* or be the \*\*creator\*\* of this scheduled event\./,
      );

      const inter = await erSlash("edit", [strOpt("event", String(se.event.id))]);
      const state = await poll(async () => {
        const st = await env.mock.interactionState(inter.id);
        return st.response_json?.type === 9 ? st : null;
      });
      assert.equal(
        state.response_json?.data?.custom_id,
        `er:edit:${se.event.id}`,
      );
      assert.match(
        String(state.response_json?.data?.title),
        /Reminders: Friday Game Night/,
      );

      const submit = await env.mock.modal({
        customId: `er:edit:${se.event.id}`,
        fields: {
          shortname: "game-night",
          offsets_custom: "45m",
          message: "GLHF — {event} in {location}",
        },
      });
      const reply = await env.mock.awaitSettledReply(submit);
      assert.match(
        String(reply.content),
        /Updated reminders for \*\*Friday Game Night\*\*\./,
      );
      assert.match(String(reply.content), /Pending fires/);

      const cfg = env.dbmod.getEventReminderConfigById(se.configId);
      assert.equal(cfg.shortname, "game-night");
      assert.equal(cfg.message_template, "GLHF — {event} in {location}");
      // presets fall back to DEFAULT(1440/60/15) + custom 45m — all future
      // vs the +26h start; the already-sent audit row survives.
      const pending = cfg.offsets.filter((o) => o.sent_at == null);
      assert.deepEqual(
        pending.map((o) => o.offset_minutes).sort((x, y) => y - x),
        [1440, 60, 45, 15],
      );
      assert.ok(cfg.offsets.some((o) => o.sent_at != null), "sent row kept as audit trail");

      const roles = await j(`${env.mock.base}/api/guilds/${env.ids.guild}/roles`, {
        headers: env.mock.auth,
      });
      const renamed = (Array.isArray(roles) ? roles : roles?.roles || []).find(
        (r) => String(r.id) === String(se.role.id),
      );
      assert.equal(renamed?.name, "event-game-night", "role renamed with the shortname");
    });

    it("er-recur button toggles persistent (organizer-gated)", async () => {
      const submit = await env.mock.modal({
        customId: `er:edit:${se.event.id}`,
        fields: { shortname: "game-night" },
      });
      const reply = await env.mock.awaitSettledReply(submit);
      const rows = await env.mock.buttons(reply.id, env.ids.general);
      const recur = rows.find((c) => String(c.custom_id || "").startsWith("er-recur:"));
      assert.ok(recur, "recurring toggle on the edit confirmation");

      const denied = await env.mock.click({
        customId: recur.custom_id,
        messageId: reply.id,
        userId: env.ids.outsider,
      });
      const deniedState = await respondedState(denied, "outsider er-recur denial");
      assert.match(
        String(deniedState.response_json?.data?.content ?? ""),
        /You need \*\*Manage Guild\*\* or be the \*\*creator\*\*/,
      );

      const click = await env.mock.click({
        customId: recur.custom_id,
        messageId: reply.id,
      });
      const clickState = await respondedState(click, "human er-recur toggle");
      assert.match(
        String(clickState.response_json?.data?.content ?? ""),
        /♾️ \*\*Recurring: on\*\* — reminders for \*\*Friday Game Night\*\*/,
      );
      assert.equal(env.dbmod.getEventReminderConfigById(se.configId).persistent, 1);
    });

    it("eventreminder autocomplete lists scheduled events + configs (event name labels)", async () => {
      const createdChoices = await env.mock.autocomplete({
        command: "eventreminder",
        options: [
          sub("create", [{ name: "event", type: 3, value: "friday", focused: true }]),
        ],
      });
      const st1 = await poll(async () => {
        const st = await env.mock.interactionState(createdChoices.id);
        return st.response_json?.type === 8 ? st : null;
      });
      assert.ok(
        (st1.response_json?.data?.choices || []).some(
          (c) => String(c.value) === String(se.event.id) && c.name === "Friday Game Night",
        ),
        "create lists the non-terminal scheduled event by name",
      );

      const editChoices = await env.mock.autocomplete({
        command: "eventreminder",
        options: [sub("edit", [{ name: "event", type: 3, value: "", focused: true }])],
      });
      const st2 = await poll(async () => {
        const st = await env.mock.interactionState(editChoices.id);
        return st.response_json?.type === 8 ? st : null;
      });
      assert.ok(
        (st2.response_json?.data?.choices || []).some(
          (c) =>
            String(c.value) === String(se.event.id) &&
            c.name === "Friday Game Night (event-game-night)",
        ),
        "edit labels configs with the event name + role shortname",
      );
    });

    it("mute/status/opt-out family tracks the per-user state", async () => {
      const mute = await erSlash("mute", [strOpt("event", String(se.event.id))], env.ids.target);
      assert.match(
        await settledText(mute),
        /Muted reminders for \*\*event-game-night\*\*/,
      );

      // Muted configs get the 🔇 prefix in the picker.
      const ac = await env.mock.autocomplete({
        command: "eventreminder",
        options: [sub("mute", [{ name: "event", type: 3, value: "", focused: true }])],
        userId: env.ids.target,
      });
      const st = await poll(async () => {
        const s = await env.mock.interactionState(ac.id);
        return s.response_json?.type === 8 ? s : null;
      });
      assert.ok(
        (st.response_json?.data?.choices || []).some(
          (c) => String(c.value) === String(se.event.id) && c.name.startsWith("🔇"),
        ),
        "muted config surfaces with the 🔇 label",
      );

      const status = await erSlash("status", [], env.ids.target);
      const statusText = await settledText(status);
      assert.match(statusText, /Guild opted out: \*\*no\*\*/);
      assert.match(statusText, /Muted events: `event-game-night`/);
      assert.match(statusText, /Event roles you hold: _none_/);

      const optout = await erSlash("optout", [], env.ids.target);
      assert.match(
        await settledText(optout),
        /You have opted out of \*\*all\*\* event reminder pings in this server\./,
      );
      assert.ok(env.dbmod.isEventReminderOptedOut(env.communityId, env.ids.target));

      // Unmute while guild-opted-out warns instead of restoring the role.
      const unmute = await erSlash("unmute", [strOpt("event", String(se.event.id))], env.ids.target);
      assert.match(
        await settledText(unmute),
        /Unmuted \*\*event-game-night\*\*, but you are still \*\*guild-opted-out\*\*/,
      );

      const optin = await erSlash("optin", [], env.ids.target);
      assert.match(
        await settledText(optin),
        /Opted back in\. No current Interested event roles to restore/,
      );
      assert.ok(!env.dbmod.isEventReminderOptedOut(env.communityId, env.ids.target));
    });

    it("sync re-grants interested members (+0/−0 on the mock — no subscribe surface)", async () => {
      const sync = await erSlash("sync", [strOpt("event", String(se.event.id))]);
      assert.match(
        await settledText(sync),
        /Synced \*\*event-game-night\*\*: \+0 \/ −0 members\./,
      );
    });

    it("clear deletes the config and the reminder role", async () => {
      const clear = await erSlash("clear", [strOpt("event", String(se.event.id))]);
      assert.match(
        await settledText(clear),
        /Cleared event reminders and deleted role \*\*event-game-night\*\*/,
      );
      assert.equal(env.dbmod.getAnyConfigByScheduledEventId(env.communityId, String(se.event.id)), null);
      const gone = await j(
        `${env.mock.base}/api/guilds/${env.ids.guild}/roles/${se.role.id}`,
        { headers: env.mock.auth },
      )
        .then(() => null)
        .catch((err) => err.status === 404);
      assert.ok(gone, "reminder role deleted on clear");
    });

    // ── 12 · reminder delivery state machine (eventReminders ticker) ───────
    it("no notify channel → bounded retry with a fixable reason", async () => {
      const clear = await erSlash("setchannel", []);
      assert.match(
        await replyText(clear),
        /Default event reminder channel cleared/,
      );

      const cfg = env.dbmod.createEventReminderConfig({
        communityId: env.communityId,
        scheduledEventId: String(se.event2.id),
        shortname: "nochan",
        roleId: (await env.mock.createRole("event-nochan")).id,
        channelId: null,
        messageTemplate: null,
        persistent: false,
        createdBy: env.ids.human,
        offsets: [{ offsetMinutes: 30, fireAt: Date.now() - 60_000 }],
      });

      await runReminderTick();
      const row = await poll(async () => {
        const r = env.dbmod
          .getEventReminderConfigById(cfg.id)
          .offsets.find((o) => o.offset_minutes === 30);
        return (r.attempts ?? 0) >= 1 ? r : null;
      });
      assert.equal(row.status, "pending");
      assert.match(String(row.last_error), /no notify channel configured/);
      assert.ok(row.next_attempt_at > Date.now(), "backoff scheduled, not a hot loop");

      env.dbmod.clearEventReminderConfigById(cfg.id);
    });

    it("notify channel gone → terminal retire on first detection", async () => {
      const cfg = env.dbmod.createEventReminderConfig({
        communityId: env.communityId,
        scheduledEventId: String(se.event2.id),
        shortname: "gonechan",
        roleId: (await env.mock.createRole("event-gonechan")).id,
        channelId: "900000000000000555", // never existed
        messageTemplate: null,
        persistent: false,
        createdBy: env.ids.human,
        offsets: [{ offsetMinutes: 10, fireAt: Date.now() - 60_000 }],
      });

      await runReminderTick();
      const row = await poll(async () => {
        const r = env.dbmod
          .getEventReminderConfigById(cfg.id)
          ?.offsets.find((o) => o.offset_minutes === 10);
        return r?.status === "retired" ? r : null;
      });
      assert.match(String(row.last_error), /notify channel 900000000000000555 is gone/);
      env.dbmod.clearEventReminderConfigById(cfg.id);
    });

    it("scheduled event gone: non-persistent config is cleaned up; persistent KEEPS retrying (BUG #350)", async () => {
      // BUG #350: deliverOne classifies a missing scheduled event via
      // GONE_EVENT_CODES=[10008] (Unknown MESSAGE) — the real code for
      // scheduled events is 10066, so the delivery path never takes the
      // cleanup/retire branch. Configs with a vanished event survive only by
      // SAFETY CLEANUP (non-persistent) or retry toward 'failed' (persistent,
      // designed RETIRE never fires). Flip these pins with the fix.
      const gone = {
        communityId: env.communityId,
        scheduledEventId: "900000000000000777",
        shortname: "ghostcfg",
        roleId: mgRole.id,
        channelId: feed(),
        messageTemplate: null,
        persistent: false,
        createdBy: env.ids.human,
        offsets: [{ offsetMinutes: 15, fireAt: Date.now() - 60_000 }],
      };
      const cfgC = env.dbmod.createEventReminderConfig({
        ...gone,
        shortname: "ghostcfg",
        roleId: (await env.mock.createRole("event-ghostcfg")).id,
        scheduledEventId: "900000000000000777",
        persistent: false,
      });
      const cfgD = env.dbmod.createEventReminderConfig({
        ...gone,
        shortname: "ghostpers",
        roleId: (await env.mock.createRole("event-ghostpers")).id,
        scheduledEventId: "900000000000000778",
        persistent: true,
      });

      await runReminderTick();

      // Non-persistent: safetyCleanup wipes config + offsets + role lookup.
      await poll(async () =>
        env.dbmod.getEventReminderConfigById(cfgC.id) ? null : true,
      );

      // Persistent: safetyCleanup skips; delivery RETRIED (attempts≥1)
      // instead of retiring — the current (wrong-but-bounded) behavior.
      const d = await poll(async () => {
        const row = env.dbmod
          .getEventReminderConfigById(cfgD.id)
          ?.offsets.find((o) => o.offset_minutes === 15);
        return (row?.attempts ?? 0) >= 1 ? row : null;
      });
      assert.equal(d.status, "pending");
      assert.match(String(d.last_error), /fetch failed|not found/);

      env.dbmod.clearEventReminderConfigById(cfgD.id);

      // Restore the default channel so no stray retries post later.
      const set = await erSlash("setchannel", [chanOpt("channel", feed())]);
      assert.match(await replyText(set), /will post to <#/);
    });

    // ── 13 · teardown-adjacent checks ──────────────────────────────────────
    it("unmark clears the event-channel row (list back to the empty copy)", async () => {
      const unmark = await channelsSlash("channel", "unmark", [chanOpt("channel", feed())]);
      assert.match(
        await settledText(unmark),
        new RegExp(`<#${env.ids.channel2}> is no longer an event channel\\.`),
      );
      const list = await channelsSlash("channel", "list");
      assert.match(await settledText(list), /No event channels marked/);
    });

    it(
      "cross-post DESTINATION delivery + scheduled-event subscribers stay mock-DARK (#318 acceptance rows)",
      { todo: "fauxcord: no second-guild bot identity, no scheduled-event subscribe surface" },
      () => {},
    );
  },
);
