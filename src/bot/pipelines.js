const { Events } = require("discord.js");
const { tryAwardMessageXp, tryAwardReactionXp } = require("../features/xp");
const { cacheMessage } = require("../features/logs");
const {
  handleHoneypotMessage,
  handleHoneypotWarningReaction,
} = require("../features/honeypot");
const { handleGorkMessage } = require("../features/gork");
const {
  handleReactionRoleAdd,
  handleReactionRoleRemove,
  handlePendingOptionEmojiMessage,
} = require("../features/reactionRoles");
const { recordUserChannelMessage } = require("../features/userActivity");
const { getDiscordOutbound } = require("../platform/discord/outbound");
const { normalizeDiscordMessage } = require("../platform/discord/normalize");

/**
 * MessageCreate pipeline (exported for integration tests), spec order from
 * roadmap/fluxer.md § Normalized gateway events:
 * 1. guild gate (normalized: externalGuildId mirrors the Discord guild)
 * 2. bot author gate (normalized: authorBot)
 * 3. message cache (logs)
 * 4. parsePrefix (Fluxer only — null on Discord, so step 7 is dead code there)
 * 5. reaction-role pending emoji capture (only for non-prefix lines)
 * 6. honeypot channel enforcement
 * 7. prefix command: record channel activity, then stop — no gork, no message XP
 * 8. gork AI keyword Q&A (detached; never blocks, never early-returns)
 * 9. user channel activity counters (all human messages)
 * 10. message XP (with the isPrefixCommand backstop)
 *
 * `message` is a NormalizedMessage (output of normalizeDiscordMessage): the
 * normalized fields (authorBot, externalGuildId, communityId, parsePrefix,
 * …) plus every Discord duck field (guild, author, channel, …), which
 * unmigrated features keep reading. `isPrefixCommand` at step 10 is a backstop
 * for future callers (spec line 227) — on Discord parsePrefix is always null.
 *
 * @param {object} outbound OutboundClient (getDiscordOutbound(client))
 * @param {object} message normalized discord.js Message
 * @param {{ gorkClient?: import("discord.js").Client }} [opts]
 *   Transitional: `opts.gorkClient` is the raw Discord client for gork's AI
 *   hook, which still takes a discord.js client (migrates to outbound in PR 5).
 */
async function onMessageCreate(outbound, message, opts = {}) {
  try {
    if (!message.guild && !message.externalGuildId) return;
    if (message.authorBot) return;

    cacheMessage(message);

    const prefixCommand = message.parsePrefix ?? null;

    // A prefix command must not be swallowed by a pending reaction-role emoji
    // session (spec § Normalized gateway events).
    if (!prefixCommand) {
      const pendingRr = await handlePendingOptionEmojiMessage(message);
      if (pendingRr.handled) return;
    }

    if (await handleHoneypotMessage(message)) return;

    if (prefixCommand) {
      // Prefix command (Fluxer only today): every human message counts, but
      // no gork and no message XP.
      recordUserChannelMessage(message);
      return;
    }

    // Gork AI keyword Q&A — never blocks the pipeline (detached job inside);
    // a triggering message still earns XP below.
    if (opts.gorkClient) {
      handleGorkMessage(opts.gorkClient, message).catch((e) =>
        console.error("[MessageCreate] gork error:", e?.message || e)
      );
    }

    // Count real message volume by channel (not XP-cooldown gated)
    recordUserChannelMessage(message);

    await tryAwardMessageXp(outbound, message, {
      isPrefixCommand: Boolean(prefixCommand),
    });
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

    await tryAwardReactionXp(getDiscordOutbound(client), guild, user);
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
  const outbound = getDiscordOutbound(client);
  client.on(Events.MessageCreate, (message) =>
    onMessageCreate(outbound, normalizeDiscordMessage(message), {
      gorkClient: client,
    })
  );
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
