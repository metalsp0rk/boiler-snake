const { Events } = require("discord.js");
const { tryAwardMessageXp, tryAwardReactionXp } = require("../features/xp");
const { cacheMessage } = require("../features/logs");
const {
  handleHoneypotMessage,
  handleHoneypotWarningReaction,
} = require("../features/honeypot");
const {
  handleReactionRoleAdd,
  handleReactionRoleRemove,
  handlePendingOptionEmojiMessage,
} = require("../features/reactionRoles");
const { recordUserChannelMessage } = require("../features/userActivity");

/**
 * MessageCreate pipeline (exported for integration tests):
 * 1. message cache (logs)
 * 2. reaction-role pending emoji capture
 * 3. honeypot channel enforcement
 * 4. user channel activity counters (all human messages)
 * 5. message XP
 *
 * @param {import("discord.js").Client} client
 * @param {import("discord.js").Message} message
 */
async function onMessageCreate(client, message) {
  try {
    if (!message.guild) return;
    if (message.author?.bot) return;

    cacheMessage(message);

    const pendingRr = await handlePendingOptionEmojiMessage(message);
    if (pendingRr.handled) return;

    if (await handleHoneypotMessage(message)) return;

    // Count real message volume by channel (not XP-cooldown gated)
    recordUserChannelMessage(message);

    await tryAwardMessageXp(client, message);
  } catch (e) {
    console.error("[MessageCreate] error:", e?.message || e);
  }
}

/**
 * MessageReactionAdd pipeline (exported for integration tests):
 * 1. resolve partials
 * 2. honeypot warning strip
 * 3. reaction-role panels
 * 4. reaction XP
 *
 * @param {import("discord.js").Client} client
 * @param {import("discord.js").MessageReaction} reaction
 * @param {import("discord.js").User} user
 */
async function onMessageReactionAdd(client, reaction, user) {
  try {
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        return;
      }
    }
    if (reaction.message?.partial) {
      try {
        await reaction.message.fetch();
      } catch {
        /* may still lack content */
      }
    }

    if (await handleHoneypotWarningReaction(reaction)) return;

    if (user?.bot) return;

    const guild =
      reaction.message?.guild ||
      (reaction.message?.guildId
        ? client.guilds.cache.get(reaction.message.guildId)
        : null);
    if (!guild) return;

    const rr = await handleReactionRoleAdd(reaction, user);
    if (rr.handled) return;

    await tryAwardReactionXp(client, guild, user);
  } catch (e) {
    console.error("[ReactionAdd] error:", e?.message || e);
  }
}

/**
 * MessageReactionRemove pipeline (exported for integration tests).
 *
 * @param {import("discord.js").Client} client
 * @param {import("discord.js").MessageReaction} reaction
 * @param {import("discord.js").User} user
 */
async function onMessageReactionRemove(client, reaction, user) {
  try {
    if (user?.bot) return;

    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        return;
      }
    }
    if (reaction.message?.partial) {
      try {
        await reaction.message.fetch();
      } catch {
        /* ignore */
      }
    }

    const guild =
      reaction.message?.guild ||
      (reaction.message?.guildId
        ? client.guilds.cache.get(reaction.message.guildId)
        : null);
    if (!guild) return;

    await handleReactionRoleRemove(reaction, user);
  } catch (e) {
    console.error("[ReactionRemove] error:", e?.message || e);
  }
}

/**
 * Ordered gateway pipelines that span multiple features.
 * (Independent events — delete/ban/kick, etc. — register via feature.registerEvents.)
 *
 * @param {import("discord.js").Client} client
 */
function registerOrderedPipelines(client) {
  client.on(Events.MessageCreate, (message) => onMessageCreate(client, message));
  client.on(Events.MessageReactionAdd, (reaction, user) =>
    onMessageReactionAdd(client, reaction, user)
  );
  client.on(Events.MessageReactionRemove, (reaction, user) =>
    onMessageReactionRemove(client, reaction, user)
  );
}

module.exports = {
  registerOrderedPipelines,
  onMessageCreate,
  onMessageReactionAdd,
  onMessageReactionRemove,
};
