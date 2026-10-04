/**
 * /link command surface (roadmap/account-linking.md T3).
 *
 * ONE context-API handler (KD 17: single entry point per command) serves BOTH
 * the Discord slash `/link …` and the Fluxer prefix `!link …`: the Discord
 * router (src/commands/router.js) and the Fluxer prefix dispatcher
 * (src/platform/fluxer/dispatch.js, step-5 gate `api === "context"`) both hand
 * a CommandContext to {@link handleLink}. The prefix command tree in
 * src/platform/fluxer/commands.js is built FROM the slash JSON exported here
 * (buildFluxerCommandTree), so this file is the single source for both surfaces
 * — same precedent as src/features/bridge/commands.js + handlers.js, merged
 * into one module because linking owns one command.
 *
 * Reply contract (AGENTS.md § Error Handling, rules 3/6, and the design bundle):
 *  - The service (./service.js) owns EVERY user-facing sentence, including all
 *    refusals. Handlers reply `result.error` VERBATIM — never a generic
 *    "something went wrong" (the router's MSG_GENERIC_ERROR stays the last-
 *    resort boundary fallback the router itself applies when a handler throws).
 *  - Discord replies are `sensitive: true` — the seam spelling of "private to
 *    the invoker" (src/platform/discord/context.js maps it to
 *    MessageFlags.Ephemeral). Fluxer has no ephemeral concept: replies go to
 *    the channel, and the create reply carries the "short-lived, one-time"
 *    note in its text (K2 DM mode is deliberately NOT used — the link code is
 *    addressed to the caller's peer on the other platform, and the service's
 *    minted code is single-use, so a public post is burned on first redeem;
 *    the reply text says so).
 *  - `surfaceCmd` ("/link" vs "<prefix>link", K1 prefix read at call time) is
 *    resolved from the ctx shape and passed to EVERY service call so the
 *    service's sentences name the command on the caller's own platform.
 *
 * Self-service v1: no staff gate anywhere — the caller can only ever mint,
 * redeem, inspect, configure, and remove THEIR OWN link (the service enforces
 * party-ness on every one of those).
 */

const { SlashCommandBuilder } = require("discord.js");

const service = require("./service");
const { getCommunityById } = require("../../platform/community");
const { getFluxerCommandPrefix } = require("../../config");

/** Replies must never ping (dispatch pins mentions on its own sends too). */
const NO_PING = { parse: [] };

// ---------------------------------------------------------------------------
// Slash JSON (the Fluxer prefix parser types its options against this same
// JSON — `!link connect code LNK-…` and `!link config memory off` parse with
// no overlay, mirroring the bridge pattern).
// ---------------------------------------------------------------------------

const commands = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription(
      "Link your Discord and Fluxer accounts so XP and gork memories mirror between them.",
    )
    .addSubcommand((sc) =>
      sc
        .setName("create")
        .setDescription("Mint a one-time link code for your account (lasts 15 minutes)."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("connect")
        .setDescription("Redeem the link code from your account on the other platform.")
        .addStringOption((opt) =>
          opt
            .setName("code")
            .setDescription("The LNK- link code from the other side's link create")
            .setRequired(true)
            .setMaxLength(100),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("status")
        .setDescription("Show your account link: peer, linked date, mirror rates."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("remove")
        .setDescription("Unlink your account. History already mirrored stays mirrored."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("config")
        .setDescription("Set XP mirror percentage (direction + 0-100) and/or gork memory mirroring.")
        .addStringOption((opt) =>
          opt
            .setName("direction")
            .setDescription("Which way XP flows (pair it with pct).")
            .setRequired(false)
            // Caller-relative tokens first; the service maps them against the
            // caller's platform (a Fluxer caller's "to-discord" is b→a) and
            // also accepts the raw storage keys.
            .addChoices(
              { name: "to-fluxer", value: "to-fluxer" },
              { name: "from-fluxer", value: "from-fluxer" },
              { name: "to-discord", value: "to-discord" },
              { name: "from-discord", value: "from-discord" },
              { name: "both", value: "both" },
              { name: "a_to_b", value: "a_to_b" },
              { name: "b_to_a", value: "b_to_a" },
            ),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("pct")
            .setDescription("Mirror rate in percent (0-100), with a direction")
            .setMinValue(0)
            .setMaxValue(100)
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName("memory")
            .setDescription("gork memory mirroring: on or off")
            .setRequired(false)
            .addChoices(
              { name: "on", value: "on" },
              { name: "off", value: "off" },
            ),
        ),
    ),
];

// ---------------------------------------------------------------------------
// Surface helpers
// ---------------------------------------------------------------------------

/**
 * The `{cmd}` token in every service sentence: "/link" on the Discord slash,
 * "{prefix}link" on the Fluxer prefix (K1 prefix read at call time — the
 * operator's configured prefix, never a hardcoded "!"). Mirrors
 * src/features/bridge/handlers.js surfaceCmdFor.
 */
function surfaceCmdFor(ctx) {
  return ctx && ctx.platform === "fluxer" ? `${getFluxerCommandPrefix()}link` : "/link";
}

/**
 * The same hint for the OPPOSITE platform — the create reply tells the peer
 * what to run over there (`/link create` on Discord pairs with
 * `!link connect` on Fluxer and vice versa).
 */
function otherSideCmdFor(ctx) {
  return ctx && ctx.platform === "fluxer" ? "/link" : `${getFluxerCommandPrefix()}link`;
}

function platformLabel(platform) {
  if (platform === "discord") return "Discord";
  if (platform === "fluxer") return "Fluxer";
  return String(platform ?? "unknown");
}

/** ISO instant without the zone suffix, for "{iso} UTC" sentences (bridge style). */
function isoUtc(ms) {
  const n = Number(ms);
  return Number.isFinite(n) ? new Date(n).toISOString().replace(/Z$/, "") : String(ms);
}

/**
 * Reply the caller with a specific sentence. Discord: ephemeral (the `sensitive`
 * seam key → MessageFlags.Ephemeral on the adapter). Fluxer: in-channel —
 * K2 DM mode is deliberately NOT used; see the file header for why.
 *
 * @param {import("../../platform/context").CommandContext} ctx
 * @param {string} content
 * @returns {Promise<void>}
 */
async function replyToCaller(ctx, content) {
  const payload = { content, allowedMentions: NO_PING };
  if (ctx.platform === "discord") payload.sensitive = true;
  await ctx.reply(payload);
}

/**
 * "name — user 123 on Fluxer (instance fluxer, community 2)" — the peer
 * descriptor the service renders (id + platform, never a handle the bot
 * cannot resolve), decorated with a display name when the target platform
 * can supply one. Name resolution is best-effort (roadmap acceptance:
 * "per-platform names via outbound.fetchMember"); every failure path
 * degrades to the bare id, never an error reply.
 *
 * @param {import("../../platform/context").CommandContext} ctx
 * @param {object} featureCtx
 * @param {{ communityId: number, userId: string, platformLabel: string, instanceKey: string }} peer
 * @returns {Promise<string>}
 */
async function describePeer(ctx, featureCtx, peer) {
  const base = `user ${peer.userId} on ${peer.platformLabel} (instance ${peer.instanceKey}, community ${peer.communityId})`;
  const name = await resolvePeerName(ctx, featureCtx, peer);
  return name ? `${name} — ${base}` : base;
}

/**
 * Best-effort display name for a peer identity on the OTHER platform: the
 * supervisor's outbound client for the PEER's community runs fetchMember
 * (the same resolution the leaderboard uses for linked rows). Any failure
 * is logged with ids and returns null — a status reply that shows the id is
 * correct, just less friendly.
 */
async function resolvePeerName(ctx, featureCtx, peer) {
  let outbound = ctx && ctx.outbound;
  try {
    const peerClient = featureCtx?.supervisor?.clientForCommunity?.(peer.communityId);
    if (peerClient && typeof peerClient.fetchMember === "function") outbound = peerClient;
  } catch (err) {
    console.error(
      `[linking] peer name lookup: no outbound client for community ${peer.communityId}:`,
      err?.message || err,
    );
    outbound = null;
  }
  if (!outbound || typeof outbound.fetchMember !== "function") return null;
  try {
    const member = await outbound.fetchMember(peer.communityId, peer.userId);
    const name = member?.user?.username ?? member?.username ?? member?.displayName ?? null;
    return name ? String(name) : null;
  } catch (err) {
    console.error(
      `[linking] peer name fetch failed (community ${peer.communityId} user ${peer.userId}):`,
      err?.message || err,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reply text composition (the service owns every refusal; these are the
// success sentences, matching the service's direct, actionable style)
// ---------------------------------------------------------------------------

function createSuccessText(result, surfaceCmd, otherCmd) {
  const minutes = Math.max(1, Math.round((Number(result.lifetimeMs) || 15 * 60 * 1000) / 60000));
  return (
    `Link code, shown once: ${result.code}\n` +
    `It expires ${isoUtc(result.expiresAt)} UTC (about ${minutes} minutes) and works exactly once. ` +
    `The account on the other platform redeems it THERE: ${otherCmd} connect with that code. ` +
    "Treat the code like a password: whoever redeems it first links to your account, " +
    `so send it privately. Your link shows up under ${surfaceCmd} status, and one code can only ever mint one link.`
  );
}

function connectSuccessText(peerDesc, surfaceCmd) {
  return (
    `Linked to ${peerDesc}. ` +
    "XP and gork memories now mirror between the two accounts — both XP directions start at 100% " +
    "and memory mirroring starts on. " +
    `Change rates with ${surfaceCmd} config (e.g. "config both 50", "config memory off"), ` +
    `inspect with ${surfaceCmd} status, undo with ${surfaceCmd} remove. ` +
    "That link code is spent."
  );
}

function statusText(ctx, link, peerDesc) {
  const memory = Number(link.mirror_memory) === 1 ? "on" : "off";
  return (
    `Linked: you (${platformLabel(ctx.platform)} user ${ctx.userId} in community ${ctx.communityId}) ↔ ${peerDesc}.\n` +
    `Linked since: ${isoUtc(link.created_at)} UTC.\n` +
    `XP mirror: Discord → Fluxer ${link.mirror_a_to_b_pct}%, Fluxer → Discord ${link.mirror_b_to_a_pct}%.\n` +
    `gork memory mirroring: ${memory}.`
  );
}

// ---------------------------------------------------------------------------
// Subcommand handlers (all share the replyToCaller surface)
// ---------------------------------------------------------------------------

/** `link create` — mint the one-time code (ephemeral on Discord). */
async function handleCreate(ctx, featureCtx, surfaceCmd) {
  const result = await service.createLinkCode(ctx.communityId, ctx.userId, { surfaceCmd });
  if (!result.ok) return replyToCaller(ctx, result.error);
  return replyToCaller(ctx, createSuccessText(result, surfaceCmd, otherSideCmdFor(ctx)));
}

/** `link connect <code>` — redeem the peer's code. The service's failure
 *  sentences (expired / used / same-platform / no bridge / already linked)
 *  are replied verbatim, exactly as written in service.js. */
async function handleConnect(ctx, featureCtx, surfaceCmd) {
  const code = ctx.options.getString("code");
  const result = await service.redeemLinkCode(ctx.communityId, ctx.userId, code, { surfaceCmd });
  if (!result.ok) return replyToCaller(ctx, result.error);
  const peerDesc = await describePeer(ctx, featureCtx, result.peer);
  return replyToCaller(ctx, connectSuccessText(peerDesc, surfaceCmd));
}

/** `link status` — the caller's link, party-only. */
async function handleStatus(ctx, featureCtx, surfaceCmd) {
  const result = service.getLinkFor(ctx.communityId, ctx.userId);
  if (!result.ok) return replyToCaller(ctx, result.error);
  if (!result.link) {
    return replyToCaller(
      ctx,
      `You (user ${ctx.userId} in community ${ctx.communityId}) have no account link here. ` +
        `${surfaceCmd} create mints a code; your account on the other platform redeems it with ` +
        `${otherSideCmdFor(ctx)} connect.`,
    );
  }
  const peerDesc = await describePeer(ctx, featureCtx, result.peer);
  return replyToCaller(ctx, statusText(ctx, result.link, peerDesc));
}

/** `link remove` — caller must be a party. The service's `note` (mirroring is
 *  not retroactive) is displayed verbatim. */
async function handleRemove(ctx, surfaceCmd) {
  const result = service.removeLink(ctx.communityId, ctx.userId, { surfaceCmd });
  if (!result.ok) return replyToCaller(ctx, result.error);
  const link = result.link;
  const callerIsA = link.community_id_a === ctx.communityId && link.user_id_a === ctx.userId;
  const peerCommunityId = callerIsA ? link.community_id_b : link.community_id_a;
  const peerUserId = callerIsA ? link.user_id_b : link.user_id_a;
  const peerPlatform = platformLabel(getCommunityById(peerCommunityId)?.platform);
  return replyToCaller(
    ctx,
    `Unlinked from user ${peerUserId} on ${peerPlatform} (community ${peerCommunityId}). ${result.note}`,
  );
}

/**
 * `link config [direction] [pct] | memory on|off` — caller must be a party.
 * Free-text direction tokens pass through untouched: the service resolves them
 * against the CALLER's platform (a Fluxer caller's "to-discord" = b→a) and
 * validates the 0–100 integer. Absent options are OMITTED from the opts bag
 * (the service treats `undefined` as "not provided"; passing null would read
 * as "set to null" for pct and break `config memory off`).
 */
async function handleConfig(ctx, surfaceCmd) {
  const opts = { surfaceCmd };
  const direction = ctx.options.getString("direction");
  if (typeof direction === "string" && direction.trim() !== "") opts.direction = direction.trim();
  const pct = ctx.options.getInteger("pct");
  if (pct != null) opts.pct = pct;
  const memory = ctx.options.getString("memory");
  if (typeof memory === "string" && memory.trim() !== "") {
    opts.mirrorMemory = memory.trim().toLowerCase() === "on";
  }

  const result = await service.configureMirror(ctx.communityId, ctx.userId, opts);
  if (!result.ok) {
    // Partial failures report what DID land (AGENTS.md rule 5): the service
    // applies pct before memory and stops at the first refusal.
    const applied = Array.isArray(result.applied) ? result.applied.filter(Boolean) : [];
    const suffix = applied.length
      ? ` Applied before the failure: ${applied.join(", ")}.`
      : "";
    return replyToCaller(ctx, `${result.error}${suffix}`);
  }

  const m = result.mirror;
  const memoryLabel = m.memory ? "on" : "off";
  return replyToCaller(
    ctx,
    `Applied: ${result.applied.join(", ")}. ` +
      `(a_to_b = Discord → Fluxer, b_to_a = Fluxer → Discord, mirror_memory = gork memories.) ` +
      `Now: Discord → Fluxer ${m.a_to_b_pct}%, Fluxer → Discord ${m.b_to_a_pct}%, memory ${memoryLabel}.`,
  );
}

// ---------------------------------------------------------------------------
// Context-arm entry point (registered as the "link" handler, api "context")
// ---------------------------------------------------------------------------

/**
 * Guild-surface entry: Discord slash contexts AND the shipped Fluxer prefix
 * dispatcher (KD 17: one handler, no second listener). Every service failure
 * is answered with the service's own specific sentence; unexpected throws are
 * the router/dispatch boundary's job (both wrap handler invocations — AGENTS.md
 * rule 1), and this handler detaches no async work, so there is no unhandled
 * promise to attach a catch to.
 *
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleLink(commandCtx, featureCtx) {
  const surfaceCmd = surfaceCmdFor(commandCtx);
  const sub = commandCtx.subcommand;
  switch (sub) {
    case "create":
      return handleCreate(commandCtx, featureCtx, surfaceCmd);
    case "connect":
      return handleConnect(commandCtx, featureCtx, surfaceCmd);
    case "status":
      return handleStatus(commandCtx, featureCtx, surfaceCmd);
    case "remove":
      return handleRemove(commandCtx, surfaceCmd);
    case "config":
      return handleConfig(commandCtx, surfaceCmd);
    default:
      // Reaching this means the invocation named a subcommand the registry
      // JSON does not define — name the valid set, never a generic shrug.
      return replyToCaller(
        commandCtx,
        `Unknown subcommand: ${String(sub)}. Valid subcommands: create, connect, status, remove, config.`,
      );
  }
}

module.exports = {
  commands,
  handleLink,
  // exported for tests / docs:
  surfaceCmdFor,
  otherSideCmdFor,
  createSuccessText,
  connectSuccessText,
  statusText,
};
