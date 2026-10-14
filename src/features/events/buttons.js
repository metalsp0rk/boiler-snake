/**
 * `/event` message components (epic #218) — customIds under `ev:`.
 *
 *   ev:rs:<eventId>:<optionId>   signup toggle (also on cross-post copies —
 *                                gated by the pair's whitelist, E12)
 *   ev:ok:<eventId>              confirm-create preview → post
 *   ev:rm:<eventId>              discard preview draft
 *   ev:ed:<eventId>              open the quick-edit modal
 *   ev:dl:<eventId>              ephemeral delete confirmation
 *   ev:dlc:<eventId>:<requester> confirmed delete (requester-bound)
 *   ev:gc:<eventId>              add to MY Google calendar
 *   ev:w:*                       DM wizard buttons (wizard.js)
 *
 * Handlers are ephemeral-first: the RSVP click never pollutes the channel.
 */
const { MessageFlags } = require("discord.js");
const repo = require("../../db/repositories/events");
const { ensureCommunity } = require("../../platform/community");
const { isStaff } = require("../../core/permissions");
const service = require("./service");
const ui = require("./ui");
const wizard = require("./wizard");
const gcal = require("./gcal");
const crosspost = require("./crosspost");

function clientFor(ctx) {
  return ctx && ctx.supervisor && ctx.supervisor.discord
    ? ctx.supervisor.discord
    : ctx && ctx.guilds
      ? ctx
      : null;
}

async function note(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => {});
  } else {
    await interaction.reply(payload).catch(() => {});
  }
}

async function loadEvent(interaction, { communityId = null } = {}) {
  const raw = interaction.customId;
  const eventId = Number(/:(\d+)/.exec(raw)?.[1]);
  const event = Number.isInteger(eventId) ? repo.getEventById(eventId) : null;
  if (!event) {
    await note(interaction, "That event no longer exists.");
    return null;
  }
  if (communityId != null && event.community_id !== communityId) {
    await note(interaction, "That event belongs to a different server.");
    return null;
  }
  return event;
}

// ── signup toggle ───────────────────────────────────────────────────────────

async function handleSignup(interaction, ctx) {
  const client = clientFor(ctx);
  const parts = interaction.customId.split(":"); // ev, rs, eventId, optionId
  const event = Number.isInteger(Number(parts[2])) ? repo.getEventById(Number(parts[2])) : null;
  if (!event) return note(interaction, "That event no longer exists.");
  const localCommunity = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: interaction.guildId,
  });

  // Source event clicked in its own channel: normal engine path.
  if (event.community_id === localCommunity) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const res = await service.toggleSignup(client, {
      guild: interaction.guild,
      member: interaction.member,
      event,
      optionId: Number(parts[3]),
    });
    if (!res.ok) return interaction.editReply(res.error);
    const warn = res.warnings?.length ? `\n_${res.warnings.join("; ")}_` : "";
    return interaction.editReply(res.reply + warn);
  }

  // Cross-post copy (E12): gated write-through to the source event.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const pair = crosspost.pairForCopy(event.community_id, localCommunity);
  const gate = crosspost.canSignupFromDestination(pair, interaction.member);
  if (!gate.ok) return interaction.editReply(gate.error);

  const option = repo.getEventOptionById(Number(parts[3]));
  if (!option || option.event_id !== event.id) {
    return interaction.editReply("That option is no longer part of the original event.");
  }
  if (event.status !== "posted") return interaction.editReply("This event is not open for signups.");
  const closed = service.signupClosedReason(event);
  if (closed) return interaction.editReply(closed);

  const srcGuild = await service.guildFor(client, event.community_id);
  const res = repo.applySignupChoice({
    eventId: event.id,
    optionId: option.id,
    userId: interaction.user.id,
    actorId: null,
    allowMultiple: Boolean(event.multiple_signups),
  });
  if (!res.ok) return interaction.editReply(res.error || "Signup failed.");

  // Attendee role on the SOURCE guild when we can reach the member there.
  if (srcGuild && res.result === "signed_up") {
    await rolesSyncBestEffort(srcGuild, event, interaction.user.id, option);
  }
  repo.logEventActivity({
    eventId: event.id,
    actorId: interaction.user.id,
    action: res.result === "removed" ? "withdrawn" : res.result,
    detail: `${option.label} (cross-post)`,
  });
  await service.refreshEventMessages(client, repo.getEventById(event.id));
  const text =
    res.result === "removed"
      ? `You're off **${option.label}** (original event: **${event.title}**).`
      : res.result === "waitlisted"
        ? `Waitlisted for **${option.label}** (#${res.position}) on the original event.`
        : `You're signed up for **${option.label}** on **${event.title}** (cross-posted here — counts on the original).`;
  return interaction.editReply(text);
}

async function rolesSyncBestEffort(guild, event, userId, option) {
  try {
    const roles = require("./roles");
    const db = require("../../db");
    const attends =
      option.reminders_on === 1 &&
      !db.isEventReminderOptedOut(event.community_id, userId) &&
      !repo.isEventMuted(event.community_id, event.id, userId);
    await roles.syncMemberRole(guild, event, userId, attends, "Event attendee (cross-post signup)");
  } catch (err) {
    console.error(`[events] cross-post role sync user=${userId} event=${event.id}:`, err?.message || err);
  }
}

// ── lifecycle buttons ───────────────────────────────────────────────────────

async function handleConfirmPost(interaction, ctx) {
  const client = clientFor(ctx);
  const event = await loadEvent(interaction);
  if (!event) return;
  // "posted" is allowed through: the service verifies whether the original
  // message still exists and re-posts cleanly if it was deleted.
  if (
    event.status !== "pending_confirm" &&
    event.status !== "draft" &&
    event.status !== "posted"
  ) {
    return note(interaction, `This event is ${event.status} — nothing to post.`);
  }
  if (event.creator_id !== interaction.user.id && !isStaff(interaction)) {
    return note(interaction, "Only the organizer or staff can post this event.");
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const res = await service.postEventNow(client, event, { actorId: interaction.user.id });
  if (!res.ok) return interaction.editReply(`Couldn't post it: \`${res.error}\``);
  if (res.warnings?.includes("already posted")) {
    return interaction.editReply("Already posted ✅");
  }
  return interaction.editReply(
    `Posted ✅${res.warnings?.length ? ` — notes: ${res.warnings.join("; ")}` : ""}`
  );
}

async function handleDiscard(interaction, ctx) {
  const event = await loadEvent(interaction);
  if (!event) return;
  if (event.creator_id !== interaction.user.id && !isStaff(interaction)) {
    return note(interaction, "Only the organizer or staff can discard this draft.");
  }
  if (event.status === "posted") {
    return note(interaction, "It's already posted — use the Delete button (or `/event delete`).");
  }
  const res = await service.deleteEvent(clientFor(ctx), event, { removeDiscord: false });
  if (res && res.ok === false) return note(interaction, `Could not discard: \`${res.error}\``);
  return interaction.update({ content: "Draft discarded 🗑️", embeds: [], components: [] });
}

async function handleEditOpen(interaction, ctx) {
  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: interaction.guildId,
  });
  const event = await loadEvent(interaction, { communityId });
  if (!event) return;
  const gate = service.canManageEvent(interaction.member, communityId, event, "edit");
  if (!gate.ok) return note(interaction, gate.error);
  return interaction.showModal(ui.buildEditModal(event));
}

async function handleDeleteAsk(interaction, ctx) {
  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: interaction.guildId,
  });
  const event = await loadEvent(interaction, { communityId });
  if (!event) return;
  const gate = service.canManageEvent(interaction.member, communityId, event, "delete");
  if (!gate.ok) return note(interaction, gate.error);
  return interaction.reply({
    content: `Really delete **${event.title}** (${event.id}) with all signups?`,
    components: ui.buildDeleteConfirmComponents(event.id, interaction.user.id),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleDeleteConfirm(interaction, ctx) {
  const parts = interaction.customId.split(":"); // ev, dlc, eventId, requesterId
  const event = await loadEvent(interaction);
  if (!event) return;
  if (parts[3] !== interaction.user.id) {
    return note(interaction, "Only the person who pressed Delete can confirm this.");
  }
  if (event.creator_id !== interaction.user.id && !isStaff(interaction)) {
    return note(interaction, "Only the organizer or staff can delete this event.");
  }
  const res = await service.deleteEvent(clientFor(ctx), event, { actorId: interaction.user.id });
  if (!res.ok) return note(interaction, `Delete failed: \`${res.error}\``);
  return interaction.update({
    content: `Deleted **${event.title}** (${event.id}).`,
    embeds: [],
    components: [],
  });
}

async function handleGoogleSync(interaction, ctx) {
  const client = clientFor(ctx);
  const event = await loadEvent(interaction);
  if (!event) return;
  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: interaction.guildId,
  });
  // Google links are scoped to the community where the user connected;
  // a copy clicked in the destination syncs to the DESTINATION-side link.
  const res = await gcal.addToCalendar(client, communityId, interaction.user.id, event);
  if (!res.ok) {
    return note(interaction, `Google Calendar: ${res.error}`);
  }
  return note(
    interaction,
    `Added to your Google Calendar ✅${res.htmlLink ? ` — ${res.htmlLink}` : ""}`
  );
}

// ── dispatcher ──────────────────────────────────────────────────────────────

async function handleEventButton(interaction, ctx) {
  const id = interaction.customId;
  if (id.startsWith(ui.SIGNUP_BTN)) return handleSignup(interaction, ctx);
  if (id.startsWith(ui.CONFIRM_BTN)) return handleConfirmPost(interaction, ctx);
  if (id.startsWith(ui.DISCARD_BTN)) return handleDiscard(interaction, ctx);
  if (id.startsWith(ui.EDIT_BTN)) return handleEditOpen(interaction, ctx);
  if (id.startsWith(ui.DELETE_CONFIRM_BTN)) return handleDeleteConfirm(interaction, ctx);
  if (id.startsWith(ui.DELETE_BTN)) return handleDeleteAsk(interaction, ctx);
  if (id.startsWith(ui.SYNC_BTN)) return handleGoogleSync(interaction, ctx);
  if (id.startsWith("ev:w:")) return wizard.handleButton(interaction, ctx);
  return note(interaction, "Unknown event button.");
}

module.exports = { handleEventButton };
