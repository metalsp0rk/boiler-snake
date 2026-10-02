/**
 * Bridge service (roadmap/bridge.md §10.2, §10.7, §10.9, §10.10, §"Service").
 *
 * The one service behind every surface (Discord slash now; Fluxer prefix/DM
 * arrive with the activation PR). Contract:
 *
 *  - Every method returns { ok: true, ... } | { ok: false, error: string }.
 *    `error` is the VERBATIM §10.2 sentence; handlers reply it verbatim.
 *    Expected failures are values, never thrown (AGENTS.md rule 6).
 *  - Imports NEITHER discord.js NOR the Fluxer SDK core package, and it
 *    never replies to
 *    a platform: all outbound platform access is INJECTED through `deps`
 *    (unit tests pass fakes for every one of them).
 *  - The pending → active flip is the connect-owned compare-and-swap of
 *    spec §10.7 step 8. It lives HERE (not in the repository, which
 *    deliberately never writes 'active' — KD 22): the first build that can
 *    set state='active' is this one, and it also enforces the token key,
 *    both clients, and the permission probes BEFORE any webhook create.
 *
 * `community` is a communities row (getCommunityById / getCommunityByExternal
 * output: { id, platform, instanceKey, externalGuildId }). Channel arguments
 * are ids only — the handler layer resolves channel objects into the
 * `channelFacts` descriptor the probes below read:
 *
 *   { id, type, nsfw, everyoneDeniedView, invokerPermissions, botPermissions }
 *
 * Permission masks are bigints (or bigint/number-coercible). Bit values are
 * Discord's permission flags; the service is platform-neutral and keeps the
 * constants locally because importing discord.js is forbidden for this file.
 *
 * Secrets (AGENTS.md, spec §Security): no pairing code, code hash, webhook
 * token, or message body ever enters an audit row, a log line, or a returned
 * string. The plaintext code exists only in the create result (`code`), which
 * handlers surface ONLY through an ephemeral reply / DM.
 */

const crypto = require("crypto");

const repo = require("../../db/repositories/bridges");
const { db } = require("../../db/connection");
const { getCommunityById, assertCommunityId } = require("../../platform/community");
const { recordSlashAudit } = require("../../core/auditTrail");
const codes = require("./codes");
const media = require("./media");
const tokenCrypto = require("./tokenCrypto");
const relay = require("./relay");

// ---------------------------------------------------------------------------
// Verbatim §10.2 sentences (single source; handlers reply `error` verbatim)
// ---------------------------------------------------------------------------

const MSG_DENIED = "You don't have permission to use this.";

const BRIDGE_MESSAGES = Object.freeze({
  denied: MSG_DENIED,
  killSwitch: "Bridges are turned off on this process (BRIDGE_ENABLED=0).",
  channelTaken: (publicId, cmd) =>
    `This channel is already in bridge ${publicId}. Disconnect it with ${cmd} disconnect before creating another.`,
  pendingExists: (publicId, iso, cmd) =>
    `This channel already has a pending bridge (${publicId}) that expires at ${iso} UTC. The pairing code cannot be shown again. Disconnect it with ${cmd} disconnect, or wait until it expires.`,
  badType:
    "Bridges only support a guild text channel. Threads, voice, forums, categories, DMs, and Fluxer voice channels can't be bridged.",
  invokerNoView: "You can't view that channel, so you can't bridge it.",
  botMissingPerms: (names, cmd) =>
    `I can't bridge this channel: the bot is missing ${names.join(", ")}. Grant them on the bot role and try again.`,
  honeypot: "That channel is a honeypot. Honeypot channels can't be bridged.",
  invalidDirection: (toOther, fromOther) =>
    `That is not a bridge direction. Use both, ${toOther}, ${fromOther}, or leave it out for both.`,
  handlePassedToConnect: (publicId) =>
    `That is the bridge handle ${publicId}, not the connect credential. Connect will not accept it. Use the BRG- code from create.`,
  alphabetGarbage:
    "That bridge code has characters a code can't contain. Paste the BRG- code again, with or without the dashes.",
  expiredOrUnknown: (cmd) =>
    `That bridge code is expired or unknown. Codes last 30 minutes, work once, and cannot be shown again. Create a new one with ${cmd} create.`,
  alreadyUsed: (publicId) => `That bridge code was already used to connect bridge ${publicId}.`,
  samePlatform: (createdOn, cmd) =>
    `A bridge is one Discord channel and one Fluxer channel. This code was created on ${createdOn}; run ${cmd} connect on the other platform.`,
  destinationTaken: (publicId) =>
    `That channel is already in bridge ${publicId}. Pick a different channel, or disconnect that bridge first.`,
  tooManyMisses:
    "Too many failed bridge connect attempts in this community. Wait 10 minutes and try again.",
  fluxerClientAbsent: (instanceKey) =>
    `This process has no Fluxer client for ${instanceKey}, so that end can't be checked or written. Fix the Fluxer endpoint and try again.`,
  discordClientAbsent:
    "This process has no Discord client, so the Discord end can't be checked or written. Start the bot with DISCORD_TOKEN and try again.",
  keyMissing:
    "Set BRIDGE_TOKEN_KEY (32 bytes, base64) before connecting a bridge. Webhook tokens are not stored in plaintext.",
  fluxerMfa:
    "Fluxer refused to create the bridge webhook: TWO_FACTOR_REQUIRED. On an MFA-elevated community the bot was not exempt from Manage Webhooks. Bridge not connected.",
  webhookCapChannel: (detail, cmd) =>
    `The bridge webhook was refused: this channel is at its webhook limit (${detail}). Remove a webhook and run ${cmd} connect again. Bridge not connected.`,
  webhookCapCommunity: (detail, cmd) =>
    `The bridge webhook was refused: this community is at its webhook limit (${detail}). Remove a webhook and run ${cmd} connect again. Bridge not connected.`,
  burnReply: (cmd) =>
    `That connect command was posted in the channel, so the pairing code is burned and was not used. Create a new one with ${cmd} create, then DM me ${cmd} connect <code> <channel>.`,
  lostPendingRow: (cmd) =>
    `That bridge code was no longer pending when connect finished (it was burned or already used). Webhooks created for this attempt were deleted. Bridge not connected. Create a new code with ${cmd} create.`,
  disconnectNone: (cmd) =>
    `This channel isn't in a bridge. Use ${cmd} list to see bridges in this community.`,
  listNone: "This community has no bridges.",
  saveFailed: (message) => `Could not save the bridge: ${message}.`,
  webhookCreateFailed: (side, detail) =>
    `The bridge webhook creation on the ${side} end failed: ${detail}. No channels were paired and the code is still valid — fix the cause and run connect again.`,
  channelUnreadable: (channelId, detail) =>
    `I couldn't load channel ${channelId}: ${detail}. Pick a channel the bot can read and try again.`,
  botPermsUnreadable: (channelId, detail) =>
    `I couldn't read my own permissions in channel ${channelId}: ${detail}. Grant the bot View Channel and try again.`,
  invokerNoViewCross:
    "I couldn't confirm you can see that channel: the member record is not resolvable here. Run this from a channel you can see, or pass a channel you share with the bot.",
});

/**
 * PR 4 (KD 22): relay not wired. `connectBridge` refuses activation with this
 * sentence BEFORE any webhook create when no `activateBridge` is injected, so
 * a process that cannot relay never touches the webhook API. The activation
 * PR injects the real activator; unit tests inject a §10.7 step-8 stand-in.
 */
const MSG_RELAY_NOT_WIRED =
  "Connecting runs through a relay build that is not wired in this process (the activation PR wires it). No channels were paired and the code is still valid.";

// ---------------------------------------------------------------------------
// Permission-bit constants (Discord permission flags; BigInt masks)
// ---------------------------------------------------------------------------

const BITS = Object.freeze({
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  MANAGE_WEBHOOKS: 1n << 28n,
});

/** Required bot permissions, in the order the §10.2 sentence lists them. */
const REQUIRED_BOT_PERMISSIONS = Object.freeze([
  ["View Channel", BITS.VIEW_CHANNEL],
  ["Send Messages", BITS.SEND_MESSAGES],
  ["Attach Files", BITS.ATTACH_FILES],
  ["Embed Links", BITS.EMBED_LINKS],
  ["Manage Webhooks", BITS.MANAGE_WEBHOOKS],
]);

/** Guild text channel types accepted as bridge ends (both platforms: 0). */
const GUILD_TEXT_TYPE = 0;

/** Webhook display name (spec §10.7 step 6; ≤ 80 chars). */
const RELAY_WEBHOOK_NAME = "Boiler Snake Bridge";

function toBitMask(value) {
  try {
    return BigInt(value ?? 0n);
  } catch {
    return null;
  }
}

function hasBit(mask, bit) {
  const m = toBitMask(mask);
  if (m == null) return false;
  return (m & bit) === bit;
}

function hasAdmin(mask) {
  return hasBit(mask, BITS.ADMINISTRATOR);
}

function missingBotPermNames(mask) {
  if (hasAdmin(mask)) return [];
  const m = toBitMask(mask);
  if (m == null) return null;
  const missing = [];
  for (const [name, bit] of REQUIRED_BOT_PERMISSIONS) {
    if ((m & bit) !== bit) missing.push(name);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} community a communities row
 * @returns {boolean}
 */
function isCommunityRow(community) {
  return (
    community !== null &&
    typeof community === "object" &&
    Number.isSafeInteger(community.id) &&
    typeof community.platform === "string" &&
    typeof community.instanceKey === "string"
  );
}

/**
 * Staff gate on data the handler supplies (the service cannot call
 * requireStaff — that module imports discord.js, which this file must not).
 * Mirrors src/core/permissions.js: Manage Guild **or** any staff_roles role.
 */
function staffPermits(communityId, staff) {
  if (!staff || typeof staff !== "object") return false;
  if (staff.hasManageGuild === true) return true;
  const { memberHasStaffRole } = require("../../db");
  try {
    return memberHasStaffRole(communityId, Array.isArray(staff.memberRoleIds) ? staff.memberRoleIds : []);
  } catch (err) {
    console.error(`[bridge] staff gate failed for community ${communityId}:`, err?.message || err);
    return false;
  }
}

/**
 * Command-channel allow-list on the INVOCATION channel only (spec §10.2
 * "Command channels"): empty allow-list → everywhere; a null invocation
 * channel (Fluxer DM connect) skips the check. Bridge has NO
 * setcommandchannel lockout exception.
 *
 * @param {number|null|undefined} communityId
 * @param {string|null|undefined} invocationChannelId
 * @returns {boolean}
 */
function commandChannelsPermit(communityId, invocationChannelId) {
  const { listAllowedCommandChannels } = require("../../db");
  if (communityId == null) return true;
  if (invocationChannelId == null || invocationChannelId === "") return true;
  try {
    const rows = listAllowedCommandChannels(communityId);
    if (!rows.length) return true;
    return rows.some((r) => r.channel_id === String(invocationChannelId));
  } catch (err) {
    console.error(
      `[bridge] command-channel allow-list check failed for community ${communityId}:`,
      err?.message || err,
    );
    return false; // fail closed: config commands run in configured channels
  }
}

/** Map a create-side direction token (platform-relative) to storage form. */
function normalizeCreateDirection(platform, raw) {
  const token = String(raw ?? "both").trim().toLowerCase();
  if (token === "" || token === "both") return { ok: true, direction: "both" };
  if (platform === "discord") {
    if (token === "to-fluxer") return { ok: true, direction: "a_to_b" };
    if (token === "from-fluxer") return { ok: true, direction: "b_to_a" };
  } else if (platform === "fluxer") {
    if (token === "to-discord") return { ok: true, direction: "a_to_b" };
    if (token === "from-discord") return { ok: true, direction: "b_to_a" };
  }
  return { ok: false };
}

function platformLabel(platform) {
  if (platform === "discord") return "Discord";
  if (platform === "fluxer") return "Fluxer";
  return String(platform ?? "unknown");
}

/** Human rendering of a stored direction, from the create side's view. */
function directionLabel(direction, endAPlatform, endBPlatform) {
  const a = platformLabel(endAPlatform);
  const b = platformLabel(endBPlatform);
  if (direction === "a_to_b") return `${a} → ${b}`;
  if (direction === "b_to_a") return `${b} → ${a}`;
  return "both directions";
}

function isoUtc(ms) {
  const n = Number(ms);
  return Number.isFinite(n) ? new Date(n).toISOString() : String(ms);
}

function causeOf(err) {
  return String(err?.message || err);
}

function defaultDeps(deps) {
  return {
    repo,
    db,
    audit: (entry) => recordSlashAudit(entry),
    keyGetter: () => process.env.BRIDGE_TOKEN_KEY,
    resolveChannel: async (community, channelId) => ({
      ok: false,
      error: `no channel resolver is wired for platform ${community?.platform ?? "unknown"} (this surface cannot read channel ${channelId})`,
    }),
    sendMessage: async () => ({ ok: true }),
    webhookApiFor: () => null,
    hasDiscordClient: () => false,
    hasFluxerClient: () => false,
    ...deps,
  };
}

/** Audit row writer: never breaks the command (recordSlashAudit is fail-safe). */
function audit(deps, entry) {
  try {
    deps.audit(entry);
  } catch (err) {
    // recordSlashAudit swallows by contract; this belt is for injected fakes.
    console.error(`[bridge] audit ${entry?.action} failed:`, err?.message || err);
  }
}

/**
 * Resolve + sanity-check a channel descriptor. Returns the facts object, or
 * an { ok: false, error } result.
 */
async function fetchChannelFacts(deps, community, channelId, method) {
  const id = String(channelId ?? "").trim();
  if (!id) {
    return { ok: false, error: "A channel is required. Pass a channel you can see." };
  }
  let resolved;
  try {
    resolved = await deps.resolveChannel(community, id);
  } catch (err) {
    return { ok: false, error: BRIDGE_MESSAGES.channelUnreadable(id, causeOf(err)) };
  }
  if (!resolved || resolved.ok !== true) {
    return {
      ok: false,
      error: BRIDGE_MESSAGES.channelUnreadable(id, resolved?.error ?? "the channel lookup reported no cause"),
    };
  }
  const facts = resolved.channel;
  if (!facts || typeof facts !== "object") {
    return { ok: false, error: BRIDGE_MESSAGES.channelUnreadable(id, `${method} returned no channel data`) };
  }
  return { ok: true, facts: { id, ...facts, id: id } };
}

/**
 * The shared target-channel probe (spec §10.7 step 1 "view/bot-perms/type/
 * honeypot/1:1"): returns { ok: true, facts } or { ok: false, error }.
 */
async function probeTargetChannel(deps, { community, channelId, enforceView = true }) {
  const fetched = await fetchChannelFacts(deps, community, channelId, "resolveChannel");
  if (!fetched.ok) return fetched;
  const facts = fetched.facts;

  if (enforceView) {
    const invoker = toBitMask(facts.invokerPermissions);
    if (invoker == null) {
      return { ok: false, error: BRIDGE_MESSAGES.invokerNoViewCross };
    }
    if (!hasAdmin(invoker) && !hasBit(invoker, BITS.VIEW_CHANNEL)) {
      return { ok: false, error: BRIDGE_MESSAGES.invokerNoView };
    }
  }

  if (Number(facts.type) !== GUILD_TEXT_TYPE) {
    return { ok: false, error: BRIDGE_MESSAGES.badType };
  }

  try {
    // honeypot registry lives in the db facade (the bridges repo has no view
    // into honeypot channels).
    const { isHoneypotChannel } = require("../../db");
    if (isHoneypotChannel(community.id, facts.id)) {
      return { ok: false, error: BRIDGE_MESSAGES.honeypot };
    }
  } catch (err) {
    return { ok: false, error: BRIDGE_MESSAGES.saveFailed(causeOf(err)) };
  }

  return { ok: true, facts };
}

/**
 * The 1:1 lookups, mapped to the §10.2 sentences (create distinguishes a
 * pending occupant from a connected one — spec §10.2 "Worked checks").
 */
function channelOccupancyError(communityId, channelId, cmd) {
  const end = repo.getBridgeEndForChannel(communityId, String(channelId));
  if (!end) return null;
  const bridge = repo.getBridgeById(end.bridge_id);
  if (!bridge) return null; // orphan end (schema says impossible; be specific)
  return { end, bridge, takenError: BRIDGE_MESSAGES.channelTaken(bridge.public_id, cmd) };
}

/** The webhook-lifecycle api pair for one community, resolved via deps. */
function webhookApiForCommunity(deps, community) {
  try {
    return deps.webhookApiFor(community.platform, community.instanceKey) ?? null;
  } catch (err) {
    console.error(
      `[bridge] webhook api resolution failed for community ${community.id}:`,
      causeOf(err),
    );
    return null;
  }
}

/**
 * Best-effort delete of a webhook created by a connect attempt that then
 * failed (spec §10.7 step 7: a retry must not leak webhook slots).
 */
async function bestEffortDeleteWebhook(api, webhook) {
  if (!api || typeof api.deleteRelayWebhook !== "function" || !webhook) return;
  try {
    const res = await api.deleteRelayWebhook(webhook);
    if (res && res.ok === false) {
      console.error(`[bridge] webhook ${webhook.id} cleanup failed: ${res.error}`);
    }
  } catch (err) {
    console.error(`[bridge] webhook ${webhook.id} cleanup threw:`, causeOf(err));
  }
}

/** Map a webhook-create failure to its §10.2 sentence. */
function webhookCreateError(side, result, cmd) {
  const code = result?.code != null ? String(result.code) : null;
  const detail = result?.error ?? "the platform returned no cause";
  if (side === "fluxer" && code === "TWO_FACTOR_REQUIRED") return BRIDGE_MESSAGES.fluxerMfa;
  if (code === "MAX_WEBHOOKS_PER_CHANNEL") return BRIDGE_MESSAGES.webhookCapChannel(detail, cmd);
  if (code === "MAX_WEBHOOKS_PER_GUILD") return BRIDGE_MESSAGES.webhookCapCommunity(detail, cmd);
  return BRIDGE_MESSAGES.webhookCreateFailed(side, detail);
}

// ---------------------------------------------------------------------------
// createBridge
// ---------------------------------------------------------------------------

/**
 * Create a pending bridge + pairing credential (spec §10.1 create step).
 *
 * @param {object} args
 * @param {object} args.community communities row of the create-side guild
 * @param {string|null} args.invocationChannelId channel the command ran in
 * @param {string} args.targetChannelId channel to pair (resolved id)
 * @param {string} [args.direction='both'] raw token (both|to-fluxer|from-fluxer|to-discord|from-discord)
 * @param {string} args.actorUserId invoking user's external id (display-only)
 * @param {string} [args.surfaceCmd='/bridge'] '/bridge' or '{prefix}bridge'
 * @param {() => number} [args.clock] epoch-ms clock (tests)
 * @param {object} [args.staff] { hasManageGuild, memberRoleIds }
 * @param {object} [args.deps] injected seams (see defaultDeps)
 * @returns {Promise<{ ok: boolean, error?: string, publicId?: string, code?: string, expiresAt?: number, direction?: string }>}
 */
async function createBridge({
  community,
  invocationChannelId = null,
  targetChannelId = null,
  direction = "both",
  actorUserId = null,
  surfaceCmd = "/bridge",
  clock = () => Date.now(),
  staff = null,
  deps: depsIn = {},
} = {}) {
  const deps = defaultDeps(depsIn);
  try {
    if (!isCommunityRow(community)) {
      throw new TypeError("createBridge: community must be a communities row (resolved by the edge)");
    }
    assertCommunityId(community.id);

    if (!staffPermits(community.id, staff)) return { ok: false, error: MSG_DENIED };
    if (!commandChannelsPermit(community.id, invocationChannelId)) {
      return { ok: false, error: "Commands aren't enabled in this channel." };
    }

    const actor = String(actorUserId ?? "").trim();
    if (!actor) {
      throw new TypeError("createBridge: actorUserId is required");
    }

    // Direction (KD 19) — parsed before any write so a bad token saves nothing.
    const parsedDirection = normalizeCreateDirection(community.platform, direction);
    if (!parsedDirection.ok) {
      const [toOther, fromOther] =
        community.platform === "discord"
          ? ["to-fluxer", "from-fluxer"]
          : ["to-discord", "from-discord"];
      return { ok: false, error: BRIDGE_MESSAGES.invalidDirection(toOther, fromOther) };
    }

    const probed = await probeTargetChannel(deps, {
      community,
      channelId: targetChannelId,
    });
    if (!probed.ok) return probed;
    const facts = probed.facts;

    // 1:1 — a second create in an occupied channel never mints a code.
    const occupancy = channelOccupancyError(community.id, facts.id, surfaceCmd);
    if (occupancy) {
      if (occupancy.bridge.state === "pending") {
        return {
          ok: false,
          error: BRIDGE_MESSAGES.pendingExists(
            occupancy.bridge.public_id,
            isoUtc(occupancy.bridge.expires_at),
            surfaceCmd,
          ),
        };
      }
      return { ok: false, error: occupancy.takenError };
    }

    const minted = codes.generateConnectCode();
    const expiresAt = clock() + repo.BRIDGE_CODE_LIFETIME_MS;

    let row = null;
    for (let attempt = 0; attempt < 3 && !row; attempt += 1) {
      const handle = codes.generatePublicId({
        isTaken: (candidate) => Boolean(repo.getBridgeByPublicId(candidate)),
      });
      try {
        row = deps.repo.createBridge({
          publicId: handle,
          createdByUserId: actor,
          endACommunityId: community.id,
          endAChannelId: facts.id,
          direction: parsedDirection.direction,
          expiresAt,
          codeHash: minted.digest,
          nsfw: facts.nsfw === true,
          everyoneDeniedView: facts.everyoneDeniedView === true,
        });
      } catch (err) {
        if (err?.code === "bridge_public_id_taken") continue; // collision: mint fresh
        if (err?.code === "bridge_channel_taken") {
          // Raced with another create: re-read the winner and name it.
          const winner = channelOccupancyError(community.id, facts.id, surfaceCmd);
          return winner
            ? {
                ok: false,
                error:
                  winner.bridge.state === "pending"
                    ? BRIDGE_MESSAGES.pendingExists(
                        winner.bridge.public_id,
                        isoUtc(winner.bridge.expires_at),
                        surfaceCmd,
                      )
                    : winner.takenError,
              }
            : { ok: false, error: BRIDGE_MESSAGES.saveFailed(causeOf(err)) };
        }
        return { ok: false, error: BRIDGE_MESSAGES.saveFailed(causeOf(err)) };
      }
    }
    if (!row) {
      return { ok: false, error: BRIDGE_MESSAGES.saveFailed("handle collision on three attempts") };
    }

    audit(deps, {
      communityId: community.id,
      actorUserId: actor,
      action: "bridge.create",
      targetType: "channel",
      targetId: facts.id,
      details: {
        publicId: row.public_id,
        channel: facts.id,
        direction: parsedDirection.direction,
        communityIdB: null,
      },
    });

    return {
      ok: true,
      publicId: row.public_id,
      // The plaintext credential: handlers may show it ONLY in an ephemeral
      // reply / DM (spec §10.1). Never logged, never audited, never stored.
      code: minted.displayCode,
      expiresAt: Number(expiresAt),
      direction: parsedDirection.direction,
    };
  } catch (err) {
    // Programmer errors only (missing community/actor): surface them with the
    // save-failed copy so a handler reply is always actionable (rule 3).
    console.error("[bridge] createBridge failed:", causeOf(err));
    return { ok: false, error: BRIDGE_MESSAGES.saveFailed(causeOf(err)) };
  }
}

// ---------------------------------------------------------------------------
// connectBridge (activation order §10.7 steps 1–9; via:"guild" is the burn)
// ---------------------------------------------------------------------------

/**
 * The guild-paste burn (spec §10.1 "Guild-channel connect"): delete the
 * pending row + children in ONE transaction, matched on the code hash,
 * committing only when the parent delete changed exactly one row. Never
 * activates, never touches the failure counter, never creates a webhook.
 */
function burnPendingBridge(dbHandle, digest) {
  const selectByHash = dbHandle.prepare(
    `SELECT id, public_id, state FROM bridges WHERE code_hash = ?`,
  );
  const deleteChild = (table) =>
    dbHandle.prepare(`DELETE FROM ${table} WHERE bridge_id = ?`);
  const deleteParent = dbHandle.prepare(
    `DELETE FROM bridges WHERE id = ? AND state = 'pending'`,
  );

  const tx = dbHandle.transaction(() => {
    const row = selectByHash.get(digest);
    if (!row) return { burned: false, state: null, publicId: null };
    if (row.state !== "pending") {
      return { burned: false, state: row.state, publicId: row.public_id };
    }
    for (const table of ["bridge_src_snapshots", "bridge_message_links", "bridge_outbox", "bridge_ends"]) {
      deleteChild(table).run(row.id);
    }
    const result = deleteParent.run(row.id);
    if (result.changes !== 1) {
      // Lost the race to activate/disconnect: roll back the child deletes.
      throw new Error("__bridge_burn_lost__");
    }
    return { burned: true, state: "pending", publicId: row.public_id };
  });

  try {
    return tx();
  } catch (err) {
    if (String(err?.message) === "__bridge_burn_lost__") {
      return { burned: false, state: "racing", publicId: null };
    }
    throw err;
  }
}

/**
 * The §10.7 step-8 compare-and-swap: pending → active in ONE transaction,
 * inserting end B (and only then) when the swap won.
 */
function activateBridgeTx(
  dbHandle,
  { bridgeId, connectedAt, endB, endAWebhook, endAFlags = {} },
) {
  const swap = dbHandle.prepare(
    `UPDATE bridges SET state = 'active', connected_at = ? WHERE id = ? AND state = 'pending'`,
  );
  const insertEndB = dbHandle.prepare(
    `INSERT INTO bridge_ends (bridge_id, position, community_id, channel_id, nsfw, everyone_denied_view, webhook_id, webhook_token_enc)
     VALUES (?, 'b', ?, ?, ?, ?, ?, ?)`,
  );
  const patchEndA = dbHandle.prepare(
    `UPDATE bridge_ends SET webhook_id = ?, webhook_token_enc = ? WHERE bridge_id = ? AND position = 'a'`,
  );
  const flagEndA = dbHandle.prepare(
    `UPDATE bridge_ends SET nsfw = COALESCE(?, nsfw), everyone_denied_view = COALESCE(?, everyone_denied_view)
     WHERE bridge_id = ? AND position = 'a'`,
  );

  const tx = dbHandle.transaction(() => {
    const result = swap.run(connectedAt, bridgeId);
    if (result.changes !== 1) return { won: false };
    insertEndB.run(
      bridgeId,
      endB.communityId,
      String(endB.channelId),
      endB.nsfw ? 1 : 0,
      endB.everyoneDeniedView ? 1 : 0,
      endB.webhookId,
      endB.tokenEnc,
    );
    patchEndA.run(endAWebhook.webhookId, endAWebhook.tokenEnc, bridgeId);
    flagEndA.run(
      endAFlags.nsfw ? 1 : 0,
      endAFlags.everyoneDeniedView ? 1 : 0,
      bridgeId,
    );
    return { won: true };
  });
  return tx();
}

/**
 * Connect: consume a BRG- credential and pair the connect-side channel.
 * Fail-closed ordering per spec §10.7: every check that can reject happens
 * BEFORE any webhook create; the row stays pending on every pre-activation
 * failure. `via: "guild"` is the burn path (never activates, never counts).
 *
 * @param {object} args
 * @param {object} args.community connect-side communities row
 * @param {string|null} args.invocationChannelId invocation channel (null for DM)
 * @param {string} args.targetChannelId connect-side channel to pair
 * @param {string} args.rawCode the BRG- credential as typed
 * @param {string} args.actorUserId
 * @param {string} [args.surfaceCmd='/bridge']
 * @param {() => number} [args.clock]
 * @param {"slash"|"dm"|"guild"} [args.via='slash']
 * @param {object} [args.staff] { hasManageGuild, memberRoleIds }
 * @param {object} [args.deps]
 * @returns {Promise<object>}
 */
async function connectBridge({
  community,
  invocationChannelId = null,
  targetChannelId = null,
  rawCode = null,
  actorUserId = null,
  surfaceCmd = "/bridge",
  clock = () => Date.now(),
  via = "slash",
  staff = null,
  deps: depsIn = {},
  ...rest
} = {}) {
  void rest;
  const deps = defaultDeps(depsIn);
  const activateBridge = deps.activateBridge ?? null;
  try {
    if (!isCommunityRow(community)) {
      throw new TypeError("connectBridge: community must be a communities row (resolved by the edge)");
    }
    assertCommunityId(community.id);
    if (!["slash", "dm", "guild"].includes(via)) {
      throw new TypeError(`connectBridge: unknown via "${String(via)}"`);
    }
    const actor = String(actorUserId ?? "").trim();
    if (!actor) throw new TypeError("connectBridge: actorUserId is required");

    const classify = codes.classifyConnectInput(rawCode);
    if (classify.kind === "handle") {
      return { ok: false, error: BRIDGE_MESSAGES.handlePassedToConnect(classify.publicId) };
    }
    if (classify.kind === "empty") {
      return { ok: false, error: BRIDGE_MESSAGES.expiredOrUnknown(surfaceCmd) };
    }
    if (classify.kind === "garbage") {
      // Alphabet garbage: specific sentence, and it NEVER counts toward the
      // per-community failure counter (spec §10.1).
      return { ok: false, error: BRIDGE_MESSAGES.alphabetGarbage };
    }

    // ---- The guild-paste burn path (spec §10.1) — not staff-gated: anyone's
    // paste must be able to burn the code. No counter, no activation.
    if (via === "guild") {
      const digest = codes.hashConnectCode(classify.canonical);
      const outcome = burnPendingBridge(deps.db, digest);
      if (outcome.burned) {
        return {
          ok: true,
          burned: true,
          publicId: outcome.publicId,
          message: BRIDGE_MESSAGES.burnReply(surfaceCmd),
        };
      }
      if (outcome.publicId != null) {
        // Row exists and is not pending (active/broken): the code was spent.
        return { ok: false, error: BRIDGE_MESSAGES.alreadyUsed(outcome.publicId) };
      }
      // No row at all (or a race): the paste matched nothing pending.
      return {
        ok: false,
        error: outcome.state === "racing"
          ? BRIDGE_MESSAGES.alreadyUsed("the raced bridge")
          : BRIDGE_MESSAGES.expiredOrUnknown(surfaceCmd),
      };
    }

    // ---- Activation path (via "slash" | "dm").
    if (!staffPermits(community.id, staff)) return { ok: false, error: MSG_DENIED };
    if (!commandChannelsPermit(community.id, invocationChannelId)) {
      return { ok: false, error: "Commands aren't enabled in this channel." };
    }

    // Rate limit (step 1): a locked community gets the counter sentence for
    // every well-formed attempt until the 10-minute window passes.
    const counter = repo.getBridgeConnectState(community.id, { nowMs: clock() });
    if (counter.locked) return { ok: false, error: BRIDGE_MESSAGES.tooManyMisses };

    const recordMiss = () => {
      // §10.1: the counter applies to slash and DM connects only.
      if (via !== "slash" && via !== "dm") return;
      try {
        repo.recordBridgeConnectMiss(community.id, { nowMs: clock() });
      } catch (err) {
        console.error("[bridge] connect-miss counter failed:", causeOf(err));
      }
    };

    // Target facts (view/type/honeypot on the connect side).
    const probed = await probeTargetChannel(deps, {
      community,
      channelId: targetChannelId,
    });
    if (!probed.ok) return probed;
    const factsB = probed.facts;

    // Credential lookup: the stored row is resolved by SHA-256(digest),
    // compared by the repository's exact code_hash lookup + timingSafeEqual
    // inside digestsEqual for the read-back (defence in depth vs. SQLite
    // BLOB comparison).
    const digest = codes.hashConnectCode(classify.canonical);
    const bridge = repo.getBridgeByCodeHash(digest);
    if (!bridge) {
      recordMiss();
      return { ok: false, error: BRIDGE_MESSAGES.expiredOrUnknown(surfaceCmd) };
    }
    if (!codes.digestsEqual(bridge.code_hash, digest)) {
      recordMiss();
      return { ok: false, error: BRIDGE_MESSAGES.expiredOrUnknown(surfaceCmd) };
    }
    if (bridge.state !== "pending") {
      // Already used (active) or broken: terminal for this input; not a miss.
      return { ok: false, error: BRIDGE_MESSAGES.alreadyUsed(bridge.public_id) };
    }

    // End A (the create side) + its community.
    const ends = repo.listBridgeEnds(bridge.id);
    const endA = ends.find((e) => e.position === "a");
    if (!endA) {
      console.error(
        `[bridge] connect: pending bridge ${bridge.public_id} (id=${bridge.id}) has no end A — data corruption`,
      );
      return {
        ok: false,
        error: `Bridge ${bridge.public_id} is missing its create-side end in the database. Run ${surfaceCmd} disconnect to clear it, then create a new code.`,
      };
    }
    const communityA = getCommunityById(endA.community_id);
    if (!isCommunityRow(communityA)) {
      return {
        ok: false,
        error: `The create side of bridge ${bridge.public_id} points at a community that no longer exists. Run ${surfaceCmd} disconnect to clear it, then create a new code.`,
      };
    }

    // Cross-platform rule (KD 2): same-platform connect is a specific error
    // and does NOT consume the code or count as a miss.
    if (communityA.platform === community.platform) {
      return { ok: false, error: BRIDGE_MESSAGES.samePlatform(platformLabel(communityA.platform), surfaceCmd) };
    }

    // Expiry — connect enforces it itself (spec §10.1).
    const nowMs = clock();
    if (bridge.expires_at != null && nowMs >= Number(bridge.expires_at)) {
      return { ok: false, error: BRIDGE_MESSAGES.expiredOrUnknown(surfaceCmd) };
    }

    // 1:1 on the connect side.
    const existingB = repo.getBridgeEndForChannel(community.id, factsB.id);
    if (existingB) {
      const occupant = repo.getBridgeById(existingB.bridge_id);
      return {
        ok: false,
        error: BRIDGE_MESSAGES.destinationTaken(occupant ? occupant.public_id : String(existingB.bridge_id)),
      };
    }

    // ---- Steps 3–4: key, then clients. All fail before any webhook create;
    // the code stays pending in every case.
    if (!tokenCrypto.hasBridgeTokenKey({ keyGetter: deps.keyGetter })) {
      return { ok: false, error: BRIDGE_MESSAGES.keyMissing };
    }

    const apiB = webhookApiForCommunity(deps, community);
    const apiA = webhookApiForCommunity(deps, communityA);
    if (!apiB) {
      return {
        ok: false,
        error:
          community.platform === "fluxer"
            ? BRIDGE_MESSAGES.fluxerClientAbsent(community.instanceKey)
            : BRIDGE_MESSAGES.discordClientAbsent,
      };
    }
    if (!apiA) {
      return {
        ok: false,
        error:
          communityA.platform === "fluxer"
            ? BRIDGE_MESSAGES.fluxerClientAbsent(communityA.instanceKey)
            : BRIDGE_MESSAGES.discordClientAbsent,
      };
    }

    // ---- Step 5: bot permission probe on BOTH channels (target facts are
    // in hand; resolve the create-side channel now).
    const resolvedA = await fetchChannelFacts(deps, communityA, endA.channel_id, "resolveChannel");
    if (!resolvedA.ok) return resolvedA;
    const factsA = resolvedA.facts;

    const missingB = missingBotPermNames(factsB.botPermissions);
    if (missingB === null) {
      return { ok: false, error: BRIDGE_MESSAGES.botPermsUnreadable(factsB.id, "the platform returned no permission data") };
    }
    if (missingB.length > 0) {
      return { ok: false, error: BRIDGE_MESSAGES.botMissingPerms(missingB, surfaceCmd) };
    }
    const missingA = missingBotPermNames(factsA.botPermissions);
    if (missingA === null) {
      return { ok: false, error: BRIDGE_MESSAGES.botPermsUnreadable(factsA.id, "the platform returned no permission data") };
    }
    if (missingA.length > 0) {
      return { ok: false, error: BRIDGE_MESSAGES.botMissingPerms(missingA, surfaceCmd) };
    }

    // ---- Step 2 (captured for the warning lines): NSFW + @everyone view.
    const warnings = [];
    const nsfwA = factsA.nsfw === true;
    const nsfwB = factsB.nsfw === true;
    if (nsfwA !== nsfwB) {
      warnings.push(
        "Warning: one end is age-restricted or NSFW and the other is not. Messages and files will be copied into the less restricted channel.",
      );
    }
    const privateA = factsA.everyoneDeniedView === true;
    const privateB = factsB.everyoneDeniedView === true;
    if (privateA !== privateB) {
      warnings.push(
        "Warning: one end is hidden from @everyone and the other is not. People in the more open channel will be able to read messages from the restricted one.",
      );
    }

    // ---- Step 5 → 6 gate (KD 22): without an injected activator this build
    // cannot relay, so connect refuses BEFORE any webhook create. The row
    // stays pending and the code stays usable (spec §10.7 fail-closed order).
    if (!activateBridge) {
      return { ok: false, error: MSG_RELAY_NOT_WIRED };
    }

    // ---- Step 6: create webhook B, then A. On any failure: delete what this
    // attempt created and leave the row pending (step 7).
    const created = [];
    const cleanupCreated = async () => {
      for (const entry of created) {
        await bestEffortDeleteWebhook(entry.api, entry.webhook);
      }
    };

    const madeB = await apiB.createRelayWebhook(community.id, factsB.id, {
      name: RELAY_WEBHOOK_NAME,
    });
    if (!madeB || madeB.ok !== true) {
      await cleanupCreated();
      return { ok: false, error: webhookCreateError(community.platform, madeB, surfaceCmd) };
    }
    created.push({ api: apiB, webhook: madeB.webhook });

    const madeA = await apiA.createRelayWebhook(communityA.id, factsA.id, {
      name: RELAY_WEBHOOK_NAME,
    });
    if (!madeA || madeA.ok !== true) {
      await cleanupCreated();
      return { ok: false, error: webhookCreateError(communityA.platform, madeA, surfaceCmd) };
    }
    created.push({ api: apiA, webhook: madeA.webhook });

    // Encrypt both tokens BEFORE the transaction: a key that vanished between
    // the step-3 check and here must not leave a half-activated bridge.
    const tokenEncB = tokenCrypto.encryptWebhookToken(madeB.webhook.token, { keyGetter: deps.keyGetter });
    const tokenEncA = tokenCrypto.encryptWebhookToken(madeA.webhook.token, { keyGetter: deps.keyGetter });
    if (tokenEncB == null || tokenEncA == null) {
      await cleanupCreated();
      return { ok: false, error: BRIDGE_MESSAGES.keyMissing };
    }

    // ---- Step 8: the compare-and-swap. Only the winner writes end B.
    const activation = activateBridge
      ? await activateBridge(deps.db, {
          bridgeId: bridge.id,
          connectedAt: nowMs,
          endB: {
            communityId: community.id,
            channelId: factsB.id,
            nsfw: nsfwB,
            everyoneDeniedView: privateB,
            webhookId: String(madeB.webhook.id),
            tokenEnc: tokenEncB,
          },
          endAWebhook: {
            webhookId: String(madeA.webhook.id),
            tokenEnc: tokenEncA,
          },
          endAFlags: { nsfw: nsfwA, everyoneDeniedView: privateA },
        })
      : { won: false, reason: "not wired" };

    if (!activation || activation.won !== true) {
      // Step 9: lost the swap — delete both webhooks, insert no end.
      await cleanupCreated();
      if (activation && activation.reason) {
        console.error(`[bridge] connect ${bridge.public_id}: activation not wired (${activation.reason})`);
      }
      return {
        ok: false,
        error:
          activation && activation.reason
            ? MSG_RELAY_NOT_WIRED
            : BRIDGE_MESSAGES.lostPendingRow(surfaceCmd),
      };
    }

    // Success bookkeeping: spent credential counter clears; relay gate maps
    // refresh so the new end's webhook id is gated immediately.
    try {
      repo.clearBridgeConnectAttempts(community.id);
    } catch (err) {
      console.error("[bridge] clearing connect counter failed:", causeOf(err));
    }
    relay.registerRelayWebhookId(community.platform, community.instanceKey, String(madeB.webhook.id));
    relay.registerRelayWebhookId(communityA.platform, communityA.instanceKey, String(madeA.webhook.id));

    // ---- Audit (KD 23): one row per community, never a secret.
    const detailsB = {
      publicId: bridge.public_id,
      channel: factsB.id,
      direction: bridge.direction,
      communityIdB: communityA.id,
    };
    audit(deps, {
      communityId: community.id,
      actorUserId: actor,
      action: "bridge.connect",
      targetType: "channel",
      targetId: factsB.id,
      details: detailsB,
    });
    audit(deps, {
      communityId: communityA.id,
      actorUserId: actor,
      action: "bridge.connect",
      targetType: "channel",
      targetId: String(endA.channel_id),
      details: {
        publicId: bridge.public_id,
        channel: String(endA.channel_id),
        direction: bridge.direction,
        communityIdB: community.id,
      },
    });

    return {
      ok: true,
      publicId: bridge.public_id,
      direction: bridge.direction,
      directionLabel: directionLabel(bridge.direction, communityA.platform, community.platform),
      warnings,
      // The peer seen from the invoker's side: end A (the create side).
      peer: {
        platform: communityA.platform,
        platformLabel: platformLabel(communityA.platform),
        instanceKey: communityA.instanceKey,
        channelId: String(endA.channel_id),
      },
    };
  } catch (err) {
    console.error("[bridge] connectBridge failed:", causeOf(err));
    return {
      ok: false,
      error: BRIDGE_MESSAGES.saveFailed(causeOf(err)),
    };
  }
}

// ---------------------------------------------------------------------------
// disconnectBridge
// ---------------------------------------------------------------------------

/**
 * Destroy a bridge from either side (spec §10.10 "Disconnect"): explicit
 * child-then-parent delete, best-effort webhook deletes after the commit,
 * the "no longer copied" notice in every sendable channel, one audit row per
 * community. Webhook-delete failure NEVER restores the row.
 *
 * @param {object} args
 * @param {object} args.community invoker's communities row
 * @param {string|null} [args.invocationChannelId]
 * @param {string|null} [args.targetChannelId] resolve by local channel
 * @param {string|null} [args.publicId] resolve by handle (wins over channel)
 * @param {string} args.actorUserId
 * @param {string} [args.surfaceCmd='/bridge']
 * @param {object} [args.staff]
 * @param {object} [args.deps]
 * @returns {Promise<object>}
 */
async function disconnectBridge({
  community,
  invocationChannelId = null,
  targetChannelId = null,
  publicId = null,
  actorUserId = null,
  surfaceCmd = "/bridge",
  staff = null,
  deps: depsIn = {},
} = {}) {
  const deps = defaultDeps(depsIn);
  try {
    if (!isCommunityRow(community)) {
      throw new TypeError("disconnectBridge: community must be a communities row");
    }
    assertCommunityId(community.id);
    if (!staffPermits(community.id, staff)) return { ok: false, error: MSG_DENIED };
    if (!commandChannelsPermit(community.id, invocationChannelId)) {
      return { ok: false, error: "Commands aren't enabled in this channel." };
    }

    const handle = publicId != null ? codes.normalizeHandle(publicId) : "";
    let bridge = null;
    if (handle !== "") {
      bridge = repo.getBridgeByPublicId(handle);
      if (bridge) {
        // Handle scoping: a staff member on community X must not tear down a
        // bridge they cannot see. The bridge must touch this community.
        const endsForHandle = repo.listBridgeEnds(bridge.id);
        if (!endsForHandle.some((e) => e.community_id === community.id)) bridge = null;
      }
    } else if (targetChannelId != null && String(targetChannelId).trim() !== "") {
      const pair = repo.getBridgeForChannel(community.id, String(targetChannelId).trim());
      bridge = pair ? pair.bridge : null;
    }

    if (!bridge) {
      return { ok: false, error: BRIDGE_MESSAGES.disconnectNone(surfaceCmd) };
    }

    const ends = repo.listBridgeEnds(bridge.id);
    const actor = String(actorUserId ?? "").trim();

    // One transaction, children then parent (the 034 lesson lives in the
    // repository helper: an orphan end pins UNIQUE (community_id, channel_id)).
    const counts = deps.repo.deleteBridgeCascade(bridge.id);
    if (!counts || !counts.bridges) {
      return { ok: false, error: BRIDGE_MESSAGES.disconnectNone(surfaceCmd) };
    }

    // Post-commit best effort: webhook deletes, notices, audit, gate refresh.
    const warnings = [];
    for (const end of ends) {
      const endCommunity = getCommunityById(end.community_id);
      const api = endCommunity ? webhookApiForCommunity(deps, endCommunity) : null;
      if (end.webhook_id != null && end.webhook_token_enc != null) {
        if (api && typeof api.deleteRelayWebhook === "function") {
          let token = null;
          try {
            token = tokenCrypto.decryptWebhookToken(end.webhook_token_enc, {
              keyGetter: deps.keyGetter,
            });
          } catch (err) {
            // Key rotated/missing: the row is already gone; tell staff where
            // to sweep the orphan webhook (spec §10.10 sentence shape).
            warnings.push(
              `Disconnected bridge ${bridge.public_id}, but the webhook on the ${endCommunity ? platformLabel(endCommunity.platform) : "remote"} end could not be deleted: ${causeOf(err)}. Delete the webhook named "Boiler Snake Bridge" in that channel's webhook settings.`,
            );
          }
          if (token != null) {
            try {
              const res = await api.deleteRelayWebhook({ id: String(end.webhook_id), token });
              if (res && res.ok === false) {
                warnings.push(
                  `Disconnected bridge ${bridge.public_id}, but the webhook on the ${endCommunity ? platformLabel(endCommunity.platform) : "remote"} end could not be deleted: ${res.error}. Delete the webhook named "Boiler Snake Bridge" in that channel's webhook settings.`,
                );
              }
            } catch (err) {
              warnings.push(
                `Disconnected bridge ${bridge.public_id}, but the webhook on the ${endCommunity ? platformLabel(endCommunity.platform) : "remote"} end could not be deleted: ${causeOf(err)}. Delete the webhook named "Boiler Snake Bridge" in that channel's webhook settings.`,
              );
            }
          }
        }
      }
      // In-channel notice: handle + state only, never a foreign id (§10.10).
      try {
        const sent = await deps.sendMessage(
          end.community_id,
          String(end.channel_id),
          `Bridge ${bridge.public_id} disconnected. Messages are no longer copied.`,
        );
        if (sent && sent.ok === false) {
          console.error(
            `[bridge] disconnect notice failed for ${platformLabel(endCommunity?.platform)} channel ${end.channel_id}: ${sent.error}`,
          );
        }
      } catch (err) {
        console.error(
          `[bridge] disconnect notice threw for community ${end.community_id} channel ${end.channel_id}:`,
          causeOf(err),
        );
      }
      // Audit row for this end's community.
      audit(deps, {
        communityId: end.community_id,
        actorUserId: actor || null,
        origin: actor ? "slash" : "system",
        action: "bridge.disconnect",
        targetType: "channel",
        targetId: String(end.channel_id),
        details: {
          publicId: bridge.public_id,
          channel: String(end.channel_id),
          direction: bridge.direction,
          communityIdB: ends
            .filter((e) => e.community_id !== end.community_id)
            .map((e) => e.community_id)[0] ?? null,
        },
      });
    }

    relay.refreshRelayMaps();

    return { ok: true, publicId: bridge.public_id, warnings };
  } catch (err) {
    console.error("[bridge] disconnectBridge failed:", causeOf(err));
    return { ok: false, error: BRIDGE_MESSAGES.saveFailed(causeOf(err)) };
  }
}

// ---------------------------------------------------------------------------
// statusBridge / listBridges (sync — spec §"Service")
// ---------------------------------------------------------------------------

/**
 * The staff-visible status row shape (spec § Observability: state, direction,
 * last_error, outbox depth per direction, spool bytes, and the ends'
 * platform/instance/channel ids). PR 6 keeps lastError in the shape (the
 * worker records it on every poison park — edits AND deletes — and the
 * handlers render it) and reports the REAL spool bytes from media's
 * accounting (statusBridge/list share this one builder, so list rows show
 * the same state as status).
 * @param {object} bridge bridges row
 * @param {object[]} ends bridge_ends rows
 * @returns {object}
 */
function describeBridge(bridge, ends) {
  const items = {
    publicId: bridge.public_id,
    state: bridge.state,
    direction: bridge.direction,
    lastError: bridge.last_error ?? null,
    connectedAt: bridge.connected_at ?? null,
    expiresAt: bridge.expires_at ?? null,
    outboxDepth: { a_to_b: 0, b_to_a: 0 },
    // Spool bytes on disk for this bridge (spec § Observability; media's
    // in-process accounting, refreshed from disk at start).
    spoolBytes: 0,
    ends: ends.map((end) => {
      const endCommunity = getCommunityById(end.community_id);
      return {
        position: end.position,
        communityId: end.community_id,
        platform: endCommunity?.platform ?? "unknown",
        instanceKey: endCommunity?.instanceKey ?? "unknown",
        channelId: String(end.channel_id),
      };
    }),
  };
  try {
    items.outboxDepth = repo.countOutboxDepth(bridge.id);
  } catch (err) {
    console.error(`[bridge] outbox depth for ${bridge.public_id} failed:`, causeOf(err));
  }
  // Spool bytes: media's process accounting (pure read — the bridge public
  // id is the accounting key, spec §10.8 caps are per bridge).
  items.spoolBytes = media.spoolUsageSnapshot(bridge.public_id).bridgeBytes ?? 0;
  const pa = items.ends.find((e) => e.position === "a")?.platform;
  const pb = items.ends.find((e) => e.position === "b")?.platform;
  items.directionLabel = directionLabel(bridge.direction, pa, pb);
  return items;
}

/**
 * Staff-facing status for one bridge (by handle or by local channel) or,
 * with neither, every bridge touching the community.
 *
 * @param {object} args
 * @param {object} args.community
 * @param {string|null} [args.invocationChannelId]
 * @param {string|null} [args.targetChannelId]
 * @param {string|null} [args.publicId]
 * @param {string} [args.surfaceCmd='/bridge']
 * @param {object} [args.staff]
 * @param {object} [args.deps]
 * @returns {{ ok: boolean, error?: string, items?: object[] }}
 */
function statusBridge({
  community,
  invocationChannelId = null,
  targetChannelId = null,
  publicId = null,
  surfaceCmd = "/bridge",
  staff = null,
  deps: depsIn = {},
} = {}) {
  const deps = defaultDeps(depsIn);
  try {
    if (!isCommunityRow(community)) {
      throw new TypeError("statusBridge: community must be a communities row");
    }
    // status/list are staff-tier on both platforms (KD 4) — including the
    // allow-list gate on the invocation channel.
    if (!staffPermits(community.id, staff)) return { ok: false, error: MSG_DENIED };
    if (!commandChannelsPermit(community.id, invocationChannelId)) {
      return { ok: false, error: "Commands aren't enabled in this channel." };
    }

    const handle = publicId != null ? codes.normalizeHandle(publicId) : "";
    let bridges = [];
    if (handle !== "") {
      const bridge = repo.getBridgeByPublicId(handle);
      if (!bridge) {
        return {
          ok: false,
          error: `No bridge ${handle} found in this community. Use ${surfaceCmd} list to see the bridges here.`,
        };
      }
      const ends = repo.listBridgeEnds(bridge.id);
      if (!ends.some((e) => e.community_id === community.id)) {
        return {
          ok: false,
          error: `Bridge ${handle} is not connected to this community. Use ${surfaceCmd} list to see the bridges here.`,
        };
      }
      bridges = [{ bridge, ends }];
    } else if (targetChannelId != null && String(targetChannelId).trim() !== "") {
      const pair = repo.getBridgeForChannel(community.id, String(targetChannelId).trim());
      if (!pair) return { ok: false, error: BRIDGE_MESSAGES.disconnectNone(surfaceCmd) };
      bridges = [{ bridge: pair.bridge, ends: repo.listBridgeEnds(pair.bridge.id) }];
    } else {
      const byId = new Map();
      for (const row of repo.listBridgesForCommunity(community.id)) {
        byId.set(row.bridge.id, row.bridge);
      }
      bridges = [...byId.values()].map((bridge) => ({ bridge, ends: repo.listBridgeEnds(bridge.id) }));
    }

    return {
      ok: true,
      items: bridges.map(({ bridge, ends }) => describeBridge(bridge, ends)),
    };
  } catch (err) {
    console.error("[bridge] statusBridge failed:", causeOf(err));
    return { ok: false, error: BRIDGE_MESSAGES.saveFailed(causeOf(err)) };
  }
}

/**
 * Every bridge touching a community (staff surfaces only; the foreign ids in
 * each item are safe to show to staff of that community — every end listed
 * touches it).
 *
 * @param {object} args
 * @param {object} args.community
 * @param {string|null} [args.invocationChannelId]
 * @param {string} [args.surfaceCmd='/bridge']
 * @param {object} [args.staff]
 * @param {object} [args.deps]
 * @returns {{ ok: boolean, error?: string, items?: object[] }}
 */
function listBridges({
  community,
  invocationChannelId = null,
  surfaceCmd = "/bridge",
  staff = null,
  deps: depsIn = {},
} = {}) {
  const deps = defaultDeps(depsIn);
  void surfaceCmd;
  try {
    if (!isCommunityRow(community)) {
      throw new TypeError("listBridges: community must be a communities row");
    }
    if (!staffPermits(community.id, staff)) return { ok: false, error: MSG_DENIED };
    if (!commandChannelsPermit(community.id, invocationChannelId)) {
      return { ok: false, error: "Commands aren't enabled in this channel." };
    }

    const byId = new Map();
    for (const row of repo.listBridgesForCommunity(community.id)) {
      byId.set(row.bridge.id, row.bridge);
    }
    const items = [...byId.values()].map((bridge) =>
      describeBridge(bridge, repo.listBridgeEnds(bridge.id)),
    );
    return { ok: true, items, emptyMessage: BRIDGE_MESSAGES.listNone };
  } catch (err) {
    console.error("[bridge] listBridges failed:", causeOf(err));
    return { ok: false, error: BRIDGE_MESSAGES.saveFailed(causeOf(err)) };
  }
}

module.exports = {
  BRIDGE_MESSAGES,
  RELAY_WEBHOOK_NAME,
  createBridge,
  connectBridge,
  disconnectBridge,
  statusBridge,
  listBridges,
  commandChannelsPermit,
  // exported for tests (real §10.7 step-8 activator) and the PR 7 wiring:
  activateBridgeTx,
  normalizeCreateDirection,
  directionLabel,
  platformLabel,
  hasBit,
  missingBotPermNames,
};
