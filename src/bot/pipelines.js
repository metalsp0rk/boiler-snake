const { Events } = require("discord.js");
const {
  tryAwardMessageXp,
  tryAwardReactionXp,
  tryAwardReactionXpFluxer,
} = require("../features/xp");
const { cacheMessage } = require("../features/logs");
const {
  handleHoneypotMessage,
  handleHoneypotWarningReaction,
  handleHoneypotFluxerMessage,
  handleHoneypotFluxerWarningReaction,
} = require("../features/honeypot");
const { handleGorkMessage } = require("../features/gork");
const {
  handleReactionRoleAdd,
  handleReactionRoleRemove,
  handlePendingOptionEmojiMessage,
  handleReactionRoleAddFluxer,
  handleReactionRoleRemoveFluxer,
} = require("../features/reactionRoles");
const { recordUserChannelMessage } = require("../features/userActivity");
const { getDiscordOutbound } = require("../platform/discord/outbound");
const { normalizeDiscordMessage } = require("../platform/discord/normalize");
// Fluxer (PR 6): the prefix parser and dispatcher are SDK-free (the SDK
// package is never in their import graph), so top-level requires are
// safe for Discord-only boots and tests.
const { parsePrefix } = require("../platform/fluxer/commands");
const { dispatchPrefixCommand } = require("../platform/fluxer/dispatch");
const { ensureCommunity } = require("../platform/community");

/**
 * MessageCreate pipeline (exported for integration tests), spec order from
 * roadmap/fluxer.md § Normalized gateway events:
 * 1. guild gate (normalized: externalGuildId mirrors the Discord guild)
 * 2. bot author gate (normalized: authorBot)
 * 2b. Fluxer community resolution (Fluxer only: externalGuildId → communities.id)
 * 3. message cache (logs)
 * 4. parsePrefix (Fluxer only — null on Discord, so step 7 is dead code there;
 *    fluxer normalized messages carry parsePrefix null, so it runs here)
 * 5. reaction-role pending emoji capture (only for non-prefix lines)
 * 6. honeypot channel enforcement (Discord duck fields; Fluxer: normalized path)
 * 7. prefix command: record channel activity, dispatch, then stop —
 *    no gork, no message XP (dispatch swallows handler throws itself)
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
 * @param {{ gorkClient?: import("discord.js").Client, registry?: import("../commands/registry").CommandRegistry, supervisor?: object }} [opts]
 *   Transitional: `opts.gorkClient` is the raw Discord client for gork's AI
 *   hook, which still takes a discord.js client (migrates to outbound in PR 5).
 *   `opts.registry` (+ `opts.supervisor`) enable the Fluxer prefix-command
 *   dispatch (PR 6); omitted on Discord-only wiring, where no message ever
 *   produces a prefix command. `opts.supervisor` also feeds gork for
 *   `platform === "fluxer"` messages (PR 8): `handleGorkMessage` detects the
 *   platform and runs the Fluxer path, which resolves the community's
 *   OutboundClient through `supervisor.clientForCommunity`.
 */
async function onMessageCreate(outbound, message, opts = {}) {
  try {
    if (!message.guild && !message.externalGuildId) return;
    if (message.authorBot) return;

    // Fluxer (PR 6): resolve the communities row at this edge — repositories
    // take the integer id. Discord rows are untouched (platform "discord").
    if (message.platform === "fluxer" && message.externalGuildId) {
      try {
        message.communityId = ensureCommunity({
          platform: "fluxer",
          instanceKey: message.instanceKey,
          externalGuildId: message.externalGuildId,
        });
      } catch (e) {
        console.error("[fluxer] community resolve failed:", e?.message || e);
      }
    }

    cacheMessage(message);

    const prefixCommand =
      message.parsePrefix ??
      (message.platform === "fluxer" ? parsePrefix(message.content) : null);

    // A prefix command must not be swallowed by a pending reaction-role emoji
    // session (spec § Normalized gateway events).
    if (!prefixCommand) {
      const pendingRr = await handlePendingOptionEmojiMessage(message);
      if (pendingRr.handled) return;
    }

    const honeypotHit =
      message.platform === "fluxer"
        ? await handleHoneypotFluxerMessage(outbound, message)
        : await handleHoneypotMessage(message);
    if (honeypotHit) return;

    if (prefixCommand) {
      // Prefix command (Fluxer only today): every human message counts, but
      // no gork and no message XP.
      recordUserChannelMessage(message);
      if (opts.registry) {
        // The dispatcher swallows handler throws itself (AGENTS.md rule 1);
        // a usage error is still a command: usage reply only, no XP.
        await dispatchPrefixCommand(outbound, message, prefixCommand, {
          registry: opts.registry,
          supervisor: opts.supervisor,
        });
      }
      return;
    }

    // Gork AI keyword Q&A — never blocks the pipeline (detached job inside);
    // a triggering message still earns XP below.
    if (opts.gorkClient) {
      handleGorkMessage(opts.gorkClient, message).catch((e) =>
        console.error("[MessageCreate] gork error:", e?.message || e)
      );
    } else if (message.platform === "fluxer" && opts.supervisor) {
      // Fluxer (PR 8): Fluxer boots have no raw discord.js client, so the
      // gork hook receives the supervisor and `message.platform` selects the
      // Fluxer path inside handleGorkMessage (roadmap/fluxer.md PR 8). The
      // Discord arm above is untouched.
      handleGorkMessage(opts.supervisor, message).catch((e) =>
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
 * Fluxer MessageReactionAdd pipeline (PR 6 detection, PR 9 panel handling).
 * Fluxer sends ONE object per reaction (Phase 0 record); client.js normalizes
 * it via normalizeFluxerReaction and hands the NormalizedReaction straight
 * here — no partials, no discord.js reaction objects.
 *
 * Order mirrors the Discord pipeline exactly (spec § Normalized gateway events):
 * honeypot-warning strip (runs for bots too) → bot gate → community resolve →
 * reaction-role panels (handled ⇒ no XP) → reaction XP. Reaction-role panels
 * are the PR 9 fluxer service entry (spec § Outbound client: panels are Fluxer
 * v1 — reactions are not elevated, the role leg self-gates on K8).
 *
 * @param {object} outbound OutboundClient (Fluxer)
 * @param {object} normalizedReaction normalizeFluxerReaction output
 */
async function onFluxerReactionAdd(outbound, normalizedReaction) {
  try {
    if (!normalizedReaction) return;

    // Honeypot warning notices stay reaction-free — Discord runs the strip
    // before the bot gate, so we mirror that ordering.
    if (await handleHoneypotFluxerWarningReaction(outbound, normalizedReaction)) {
      return;
    }

    if (normalizedReaction.userBot) return;

    let communityId = normalizedReaction.communityId;
    if (!Number.isSafeInteger(communityId)) {
      if (!normalizedReaction.externalGuildId) {
        console.error(
          `[fluxer] reaction add has no guild (message ${normalizedReaction.messageId}) — no XP`,
        );
        return;
      }
      communityId = ensureCommunity({
        platform: "fluxer",
        instanceKey: normalizedReaction.instanceKey ?? "fluxer",
        externalGuildId: String(normalizedReaction.externalGuildId),
      });
      normalizedReaction.communityId = communityId;
    }

    // Reaction-role panels first: handled ⇒ the reaction is panel traffic,
    // never reaction XP (Discord parity).
    const rr = await handleReactionRoleAddFluxer(outbound, normalizedReaction);
    if (rr?.handled) return;

    await tryAwardReactionXpFluxer(outbound, normalizedReaction);
  } catch (e) {
    console.error("[fluxer] ReactionAdd error:", e?.message || e);
  }
}

/**
 * Fluxer MessageReactionRemove pipeline (PR 9): un-react strips the role for
 * removable options through the fluxer service entry (removeRole self-gates on
 * K8 flag 0; the reaction cleanup itself is never elevated). Replaces the PR 6
 * log stub — the wire surface shipped in PR 6 is now wired.
 *
 * @param {object} outbound OutboundClient (Fluxer)
 * @param {object} normalizedReaction normalizeFluxerReaction output
 */
async function onFluxerReactionRemove(outbound, normalizedReaction) {
  try {
    if (!normalizedReaction) return;
    if (normalizedReaction.userBot) return;

    let communityId = normalizedReaction.communityId;
    if (!Number.isSafeInteger(communityId)) {
      if (!normalizedReaction.externalGuildId) {
        console.error(
          `[fluxer] reaction remove has no guild (message ${normalizedReaction.messageId}) — no panel handling`,
        );
        return;
      }
      communityId = ensureCommunity({
        platform: "fluxer",
        instanceKey: normalizedReaction.instanceKey ?? "fluxer",
        externalGuildId: String(normalizedReaction.externalGuildId),
      });
      normalizedReaction.communityId = communityId;
    }

    await handleReactionRoleRemoveFluxer(outbound, normalizedReaction);
  } catch (e) {
    console.error("[fluxer] ReactionRemove error:", e?.message || e);
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
  onFluxerReactionAdd,
  onFluxerReactionRemove,
};
