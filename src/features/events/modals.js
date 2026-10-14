/**
 * `/event` modals (epic #218) — customIds under `evm:`.
 *
 *   evm:edit:<eventId>  quick edit: title, start time, description, location
 *                       (blank = keep, "-" = clear). Time is re-parsed in the
 *                       guild zone and reminders re-arm via service.editEvent.
 */
const { MessageFlags } = require("discord.js");
const repo = require("../../db/repositories/events");
const { ensureCommunity } = require("../../platform/community");
const service = require("./service");

function clientFor(ctx) {
  return ctx && ctx.supervisor && ctx.supervisor.discord
    ? ctx.supervisor.discord
    : ctx && ctx.guilds
      ? ctx
      : null;
}

async function handleEditModal(interaction, ctx) {
  const client = clientFor(ctx);
  const eventId = Number(/evm:edit:(\d+)/.exec(interaction.customId)?.[1]);
  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: interaction.guildId,
  });
  const event = Number.isInteger(eventId) ? repo.getEventForCommunity(eventId, communityId) : null;
  if (!event) {
    return interaction.reply({ content: "That event no longer exists here.", flags: MessageFlags.Ephemeral });
  }
  const gate = service.canManageEvent(interaction.member, communityId, event, "edit");
  if (!gate.ok) {
    return interaction.reply({ content: gate.error, flags: MessageFlags.Ephemeral });
  }

  const title = String(interaction.fields.getTextInputValue("title") || "").trim();
  const startText = String(interaction.fields.getTextInputValue("start") || "").trim();
  const description = String(interaction.fields.getTextInputValue("description") || "");
  const location = String(interaction.fields.getTextInputValue("location") || "");

  const patch = {};
  if (title && title !== event.title) patch.title = title.slice(0, 150);
  if (startText) {
    const settings = repo.getEventGuildSettings(communityId);
    const startRes = service.resolveStartAt(startText, settings);
    if (!startRes.ok) {
      return interaction.reply({
        content: `I couldn't read the start time: \`${startRes.error}\` — nothing was changed.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    patch.start_at = startRes.atMs;
  }
  if (description.trim()) patch.description = description.slice(0, 1000);
  else if (description === "-" || interaction.fields.getTextInputValue("description") === "-") {
    patch.description = "";
  }
  if (location.trim()) patch.location = location.slice(0, 200);
  else if (location === "-") patch.location = "";

  if (!Object.keys(patch).length) {
    return interaction.reply({ content: "Nothing changed.", flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const res = await service.editEvent(client, {
    member: interaction.member,
    communityId,
    event,
    patch,
    actorId: interaction.user.id,
  });
  if (!res.ok) return interaction.editReply(`Edit failed: \`${res.error}\``);
  return interaction.editReply(
    `Updated **${patch.title || event.title}** ✅${res.warnings?.length ? ` — ${res.warnings.join("; ")}` : ""}`
  );
}

async function handleEventModal(interaction, ctx) {
  if (interaction.customId.startsWith("evm:edit:")) return handleEditModal(interaction, ctx);
  return interaction.reply({ content: "Unknown event form.", flags: MessageFlags.Ephemeral });
}

module.exports = { handleEventModal };
