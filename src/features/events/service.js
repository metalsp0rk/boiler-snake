/**
 * Community events service (epic #218).
 *
 * Everything Discord-facing lives here: post/edit/delete/archive of the
 * event message, the signup engine (capacity, waitlist, promotion,
 * whitelist, cutoff, attendee-role sync), reminder delivery for bot-owned
 * events, digests, duplication, and adoption from Guild Scheduled Events.
 *
 * Contract (AGENTS.md): services NEVER reply to Discord. Every failure is
 * `{ ok:false, error }` with a CAUSE a human can act on, or a logged
 * warning; handlers turn `error` into the reply. Multi-step operations
 * accumulate `warnings[]` and surface partial results instead of aborting.
 */
const db = require("../../db");
const eventRepo = require("../../db/repositories/events");
const { getCommunityById } = require("../../platform/community");
const { isStaff } = require("../../core/permissions");
const { PermissionFlagsBits } = require("discord.js");
const { baseEmbed, truncateField, truncateDescription, tsFull, tsRelative, Color } = require("../../core/theme");
const { renderReminderMessage } = require("../eventReminders/service");

const ui = require("./ui");
const roles = require("./roles");
const { parseEventTime, parseDuration } = require("./timeParse");

const REMINDER_DEFAULT_BODY =
  "⏰ **{event}** starts {starts_in} {role}";
const GONE_CODES = [10003, 10004, 10008, 10060];

const isGoneError = (err) => GONE_CODES.includes(err?.code ?? err?.rawError?.code);

// ── platform resolution ─────────────────────────────────────────────────────

/** Resolve a Discord guild for a community id (cache → fetch). */
async function guildFor(client, communityId) {
  if (!client) return null;
  const row = getCommunityById(communityId);
  if (!row || row.platform !== "discord") return null;
  const cached = client.guilds?.cache?.get(row.externalGuildId);
  if (cached) return cached;
  try {
    return await client.guilds?.fetch?.(row.externalGuildId);
  } catch {
    return null;
  }
}

function memberRoleIds(member) {
  if (!member) return [];
  if (member.roles?.cache) return [...member.roles.cache.keys()];
  if (Array.isArray(member.roles)) return member.roles.map(String);
  return [];
}

function messageLink(event) {
  if (!event?.guild_external_id) return null;
  return event.message_id && event.channel_id
    ? `https://discord.com/channels/${event.guild_external_id}/${event.channel_id}/${event.message_id}`
    : null;
}

// ── permission model (E4/E5) ────────────────────────────────────────────────

function holdsRole(member, communityId, roleId) {
  if (!roleId) return true;
  return memberRoleIds(member).includes(String(roleId));
}

/**
 * Staff gate for service code (E4). Accepts an interaction (uses
 * core/permissions.isStaff verbatim — the security source of truth) or a
 * guild member (ManageGuild via member.permissions, or a staff_roles row).
 */
function isStaffMember(subject, communityId) {
  if (!subject) return false;
  if (subject.memberPermissions !== undefined || subject.guildId !== undefined)
    return isStaff(subject);
  if (subject.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  return db.memberHasStaffRole(communityId, memberRoleIds(subject));
}

function isOrganizer(member, event) {
  return Boolean(member && event && String(member.id) === String(event.creator_id));
}

function canCreateEvent(member, communityId) {
  const settings = db.getEventGuildSettings(communityId);
  if (isStaffMember(member, communityId)) return { ok: true };
  if (settings.create_role_id && !holdsRole(member, communityId, settings.create_role_id)) {
    return {
      ok: false,
      error: `Events in this server are created by people with the <@&${settings.create_role_id}> role.`,
    };
  }
  return { ok: true };
}

/**
 * E4: creator OR staff OR the action's extra role gate.
 * @param {'edit'|'delete'|'options'|'channels'} kind
 */
function canManageEvent(member, communityId, event, kind = "edit") {
  if (isOrganizer(member, event) || isStaffMember(member, communityId)) return { ok: true };
  const settings = db.getEventGuildSettings(communityId);
  const gateRole =
    kind === "delete" ? settings.delete_role_id
      : kind === "options" ? settings.options_role_id
      : kind === "channels" ? settings.channels_role_id
      : settings.edit_role_id;
  if (gateRole && holdsRole(member, communityId, gateRole)) return { ok: true };
  return {
    ok: false,
    error: `Only the **organizer**, **staff**, or holders of${
      gateRole ? ` <@&${gateRole}>` : " the required role"
    } may ${kind} this event.`,
  };
}

/** E5 bypass for signup restrictions/cutoffs. */
function bypassesRestrictions(member, event, communityId) {
  return isOrganizer(member, event) || isStaffMember(member, communityId);
}

// ── signup gating ───────────────────────────────────────────────────────────

function signupClosedReason(event, nowMs = Date.now()) {
  const cutoff = event.cutoff_at ?? event.start_at;
  if (nowMs > cutoff) {
    return `Signups for this event closed {cutoff}`.replace("{cutoff}", tsFull(cutoff));
  }
  return null;
}

/**
 * Whitelist check: event-level whitelist AND the option's own whitelist.
 * @param {string[]} roleIds member role ids
 */
function whitelistReason(event, option, roleIds) {
  const parse = (raw) => {
    if (Array.isArray(raw)) return raw;
    try {
      const v = JSON.parse(raw || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const evList = parse(event.role_whitelist);
  if (evList.length && !evList.some((r) => roleIds.includes(String(r)))) {
    return `This event is restricted to: ${evList.map((r) => `<@&${r}>`).join(" ")}.`;
  }
  const optList = parse(option.role_whitelist);
  if (optList.length && !optList.some((r) => roleIds.includes(String(r)))) {
    return `**${option.label}** is restricted to: ${optList.map((r) => `<@&${r}>`).join(" ")}.`;
  }
  return null;
}

// ── rendering / refresh ─────────────────────────────────────────────────────

/**
 * Build the Discord payload for an event from DB truth.
 * @param {object|null} guild resolved Discord guild (nameOf degrades without)
 */
function renderEventPayload(event, { guild = null } = {}) {
  const settings = db.getEventGuildSettings(event.community_id);
  const options = db.listEventOptions(event.id);
  const counts = db.countEventSignups(event.id);
  const signups = db.listEventSignups(event.id, { state: "signed_up", limit: 400 });
  for (const opt of options) opt._attendees = [];
  const byId = new Map(options.map((o) => [o.id, o]));
  for (const s of signups) byId.get(s.option_id)?._attendees.push(s.user_id);

  const nameOf = (uid) => {
    const m = guild?.members?.cache?.get(String(uid));
    return m?.displayName ?? m?.user?.username ?? `<@${uid}>`;
  };
  return ui.buildEventMessage(event, { options, counts, settings, nameOf });
}

/**
 * Re-edit every Discord message showing this event (the original post and all
 * cross-post copies). Failures are logged; the DB stays authoritative.
 * gone=true results clear coordinates instead of retrying forever.
 */
async function refreshEventMessages(client, event) {
  const warnings = [];
  if (event.status !== "posted") return { updated: 0, warnings };
  const guild = await guildFor(client, event.community_id);
  let updated = 0;
  if (event.message_id && event.channel_id) {
    try {
      const channel = client.channels?.cache?.get(event.channel_id)
        ?? (await client.channels?.fetch?.(event.channel_id).catch(() => null));
      if (!channel) throw Object.assign(new Error("channel missing"), { code: 10003 });
      const msg = await channel.messages.fetch(event.message_id);
      const payload = renderEventPayload(event, { guild });
      await msg.edit({ ...payload, content: msg.content ?? null }); // keep post-time mentions
      updated += 1;
    } catch (err) {
      if (isGoneError(err)) warnings.push("event message is gone (deleted or channel removed)");
      else warnings.push(`Could not update the event message: ${err?.message || err}`);
      console.warn(
        `[events] refresh message failed guild=${event.community_id} event=${event.id}:`,
        err?.message || err,
      );
    }
  }
  try {
    const x = require("./crosspost");
    const res = await x.syncEventMessages(client, event);
    updated += res.updated;
    warnings.push(...res.warnings);
  } catch (err) {
    warnings.push(`cross-post sync failed: ${err?.message || err}`);
  }
  return { updated, warnings };
}

// ── reminder arming / rescheduling ──────────────────────────────────────────

function buildDefaultReminderRow(event, settings) {
  const minutes = settings.default_reminder_minutes;
  if (!minutes || minutes <= 0) return null;
  if (minutes > eventRepo.MAX_OFFSET_MINUTES) return null;
  const fireAt = event.start_at - minutes * 60_000;
  if (fireAt <= Date.now()) return null; // too late to warn anyone
  return { offsetMinutes: minutes, fireAt, message: null, target: "attendees", roleId: null };
}

/** Arm the guild-default reminder when the event has none armed yet. */
function armDefaultReminder(event, settings) {
  const unsent = db.listEventReminders(event.id, { unsentOnly: true });
  if (unsent.length) return { ok: true, armed: 0 };
  const row = buildDefaultReminderRow(event, settings);
  if (!row) return { ok: true, armed: 0 };
  const res = db.createEventReminders(event.id, [row]);
  if (!res.ok) return { ok: false, warning: `Could not arm the default reminder: ${res.error}` };
  return { ok: true, armed: 1 };
}

// ── posting ─────────────────────────────────────────────────────────────────

/**
 * Post a draft (from /event create confirm, /event post, the scheduled-post
 * step, or a series materialization). Partial failures degrade: the event is
 * posted and every skipped side effect lands in `warnings` (AGENTS rule 5).
 */
async function postEventNow(client, event, { actorId = null, announce = true } = {}) {
  const warnings = [];
  if (event.status === "posted") return { ok: true, event, warnings: ["already posted"] };
  const guild = await guildFor(client, event.community_id);
  if (!guild) {
    return { ok: false, error: `the guild for this event is not reachable (community ${event.community_id})` };
  }
  const channelId = event.channel_id;
  if (!channelId) return { ok: false, error: "no post channel set — add one with /event edit" };
  const channel = guild.channels.cache.get(channelId)
    ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel) {
    return { ok: false, error: `post channel <#${channelId}> not found — pick another with \`/event edit\`.` };
  }
  if (typeof channel.send !== "function") {
    return { ok: false, error: `<#${channelId}> cannot receive messages (wrong channel type or missing Send Messages).` };
  }

  // Attendee role first so the reminder audience can be synced at once.
  let roleReady = null;
  const roleRes = await roles.ensureEventAttendeeRole(
    guild,
    event,
    `Event: ${event.title}`,
  );
  if (roleRes.ok && roleRes.role) {
    roleReady = roleRes.role;
    if (event.role_mode === "temp" && roleRes.role.id !== event.attendee_role_id) {
      db.updateEvent(event.id, { attendee_role_id: roleRes.role.id });
      event = db.getEventById(event.id);
    }
  } else if (!roleRes.ok) {
    warnings.push(`Attendee role: ${roleRes.error}`);
    console.error(
      `[events] attendee role failed guild=${event.community_id} event=${event.id}: ${roleRes.error}`,
    );
  }

  const payload = renderEventPayload(event, { guild });
  const announceIds = JSON.parse(event.announce_role_ids || "[]");
  const content = announce && announceIds.length
    ? announceIds.map((r) => `<@&${r}>`).join(" ")
    : null;
  let posted;
  try {
    posted = await channel.send({
      ...payload,
      content,
      allowedMentions: { roles: announce && announceIds.length ? announceIds : [], users: [], parse: [] },
    });
  } catch (err) {
    return {
      ok: false,
      error: `Could not post the event: ${err?.message || err}`,
    };
  }

  db.markEventPosted(event.id, { channelId: channel.id, messageId: posted.id });
  let fresh = db.getEventById(event.id);

  // Event thread (phase 3) — best effort, never blocks the post.
  if (fresh.thread_enabled) {
    try {
      const thread = await channel.threads.create({
        name: `event-${roles.slugify(fresh.title)}`.slice(0, 90),
        type: undefined, // public default; private handled below
        invitable: !fresh.thread_private,
        private: Boolean(fresh.thread_private),
        startMessage: posted,
        reason: `Event thread: ${fresh.title}`,
      });
      db.setEventThread(fresh.id, thread.id);
      fresh = db.getEventById(fresh.id);
    } catch (err) {
      warnings.push(`Could not create the event thread: ${err?.message || err}`);
      console.warn(
        `[events] thread create failed guild=${fresh.community_id} event=${fresh.id}:`,
        err?.message || err,
      );
    }
  }

  // Reminders: arm the guild default when nothing explicit was added.
  const settings = db.getEventGuildSettings(fresh.community_id);
  const armed = armDefaultReminder(fresh, settings);
  if (!armed.ok) warnings.push(armed.warning);

  db.logEventActivity({ eventId: fresh.id, actorId, action: "posted", detail: `message ${posted.id}` });

  // Cross-post fan-out + Google auto-sync (both degrade to warnings).
  try {
    const x = require("./crosspost");
    const res = await x.fanoutOnPost(client, fresh);
    warnings.push(...res.warnings);
  } catch (err) {
    warnings.push(`cross-post fan-out failed: ${err?.message || err}`);
  }
  try {
    const gcal = require("./gcal");
    const res = await gcal.autoSyncOnPost(client, fresh);
    warnings.push(...(res?.warnings || []));
  } catch (err) {
    warnings.push(`calendar auto-sync failed: ${err?.message || err}`);
  }

  // Sync the audience role in case a draft already collected signups (web).
  if (roleReady) {
    const sync = await roles.syncAudienceRole(guild, fresh, blockedPredicate(fresh));
    warnings.push(...sync.errors);
  }

  return { ok: true, event: fresh, warnings };
}

// ── signup engine ───────────────────────────────────────────────────────────

function blockedPredicate(event) {
  const communityId = event.community_id;
  return (userId) =>
    db.isEventReminderOptedOut(communityId, String(userId)) ||
    db.isEventMuted(communityId, event.id, String(userId));
}

/**
 * A member (or organizer acting for them) tapped an option.
 * Full phase-2 gate order: posted → cutoff → whitelist → (E5 bypass) →
 * atomic apply (capacity/waitlist/promotion) → role sync → message refresh →
 * notices. Every branch returns {ok, result, ...} or {ok:false, error}.
 */
async function toggleSignup(client, { guild, member, event, optionId, actorId = null }) {
  if (event.status !== "posted") return { ok: false, error: "This event is not posted yet." };
  const option = db.getEventOptionById(optionId);
  if (!option || option.event_id !== event.id)
    return { ok: false, error: "That option is no longer part of this event." };

  const communityId = event.community_id;
  const roleIds = memberRoleIds(member);
  const bypass = bypassesRestrictions(member, event, communityId);

  if (!bypass) {
    const closed = signupClosedReason(event);
    if (closed) return { ok: false, error: closed };
    const denied = whitelistReason(event, option, roleIds);
    if (denied) return { ok: false, error: denied };
  }

  const res = db.applyEventSignupChoice({
    eventId: event.id,
    optionId,
    userId: member.id,
    actorId,
    allowMultiple: Boolean(event.multiple_signups),
  });
  if (!res.ok) return res;

  // Attendee role follows the attending bit (E6), minus opt-out/mute.
  const attendsNow =
    res.result === "signed_up" &&
    option.reminders_on === 1 &&
    !db.isEventReminderOptedOut(communityId, String(member.id)) &&
    !db.isEventMuted(communityId, event.id, String(member.id));
  const roleSync = await roles.syncMemberRole(
    guild,
    event,
    member.id,
    attendsNow,
    option.reminders_on ? "Event attendee (signed up)" : "Event attendee removed",
  );

  db.logEventActivity({
    eventId: event.id,
    actorId: actorId || member.id,
    action:
      res.result === "removed"
        ? "withdrawn"
        : res.result === "waitlisted"
          ? "waitlisted"
          : "signup",
    detail: `${option.label}${res.position ? ` (waitlist #${res.position})` : ""}`,
  });

  const refresh = await refreshEventMessages(client, db.getEventById(event.id));

  // Promoted waiters get told — in the event's delivery channel (visible,
  // not DM-dependent).
  const notices = [];
  for (const p of res.promoted || []) {
    db.logEventActivity({ eventId: event.id, actorId: null, action: "promoted", detail: `${p.userId} → option ${p.optionId}` });
    const notice = await sendWaitlistPromotionNotice(client, db.getEventById(event.id), p);
    notices.push(notice);
  }

  const warnings = [...(roleSync.ok ? [] : [roleSync.error]), ...refresh.warnings];
  const positionText = res.result === "waitlisted" ? ` You are **waitlist #${res.position}**.` : "";
  const reply =
    res.result === "removed"
      ? `You're off **${option.label}** for **${event.title}**.`
      : res.result === "waitlisted"
        ? `You're on the waitlist for **${option.label}** (${event.title}).${positionText}`
        : `You're signed up for **${option.label}** (${event.title}).`;

  // Destination copies need the actor's held options — refresh handles the
  // canonical message; destination-specific button state is generic enough.
  return { ok: true, result: res.result, position: res.position, promoted: res.promoted, reply, warnings };
}

/** Deliver "you're off the waitlist" in the event's reminder target. */
async function sendWaitlistPromotionNotice(client, event, promoted) {
  const target = await resolveDeliveryTarget(client, event);
  const option = db.getEventOptionById(promoted.optionId);
  const body = `✋ **${event.title}** — a spot opened up: <@${promoted.userId}> you're **signed up for ${option?.label ?? "an option"}** (no action needed).`;
  if (!target.ok) {
    console.warn(
      `[events] waitlist notice undeliverable guild=${event.community_id} event=${event.id}: ${target.error}`,
    );
    return { delivered: false };
  }
  try {
    await target.channel.send({
      content: body,
      allowedMentions: { users: [String(promoted.userId)], parse: [], repliedUser: false },
    });
    return { delivered: true };
  } catch (err) {
    console.warn(
      `[events] waitlist notice send failed guild=${event.community_id} event=${event.id}:`,
      err?.message || err,
    );
    return { delivered: false };
  }
}

// ── organizer responses (add|remove|move) ───────────────────────────────────

async function organizerAdd(client, { guild, event, userId, optionId, actorId }) {
  if (event.status !== "posted") return { ok: false, error: "This event is not posted yet." };
  const option = db.getEventOptionById(optionId);
  if (!option || option.event_id !== event.id)
    return { ok: false, error: "That option is not part of this event." };
  const res = db.forceEventSignup({ eventId: event.id, optionId, userId, actorId });
  if (!res.ok) return res;
  const member = await roles.memberOrNull(guild, userId);
  if (option.reminders_on) {
    const blocked = db.isEventReminderOptedOut(event.community_id, String(userId))
      || db.isEventMuted(event.community_id, event.id, String(userId));
    await roles.syncMemberRole(guild, event, userId, !blocked, `Added by organizer ${actorId}`);
  }
  db.logEventActivity({ eventId: event.id, actorId, action: "added_by", detail: `${userId} → ${option.label}` });
  const refresh = await refreshEventMessages(client, db.getEventById(event.id));
  return { ok: true, reply: `Added <@${userId}> to **${option.label}**.`, warnings: refresh.warnings };
}

async function organizerRemove(client, { guild, event, userId, optionId, actorId }) {
  const option = db.getEventOptionById(optionId);
  if (!option || option.event_id !== event.id)
    return { ok: false, error: "That option is not part of this event." };
  const res = db.removeEventSignupRow({ eventId: event.id, optionId, userId, actorId });
  if (!res.ok) return res;
  await roles.syncMemberRole(guild, event, userId, false, `Removed by organizer ${actorId}`);
  db.logEventActivity({ eventId: event.id, actorId, action: "removed_by", detail: `${userId} from ${option.label}` });
  for (const p of res.promoted || []) {
    db.logEventActivity({ eventId: event.id, actorId: null, action: "promoted", detail: `${p.userId} → option ${p.optionId}` });
    await sendWaitlistPromotionNotice(client, event, p);
  }
  const refresh = await refreshEventMessages(client, db.getEventById(event.id));
  const promo = res.promoted?.length
    ? ` Promoted: ${res.promoted.map((p) => `<@${p.userId}>`).join(", ")}.`
    : "";
  return { ok: true, reply: `Removed <@${userId}> from **${option.label}**.${promo}`, warnings: refresh.warnings };
}

async function organizerMove(client, { guild, event, userId, fromOptionId, toOptionId, actorId }) {
  const from = db.getEventOptionById(fromOptionId);
  const to = db.getEventOptionById(toOptionId);
  if (!from || !to || from.event_id !== event.id || to.event_id !== event.id)
    return { ok: false, error: "Both options must belong to this event." };
  const held = db.getEventSignup(event.id, fromOptionId, userId);
  if (!held) return { ok: false, error: `<@${userId}> is not on **${from.label}**.` };
  // Capacity-check the target first (organizer bypass still must not oversell:
  // capacity is a property of the option, not a restriction on the member).
  const counts = db.countEventSignups(event.id);
  const inTarget = counts[to.id]?.signedUp || 0;
  if (to.capacity > 0 && inTarget >= to.capacity && userId !== String(held.user_id)) {
    return { ok: false, error: `**${to.label}** is full (capacity ${to.capacity}).` };
  }
  const removed = await organizerRemove(client, { guild, event, userId, optionId: fromOptionId, actorId });
  if (!removed.ok) return removed;
  const added = await organizerAdd(client, { guild, event, userId, optionId: toOptionId, actorId });
  if (!added.ok) {
    // roll the member back to the original option
    await organizerAdd(client, { guild, event, userId, optionId: fromOptionId, actorId });
    return { ok: false, error: `Move failed after removal: ${added.error}` };
  }
  return { ...added, reply: `Moved <@${userId}>: **${from.label}** → **${to.label}**.` };
}

// ── edit / delete / archive / duplicate / adopt ─────────────────────────────

/**
 * Patch fields on an event. start_at changes move unsent reminders (E14);
 * posted events re-edit the Discord message; role-config changes reconcile.
 */
async function editEvent(client, { member, communityId, event, patch, actorId }) {
  const gate = canManageEvent(member, communityId, event, "edit");
  if (!gate.ok) return gate;
  const before = event;
  const nextPatch = { ...patch };
  if (patch.start_at != null && patch.end_at === undefined && before.duration_minutes) {
    nextPatch.end_at = Number(patch.start_at) + before.duration_minutes * 60_000;
  }
  const res = db.updateEvent(event.id, nextPatch);
  if (!res.ok) return res;
  let fresh = res.event;

  const warnings = [];
  if (patch.start_at != null && Number(patch.start_at) !== Number(before.start_at)) {
    const moved = db.rescheduleUnsentEventReminders(fresh.id, Number(patch.start_at));
    db.logEventActivity({
      eventId: fresh.id,
      actorId,
      action: "time_moved",
      detail: `${before.start_at} → ${patch.start_at} (${moved} reminders moved)`,
    });
  }
  const roleChanged =
    (patch.role_mode && patch.role_mode !== before.role_mode) ||
    (patch.attendee_role_existing && patch.attendee_role_existing !== before.attendee_role_existing);
  if (roleChanged && fresh.status === "posted") {
    const guild = await guildFor(client, communityId);
    if (guild) {
      if (before.role_mode === "temp" && patch.role_mode && patch.role_mode !== "temp") {
        await roles.deleteEventRoleSafe(guild, before);
        fresh = db.updateEvent(fresh.id, { attendee_role_id: null }).event;
      }
      const ensure = await roles.ensureEventAttendeeRole(guild, fresh, "Event role changed");
      if (ensure.ok && ensure.role && fresh.role_mode === "temp") {
        fresh = db.updateEvent(fresh.id, { attendee_role_id: ensure.role.id }).event;
      } else if (!ensure.ok) warnings.push(`Attendee role: ${ensure.error}`);
      const sync = await roles.syncAudienceRole(guild, fresh, blockedPredicate(fresh));
      warnings.push(...sync.errors);
    }
  }
  db.logEventActivity({ eventId: fresh.id, actorId, action: "edited", detail: Object.keys(patch).join(",") });
  if (fresh.status === "posted") {
    const refresh = await refreshEventMessages(client, fresh);
    warnings.push(...refresh.warnings);
  }
  return { ok: true, event: fresh, warnings };
}

async function deleteEvent(client, event, { actorId = null, removeDiscord = true } = {}) {
  const warnings = [];
  if (removeDiscord && event.status === "posted") {
    const guild = await guildFor(client, event.community_id);
    if (guild) {
      if (event.message_id) {
        try {
          const channel = guild.channels.cache.get(event.channel_id)
            ?? (await guild.channels.fetch(event.channel_id).catch(() => null));
          if (channel) {
            const msg = await channel.messages.fetch(event.message_id).catch(() => null);
            if (msg) await msg.delete(`Event deleted: ${event.title}`);
          }
        } catch (err) {
          if (!isGoneError(err)) warnings.push(`Could not delete the event message: ${err?.message || err}`);
        }
      }
      await roles.deleteEventRoleSafe(guild, event);
    }
  }
  try {
    const x = require("./crosspost");
    await x.deleteEventMessages(client, event);
  } catch (err) {
    warnings.push(`cross-post copy cleanup failed: ${err?.message || err}`);
  }
  db.deleteEventCascade(event.id);
  return { ok: true, warnings };
}

/** E8 auto-archive: Discord artifacts go, the row stays for the dashboard. */
/**
 * E8 auto/manual archive: the DISCORD artifacts go (event message, attendee
 * role, cross-post copies, thread) and unsent reminders retire — but the
 * ROW and its options/signups/activity stay for the dashboard archive
 * (web-admin calendar §12.4). This must never run deleteEventCascade: an
 * earlier revision did exactly that and silently destroyed the history
 * archive said it keeps.
 */
async function archiveEvent(client, event, { reason = "auto-archive" } = {}) {
  const warnings = [];
  const guild = await guildFor(client, event.community_id);
  if (guild) {
    if (event.message_id && event.channel_id) {
      try {
        const channel = guild.channels.cache.get(event.channel_id)
          ?? (await guild.channels.fetch(event.channel_id).catch(() => null));
        if (channel) {
          const msg = await channel.messages.fetch(event.message_id).catch(() => null);
          if (msg) await msg.delete(`Event archived: ${event.title}`);
        }
      } catch (err) {
        if (!isGoneError(err))
          warnings.push(`Could not delete the event message: ${err?.message || err}`);
      }
    }
    const cleaned = await roles.deleteEventRoleSafe(guild, event);
    if (cleaned && cleaned.ok === false)
      warnings.push(`Attendee role left in place: ${cleaned.error}`);
  }
  if (event.thread_id && client) {
    try {
      const thread = client.channels?.cache?.get(event.thread_id)
        ?? (await client.channels?.fetch?.(event.thread_id).catch(() => null));
      if (thread?.archive) await thread.archive();
    } catch (err) {
      console.warn(`[events] thread archive failed event=${event.id}:`, err?.message || err);
      warnings.push(`Could not close the event thread: ${err?.message || err}`);
    }
  }
  try {
    const x = require("./crosspost");
    await x.deleteEventMessages(client, event);
  } catch (err) {
    warnings.push(`cross-post copy cleanup failed: ${err?.message || err}`);
  }
  db.retireAllUnsentEventReminders(event.id, reason);
  const upd = db.updateEvent(event.id, { status: "archived", message_id: null, thread_id: null });
  db.logEventActivity({
    eventId: event.id,
    actorId: null,
    action: "archived",
    detail: reason,
  });
  return { ok: upd.ok !== false, warnings };
}

async function duplicateEvent(client, event, actorId) {
  const options = db.listEventOptions(event.id).map((o) => ({
    label: o.label,
    emoji: o.emoji,
    position: o.position,
    capacity: o.capacity,
    waitlist_on: o.waitlist_on,
    reminders_on: o.reminders_on,
    role_whitelist: o.role_whitelist,
  }));
  const copy = db.createEvent({
    communityId: event.community_id,
    creatorId: actorId,
    title: `Copy of ${event.title}`.slice(0, 150),
    status: "draft",
    startAt: event.start_at,
    channelId: event.channel_id,
    description: event.description,
    location: event.location,
    endAt: event.end_at,
    durationMinutes: event.duration_minutes,
    imageUrl: event.image_url,
    color: event.color,
    announceRoleIds: JSON.parse(event.announce_role_ids || "[]"),
    roleMode: "temp",
    cutoffAt: event.cutoff_at,
    roleWhitelist: JSON.parse(event.role_whitelist || "[]"),
    multipleSignups: event.multiple_signups,
    threadEnabled: event.thread_enabled,
    threadPrivate: event.thread_private,
    options,
  });
  if (!copy.ok) return copy;
  db.logEventActivity({ eventId: copy.event.id, actorId, action: "created", detail: `duplicated from ${event.id}` });
  return { ok: true, event: copy.event, options: copy.options };
}

/** /event adopt — copy a Discord scheduled event into a draft (no Interested). */
async function adoptScheduledEvent(guild, communityId, scheduledEvent, creatorId) {
  const startMs = Date.parse(
    scheduledEvent.scheduledStartTime
      ? scheduledEvent.scheduledStartTime.toISOString?.() ?? scheduledEvent.scheduledStartTime
      : scheduledEvent.scheduledStartTimestamp,
  );
  if (!Number.isFinite(startMs)) return { ok: false, error: "That scheduled event has no usable start time." };
  const created = db.createEvent({
    communityId,
    creatorId,
    title: String(scheduledEvent.title ?? scheduledEvent.name ?? "Adopted event").slice(0, 150),
    status: "draft",
    startAt: startMs,
    channelId: scheduledEvent.channelId ?? null,
    description: scheduledEvent.description ?? null,
    location:
      typeof scheduledEvent.location === "string"
        ? scheduledEvent.location
        : scheduledEvent.channelId
          ? `<#${scheduledEvent.channelId}>`
          : null,
    options: ui.DEFAULT_OPTIONS.map((o) => ({ ...o })),
  });
  if (!created.ok) return created;
  db.logEventActivity({
    eventId: created.event.id,
    actorId: creatorId,
    action: "created",
    detail: `adopted from scheduled event ${scheduledEvent.id}`,
  });
  return created;
}

// ── reminder delivery (ticker step) ─────────────────────────────────────────

/**
 * Where a reminder posts: event thread (when thread_reminders and the thread
 * exists), else the event channel, else the guild fallback channel.
 */
async function resolveDeliveryTarget(client, event) {
  const settings = db.getEventGuildSettings(event.community_id);
  const guild = await guildFor(client, event.community_id);
  if (!guild) return { ok: false, transient: true, error: "guild not in cache" };
  const fetchChannel = async (id) => {
    if (!id) return null;
    return (
      client.channels?.cache?.get(String(id)) ??
      (await client.channels?.fetch?.(String(id)).catch((e) => (isGoneError(e) ? "gone" : null)))
    );
  };
  if (settings.thread_reminders && event.thread_id) {
    const thread = await fetchChannel(event.thread_id);
    if (thread === "gone") {
      db.setEventThread(event.id, null);
    } else if (thread && typeof thread.send === "function") {
      return { ok: true, channel: thread, kind: "thread" };
    }
  }
  let channel = await fetchChannel(event.channel_id);
  if (channel && typeof channel.send === "function") return { ok: true, channel, kind: "channel" };
  if (settings.reminder_channel_id) {
    const fallback = await fetchChannel(settings.reminder_channel_id);
    if (fallback && typeof fallback.send === "function")
      return { ok: true, channel: fallback, kind: "guild-default" };
  }
  if (event.channel_id) return { ok: false, gone: true, error: `event channel <#${event.channel_id}> is gone` };
  return { ok: false, transient: true, error: "no delivery channel configured" };
}

function buildReminderPayload(event, row, roleId, startMs) {
  const ctx = {
    eventName: event.title,
    startMs,
    roleId,
    location: event.location || "",
    url: messageLink(event) || "",
    description: "",
    offset: `${row.offset_minutes} min`,
  };
  const body = renderReminderMessage(row.message, ctx, { defaultBody: REMINDER_DEFAULT_BODY });
  const embed = baseEmbed({
    description: truncateDescription(body, 1800),
    color: Color.caution,
    timestamp: new Date(),
  });
  embed.addFields({
    name: "📅 " + event.title,
    value: truncateField(`Starts ${tsFull(startMs)} (${tsRelative(startMs)})`),
  });
  return {
    content: roleId ? `<@&${roleId}>` : null,
    embeds: [embed],
    allowedMentions: roleId ? { roles: [String(roleId)], parse: [], repliedUser: false } : { parse: [], repliedUser: false },
  };
}

/**
 * Deliver one claimed reminder row. Resolves to exactly one of:
 *   {status:'sent', messageId} | {status:'retired', reason} | {status:'retry', reason, ...}
 * The ticker turns those into the row-state CAS writes — never a silent skip.
 */
async function deliverReminder(client, row) {
  const event = db.getEventById(row.event_id);
  if (!event || event.status === 'archived' || event.status === 'skipped')
    return { status: "retired", reason: `event ${row.event_id} gone/${event?.status ?? "deleted"}` };
  if (event.status === "draft" || event.status === "pending_confirm") {
    // unposted (scheduled-post retries keep arming after post) — wait, not retire.
    return { status: "retry", reason: "event not posted yet" };
  }

  // Audience / target.
  let roleId = null;
  if (row.target === "role") {
    roleId = row.role_id;
    if (!roleId) return { status: "retired", reason: "role reminder without a role" };
    const guild = await guildFor(client, event.community_id);
    const role = guild ? await roles.findRole(guild, roleId) : null;
    if (!role) return { status: "retired", reason: `role ${roleId} deleted` };
  } else {
    roleId = event.attendee_role_existing || event.attendee_role_id || null;
    if (event.role_mode === "temp" && !roleId) {
      // try once more to create the role — then deliver without a ping
      const guild = await guildFor(client, event.community_id);
      if (!guild) return { status: "retry", reason: "guild not in cache" };
      const ensure = await roles.ensureEventAttendeeRole(guild, event, "Event reminder (role restore)");
      if (ensure.ok && ensure.role) {
        db.updateEvent(event.id, { attendee_role_id: ensure.role.id });
        roleId = ensure.role.id;
        const sync = await roles.syncAudienceRole(guild, event, blockedPredicate(event));
        console.log(
          `[events] attendee role restored guild=${event.community_id} event=${event.id} granted=${sync.granted} removed=${sync.removed}`,
        );
      } else {
        console.warn(
          `[events] delivering reminder WITHOUT attendee ping guild=${event.community_id} event=${event.id}: ${ensure.error}`,
        );
        roleId = null;
      }
    }
  }

  const target = await resolveDeliveryTarget(client, event);
  if (!target.ok) {
    if (target.gone) return { status: "retired", reason: target.error };
    return { status: "retry", reason: target.error };
  }

  let msg;
  try {
    msg = await target.channel.send(buildReminderPayload(event, row, roleId, event.start_at));
  } catch (err) {
    if (isGoneError(err)) {
      if (target.kind === "thread") {
        db.setEventThread(event.id, null);
        return { status: "retry", reason: `thread gone (${err.code ?? err.message})` };
      }
      return { status: "retired", reason: `channel gone (${err.code ?? err.message})` };
    }
    return { status: "retry", reason: `send failed: ${err?.message || err}` };
  }
  return { status: "sent", messageId: msg?.id || null };
}

// ── digest (phase 5) ────────────────────────────────────────────────────────

/** UTC due-boundary for a digest row this instant, or null. */
function digestDueBoundary(settings, nowMs) {
  const now = new Date(nowMs);
  const hour = settings.digest_hour_utc ?? 0;
  if (settings.digest_frequency === "daily") {
    const boundary = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour);
    if (nowMs < boundary) return null;
    if (settings.digest_last_sent_at != null && settings.digest_last_sent_at >= boundary) return null;
    return boundary;
  }
  if (settings.digest_frequency === "weekly") {
    const wd = settings.digest_weekday ?? 1;
    const delta = (now.getUTCDay() - wd + 7) % 7;
    const boundary = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - delta, hour);
    if (nowMs < boundary) return null;
    if (settings.digest_last_sent_at != null && settings.digest_last_sent_at >= boundary) return null;
    return boundary;
  }
  return null;
}

async function sendDigest(client, settings, windowMs = 7 * 86_400_000) {
  const communityId = settings.community_id;
  const nowMs = Date.now();
  const events = db.listEvents(communityId, {
    statuses: ["posted"],
    from: nowMs,
    to: nowMs + windowMs,
    limit: 20,
  });
  const lines = events.map((e) => {
    const counts = db.countEventSignups(e.id);
    const options = db.listEventOptions(e.id);
    const parts = options.map((o) => {
      const c = counts[o.id]?.signedUp || 0;
      const cap = o.capacity > 0 ? `/${o.capacity}` : "";
      return `${o.label} ${c}${cap}`;
    });
    return `• **${e.title}** ${tsRelative(e.start_at)} · <#${e.channel_id}>${parts.length ? ` · ${parts.join(", ")}` : ""}`;
  });
  const embed = baseEmbed({
    title: "📆 Upcoming events",
    description:
      lines.join("\n") ||
      "No events in the next week. An organizer can start one with `/event create` or the `/event wizard`.",
    color: Color.brand,
    timestamp: new Date(),
  });
  const channel =
    client.channels?.cache?.get(String(settings.digest_channel_id)) ??
    (await client.channels?.fetch?.(String(settings.digest_channel_id)).catch(() => null));
  if (!channel || typeof channel.send !== "function") {
    return { ok: false, error: `digest channel <#${settings.digest_channel_id}> not found or unsendable` };
  }
  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    return { ok: false, error: `digest send failed: ${err?.message || err}` };
  }
  db.setEventDigestLastSent(communityId, nowMs);
  return { ok: true, count: events.length };
}

// ── shared time helpers (handlers reuse) ────────────────────────────────────

function resolveStartAt(text, settings, nowMs = Date.now()) {
  return parseEventTime(text, {
    timeZone: settings?.time_zone || "UTC",
    nowMs,
  });
}

module.exports = {
  isGoneError,
  guildFor,
  memberRoleIds,
  messageLink,
  isStaffMember,
  isOrganizer,
  canCreateEvent,
  canManageEvent,
  bypassesRestrictions,
  signupClosedReason,
  whitelistReason,
  renderEventPayload,
  refreshEventMessages,
  armDefaultReminder,
  postEventNow,
  toggleSignup,
  organizerAdd,
  organizerRemove,
  organizerMove,
  editEvent,
  deleteEvent,
  archiveEvent,
  duplicateEvent,
  adoptScheduledEvent,
  resolveDeliveryTarget,
  deliverReminder,
  blockedPredicate,
  digestDueBoundary,
  sendDigest,
  resolveStartAt,
  REMINDER_DEFAULT_BODY,
};
