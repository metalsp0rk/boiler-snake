const { Events } = require("discord.js");
const {
  tryAwardMessageXp,
  tryAwardReactionXp,
  tryAwardReactionXpFluxer,
} = require("../features/xp");
const { cacheMessage } = require("../features/logs");
const {
  handleHoneypotBotMessage,
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
  handlePendingOptionEmojiMessageFluxer,
  handleReactionRoleAddFluxer,
  handleReactionRoleRemoveFluxer,
} = require("../features/reactionRoles");
const { recordUserChannelMessage } = require("../features/userActivity");
const { getDiscordOutbound } = require("../platform/discord/outbound");
const { normalizeDiscordMessage } = require("../platform/discord/normalize");
// NormalizedMessage required-field contract (issue #201, audit §6 P2): one
// shared validator at the boundary BOTH adapters' normalized MESSAGE_CREATE
// output flows through — never per-feature duck-type checks. Issue #279
// extends the same pattern to the adjacent fluxer-normalized shapes: the
// reaction entries get assertNormalizedReaction, the fluxer delete entry
// gets assertNormalizedDelete (delete partials are NEVER full-message
// validated). Same module, same error class, same boundary discipline.
const {
  assertNormalizedMessage,
  assertNormalizedReaction,
  assertNormalizedDelete,
  NormalizedMessageContractError,
} = require("../platform/normalizedMessageContract");
// Fluxer (PR 6): the prefix parser and dispatcher are SDK-free (the SDK
// package is never in their import graph), so top-level requires are
// safe for Discord-only boots and tests.
const { parsePrefix } = require("../platform/fluxer/commands");
const { dispatchPrefixCommand } = require("../platform/fluxer/dispatch");
const { ensureCommunity } = require("../platform/community");
// Bridge (PR 4): loop + echo gates and the outbox enqueue. relay.js imports
// neither discord.js nor the Fluxer SDK, so a top-level require is safe.
const bridgeRelay = require("../features/bridge/relay");

/**
 * MessageCreate pipeline (exported for integration tests), spec order from
 * roadmap/fluxer.md § Normalized gateway events (+ bridge gates, roadmap/bridge.md §10.4):
 * 0a. normalized-message contract assertion (issue #201): both adapters'
 *     output enters through THIS validator — a violation is logged (naming
 *     field + platform) and the message is skipped, never a crash
 * 0b. bridge loop gate (relay copies, bot traffic, echoes) + bridge command
 *     line branch (Fluxer guild, human author): dispatched exactly once via
 *     the shipped dispatcher; no cache, gork, enqueue, activity, or XP
 * 1. guild gate (contract: externalGuildId — null only for guild-less
 *    Discord DMs, which stop here; the `guild` duck object is no longer consulted)
 * 2. bot author gate (normalized: authorBot)
 * 2b. Fluxer community resolution (Fluxer only: externalGuildId → communities.id)
 * 3. message cache (logs — Discord only: cacheMessage drops Fluxer writes,
 *    consumer-less rows per issue #277; re-enable with the reader + test)
 * 4. parsePrefix (Fluxer only — null on Discord, so step 7 is dead code there;
 *    fluxer normalized messages carry parsePrefix null, so it runs here)
 * 5. reaction-role pending emoji capture (only for non-prefix lines)
 * 6. honeypot channel enforcement (Discord duck fields; Fluxer: normalized path)
 * 7. prefix command: record channel activity, dispatch, then stop —
 *    no gork, no message XP (dispatch swallows handler throws itself)
 * 8. gork AI keyword Q&A (detached; never blocks, never early-returns)
 * 8b. bridge enqueue (after honeypot, before activity/XP; never throws)
 * 9. user channel activity counters (all human messages)
 * 10. message XP (with the isPrefixCommand backstop)
 *
 * `message` is a NormalizedMessage (output of normalizeDiscordMessage or
 * normalizeFluxerMessage): the normalized fields (authorBot, externalGuildId,
 * communityId, parsePrefix, …) plus every Discord duck field (guild, author,
 * channel, …), which unmigrated features keep reading. On entry the object is
 * validated against the shared required-field contract
 * (src/platform/normalizedMessageContract.js, "contract 1") — the guild/DM
 * semantics are explicit there: `externalGuildId` is string-or-null, so the
 * guild gate below never duck-types `message.guild`. `isPrefixCommand` at
 * step 10 is a backstop for future callers (spec line 227) — on Discord
 * parsePrefix is always null.
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
    // Contract gate (issue #201): the single required-field assertion for
    // BOTH adapters' normalized output, ahead of every step below (the
    // gates themselves read platform/instanceKey/id). A violation throws
    // naming field + platform; the catch logs it distinctly and the message
    // is skipped — an adapter can never ship half-shaped traffic downstream.
    assertNormalizedMessage(message, { boundary: "onMessageCreate" });

    // Bridge loop gate (KD 10, spec §10.4): FIRST pipeline line — relay
    // copies, bot traffic, and destination echoes never reach the cache,
    // gork, activity counters, XP, or the enqueue below.
    if (bridgeRelay.createLoopGate(message)) {
      // #469 (F2-5): ONE exception to the bot blackout — the honeypot
      // trap. An outside bot posting into a honeypot channel used to be
      // silent NOTHING (no delete, no ban, no log), so a bot-built raid
      // littered the trap forever. Relay copies, echoes and our own
      // notices still die here untouched (they are copies and warnings,
      // not intruders — the trap's self-post guard is the second lock).
      if (
        message.platform === "discord" &&
        (message.authorBot === true || message.author?.bot === true)
      ) {
        await handleHoneypotBotMessage(message, {
          selfId: opts.gorkClient?.user?.id ?? null,
        });
      }
      return;
    }

    // Bridge command lines (Fluxer guild, human author): command traffic, not
    // chat (spec §10.4, KD 17). Dispatched EXACTLY ONCE through the shipped
    // dispatcher — the registry handler is the single entry — while the cache,
    // reaction-role capture, gork, enqueue, activity counters, and XP are all
    // skipped. Honeypot enforcement stays in force. Bot-authored bridge lines
    // died at the gate above.
    if (bridgeRelay.isBridgeCommandLine(message)) {
      // The dispatcher's permission step (and honeypot) read the INTEGER
      // community id — resolve it here exactly as step 2b does for chat.
      // #467 (A2-9): the ONE helper (it owns the already-resolved skip +
      // the log); the inline copy here was the drift the extraction aimed
      // to prevent.
      resolveFluxerCommunity(message);
      const hpHit =
        message.platform === "fluxer"
          ? await handleHoneypotFluxerMessage(outbound, message)
          : false;
      if (hpHit) return;
      const bridgeCmd =
        message.parsePrefix ??
        (message.platform === "fluxer" ? parsePrefix(message.content ?? "") : null);
      if (bridgeCmd && opts.registry) {
        await dispatchPrefixCommand(outbound, message, bridgeCmd, {
          registry: opts.registry,
          supervisor: opts.supervisor,
        });
      }
      return;
    }

    // Guild gate: contract-guaranteed field — `externalGuildId` is
    // string-or-null (null = guild-less Discord DM). The old
    // `!message.guild && !message.externalGuildId` duck disjunct is gone:
    // the adapter boundary already proved this key exists (issue #201).
    if (message.externalGuildId == null) return;
    if (message.authorBot) return; // (bots already died at the loop gate above; #469 F2-5 trap exception lives there)

    // Fluxer (PR 6): resolve the communities row at this edge — repositories
    // take the integer id. Discord rows are untouched (platform "discord").
    // #467 (A2-9): through the shared helper — this copy used to re-run
    // ensureCommunity even when the message already carried one (a fresh
    // write txn per message, the A2-3 churn).
    resolveFluxerCommunity(message);

    cacheMessage(message);

    const prefixCommand =
      message.parsePrefix ??
      (message.platform === "fluxer" ? parsePrefix(message.content) : null);

    // A prefix command must not be swallowed by a pending reaction-role emoji
    // session (spec § Normalized gateway events).
    if (!prefixCommand) {
      // Platform branch (PR 5, gap #1): Fluxer normalized messages have no
      // discord.js shape (the Discord arm bails on !message.guild), so the
      // emoji-config flow gets its OutboundClient twin here — the same
      // honeypot pattern as the step below.
      const pendingRr =
        message.platform === "fluxer"
          ? await handlePendingOptionEmojiMessageFluxer(outbound, message)
          : await handlePendingOptionEmojiMessage(message);
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

    // Bridge enqueue (spec §10.4): runs after honeypot and before activity/XP,
    // is synchronous, does no network, and NEVER returns early — a bridge fault
    // is caught inside enqueueBridgeMessage and can never skip XP. PR 4 writes
    // the outbox row only (kind "create"); the worker that sends it is PR 5.
    bridgeRelay.enqueueBridgeMessage(message);

    // Count real message volume by channel (not XP-cooldown gated)
    recordUserChannelMessage(message);

    await tryAwardMessageXp(outbound, message, {
      isPrefixCommand: Boolean(prefixCommand),
    });
  } catch (e) {
    if (e instanceof NormalizedMessageContractError) {
      // Adapter-boundary fault, not a feature fault: named distinctly (with
      // the field + platform the validator produced) so the log tells the
      // adapter apart from downstream failures. Message skipped, pipeline alive.
      console.error(
        `[MessageCreate] normalized-message contract violation (message skipped): ${e.message}`,
      );
      return;
    }
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
/** Guild id for reaction logs when even the (partial) message lacks one. */
function interactionGuildHint(reaction) {
  return reaction.guildId ?? reaction.message?.guild?.id ?? null;
}

async function onMessageReactionAdd(client, reaction, user) {
  try {
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch (err) {
        // #467 (A2-12): the drop used to be silent — exactly where
        // "role didn't get granted" dead-ends land. Log the identity +
        // cause, then skip this reaction (nothing more we can do).
        console.error(
          `[reaction] partial fetch failed (message=${reaction.message?.id ?? "?"} guild=${reaction.message?.guildId ?? interactionGuildHint(reaction)} emoji=${reaction.emoji?.name ?? reaction.emoji?.id ?? "?"} user=${user?.id ?? "?"}): ${err?.message || err}`,
        );
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
      } catch (err) {
        // #467 (A2-12): the drop used to be silent — exactly where
        // "role didn't get granted" dead-ends land. Log the identity +
        // cause, then skip this reaction (nothing more we can do).
        console.error(
          `[reaction] partial fetch failed (message=${reaction.message?.id ?? "?"} guild=${reaction.message?.guildId ?? interactionGuildHint(reaction)} emoji=${reaction.emoji?.name ?? reaction.emoji?.id ?? "?"} user=${user?.id ?? "?"}): ${err?.message || err}`,
        );
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
 * 0. normalized-reaction contract assertion (issue #279): the
 *    normalizeFluxerReaction output enters shared code HERE — a violation is
 *    logged (naming field + platform) and the reaction is skipped, never a
 *    crash and never a downstream feature seeing a half-shaped payload.
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

    // Contract gate (issue #279): the required-field assertion for the
    // NormalizedReaction shape (src/platform/normalizedMessageContract.js),
    // ahead of every step below. A violation throws naming field + platform;
    // the catch logs it distinctly and the reaction is skipped — an adapter
    // can never ship half-shaped reaction traffic downstream. (A null payload
    // is the normalizer's OWN logged drop signal, not a contract violation —
    // it stays the quiet no-op above.)
    assertNormalizedReaction(normalizedReaction, { boundary: "onFluxerReactionAdd" });

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
    if (e instanceof NormalizedMessageContractError) {
      // Adapter-boundary fault, not a feature fault (issue #279, the #201
      // idiom): named distinctly (field + platform from the validator) so
      // the log tells the adapter apart from downstream failures. Reaction
      // skipped, pipeline alive.
      console.error(
        `[fluxer ReactionAdd] normalized-reaction contract violation (reaction skipped): ${e.message}`,
      );
      return;
    }
    console.error("[fluxer] ReactionAdd error:", e?.message || e);
  }
}

/**
 * Fluxer MessageReactionRemove pipeline (PR 9): un-react strips the role for
 * removable options through the fluxer service entry (removeRole self-gates on
 * K8 flag 0; the reaction cleanup itself is never elevated). Replaces the PR 6
 * log stub — the wire surface shipped in PR 6 is now wired.
 *
 * Entry contract (issue #279): same assertNormalizedReaction gate as the Add
 * entry — a violation logs distinctly and skips the payload.
 *
 * @param {object} outbound OutboundClient (Fluxer)
 * @param {object} normalizedReaction normalizeFluxerReaction output
 */
async function onFluxerReactionRemove(outbound, normalizedReaction) {
  try {
    if (!normalizedReaction) return;

    // Contract gate (issue #279) — see onFluxerReactionAdd for the full
    // rationale; both reaction entries share the NormalizedReaction shape.
    assertNormalizedReaction(normalizedReaction, { boundary: "onFluxerReactionRemove" });

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
    if (e instanceof NormalizedMessageContractError) {
      // Adapter-boundary fault, not a feature fault (issue #279, the #201
      // idiom): named distinctly (field + platform from the validator) so
      // the log tells the adapter apart from downstream failures. Reaction
      // skipped, pipeline alive.
      console.error(
        `[fluxer ReactionRemove] normalized-reaction contract violation (reaction skipped): ${e.message}`,
      );
      return;
    }
    console.error("[fluxer] ReactionRemove error:", e?.message || e);
  }
}

/**
 * MessageUpdate pipeline (PR 4: the echo gate; PR 6 owns source-side edit
 * intake). A MESSAGE_UPDATE whose id is a relayed destination copy of this
 * process (bridge_message_links.dst_message_id, partitioned by deployment)
 * is the echo of our own copy — dropped BEFORE any feature sees it (KD 10),
 * so a destination-side moderation edit never re-enters as a source edit.
 *
 * @param {object} outbound OutboundClient (unused in PR 4; PR 6 intake uses it)
 * @param {object} message NormalizedMessage (new state preferred)
 */
async function onMessageUpdate(outbound, message) {
  try {
    if (!message) return;
    void outbound;
    if (bridgeRelay.isRelayedEcho(message.platform, message.instanceKey, message.id)) {
      return;
    }
    // PR 6 (roadmap/bridge.md §10.4/§10.10): source-side kind-`edit` intake.
    // ALL eligibility lives inside enqueueBridgeEdit — relayed-source check,
    // human author, connected_at window, direction gate, and the
    // bridge_src_snapshots hash coalescing (a pin/flag update whose content
    // hash is unchanged enqueues nothing). A non-bridge channel is a no-op.
    // The enqueue never rejects: its spool tail is media-only and self-caught
    // (AGENTS.md rule 1 for detached async work).
    bridgeRelay.enqueueBridgeEdit(message).catch((e) =>
      console.error("[bridge] edit intake failed:", e?.message || e),
    );
  } catch (e) {
    console.error("[MessageUpdate] error:", e?.message || e);
  }
}

/**
 * MessageDelete pipeline (PR 4: the echo gate; PR 6 owns source-side delete
 * intake). Same echo rule as onMessageUpdate, applied before any feature.
 *
 * @param {object} outbound OutboundClient (unused in PR 4; PR 6 intake uses it)
 * @param {object} message NormalizedMessage (partial allowed)
 */
async function onMessageDelete(outbound, message) {
  try {
    if (!message) return;
    void outbound;
    if (bridgeRelay.isRelayedEcho(message.platform, message.instanceKey, message.id)) {
      return;
    }
    // PR 6 (roadmap/bridge.md §10.4/§10.10): source-side kind-`delete`
    // intake — synchronous, never throws, enqueues ONLY for relayed source
    // messages (a links row must exist). MESSAGE_DELETE_BULK arrives through
    // relay.enqueueBridgeBulkDelete (one kind-`delete` row per LINKED id;
    // the Discord bulk event wiring is the adapter follow-up). MESSAGE_CLEAR
    // / channel purge is deliberately NEVER relayed (spec §10.5).
    bridgeRelay.enqueueBridgeDelete(message);
  } catch (e) {
    console.error("[MessageDelete] error:", e?.message || e);
  }
}

/**
 * MESSAGE_DELETE_BULK intake (issue #275, roadmap/bridge.md §10.4 "BULK:
 * one kind-\`delete\` row per id with a link"). Both adapters deliver here
 * with an identity-shaped bulk object:
 *   { platform, instanceKey, externalGuildId|null, communityId|null,
 *     channelId, ids: string[] }
 * Community resolution mirrors the delete contract (guild-scoped, DMs have
 * no bridge consumer); the per-id echo gate mirrors the single-delete
 * pipeline, and relay.enqueueBridgeBulkDelete already skips unlinked ids
 * and never stacks. Never throws.
 *
 * @param {object} outbound OutboundClient (unused at intake, same as delete)
 * @param {object} bulk normalized bulk-delete identity
 */
async function onMessageDeleteBulk(outbound, bulk) {
  try {
    if (!bulk) return;
    void outbound;
    const ids = (Array.isArray(bulk.ids) ? bulk.ids : [])
      .map((id) => (id == null ? "" : String(id).trim()))
      .filter((id) => id !== "");
    if (ids.length === 0) return;

    let communityId = Number.isSafeInteger(bulk.communityId) ? bulk.communityId : null;
    if (communityId == null && bulk.externalGuildId) {
      communityId = ensureCommunity({
        platform: bulk.platform,
        instanceKey: bulk.instanceKey,
        externalGuildId: String(bulk.externalGuildId),
      });
    }
    if (communityId == null) return; // DM purge or unresolvable scope: no bridge end

    // Echo gate per id (KD 10): purges that include OUR OWN relayed copies
    // must not fan out deletes back to the peer — the single-delete
    // pipeline's first check, applied to every id.
    const mine = ids.filter(
      (id) => !bridgeRelay.isRelayedEcho(bulk.platform, bulk.instanceKey, id),
    );
    if (mine.length === 0) return;

    bridgeRelay.enqueueBridgeBulkDelete(communityId, String(bulk.channelId), mine, {
      platform: bulk.platform,
      instanceKey: bulk.instanceKey,
    });
  } catch (e) {
    console.error("[MessageDeleteBulk] error:", e?.message || e);
  }
}

/**
 * Fluxer MessageUpdate pipeline (audit #195 item 5 — Fluxer→Discord edit
 * relay). The mirror of the Discord MessageUpdate listener, minus its
 * normalizer's inline community resolve: normalizeFluxerMessage leaves
 * communityId null by contract (4), so this entry resolves the communities
 * row for the edge BEFORE delegating. Everything else — the KD 10 echo gate
 * and the source-side kind-edit intake — is the platform-neutral
 * onMessageUpdate below (§10.4: the intake lives IN the pipeline, no second
 * listener).
 *
 * @param {object} outbound OutboundClient (Fluxer)
 * @param {object} message NormalizedMessage (post-update state)
 */
async function onFluxerMessageUpdate(outbound, message) {
  try {
    if (!message) return;
    resolveFluxerCommunity(message);
    await onMessageUpdate(outbound, message);
  } catch (e) {
    console.error("[fluxer MessageUpdate] error:", e?.message || e);
  }
}

/**
 * Fluxer MessageDelete pipeline (audit #195 item 5 — Fluxer→Discord delete
 * relay). Same delegation contract as onFluxerMessageUpdate; the delete
 * intake (echo gate, links check, supersession) is platform-neutral inside
 * onMessageDelete.
 *
 * Entry contract (issue #279): the payload is the DELETE-IDENTITY PARTIAL
 * (normalizeFluxerMessageDelete dual shape: raw wire snake_case or SDK
 * PartialMessage camelCase — both normalize to the same six keys). It is
 * validated against assertNormalizedDelete — NEVER the full message
 * contract: a partial delete has no author/content by design and full
 * rules would reject every legitimate delete. Violations log distinctly
 * and skip; the Discord duck-shape delete path is untouched.
 *
 * @param {object} outbound OutboundClient (Fluxer)
 * @param {object} message normalizeFluxerMessageDelete output (partial)
 */
async function onFluxerMessageDelete(outbound, message) {
  try {
    if (!message) return;

    // Contract gate (issue #279): identity triple + community-resolvable
    // anchor + platform tags must all be present BEFORE the resolve below
    // (resolveFluxerCommunity keys off externalGuildId; the echo gate keys
    // off platform/instanceKey/id). A violation logs distinctly + skips —
    // the bridge intake never sees a duck-typed partial.
    assertNormalizedDelete(message, { boundary: "onFluxerMessageDelete" });

    resolveFluxerCommunity(message);
    await onMessageDelete(outbound, message);
  } catch (e) {
    if (e instanceof NormalizedMessageContractError) {
      // Adapter-boundary fault, not a feature fault (issue #279, the #201
      // idiom): named field + platform, distinct from downstream errors.
      // Delete skipped, pipeline alive.
      console.error(
        `[fluxer MessageDelete] normalized-delete contract violation (delete skipped): ${e.message}`,
      );
      return;
    }
    console.error("[fluxer MessageDelete] error:", e?.message || e);
  }
}

/**
 * Resolve + attach the communities row for a Fluxer normalized message
 * (the create pipeline's step 2b as a named helper — the update/delete
 * entries need the same resolve). A resolve failure leaves communityId
 * null, which every bridge intake treats as "not a source end" (fails
 * closed).
 * @param {object} message normalized Fluxer message (mutated)
 */
function resolveFluxerCommunity(message) {
  if (
    message.platform !== "fluxer" ||
    !message.externalGuildId ||
    Number.isSafeInteger(message.communityId)
  ) {
    return;
  }
  try {
    message.communityId = ensureCommunity({
      platform: "fluxer",
      instanceKey: message.instanceKey,
      externalGuildId: String(message.externalGuildId),
    });
  } catch (e) {
    console.error("[fluxer] community resolve failed:", e?.message || e);
  }
}

/**
 * Normalize a raw gateway message inside a try/catch (audit C8).
 *
 * `normalizeDiscordMessage` throws SYNCHRONOUSLY inside the gateway listener
 * on bad input — including its synchronous `ensureCommunity` SQLite insert
 * (a disk-full/constraint throw). An uncaught throw there crashes the whole
 * process (the 2026-10-01 gatewayPayloadGuard incident class), so the throw
 * is caught at the listener boundary: log with the message id, drop that one
 * message, keep the bot (and the other platform's connection) alive.
 *
 * @param {string} event listener name for the log prefix
 * @param {unknown} message raw discord.js Message
 * @returns {object|null} the normalized message, or null when normalize threw
 */
function safeNormalizeDiscord(event, message) {
  try {
    return normalizeDiscordMessage(message);
  } catch (e) {
    console.error(
      `[${event}] normalize failed (message ${message?.id ?? "?"}), message dropped:`,
      e?.message || e,
    );
    return null;
  }
}

/**
 * Ordered gateway pipelines that span multiple features.
 * (Independent events — delete/ban/kick, etc. — register via feature.registerEvents.)
 *
 * Every listener (audit C8): normalize runs under `safeNormalizeDiscord`, and
 * the pipeline promise carries its own `.catch()` so a rejection is logged
 * with the event name — fire-and-forget here can never reach the process net.
 *
 * @param {import("discord.js").Client} client
 */
function registerOrderedPipelines(client) {
  const outbound = getDiscordOutbound(client);
  client.on(Events.MessageCreate, (message) => {
    const normalized = safeNormalizeDiscord("MessageCreate", message);
    if (!normalized) return;
    onMessageCreate(outbound, normalized, {
      gorkClient: client,
    }).catch((e) =>
      console.error("[MessageCreate] pipeline rejected:", e?.message || e)
    );
  });
  client.on(Events.MessageReactionAdd, (reaction, user) =>
    onMessageReactionAdd(client, reaction, user).catch((e) =>
      console.error("[ReactionAdd] pipeline rejected:", e?.message || e)
    )
  );
  client.on(Events.MessageReactionRemove, (reaction, user) =>
    onMessageReactionRemove(client, reaction, user).catch((e) =>
      console.error("[ReactionRemove] pipeline rejected:", e?.message || e)
    )
  );
  // Bridge echo gates (KD 10): the update pair carries (old, new); prefer the
  // new state — it is the live content — and fall back to the old one.
  client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    const normalized = safeNormalizeDiscord(
      "MessageUpdate",
      newMessage ?? oldMessage,
    );
    if (!normalized) return;
    onMessageUpdate(outbound, normalized).catch((e) =>
      console.error("[MessageUpdate] pipeline rejected:", e?.message || e)
    );
  });
  client.on(Events.MessageDelete, (message) => {
    const normalized = safeNormalizeDiscord("MessageDelete", message);
    if (!normalized) return;
    onMessageDelete(outbound, normalized).catch((e) =>
      console.error("[MessageDelete] pipeline rejected:", e?.message || e)
    );
  });
  // #275: purge relay. discord.js hands the event ONLY the cached subset
  // (uncached ids never surface here — the same cache horizon the single
  // messageDelete has); purges of cached bridged copies are the exact case
  // that used to leave peer copies + link rows alive forever.
  client.on(Events.MessageBulkDelete, (messages, channel) => {
    const guildId = channel?.guild?.id ?? null;
    if (guildId == null) return;
    onMessageDeleteBulk(outbound, {
      platform: "discord",
      instanceKey: "discord",
      externalGuildId: String(guildId),
      channelId: String(channel?.id ?? ""),
      ids: [...messages.keys()],
    }).catch((e) =>
      console.error("[MessageDeleteBulk] pipeline rejected:", e?.message || e)
    );
  });
}

module.exports = {
  registerOrderedPipelines,
  onMessageCreate,
  onMessageUpdate,
  onMessageDelete,
  onMessageDeleteBulk,
  onMessageReactionAdd,
  onMessageReactionRemove,
  onFluxerReactionAdd,
  onFluxerReactionRemove,
  onFluxerMessageUpdate,
  onFluxerMessageDelete,
};
