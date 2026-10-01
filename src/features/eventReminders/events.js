/**
 * Guild scheduled-event gateway hooks for reminder roles and reschedule.
 */
const { Events } = require("discord.js");
const { getConfigByScheduledEventId } = require("../../db");
const { discordCommunityId } = require("../../platform/community");
const {
  grantRoleIfEligible,
  removeRoleSafe,
  cleanupEventReminder,
  isEventTerminal,
  eventStartMs,
  rescheduleUnsentOffsets,
} = require("./service");

/**
 * Bind the scheduled-event gateway hooks. PR 7: the first argument is the
 * supervisor — the binds attach to supervisor.discord only (Fluxer gateway
 * events land in the elevated-permissions PR; spec § Scheduler jobs).
 * @param {object|null} supervisor
 * @param {object} [featureCtx]
 */
function registerEvents(supervisor, featureCtx) {
  void featureCtx;
  const client =
    supervisor && typeof supervisor.clientForCommunity === "function"
      ? supervisor.discord ?? null
      : supervisor && supervisor.on
        ? supervisor // legacy raw discord.js client
        : null;
  if (!client) return; // Discord unconfigured → no-op binds

  client.on(Events.GuildScheduledEventUserAdd, async (scheduledEvent, user) => {
    try {
      const guild =
        scheduledEvent.guild || client.guilds.cache.get(scheduledEvent.guildId);
      if (!guild || !user?.id) return;
      const communityId = discordCommunityId(guild.id);
      if (communityId == null) return;
      const config = getConfigByScheduledEventId(communityId, scheduledEvent.id);
      if (!config) return;
      await grantRoleIfEligible(
        guild,
        user.id,
        config.role_id,
        scheduledEvent.id,
      );
    } catch (err) {
      console.error(
        "[eventReminders] GuildScheduledEventUserAdd:",
        err?.message || err,
      );
    }
  });

  client.on(
    Events.GuildScheduledEventUserRemove,
    async (scheduledEvent, user) => {
      try {
        const guild =
          scheduledEvent.guild ||
          client.guilds.cache.get(scheduledEvent.guildId);
        if (!guild || !user?.id) return;
        const communityId = discordCommunityId(guild.id);
        if (communityId == null) return;
        const config = getConfigByScheduledEventId(communityId, scheduledEvent.id);
        if (!config) return;
        await removeRoleSafe(guild, user.id, config.role_id);
      } catch (err) {
        console.error(
          "[eventReminders] GuildScheduledEventUserRemove:",
          err?.message || err,
        );
      }
    },
  );

  client.on(Events.GuildScheduledEventUpdate, async (oldEvent, newEvent) => {
    try {
      const event = newEvent || oldEvent;
      const guild = event?.guild || client.guilds.cache.get(event?.guildId);
      if (!guild || !event) return;

      if (isEventTerminal(event)) {
        await cleanupEventReminder(guild, event.id);
        return;
      }

      const oldStart = eventStartMs(oldEvent);
      const newStart = eventStartMs(event);
      if (oldStart !== newStart && newStart != null) {
        const communityId = discordCommunityId(guild.id);
        if (communityId != null) rescheduleUnsentOffsets(communityId, event.id, newStart);
      }
    } catch (err) {
      console.error(
        "[eventReminders] GuildScheduledEventUpdate:",
        err?.message || err,
      );
    }
  });

  client.on(Events.GuildScheduledEventDelete, async (scheduledEvent) => {
    try {
      const guild =
        scheduledEvent?.guild ||
        client.guilds.cache.get(scheduledEvent?.guildId);
      if (!guild || !scheduledEvent?.id) return;
      await cleanupEventReminder(guild, scheduledEvent.id);
    } catch (err) {
      console.error(
        "[eventReminders] GuildScheduledEventDelete:",
        err?.message || err,
      );
    }
  });
}

module.exports = { registerEvents };
