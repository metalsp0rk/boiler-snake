/**
 * `/event` pickers (epic #218).
 *
 * integer options `event`, `option`, `reminder` autocomplete against this
 * guild's data. Discord caps at 25 results.
 */
const repo = require("../../db/repositories/events");
const { ensureCommunity } = require("../../platform/community");

function short(title, max = 60) {
  const t = String(title || "");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

async function autocompleteEvent(interaction) {
  const focused = interaction.options.getFocused(true);
  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: interaction.guildId,
  });
  if (!communityId) return interaction.respond([]);

  if (focused.name === "event") {
    const rows = repo.listUpcomingEvents(communityId, { limit: 50 });
    const mine = rows.filter((e) => e.creator_id === interaction.user.id);
    const pool = (mine.length ? [...mine, ...rows.filter((e) => e.creator_id !== interaction.user.id)] : rows)
      .slice(0, 25);
    return interaction.respond(
      pool.map((e) => ({
        name: short(`${e.id} · ${e.title}${e.status === "draft" ? " (draft)" : ""}`),
        value: e.id,
      }))
    );
  }

  if (focused.name === "option") {
    const eventId = interaction.options.getInteger("event");
    const event = eventId ? repo.getEventForCommunity(eventId, communityId) : null;
    if (!event) return interaction.respond([]);
    return interaction.respond(
      repo
        .listEventOptions(event.id)
        .slice(0, 25)
        .map((o) => ({ name: short(`${o.position}. ${o.label}`), value: o.id }))
    );
  }

  if (focused.name === "reminder") {
    const eventId = interaction.options.getInteger("event");
    const event = eventId ? repo.getEventForCommunity(eventId, communityId) : null;
    if (!event) return interaction.respond([]);
    return interaction.respond(
      repo
        .listEventReminders(event.id, { unsentOnly: true })
        .slice(0, 25)
        .map((r) => ({ name: short(`${r.id} · ${r.offset_minutes} min before`), value: r.id }))
    );
  }

  return interaction.respond([]);
}

module.exports = { autocompleteEvent };
