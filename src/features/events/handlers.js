/**
 * `/event` command router (epic #218).
 *
 * One chat-input handler dispatching every subcommand; gates follow
 * roadmap/community-events.md E4/E5 and AGENTS.md:
 *  - create            ManageGuild/staff OR the configured create role
 *  - edit/delete/…     organizer (creator) or ManageGuild/staff, plus the
 *                      per-action settings role gates (E4)
 *  - options/presets/
 *    reminders/series  organizer/staff (E5)
 *  - settings/channel/
 *    crosspost/config  ManageGuild/staff
 * Errors always reach the user WITH the cause (no generic fallbacks here —
 * the router's safeErrorReply is the last resort, not the tool).
 */
const repo = require("../../db/repositories/events");
const { ensureCommunity } = require("../../platform/community");
const { isStaff } = require("../../core/permissions");
const { replyEphemeral } = require("../../core/interaction");
const { baseEmbed, truncateField, tsFull, tsRelative, Color } = require("../../core/theme");
const { PermissionFlagsBits, MessageFlags } = require("discord.js");

const ui = require("./ui");
const service = require("./service");
const options = require("./options");
const presets = require("./presets");
const series = require("./series");
const wizard = require("./wizard");
const gcal = require("./gcal");
const crosspost = require("./crosspost");
const { parseCutoff, parseDuration } = require("./timeParse");

const {
  parseColor,
  parseRoleList,
  parseWeekdayList,
  parseSignupOptionSpec,
} = ui;

// ── shared plumbing ─────────────────────────────────────────────────────────

function resolveCtx(interaction, ctx) {
  const client =
    ctx && ctx.supervisor && ctx.supervisor.discord
      ? ctx.supervisor.discord
      : ctx && ctx.guilds
        ? ctx
        : null;
  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: interaction.guildId,
  });
  return { client, communityId, guild: interaction.guild };
}

async function fail(interaction, message) {
  await replyEphemeral(interaction, message);
}

/** Fetch the `event` option target, scoped to this community. */
function eventFrom(interaction, communityId, { optional = false } = {}) {
  const id = interaction.options.getInteger("event");
  if (id == null) {
    if (optional) return { ok: true, event: null };
    return { ok: false, error: "Which event? Pass `event:` (see `/event list`)." };
  }
  const event = repo.getEventForCommunity(id, communityId);
  if (!event) return { ok: false, error: `No event **${id}** in this server.` };
  return { ok: true, event };
}

function isAdmin(interaction) {
  return (interaction.memberPermissions ?? interaction.member?.permissions ?? []).includes
    ? Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild))
    : false;
}

function staffGate(interaction, communityId) {
  if (isStaff(interaction)) return { ok: true };
  return { ok: false, error: "This needs Manage Server or a staff role (`/staff`)." };
}

function manageGate(interaction, communityId, event, kind) {
  return service.canManageEvent(interaction.member, communityId, event, kind);
}

// ── create ──────────────────────────────────────────────────────────────────

async function handleCreate(interaction, ctx) {
  const { client, communityId } = resolveCtx(interaction, ctx);
  const o = interaction.options;
  const settings = repo.getEventGuildSettings(communityId);

  const gate = service.canCreateEvent(interaction.member, communityId);
  if (!gate.ok) return fail(interaction, gate.error);

  const title = o.getString("title");
  const startRes = service.resolveStartAt(o.getString("start"), settings);
  if (!startRes.ok) return fail(interaction, startRes.error);
  const startAt = startRes.atMs;

  const durRes = parseDuration(o.getString("duration"));
  if (!durRes.ok) return fail(interaction, durRes.error);
  const duration = durRes.minutes;
  const endAt = duration ? startAt + duration * 60_000 : null;

  const channel = o.getChannel("channel") || interaction.channel;
  const channelId = channel?.id || null;

  // Options: custom spec > preset > default Yes/No/Maybe.
  let specs = null;
  const signupText = o.getString("signup_options");
  const presetName = o.getString("preset");
  if (signupText) {
    const res = parseSignupOptionSpec(signupText);
    if (!res.ok) return fail(interaction, res.error);
    specs = res.options;
  } else if (presetName) {
    const preset = repo.getEventPresetByName(communityId, presetName);
    if (!preset) return fail(interaction, `No preset **${presetName}** — see \`/eventsignup preset list\`.`);
    specs = presets.toSpecs(preset.options);
  } else {
    specs = presets.defaultSpecs();
  }

  const cutoffRes = parseCutoff(o.getString("cutoff"));
  if (!cutoffRes.ok) return fail(interaction, cutoffRes.error);
  const cutoffAt =
    cutoffRes.offsetMinutes == null ? startAt : startAt + cutoffRes.offsetMinutes * 60_000;

  let postAt = null;
  const postText = o.getString("post_at");
  if (postText) {
    const postRes = service.resolveStartAt(postText, settings);
    if (!postRes.ok) return fail(interaction, `post_at: ${postRes.error}`);
    postAt = postRes.atMs;
    if (postAt >= startAt) {
      return fail(interaction, "The scheduled post time must be before the event start.");
    }
  }

  const colorRes = parseColor(o.getString("color"));
  if (!colorRes.ok) return fail(interaction, colorRes.error);

  const announceIds = parseRoleList(o.getString("roles"));
  const attendeeRole = o.getRole("attendee_role");

  const created = repo.createEvent({
    communityId,
    creatorId: interaction.user.id,
    title,
    status: postAt ? "draft" : "pending_confirm",
    startAt,
    channelId,
    postAt,
    options: specs,
    description: o.getString("description"),
    location: o.getString("location"),
    end_at: endAt,
    duration_minutes: duration,
    image_url: o.getString("image"),
    color: colorRes.color,
    announce_role_ids: announceIds,
    attendee_role_id: attendeeRole ? attendeeRole.id : null,
    attendee_role_existing: attendeeRole ? 1 : 0,
    role_mode: attendeeRole ? "existing" : "temp",
    cutoff_at: cutoffAt,
    multiple_signups: o.getBoolean("multiple") ?? false,
    thread_enabled: o.getBoolean("thread") ?? true,
    thread_private: o.getBoolean("private_thread") ?? false,
  });
  if (!created.ok) return fail(interaction, created.error);

  // Recurrence → attach a series anchored on this event.
  const cadence = o.getString("recurrence");
  let seriesNote = "";
  if (cadence) {
    const weekdays = parseWeekdayList(o.getString("weekdays"));
    if (cadence === "weekly" && !weekdays.length) {
      return fail(interaction, "Weekly series need weekdays, e.g. `tue,thu`.");
    }
    const endMode = o.getString("end_mode") || "never";
    const endCount = o.getInteger("end_count");
    if (endMode === "count" && endCount == null) {
      return fail(interaction, "end_count is required when the series ends by count.");
    }
    let endUntilMs = null;
    if (endMode === "until") {
      const endRes = service.resolveStartAt(o.getString("end_date"), settings);
      if (!endRes.ok) return fail(interaction, `end_date: ${endRes.error}`);
      endUntilMs = endRes.atMs;
    }
    const sres = series.createFromEvent(created.event, {
      cadence,
      weekdays,
      monthDay: o.getInteger("month_day"),
      endMode,
      endCount,
      endUntilMs,
      createdBy: interaction.user.id,
    });
    if (!sres.ok) {
      await repo.deleteEventCascade(created.event.id);
      return fail(interaction, `Series: ${sres.error}`);
    }
    repo.updateEvent(created.event.id, { series_id: sres.series.id });
    seriesNote = ` — repeating **${cadence}** (${endMode}${endCount ? ` ×${endCount}` : ""}).`;
  }

  const fresh = repo.getEventById(created.event.id);
  if (postAt) {
    return interaction.reply({
      ...ui.buildPreviewEmbed(fresh, { options: repo.listEventOptions(fresh.id) }),
      flags: MessageFlags.Ephemeral,
      content: `Scheduled for ${tsFull(postAt)}${seriesNote}. Post it early with \`/event post event:${fresh.id}\`, or fix the time with \`/event edit\`.`,
    });
  }
  return interaction.reply({
    ...ui.buildPreviewEmbed(fresh, { options: repo.listEventOptions(fresh.id) }),
    components: ui.buildConfirmComponents(fresh.id),
    flags: MessageFlags.Ephemeral,
    content: `Almost there — does the time look right?${seriesNote}`,
  });
}

// ── edit / delete / list / post / duplicate / adopt / wizard ────────────────

async function handleEdit(interaction, ctx) {
  const { client, communityId } = resolveCtx(interaction, ctx);
  const o = interaction.options;
  const ev = eventFrom(interaction, communityId, { optional: true });
  if (!ev.ok) return fail(interaction, ev.error);
  let event = ev.event;
  if (!event) {
    // No id: assume the Edit button flow came through the modal; CLI needs one.
    const mine = repo
      .listUpcomingEvents(communityId, { limit: 50 })
      .find((e) => e.creator_id === interaction.user.id);
    if (!mine) return fail(interaction, "Which event? Pass `event:` (see `/event list`).");
    event = mine;
  }

  if (o.getBoolean("in_dm")) {
    const settings = repo.getEventGuildSettings(communityId);
    void settings;
    repo.upsertEventWizard(communityId, interaction.user.id, {
      step: "start",
      draft: JSON.stringify({
        title: event.title,
        start_at: event.start_at,
        event_id: event.id,
        default_channel_id: event.channel_id,
        creator_id: event.creator_id,
      }),
      eventId: event.id,
    });
    const ok = await wizard.ask(client, {
      community_id: communityId,
      user_id: interaction.user.id,
      step: "start",
      event_id: event.id,
      draft: JSON.stringify({ title: event.title, event_id: event.id }),
    });
    if (!ok) {
      repo.deleteEventWizard(communityId, interaction.user.id);
      return fail(interaction, "I couldn't DM you — allow server DMs, or use the Edit button on the event (quick title/time/description edit).");
    }
    return replyEphemeral(interaction, `Head to your DMs to edit **${event.title}** one step at a time.`);
  }

  const settings = repo.getEventGuildSettings(communityId);
  const patch = {};
  const title = o.getString("title");
  if (title) patch.title = title;
  const desc = o.getString("description");
  if (desc != null) patch.description = desc === "-" ? "" : desc;
  const channel = o.getChannel("channel");
  if (channel) patch.channel_id = channel.id;
  const location = o.getString("location");
  if (location != null) patch.location = location === "-" ? "" : location;
  let resolvedStartAt = null;
  const startText = o.getString("start");
  if (startText) {
    const startRes = service.resolveStartAt(startText, settings);
    if (!startRes.ok) return fail(interaction, startRes.error);
    resolvedStartAt = startRes.atMs;
    patch.start_at = resolvedStartAt;
  }
  const dur = parseDuration(o.getString("duration"));
  if (!dur.ok) return fail(interaction, dur.error);
  if (dur.minutes) {
    patch.duration_minutes = dur.minutes;
    patch.end_at = (resolvedStartAt ?? Number(event.start_at)) + dur.minutes * 60_000;
  }
  const roles = o.getString("roles");
  if (roles != null) patch.announce_role_ids = parseRoleList(roles);
  const postText = o.getString("post_at");
  if (postText === "-") patch.post_at = null;
  else if (postText) {
    const postRes = service.resolveStartAt(postText, settings);
    if (!postRes.ok) return fail(interaction, `post_at: ${postRes.error}`);
    patch.post_at = postRes.atMs;
  }
  const cutoffRes = parseCutoff(o.getString("cutoff"));
  if (!cutoffRes.ok) return fail(interaction, cutoffRes.error);
  if (o.getString("cutoff") != null) {
    patch.cutoff_at =
      cutoffRes.offsetMinutes == null ? event.start_at : event.start_at + cutoffRes.offsetMinutes * 60_000;
  }
  if (o.getBoolean("multiple") != null) patch.multiple_signups = Boolean(o.getBoolean("multiple"));
  if (o.getBoolean("thread") != null) patch.thread_enabled = Boolean(o.getBoolean("thread"));
  if (o.getBoolean("private_thread") != null) patch.thread_private = Boolean(o.getBoolean("private_thread"));
  const image = o.getString("image");
  if (image != null) patch.image_url = image === "-" ? null : image;
  const color = o.getString("color");
  if (color != null) {
    if (color === "-") patch.color = null;
    else {
      const cRes = parseColor(color);
      if (!cRes.ok) return fail(interaction, cRes.error);
      patch.color = cRes.color;
    }
  }
  const attendeeRole = o.getRole("attendee_role");
  if (attendeeRole) {
    patch.attendee_role_id = attendeeRole.id;
    patch.attendee_role_existing = 1;
    patch.role_mode = "existing";
  }
  const roleMode = o.getString("role_mode");
  if (roleMode) patch.role_mode = roleMode;

  if (!Object.keys(patch).length) {
    return fail(interaction, "Nothing to change — pass at least one option (see `/event edit`).");
  }

  const res = await service.editEvent(client, {
    member: interaction.member,
    communityId,
    event,
    patch,
    actorId: interaction.user.id,
  });
  if (!res.ok) return fail(interaction, res.error);
  return replyEphemeral(
    interaction,
    `Event updated ✅${res.warnings?.length ? ` — notes: ${res.warnings.join("; ")}` : ""}`,
  );
}

async function handleDelete(interaction, ctx) {
  const { communityId } = resolveCtx(interaction, ctx);
  const ev = eventFrom(interaction, communityId);
  if (!ev.ok) return fail(interaction, ev.error);
  const gate = manageGate(interaction, communityId, ev.event, "delete");
  if (!gate.ok) return fail(interaction, gate.error);
  if (!isStaff(interaction) && ev.event.creator_id !== interaction.user.id) {
    return fail(interaction, "Only the organizer or staff can delete this event.");
  }
  return interaction.reply({
    content: `Really delete **${ev.event.title}** (${ev.event.id}) with all signups?`,
    components: ui.buildDeleteConfirmComponents(ev.event.id, interaction.user.id),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleList(interaction, ctx) {
  const { communityId } = resolveCtx(interaction, ctx);
  const events = repo.listUpcomingEvents(communityId, { limit: 25 });
  const countsByEvent = {};
  for (const e of events) {
    const counts = repo.countEventSignups(e.id);
    countsByEvent[e.id] = {
      // #346 (same dead-key class): the repo's groups are camelCase —
      // g.signed_up was always 0, so /eventsignup list undercounted every
      // signed-up member and showed only waiters as "total".
      total: Object.values(counts).reduce(
        (acc, g) => acc + (g.signedUp || 0) + (g.waitlisted || 0),
        0
      ),
    };
  }
  return interaction.reply({ ...ui.buildListEmbed(events, { countsByEvent }), flags: MessageFlags.Ephemeral });
}

async function handleWizard(interaction, ctx) {
  const { client, communityId } = resolveCtx(interaction, ctx);
  const gate = service.canCreateEvent(interaction.member, communityId);
  if (!gate.ok) return fail(interaction, gate.error);
  return wizard.start(client, interaction, communityId);
}

async function handleDuplicate(interaction, ctx) {
  const { client, communityId } = resolveCtx(interaction, ctx);
  const ev = eventFrom(interaction, communityId);
  if (!ev.ok) return fail(interaction, ev.error);
  const gate = manageGate(interaction, communityId, ev.event, "duplicate");
  if (!gate.ok) return fail(interaction, gate.error);
  const res = await service.duplicateEvent(client, ev.event, interaction.user.id);
  if (!res.ok) return fail(interaction, res.error);
  return replyEphemeral(
    interaction,
    `Copied as draft **${res.event.title}** (\`${res.event.id}\`) — edit it, then \`/event post event:${res.event.id}\`.` +
      (res.warnings?.length ? ` Notes: ${res.warnings.join("; ")}` : ""),
  );
}

async function handlePost(interaction, ctx) {
  const { client, communityId } = resolveCtx(interaction, ctx);
  const ev = eventFrom(interaction, communityId);
  if (!ev.ok) return fail(interaction, ev.error);
  const gate = manageGate(interaction, communityId, ev.event, "post");
  if (!gate.ok) return fail(interaction, gate.error);
  const res = await service.postEventNow(client, ev.event, { actorId: interaction.user.id });
  if (!res.ok) return fail(interaction, res.error);
  // The service verifies the original message: refused only while it is
  // alive; a deleted post re-posts cleanly instead of locking the event.
  if (res.warnings?.includes("already posted")) {
    return fail(interaction, "That event is already posted.");
  }
  return replyEphemeral(
    interaction,
    `Posted ✅${res.warnings?.length ? ` — notes: ${res.warnings.join("; ")}` : ""}`
  );
}

async function handleAdopt(interaction, ctx) {
  const { client, communityId } = resolveCtx(interaction, ctx);
  const gate = staffGate(interaction, communityId);
  if (!gate.ok) return fail(interaction, gate.error);
  const id = interaction.options.getString("scheduled_event");
  let scheduled = null;
  try {
    scheduled = await interaction.guild.scheduledEvents.fetch(id);
  } catch {
    return fail(interaction, `No Discord scheduled event **${id}** here (check the id in the invite link).`);
  }
  const res = await service.adoptScheduledEvent(
    interaction.guild,
    communityId,
    scheduled,
    interaction.user.id
  );
  if (!res.ok) return fail(interaction, res.error);
  return replyEphemeral(
    interaction,
    `Adopted as draft **${res.event.title}** (\`${res.event.id}\`) — its old reminder config stays until it fires out. Post with \`/event post event:${res.event.id}\`.`
  );
}

// ── response (organizer signup management) ──────────────────────────────────

async function handleResponse(interaction, ctx) {
  const { client, communityId } = resolveCtx(interaction, ctx);
  const sub = interaction.options.getSubcommand();
  const o = interaction.options;
  const ev = eventFrom(interaction, communityId);
  if (!ev.ok) return fail(interaction, ev.error);
  const gate = manageGate(interaction, communityId, ev.event, "options");
  if (!gate.ok) return fail(interaction, gate.error);

  const member = o.getMember("member");
  if (!member) return fail(interaction, "Pick a member of this server.");
  const optRef = sub === "move" ? o.getInteger("from_option") : o.getInteger("option");
  const fromOpt = optRef == null ? null : options.resolveOption(ev.event.id, optRef);
  if (optRef != null && !fromOpt) {
    return fail(interaction, `No option \`${optRef}\` on that event (see \`/eventsignup options list event:${ev.event.id}\`).`);
  }

  let res;
  if (sub === "add") {
    res = await service.organizerAdd(client, {
      guild: interaction.guild,
      event: ev.event,
      userId: member.id,
      optionId: fromOpt.id,
      actorId: interaction.user.id,
    });
  } else if (sub === "remove") {
    res = await service.organizerRemove(client, {
      guild: interaction.guild,
      event: ev.event,
      userId: member.id,
      optionId: fromOpt.id,
      actorId: interaction.user.id,
    });
  } else {
    const toRef = o.getInteger("to_option");
    const toOpt = options.resolveOption(ev.event.id, toRef);
    if (!toOpt) return fail(interaction, `No option \`${toRef}\` on that event.`);
    res = await service.organizerMove(client, {
      guild: interaction.guild,
      event: ev.event,
      userId: member.id,
      fromOptionId: fromOpt.id,
      toOptionId: toOpt.id,
      actorId: interaction.user.id,
    });
  }
  if (!res.ok) return fail(interaction, res.error);
  return replyEphemeral(
    interaction,
    `${res.reply || "Done ✅"}${res.warnings?.length ? ` — ${res.warnings.join("; ")}` : ""}`
  );
}

// ── reminders ───────────────────────────────────────────────────────────────

function reminderLine(r) {
  const state = r.status === "sent" ? `sent ${r.sent_at ? tsRelative(r.sent_at) : ""}` : r.status;
  return `\`${r.id}\` · ${r.offset_minutes} min before (${tsFull(r.fire_at)}) · ${
    r.target === "role" ? `role <@&${r.role_id}>` : "attendees"
  } · _${state}_`;
}

async function handleReminders(interaction, ctx) {
  const { client, communityId } = resolveCtx(interaction, ctx);
  void client;
  const sub = interaction.options.getSubcommand();
  const o = interaction.options;
  const settings = repo.getEventGuildSettings(communityId);

  if (sub === "default") {
    const gate = staffGate(interaction, communityId);
    if (!gate.ok) return fail(interaction, gate.error);
    const minutes = o.getInteger("minutes");
    if (minutes < 0 || minutes > repo.MAX_OFFSET_MINUTES) {
      return fail(interaction, `Minutes must be 0–${repo.MAX_OFFSET_MINUTES} (0 disables the default).`);
    }
    repo.updateEventGuildSettings(communityId, { default_reminder_minutes: minutes });
    return replyEphemeral(
      interaction,
      minutes === 0
        ? "Default reminder **off** — new events won't get an automatic reminder."
        : `New events now remind attendees **${minutes} min** before they start.`
    );
  }

  if (sub === "off" || sub === "on") {
    const gate = staffGate(interaction, communityId);
    if (!gate.ok) return fail(interaction, gate.error);
    const minutes = settings.default_reminder_minutes;
    const next = sub === "off" ? 0 : minutes === 0 ? 15 : minutes;
    repo.updateEventGuildSettings(communityId, { default_reminder_minutes: next });
    return replyEphemeral(
      interaction,
      sub === "off"
        ? "Default reminders **off** for this server (existing events keep theirs; \`/eventconfig reminders remove\`)."
        : `Default reminders **on** (${next} min before start).`
    );
  }

  if (sub === "status") {
    const mutes = repo
      .listEventMutes(communityId)
      .filter((m) => m.user_id === interaction.user.id).length;
    return replyEphemeral(
      interaction,
      [
        `**Reminder settings**`,
        `• Default: ${settings.default_reminder_minutes === 0 ? "_off_" : `${settings.default_reminder_minutes} min before`}`,
        `• Where: ${
          settings.reminder_channel_id
            ? `<#${settings.reminder_channel_id}> (fallback)`
            : "event threads first, then this server's fallback"
        }${settings.reminder_channel_id ? ` → <#${settings.reminder_channel_id}>` : ""}`,
        `• Thread reminders: ${settings.thread_reminders ? "on" : "off"}`,
        `• You're muted on ${mutes} event${mutes === 1 ? "" : "s"}.`,
      ].join("\n")
    );
  }

  if (sub === "mute" || sub === "unmute") {
    const ev = eventFrom(interaction, communityId);
    if (!ev.ok) return fail(interaction, ev.error);
    if (sub === "mute") repo.setEventMute(communityId, ev.event.id, interaction.user.id);
    else repo.clearEventMute(communityId, ev.event.id, interaction.user.id);
    return replyEphemeral(
      interaction,
      sub === "mute"
        ? `Muted for **${ev.event.title}** — signups still count, no pings.`
        : `Reminders back **on** for **${ev.event.title}**.`
    );
  }

  // add / remove / list are per-event organizer actions
  const ev = eventFrom(interaction, communityId);
  if (!ev.ok) return fail(interaction, ev.error);
  const gate = manageGate(interaction, communityId, ev.event, "edit");
  if (!gate.ok) return fail(interaction, gate.error);

  if (sub === "add") {
    const minutes = o.getInteger("minutes");
    if (minutes <= 0 || minutes > repo.MAX_OFFSET_MINUTES) {
      return fail(interaction, `Minutes must be 1–${repo.MAX_OFFSET_MINUTES}.`);
    }
    const role = o.getRole("role");
    const res = repo.createEventReminders(ev.event.id, [
      {
        offsetMinutes: minutes,
        fireAt: Number(ev.event.start_at) - minutes * 60_000,
        message: o.getString("message"),
        target: role ? "role" : "attendees",
        roleId: role ? role.id : null,
      },
    ]);
    if (!res.ok) return fail(interaction, res.error);
    return replyEphemeral(
      interaction,
      `Reminder armed: **${minutes} min** before **${ev.event.title}**${role ? ` pinging <@&${role.id}> (no signup needed)` : " for attendees"}.`
    );
  }

  if (sub === "remove") {
    const row = repo.getEventReminderById(o.getInteger("reminder"));
    if (!row || row.event_id !== ev.event.id) {
      return fail(interaction, "That reminder isn't on this event (see `/eventconfig reminders list`).");
    }
    const removed = repo.deleteEventReminder(row.id);
    return replyEphemeral(
      interaction,
      removed ? "Reminder removed." : "Only unsent reminders can be removed."
    );
  }

  // list
  const rows = repo.listEventReminders(ev.event.id);
  if (!rows.length) {
    return replyEphemeral(
      interaction,
      `No reminders for **${ev.event.title}** yet — one is armed automatically ${settings.default_reminder_minutes} min before start (change via \`/eventconfig reminders default\` or add one with \`/eventconfig reminders add\`).`
    );
  }
  return replyEphemeral(
    interaction,
    `**Reminders for ${ev.event.title}:**\n${rows.map(reminderLine).join("\n")}`
  );
}

// ── settings ────────────────────────────────────────────────────────────────

const SETTINGS_ROLE_ACTIONS = {
  create: "create_role_id",
  edit: "edit_role_id",
  delete: "delete_role_id",
  channels: "channels_role_id",
  options: "options_role_id",
};

function settingsEmbed(s) {
  const embed = baseEmbed({
    title: "📆 Event settings",
    color: Color.brand,
    description:
      "Everything here is per-server. Role gates are **additive**: staff always pass. Times without a timezone are read in the server zone.",
  });
  embed.addFields(
    { name: "Zone", value: s.time_zone },
    {
      name: "Default reminder",
      value: s.default_reminder_minutes === 0 ? "_off_" : `${s.default_reminder_minutes} min before`,
    },
    { name: "Show attendee names", value: s.show_attendees ? "yes" : "no" },
    { name: "Remind in threads", value: s.thread_reminders ? "yes" : "no" },
    { name: "Reminder fallback", value: s.reminder_channel_id ? `<#${s.reminder_channel_id}>` : "_event channel_" },
    {
      name: "Auto-archive",
      value: s.auto_archive ? `on (${s.auto_archive_delay_minutes} min after end)` : "_off_",
    },
    {
      name: "Digest",
      value:
        s.digest_frequency === "none" || !s.digest_channel_id
          ? "_off_"
          : `${s.digest_frequency} @ ${String(s.digest_hour_utc).padStart(2, "0")}:00 UTC${
              s.digest_frequency === "weekly" ? ` on weekday ${s.digest_weekday}` : ""
            } → <#${s.digest_channel_id}>`,
    },
    {
      name: "Role gates",
      value:
        Object.entries(SETTINGS_ROLE_ACTIONS)
          .map(([a, col]) => `${a}: ${s[col] ? `<@&${s[col]}>` : "everyone"}`)
          .join("\n") || "everyone",
    },
    {
      name: "Google community calendar",
      value: s.google_auto_enabled ? `auto-syncing to <@${s.google_auto_user_id}>'s calendar` : "_off_",
    }
  );
  return { embeds: [embed] };
}

async function handleSettings(interaction, ctx) {
  const { communityId } = resolveCtx(interaction, ctx);
  const sub = interaction.options.getSubcommand();
  const o = interaction.options;
  const settings = repo.getEventGuildSettings(communityId);

  if (sub === "show") {
    const gate = staffGate(interaction, communityId);
    if (!gate.ok) return fail(interaction, gate.error);
    return interaction.reply({ ...settingsEmbed(settings), flags: MessageFlags.Ephemeral });
  }

  if (sub === "show-attendees") {
    const gate = staffGate(interaction, communityId);
    if (!gate.ok) return fail(interaction, gate.error);
    const enabled = o.getBoolean("enabled");
    repo.updateEventGuildSettings(communityId, { show_attendees: enabled ? 1 : 0 });
    return replyEphemeral(
      interaction,
      enabled ? "Attendee names will show on events ✅" : "Attendee names hidden ✅"
    );
  }

  if (sub === "timezone") {
    const gate = staffGate(interaction, communityId);
    if (!gate.ok) return fail(interaction, gate.error);
    const zone = String(o.getString("zone") || "").trim();
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
    } catch {
      return fail(interaction, `\`${zone}\` isn't a valid timezone (use an IANA name like \`Europe/Berlin\` or \`America/New_York\`).`);
    }
    repo.updateEventGuildSettings(communityId, { time_zone: zone });
    return replyEphemeral(
      interaction,
      `Server zone set to **${zone}** — \`${zone}\` times like "tomorrow 7pm" now mean ${zone}. Timestamps still localize per viewer (E3).`
    );
  }

  if (sub === "role") {
    const gate = staffGate(interaction, communityId);
    if (!gate.ok) return fail(interaction, gate.error);
    const action = o.getString("action");
    const col = SETTINGS_ROLE_ACTIONS[action];
    if (!col) return fail(interaction, `Unknown action \`${action}\`.`);
    const role = o.getRole("role");
    const clear = o.getBoolean("clear");
    if (!clear && !role) return fail(interaction, "Pick a `role` or set `clear: yes`.");
    repo.updateEventGuildSettings(communityId, { [col]: clear ? null : role.id });
    return replyEphemeral(
      interaction,
      clear
        ? `**${action}** is open to everyone again (staff always allowed).`
        : `**${action}** now requires <@&${role.id}> (staff always allowed).`
    );
  }

  if (sub === "thread-reminders") {
    const gate = staffGate(interaction, communityId);
    if (!gate.ok) return fail(interaction, gate.error);
    const enabled = o.getBoolean("enabled");
    repo.updateEventGuildSettings(communityId, { thread_reminders: enabled ? 1 : 0 });
    return replyEphemeral(
      interaction,
      enabled ? "Reminders will use the event thread ✅" : "Reminders now go to the event channel instead ✅"
    );
  }

  if (sub === "reminder-channel") {
    const gate = staffGate(interaction, communityId);
    if (!gate.ok) return fail(interaction, gate.error);
    const channel = o.getChannel("channel");
    const clear = o.getBoolean("clear");
    if (!clear && !channel) return fail(interaction, "Pick a `channel` or `clear: yes`.");
    repo.updateEventGuildSettings(communityId, { reminder_channel_id: clear ? null : channel.id });
    return replyEphemeral(
      interaction,
      clear
        ? "Reminder fallback cleared — reminders use the event's channel when there's no thread."
        : `Reminder fallback: <#${channel.id}> (used when an event has no thread).`
    );
  }

  if (sub === "auto-archive") {
    const gate = staffGate(interaction, communityId);
    if (!gate.ok) return fail(interaction, gate.error);
    const enabled = o.getBoolean("enabled");
    const patch = { auto_archive: enabled ? 1 : 0 };
    if (enabled) {
      const delay = o.getInteger("delay_minutes") ?? settings.auto_archive_delay_minutes;
      if (delay < 5 || delay > 43_200) {
        return fail(interaction, "delay_minutes must be between 5 and 43200 (30 days).");
      }
      patch.auto_archive_delay_minutes = delay;
    }
    repo.updateEventGuildSettings(communityId, patch);
    return replyEphemeral(
      interaction,
      enabled
        ? `Auto-archive **on**: posted events archive themselves ${patch.auto_archive_delay_minutes} min after they end (E8).`
        : "Auto-archive **off** — events stay posted until you delete/archive them."
    );
  }

  if (sub === "digest") {
    const gate = staffGate(interaction, communityId);
    if (!gate.ok) return fail(interaction, gate.error);
    const clear = o.getBoolean("clear");
    if (clear) {
      repo.updateEventGuildSettings(communityId, { digest_frequency: "none", digest_channel_id: null });
      return replyEphemeral(interaction, "Event digest cleared.");
    }
    const channel = o.getChannel("channel");
    const frequency = o.getString("frequency");
    if (!channel || !frequency) {
      return fail(interaction, "Digest needs a `channel` and a `frequency` (daily/weekly/none).");
    }
    if (frequency === "none") {
      repo.updateEventGuildSettings(communityId, { digest_frequency: "none", digest_channel_id: null });
      return replyEphemeral(interaction, "Event digest **off**.");
    }
    const hour = o.getInteger("hour_utc") ?? settings.digest_hour_utc;
    const weekday = o.getInteger("weekday") ?? settings.digest_weekday;
    if (hour < 0 || hour > 23) return fail(interaction, "hour_utc must be 0–23.");
    if (weekday < 0 || weekday > 6) return fail(interaction, "weekday must be 0 (Sun)–6 (Sat).");
    repo.updateEventGuildSettings(communityId, {
      digest_channel_id: channel.id,
      digest_frequency: frequency,
      digest_hour_utc: hour,
      digest_weekday: weekday,
    });
    return replyEphemeral(
      interaction,
      `Digest: **${frequency}** at ${String(hour).padStart(2, "0")}:00 UTC${
        frequency === "weekly" ? ` (weekday ${weekday})` : ""
      } → <#${channel.id}>`
    );
  }

  return fail(interaction, `Unknown settings subcommand \`${sub}\`.`);
}

// ── options (signup option CRUD) ────────────────────────────────────────────

async function handleOptions(interaction, ctx) {
  const { communityId } = resolveCtx(interaction, ctx);
  const sub = interaction.options.getSubcommand();
  const o = interaction.options;
  const ev = eventFrom(interaction, communityId);
  if (!ev.ok) return fail(interaction, ev.error);
  const gate = manageGate(interaction, communityId, ev.event, "options");
  if (!gate.ok) return fail(interaction, gate.error);

  if (sub === "list") {
    return replyEphemeral(
      interaction,
      `**Options for ${ev.event.title}:**\n${options.renderOptionTable(ev.event.id)}`
    );
  }

  if (sub === "add") {
    const res = repo.createEventOption(ev.event.id, {
      label: o.getString("label"),
      emoji: o.getString("emoji"),
      capacity: o.getInteger("capacity") ?? 0,
      waitlist_on: o.getBoolean("waitlist") ?? true,
      reminders_on: o.getBoolean("reminders") ?? false,
      // #344: the repo normalizes ARRAYS (toJsonArray) — a pre-stringified
      //      value is a non-array and flattens to "[]": the option looked gated,
      //      every member could still sign up.
      role_whitelist: o.getRole("only_role") ? [o.getRole("only_role").id] : [],
    });
    if (!res.ok) return fail(interaction, res.error);
    return replyEphemeral(interaction, `Option **${res.option.label}** added (\`${res.option.id}\`) — refresh the event message with \`/event post\`… it syncs automatically on the next edit.`);
  }

  if (sub === "edit") {
    const opt = options.resolveOption(ev.event.id, o.getInteger("option"));
    if (!opt) return fail(interaction, "That option isn't on this event (see `/eventsignup options list`).");
    const patch = {};
    if (o.getString("label") != null) patch.label = o.getString("label");
    if (o.getString("emoji") != null) patch.emoji = o.getString("emoji");
    if (o.getInteger("capacity") != null) patch.capacity = o.getInteger("capacity");
    if (o.getBoolean("waitlist") != null) patch.waitlist_on = o.getBoolean("waitlist");
    if (o.getBoolean("reminders") != null) patch.reminders_on = o.getBoolean("reminders");
    if (o.getBoolean("clear_role")) patch.role_whitelist = [];
    else if (o.getRole("only_role")) patch.role_whitelist = [o.getRole("only_role").id]; // #344: array in, see options add
    if (!Object.keys(patch).length) return fail(interaction, "Nothing to change.");
    const res = repo.updateEventOption(opt.id, patch);
    if (res && res.ok === false) return fail(interaction, res.error);
    const sync = await optionsTouchMessage(interaction, ctx, ev.event);
    return replyEphemeral(interaction, `Option updated ✅${sync}`);
  }

  if (sub === "remove") {
    const opt = options.resolveOption(ev.event.id, o.getInteger("option"));
    if (!opt) return fail(interaction, "That option isn't on this event.");
    // #346: countEventSignups groups CAMELCASE ({ signedUp, waitlisted }) —
    // this guard read counts.signed_up, could NEVER trip, and the delete
    // CASCADEd every member row while the reply celebrated the removal.
    // Any member row — signed up or waiting — blocks the removal: those are
    // people, not debris.
    const counts = repo.countEventSignups(ev.event.id)[opt.id] || {};
    if ((counts.signedUp || 0) > 0 || (counts.waitlisted || 0) > 0) {
      const parts = [];
      if ((counts.signedUp || 0) > 0) parts.push(`${counts.signedUp} signup(s)`);
      if ((counts.waitlisted || 0) > 0) parts.push(`${counts.waitlisted} waiter(s)`);
      return fail(
        interaction,
        `**${opt.label}** has ${parts.join(" and ")} — remove them first with \`/eventsignup response remove\`.`
      );
    }
    repo.deleteEventOption(opt.id);
    const sync = await optionsTouchMessage(interaction, ctx, ev.event);
    return replyEphemeral(interaction, `Option **${opt.label}** removed ✅${sync}`);
  }

  if (sub === "reorder") {
    const res = options.reorder(ev.event.id, o.getString("order"));
    if (!res.ok) return fail(interaction, res.error);
    const sync = await optionsTouchMessage(interaction, ctx, ev.event);
    return replyEphemeral(interaction, `Options reordered ✅${sync}`);
  }

  if (sub === "whitelist") {
    const clear = o.getBoolean("clear");
    const role = o.getRole("role");
    if (!clear && !role) return fail(interaction, "Pick a `role` or `clear: yes`.");
    // #344 (the e2e-pinned lie): JSON.stringify([role.id]) is a STRING —
    // toJsonArray() maps non-arrays to "[]", so the event stored an EMPTY
    // whitelist while the reply promised "limited to <@&role> and staff".
    // The repo stringifies arrays itself; hand it one.
    const res = repo.updateEvent(ev.event.id, {
      role_whitelist: clear ? [] : [role.id],
    });
    if (!res.ok) return fail(interaction, res.error);
    const sync = await optionsTouchMessage(interaction, ctx, ev.event);
    return replyEphemeral(
      interaction,
      clear
        ? `Event whitelist cleared — any member can sign up (option gates still apply).${sync}`
        : `**${ev.event.title}** is now limited to <@@${role.id}> and staff.${sync}`.replace("@@", "&")
    );
  }

  return fail(interaction, `Unknown options subcommand \`${sub}\`.`);
}

/** Re-render the posted message after an option change; returns note text. */
async function optionsTouchMessage(interaction, ctx, event) {
  if (event.status !== "posted") return "";
  const { client } = resolveCtx(interaction, ctx);
  const res = await service.refreshEventMessages(client, event);
  return res.warnings?.length ? ` (message note: ${res.warnings.join("; ")})` : "";
}

// ── presets ─────────────────────────────────────────────────────────────────

async function handlePreset(interaction, ctx) {
  const { communityId } = resolveCtx(interaction, ctx);
  const sub = interaction.options.getSubcommand();
  const o = interaction.options;
  const gate = staffGate(interaction, communityId);
  if (!gate.ok) return fail(interaction, gate.error);

  if (sub === "save") {
    const ev = eventFrom(interaction, communityId);
    if (!ev.ok) return fail(interaction, ev.error);
    const res = presets.save(communityId, o.getString("name"), ev.event.id, interaction.user.id);
    if (!res.ok) return fail(interaction, res.error);
    return replyEphemeral(interaction, `Preset **${o.getString("name")}** saved ✅ (${repo.listEventOptions(ev.event.id).length} options).`);
  }
  if (sub === "delete") {
    const res = presets.remove(communityId, o.getString("name"));
    if (!res.ok) return fail(interaction, res.error);
    return replyEphemeral(interaction, `Preset **${o.getString("name")}** deleted.`);
  }
  const rows = presets.list(communityId);
  if (!rows.length) {
    return replyEphemeral(interaction, "No presets yet — save one with `/eventsignup preset save` from any event.");
  }
  return replyEphemeral(
    interaction,
    `**Presets:**\n${rows
      .map((p) => `• **${p.name}** — ${p.options.map((x) => x.label).join(" / ")}`)
      .join("\n")}`
  );
}

// ── series ──────────────────────────────────────────────────────────────────

async function handleSeries(interaction, ctx) {
  const { communityId } = resolveCtx(interaction, ctx);
  const sub = interaction.options.getSubcommand();
  const gate = staffGate(interaction, communityId);
  if (!gate.ok) return fail(interaction, gate.error);

  if (sub === "list") {
    const rows = series.listActive(communityId);
    if (!rows.length) return replyEphemeral(interaction, "No active series — start one with `/event create` + `recurrence`.");
    return replyEphemeral(
      interaction,
      `**Series:**\n${rows
        .map(
          (s) =>
            `• \`${s.id}\` ${s.cadence}${s.cadence === "weekly" ? ` (${s.weekdays.join(",")})` : ""}` +
            ` · ${s.occurrences_created} created · next ${s.next_occurrence_at ? tsRelative(s.next_occurrence_at) : "_compute_"}` +
            ` · end ${s.end_mode}${s.end_count ? ` ×${s.end_count}` : ""}`
        )
        .join("\n")}`
    );
  }
  const ev = eventFrom(interaction, communityId);
  if (!ev.ok) return fail(interaction, ev.error);
  const gate2 = manageGate(interaction, communityId, ev.event, "edit");
  if (!gate2.ok) return fail(interaction, gate2.error);
  const res = sub === "skip" ? series.skipOccurrence(ev.event) : series.stopSeries(ev.event, interaction.user.id);
  if (!res.ok) return fail(interaction, res.error);
  return replyEphemeral(
    interaction,
    sub === "skip"
      ? `Occurrence **${ev.event.title}** skipped — series moves on.`
      : "Series stopped — existing events stay."
  );
}

// ── channels (E7) ───────────────────────────────────────────────────────────

async function handleChannel(interaction, ctx) {
  const { client, communityId } = resolveCtx(interaction, ctx);
  const sub = interaction.options.getSubcommand();
  const o = interaction.options;
  const gate = staffGate(interaction, communityId);
  if (!gate.ok) return fail(interaction, gate.error);

  if (sub === "list") {
    const rows = repo.listEventChannels(communityId);
    if (!rows.length) {
      return replyEphemeral(interaction, "No event channels marked — `/eventchannels channel mark` turns one into a dedicated event feed.");
    }
    return replyEphemeral(
      interaction,
      `**Event channels:**\n${rows
        .map((r) => `• <#${r.channel_id}>${r.purge ? " · _purge on (opt-in, E7)_" : ""}`)
        .join("\n")}`
    );
  }

  const channel = o.getChannel("channel") || interaction.channel;
  if (!channel) return fail(interaction, "Pick a channel.");

  if (sub === "mark") {
    repo.markEventChannel(communityId, channel.id);
    return replyEphemeral(
      interaction,
      `<#${channel.id}> is an event channel now. Use \`/eventconfig settings reminder-channel\` or create events there with \`/event create channel:#…\`. Purge stays **off** until enabled (E7).`
    );
  }
  if (sub === "unmark") {
    repo.unmarkEventChannel(communityId, channel.id);
    return replyEphemeral(interaction, `<#${channel.id}> is no longer an event channel.`);
  }
  if (sub === "purge") {
    const enabled = o.getBoolean("enabled");
    const run = o.getBoolean("run");
    if (!repo.isEventChannel(communityId, channel.id)) {
      return fail(interaction, "Only a marked event channel can purge (E7 keeps this opt-in twice).");
    }
    if (enabled != null) {
      repo.setEventChannelPurge(communityId, channel.id, enabled);
      if (!run) {
        return replyEphemeral(
          interaction,
          enabled
            ? `Purge **on** for <#${channel.id}>: \`/eventchannels channel purge run:yes\` deletes non-event, unpinned messages (E7).`
            : `Purge **off** for <#${channel.id}>.`
        );
      }
    }
    if (!run) return fail(interaction, "Set `enabled` and/or `run: yes`.");
    const flagged = repo.listEventChannels(communityId).find((r) => r.channel_id === channel.id);
    if (!flagged || !flagged.purge) {
      return fail(interaction, "Purge isn't enabled for that channel — `/eventchannels channel purge enabled:yes` first (E7: opt-in only).");
    }
    const del = await purgeChannelMessages(client, interaction, channel);
    return replyEphemeral(
      interaction,
      `Purged <#${channel.id}>: ${del.deleted} message(s) removed, ${del.kept} kept (events/pins)${
        del.failed ? `, ${del.failed} failed` : ""
      }.`
    );
  }
  if (sub === "sort") {
    return handleChannelSort(interaction, ctx, channel);
  }
  return fail(interaction, `Unknown channel subcommand \`${sub}\`.`);
}

/** Keep ≤50 event messages ordered by event start (re-send + delete). */
async function handleChannelSort(interaction, ctx, channel) {
  const { client, communityId } = resolveCtx(interaction, ctx);
  if (!repo.isEventChannel(communityId, channel.id)) {
    return fail(interaction, "Mark it with `/eventchannels channel mark` first — sort only touches event channels.");
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const messages = await channel.messages.fetch({ limit: 50 }).catch(async () => {
    const cached = channel.messages?.cache;
    return cached ? [...cached.values()] : [];
  });
  const list = Array.from(messages.values ? messages.values() : messages);
  const eventMsgs = [];
  for (const msg of list) {
    const ev = msg.author?.id === client.user?.id ? repo.getEventByMessage(msg.id) : null;
    if (ev && ev.community_id === communityId && ev.status === "posted") eventMsgs.push({ msg, ev });
  }
  if (eventMsgs.length < 2) {
    return interaction.editReply("Nothing to sort — fewer than two bot event messages in this channel.");
  }
  eventMsgs.sort((a, b) => Number(a.ev.start_at) - Number(b.ev.start_at));
  let moved = 0;
  let failed = 0;
  for (const { ev } of eventMsgs) {
    // Re-send in order at the bottom, newest event last; update message ids.
    try {
      const payload = service.renderEventPayload(repo.getEventById(ev.id), { guild: interaction.guild });
      const sent = await channel.send(payload);
      repo.updateEvent(ev.id, { message_id: sent.id });
      moved += 1;
    } catch (err) {
      failed += 1;
      console.error(`[events] channel sort re-post event=${ev.id}:`, err?.message || err);
    }
  }
  if (moved > 0) {
    for (const { msg, ev } of eventMsgs) {
      const fresh = repo.getEventById(ev.id);
      if (fresh.message_id === msg.id) continue; // kept as-is? (not re-posted)
      try {
        await msg.delete();
      } catch (err) {
        console.error(`[events] channel sort delete event=${ev.id}:`, err?.message || err);
      }
    }
  }
  return interaction.editReply(
    `Sorted ${moved} event message(s) chronologically (cap 50)${failed ? `; ${failed} failed` : ""}.`
  );
}

/** E7 purge: non-event, non-pinned messages in a flagged event channel. */
async function purgeChannelMessages(client, interaction, channel) {
  const list = await channel.messages.fetch({ limit: 100 }).catch(() => []);
  const messages = Array.from(list.values ? list.values() : list);
  let deleted = 0;
  let kept = 0;
  let failed = 0;
  for (const msg of messages) {
    const isEvent = repo.getEventByMessage(msg.id) != null;
    if (msg.pinned || isEvent || msg.author?.id === client.user?.id) {
      kept += 1;
      continue;
    }
    try {
      await msg.delete();
      deleted += 1;
    } catch (err) {
      failed += 1;
      console.error(`[events] purge delete msg=${msg.id}:`, err?.message || err);
    }
  }
  return { deleted, kept, failed };
}

// ── crosspost ───────────────────────────────────────────────────────────────

async function handleCrosspost(interaction, ctx) {
  const { communityId } = resolveCtx(interaction, ctx);
  const sub = interaction.options.getSubcommand();
  const o = interaction.options;
  const gate = staffGate(interaction, communityId);
  if (!gate.ok) return fail(interaction, gate.error);

  if (sub === "invite") {
    const destGuildId = String(o.getString("destination_guild_id") || "").trim();
    if (!/^\d{17,20}$/.test(destGuildId)) return fail(interaction, "destination_guild_id must be a Discord server id.");
    if (destGuildId === interaction.guildId) return fail(interaction, "That's this server.");
    const destCommunity = ensureCommunityForGuild(destGuildId);
    if (destCommunity == null) return fail(interaction, "The destination bot must be a member there and registered before pairing.");
    const existing = repo.getEventCrosspostByPair(communityId, destCommunity);
    if (existing && existing.state !== "revoked") {
      return fail(interaction, `Pair already ${existing.state} (id ${existing.id}).`);
    }
    const res = repo.inviteEventCrosspost({
      sourceCommunityId: communityId,
      destCommunityId: destCommunity,
      createdBy: interaction.user.id,
      mentions: parseRoleList(o.getString("roles")),
      roleWhitelist: [],
      destChannelId: o.getChannel("destination_channel")?.id || null,
    });
    if (!res.ok) return fail(interaction, res.error || `Could not create the invite: ${res.error}`);
    return replyEphemeral(
      interaction,
      `Give this code to staff in \`${destGuildId}\` — they run \`/eventchannels crosspost approve\`:\n**\`${res.crosspost.invite_code}\`** (id \`${res.crosspost.id}\`)`
    );
  }

  if (sub === "approve") {
    const code = String(o.getString("code") || "").trim();
    const pair = repo.getEventCrosspostByCode(code);
    if (!pair || pair.state !== "pending") return fail(interaction, "Unknown or used code.");
    if (pair.dest_community_id !== communityId) return fail(interaction, "That code isn't for this server.");
    const channel = o.getChannel("channel");
    const res = repo.approveEventCrosspost(pair.id, {
      approvedBy: interaction.user.id,
      destChannelId: channel ? channel.id : null,
    });
    if (res && res.ok === false) return fail(interaction, res.error);
    return replyEphemeral(
      interaction,
      `Cross-post active ✅ — events from the partner server will appear${channel ? ` in <#${channel.id}>` : ""}. Their members' signups still count toward THEIR event; you can gate them with \`/eventchannels crosspost config\`.`
    );
  }

  if (sub === "revoke") {
    const id = o.getInteger("id");
    const pair = repo.getEventCrosspostById(id);
    if (!pair) return fail(interaction, `No cross-post id \`${id}\` (see \`/eventchannels crosspost list\`).`);
    if (pair.source_community_id !== communityId && pair.dest_community_id !== communityId) {
      return fail(interaction, "That pair doesn't involve this server.");
    }
    const res = repo.revokeEventCrosspost(id);
    if (res && res.ok === false) return fail(interaction, res.error);
    return replyEphemeral(interaction, `Cross-post \`${id}\` revoked.`);
  }

  if (sub === "config") {
    const id = o.getInteger("id");
    const pair = repo.getEventCrosspostById(id);
    if (!pair) return fail(interaction, `No cross-post id \`${id}\`.`);
    if (pair.source_community_id !== communityId && pair.dest_community_id !== communityId) {
      return fail(interaction, "That pair doesn't involve this server.");
    }
    const patch = {};
    const roles = o.getString("roles");
    if (roles != null) patch.role_whitelist = parseRoleList(roles);
    const offset = o.getInteger("offset_minutes");
    if (offset != null) patch.post_offset_minutes = Math.max(0, Math.min(1440, offset));
    const signupRole = o.getRole("signup_role");
    if (o.getBoolean("clear_signup_role")) patch.role_whitelist = [];
    else if (signupRole) patch.role_whitelist = [signupRole.id];
    if (!Object.keys(patch).length) return fail(interaction, "Nothing to change.");
    const res = repo.updateEventCrosspost(id, patch);
    if (res && res.ok === false) return fail(interaction, res.error);
    return replyEphemeral(interaction, `Cross-post \`${id}\` updated ✅`);
  }

  // list
  const rows = repo.listEventCrosspostsForCommunity(communityId);
  if (!rows.length) {
    return replyEphemeral(interaction, "No cross-posts yet — `/eventchannels crosspost invite` starts a pair.");
  }
  return replyEphemeral(
    interaction,
    `**Cross-posts:**\n${rows
      .map(
        (p) =>
          `• \`${p.id}\` ${p.source_community_id === communityId ? "→ out" : "← in"} ↔ community \`${
            p.source_community_id === communityId ? p.dest_community_id : p.source_community_id
          }\` · **${p.state}**${p.post_offset_minutes ? ` · +${p.post_offset_minutes}m delay` : ""}`
      )
      .join("\n")}`
  );
}

function ensureCommunityForGuild(guildId) {
  try {
    return ensureCommunity({ platform: "discord", instanceKey: "discord", externalGuildId: guildId });
  } catch {
    return null;
  }
}

// ── google ──────────────────────────────────────────────────────────────────

async function handleGoogle(interaction, ctx) {
  const { client, communityId } = resolveCtx(interaction, ctx);
  void client;
  const sub = interaction.options.getSubcommand();

  if (sub === "connect") {
    const res = gcal.startConnect(communityId, interaction.user.id);
    if (!res.ok) return fail(interaction, res.error);
    return replyEphemeral(
      interaction,
      `Connect Google Calendar (link expires in ~10 min):\n<${res.url}>`
    );
  }
  if (sub === "disconnect") {
    gcal.disconnect(communityId, interaction.user.id);
    return replyEphemeral(interaction, "Calendar disconnected — posted events already added stay in Google.");
  }
  if (sub === "status") {
    const st = gcal.status(communityId, interaction.user.id);
    return replyEphemeral(
      interaction,
      st.connected
        ? `Connected as **${st.email || "unknown"}** (calendar \`${st.calendarId}\`). Tap **📅 My calendar** on any event to add it.`
        : "Not connected — `/eventconfig google connect` links your calendar."
    );
  }
  if (sub === "autoset") {
    const gate = staffGate(interaction, communityId);
    if (!gate.ok) return fail(interaction, gate.error);
    const off = interaction.options.getBoolean("off");
    const member = interaction.options.getMember("member");
    gcal.autoset(communityId, interaction.user.id, { memberId: member?.id || null, off: Boolean(off) });
    return replyEphemeral(
      interaction,
      off
        ? "Community-calendar auto-sync **off**."
        : `Posted events now auto-add to <@${member?.id || interaction.user.id}>'s connected calendar.`
    );
  }
  return fail(interaction, `Unknown google subcommand \`${sub}\`.`);
}

// ── dispatcher ──────────────────────────────────────────────────────────────

const DISPATCH = {
  create: handleCreate,
  edit: handleEdit,
  delete: handleDelete,
  list: handleList,
  wizard: handleWizard,
  duplicate: handleDuplicate,
  post: handlePost,
  adopt: handleAdopt,
  "response-add": handleResponse,
  "response-remove": handleResponse,
  "response-move": handleResponse,
  reminders: handleReminders,
  settings: handleSettings,
  options: handleOptions,
  preset: handlePreset,
  series: handleSeries,
  channel: handleChannel,
  crosspost: handleCrosspost,
  google: handleGoogle,
};

async function handleEvent(interaction, ctx) {
  const group = interaction.options.getSubcommandGroup?.() || null;
  const sub = interaction.options.getSubcommand?.() || null;
  const key = group ? `${group}-${sub}` : sub;
  const fn = DISPATCH[key] || DISPATCH[group];
  if (!fn) {
    return fail(
      interaction,
      `\`/${interaction.commandName} ${group ? group + " " + sub : sub}\` isn't wired up yet (this build is missing that handler).`
    );
  }
  try {
    await fn(interaction, ctx);
  } catch (err) {
    console.error(
      `[events] /${interaction.commandName} ${key} guild=${interaction.guildId} user=${interaction.user?.id} failed:`,
      err?.message || err
    );
    const cause = err?.message || String(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: `Something went wrong: \`${cause}\``, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: `Something went wrong: \`${cause}\``, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}

module.exports = {
  handleEvent,
  eventFrom,
  staffGate,
  handleSettings,
  handleOptions,
};
