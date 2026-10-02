/**
 * Bridge pipeline gates + enqueue + the at-least-once relay worker
 * (roadmap/bridge.md §10.4, §10.5, §10.6, §10.7, §10.8, §10.10, §10.12).
 *
 * PR 4 shipped the gates and the enqueue (outbox row, metadata payload).
 * PR 5 adds media spool-at-enqueue, the outbound ports, and the worker:
 * FIFO per direction, one in-flight per direction, 4-wide process cap, 429
 * at the head, backoff 1/2/4/8/16 s, poison park at 5 attempts with the
 * source-channel notice, Fluxer nonce + wait=true, id-synchronous commit on
 * Discord, ack-then-delete, and the start-time orphan-spool pass.
 *
 * NOTHING here is wired to boot (KD 22): startBridgeLoops is EXPORTED with
 * the start(supervisor, ctx) shape for the activation PR (PR 7) to register,
 * and no production path calls it in this build. The outbox keeps growing;
 * nothing sends.
 *
 * State model (spec §10.4 "Loops", §10.10 "Restart"):
 *   - relay-webhook ids and echo ids are per-DEPLOYMENT slices keyed
 *     `${platform}:${instanceKey}` — snowflakes are unique only inside one
 *     deployment, and a human on Discord may share a Fluxer webhook's id.
 *   - the destination-id map is process-local with a 10-minute TTL (it covers
 *     in-flight echoes only; the echo set survives reloads from SQLite).
 *
 * Like mentions.js, this module imports neither discord.js nor the Fluxer
 * SDK core package (needle-name spelled out per the SDK import guard):
 * parsePrefix and snowflakeTimeMs are SDK-free adapter modules, and the
 * outbound ports take the adapter api as injected seams.
 */

const crypto = require("crypto");
const { parsePrefix } = require("../../platform/fluxer/commands");
const { snowflakeTimeMs } = require("../../platform/snowflake");
const { neutralizeContent, NO_PING } = require("./mentions");
const { sliceSafe } = require("../../core/text");
const media = require("./media");
const { createFluxerBridgeOutbound } = require("./fluxerOutbound");
const { createDiscordBridgeOutbound } = require("./discordOutbound");
const { getCommunityById } = require("../../platform/community");

/** Destination-id map TTL (spec §10.4: TTL 10 minutes). */
const DESTINATION_TTL_MS = 10 * 60 * 1000;

/** Grace applied to the connected_at comparison (spec §10.5: 2000 ms). */
const CONNECT_GRACE_MS = 2000;

/** Relayable source message types (spec §10.5: DEFAULT and REPLY only;
 *  Fluxer type 6 = voice messages, which §10.8 copies as a plain attachment
 *  with the `Voice message` caption — Discord's type 6 is the legacy reply
 *  and is NOT relayed). */
const RELAYABLE_TYPES = new Set([0, 19]);
const FLUXER_VOICE_TYPE = 6;

function isRelayableType(platform, type) {
  if (type == null) return true;
  if (RELAYABLE_TYPES.has(type)) return true;
  return platform === "fluxer" && type === FLUXER_VOICE_TYPE;
}

/**
 * Per-deployment state. Every map key is deploymentKey(platform, instanceKey).
 * @type {Map<string, Set<string>>} deployment → relay webhook ids
 */
const relayWebhookIds = new Map();
/** @type {Map<string, Set<string>>} deployment → relayed destination message ids (echo gate) */
const echoMessageIds = new Map();
/** @type {Map<string, string>} deployment → this deployment's bot user id */
const botUserIds = new Map();
/** @type {Map<string, Map<string, number>>} deployment → (message id → expiry ms) */
const destinationIds = new Map();

/**
 * @param {string|null|undefined} platform
 * @param {string|null|undefined} instanceKey
 * @returns {string}
 */
function deploymentKey(platform, instanceKey) {
  return `${String(platform ?? "unknown")}:${String(instanceKey ?? "default")}`;
}

function setFor(map, key) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

/** destinationIds holds id → expiry maps (not Sets); same lazy-key pattern. */
function destMapFor(map, key) {
  let m = map.get(key);
  if (!m) {
    m = new Map();
    map.set(key, m);
  }
  return m;
}

/**
 * Parse a Fluxer line as a prefix command WITHOUT pulling `./commands` (and
 * with it discord.js) into this module's runtime graph: parsePrefix's default
 * tree is the default registry, which already contains the bridge command
 * (src/features/index.js manifest). The tree is built lazily and cached
 * inside the platform adapter.
 * @param {string} content
 * @returns {object|null} ParsedCommand
 */
function parseBridgeLine(content) {
  return parsePrefix(content);
}

/**
 * (Re)load the relay-webhook map and echo-gate set from SQLite (spec §10.4:
 * "Reload the map from bridge_ends at loop start; update one deployment's
 * slice on connect, disconnect, and webhook recreate"). The service calls
 * refreshRelayMaps() after connect/disconnect; the worker (PR 5) reloads at
 * start.
 *
 * @param {{ repo?: object, db?: object }} [deps]
 * @returns {{ webhooks: number, echoes: number }} loaded entry counts
 */
function reloadRelayMaps(deps = {}) {
  const db = deps.db ?? require("../../db/connection").db;
  const rows = db
    .prepare(
      `SELECT c.platform AS platform, c.instance_key AS instance_key, e.webhook_id AS webhook_id
       FROM bridge_ends e
       JOIN communities c ON c.id = e.community_id
       JOIN bridges b ON b.id = e.bridge_id
       WHERE b.state = 'active' AND e.webhook_id IS NOT NULL`,
    )
    .all();
  const echoRows = db
    .prepare(
      `SELECT c.platform AS platform, c.instance_key AS instance_key, l.dst_message_id AS dst_message_id
       FROM bridge_message_links l
       JOIN bridge_ends src ON src.bridge_id = l.bridge_id AND src.community_id = l.src_community_id
       JOIN bridge_ends dst ON dst.bridge_id = l.bridge_id AND dst.community_id <> l.src_community_id
       JOIN communities c ON c.id = dst.community_id`,
    )
    .all();

  const nextWebhooks = new Map();
  for (const row of rows) {
    const key = deploymentKey(row.platform, row.instance_key);
    setFor(nextWebhooks, key).add(String(row.webhook_id));
  }
  const nextEchoes = new Map();
  for (const row of echoRows) {
    const key = deploymentKey(row.platform, row.instance_key);
    setFor(nextEchoes, key).add(String(row.dst_message_id));
  }

  relayWebhookIds.clear();
  for (const [key, set] of nextWebhooks) relayWebhookIds.set(key, set);
  echoMessageIds.clear();
  for (const [key, set] of nextEchoes) echoMessageIds.set(key, set);
  return { webhooks: rows.length, echoes: echoRows.length };
}

/** Reload from SQLite; never throws (gate state is best-effort cache). */
function refreshRelayMaps() {
  try {
    return reloadRelayMaps();
  } catch (err) {
    console.error("[bridge] relay map reload failed:", err?.message || err);
    return null;
  }
}

/**
 * Record one relay webhook id for a deployment (connect step; tests wire the
 * gate directly).
 * @param {string} platform
 * @param {string} instanceKey
 * @param {string} webhookId
 */
function registerRelayWebhookId(platform, instanceKey, webhookId) {
  if (webhookId == null) return;
  setFor(relayWebhookIds, deploymentKey(platform, instanceKey)).add(String(webhookId));
}

/**
 * Record the deployment's bot user id (bot-authored notices die at the gate).
 * @param {string} platform
 * @param {string} instanceKey
 * @param {string} userId
 */
function setBotUserId(platform, instanceKey, userId) {
  if (userId == null) return;
  botUserIds.set(deploymentKey(platform, instanceKey), String(userId));
}

/**
 * Register a destination message id after a relay send (spec §10.4: insert
 * the execute id under that deployment BEFORE yielding to the gateway). The
 * id joins the create-gate destination map (TTL) and the update/delete echo
 * set (persisted — the durable half is bridge_message_links, reloaded by
 * reloadRelayMaps).
 *
 * @param {string} platform
 * @param {string} instanceKey
 * @param {string} messageId
 * @param {{ ttlMs?: number, nowMs?: number }} [opts]
 */
function noteRelayedDestination(platform, instanceKey, messageId, opts = {}) {
  if (messageId == null) return;
  const key = deploymentKey(platform, instanceKey);
  const ttl = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DESTINATION_TTL_MS;
  const nowMs = opts.nowMs ?? Date.now();
  destMapFor(destinationIds, key).set(String(messageId), nowMs + ttl);
  setFor(echoMessageIds, key).add(String(messageId));
}

/** Drop all in-memory state (tests; a restart starts empty, spec §10.10). */
function clearRelayState() {
  relayWebhookIds.clear();
  echoMessageIds.clear();
  destinationIds.clear();
  botUserIds.clear();
}

/**
 * True when a MESSAGE_UPDATE / MESSAGE_DELETE for this id is the echo of our
 * own relayed copy (KD 10). The id is matched only within its own deployment.
 *
 * @param {string|null|undefined} platform
 * @param {string|null|undefined} instanceKey
 * @param {string|null|undefined} messageId
 * @returns {boolean}
 */
function isRelayedEcho(platform, instanceKey, messageId) {
  if (messageId == null) return false;
  const set = echoMessageIds.get(deploymentKey(platform, instanceKey));
  return !!set && set.has(String(messageId));
}

/**
 * Test seam: the destination-id map entry for one deployment+message id —
 * the stored expiry timestamp, or undefined when the id is not registered.
 * (The map is the create-gate's in-flight window, spec §10.4.)
 * @param {string} platform
 * @param {string} instanceKey
 * @param {string} [messageId]
 * @returns {number|undefined}
 */
function isRelayedDestinationForTest(platform, instanceKey, messageId) {
  const map = destinationIds.get(deploymentKey(platform, instanceKey));
  if (!map || messageId == null) return undefined;
  return map.get(String(messageId));
}

/**
 * True when a Fluxer GUILD message's content parses as a `bridge` prefix
 * command line (spec §10.4, KD 17). Command traffic, not chat: the pipeline
 * dispatches it through the shipped dispatcher EXACTLY ONCE (the registry
 * handler is the single entry) while skipping cache/gork/enqueue/activity/XP.
 * The gate itself must NOT swallow the line — dropping it here would leave
 * the dispatcher without its one dispatch (spec: "One dispatch per line").
 *
 * @param {object} message NormalizedMessage
 * @returns {boolean}
 */
function isBridgeCommandLine(message) {
  try {
    if (!message || typeof message !== "object") return false;
    if (message.platform !== "fluxer" || !message.externalGuildId) return false;
    const parsed = parseBridgeLine(String(message.content ?? ""));
    return !!parsed && parsed.commandName === "bridge";
  } catch (err) {
    // Detection is advisory: a parser fault means "not a bridge line", and
    // normal pipeline handling continues.
    console.error("[bridge] command-line detection failed:", err?.message || err);
    return false;
  }
}

/**
 * The create loop gate (spec §10.4) — the FIRST check in onMessageCreate.
 * Returns true when the message must be dropped (no cache, no gork, no XP,
 * no activity, no enqueue).
 *
 * Human-authored `bridge` command lines are NOT dropped here: the pipeline
 * dispatches them once through the shipped dispatcher (isBridgeCommandLine
 * below); bot/echo-authored command lines die at the author rules above the
 * dispatch branch.
 *
 * A gate bug must never silence a human: any internal throw logs and returns
 * false (let the message through) — the relay path's own defenses are
 * defense-in-depth (§10.6).
 *
 * @param {object} message NormalizedMessage
 * @param {{ platform?: string, instanceKey?: string }} [ctx] deployment overrides (tests)
 * @returns {boolean} true = drop
 */
function createLoopGate(message, ctx = {}) {
  try {
    if (!message || typeof message !== "object") return true;

    const platform = ctx.platform ?? message.platform;
    const instanceKey = ctx.instanceKey ?? message.instanceKey;
    const key = deploymentKey(platform, instanceKey);

    // No author object → not a human message.
    const authorId = message.authorId ?? message.author?.id ?? null;
    if (authorId == null || authorId === "") return true;

    // author.bot (includes a Fluxer webhook author: bot: true, author.id = webhook id).
    if (message.authorBot === true || message.author?.bot === true) return true;

    // Relay-webhook set for THIS deployment: the webhookId field or author.id
    // (a Fluxer partial can carry the webhook id only in author.id).
    const webhookSet = relayWebhookIds.get(key);
    if (webhookSet && webhookSet.size > 0) {
      const webhookId = message.webhookId != null ? String(message.webhookId) : null;
      if (webhookId != null && webhookSet.has(webhookId)) return true;
      if (webhookSet.has(String(authorId))) return true;
    }

    // This deployment's bot user (its notices are bot-authored).
    const botId = botUserIds.get(key);
    if (botId != null && String(authorId) === botId) return true;

    // Destination-id map: (platform, instanceKey, messageId) we just executed.
    const dest = destinationIds.get(key);
    if (dest) {
      const expiresAt = dest.get(String(message.id));
      if (expiresAt != null) {
        if (expiresAt > Date.now()) return true;
        dest.delete(String(message.id));
      }
    }

    // NOTE: a `bridge` prefix command line is NOT dropped here. The pipeline
    // dispatches human bridge lines through the shipped dispatcher exactly
    // once (KD 17); bot/echo-authored lines were dropped by the author rules
    // above. Spec §10.4: "the registry handler is the single entry".

    return false;
  } catch (err) {
    console.error("[bridge] loop gate check failed (message passed through):", err?.message || err);
    return false;
  }
}

/**
 * Map (end position, bridge direction) to the relay direction a source
 * message on that end would take. null = this end never relays.
 * (Spec §10.5 direction table; `a` = create side, KD 19.)
 *
 * @param {"a"|"b"} position
 * @param {"both"|"a_to_b"|"b_to_a"} direction
 * @returns {"a_to_b"|"b_to_a"|null}
 */
function relayDirectionForEnd(position, direction) {
  if (direction === "both") return position === "a" ? "a_to_b" : "b_to_a";
  if (position === "a") return direction === "a_to_b" ? "a_to_b" : null;
  return direction === "b_to_a" ? "b_to_a" : null;
}

/**
 * Build the id→display-name lookup from the message's own raw payload:
 * Fluxer keeps raw mention user objects (usernames exist only on the gateway
 * payload); channel names ride the optional channel-mentions raw array. No
 * platform calls — enqueue is sync and network-free (spec §10.8).
 *
 * @param {object} message
 * @returns {import("./mentions").MentionLookup}
 */
function mentionLookupFromMessage(message) {
  const users = new Map();
  for (const u of Array.isArray(message.mentionUsersRaw) ? message.mentionUsersRaw : []) {
    if (u && u.id != null) {
      users.set(String(u.id), u.global_name ?? u.globalName ?? u.display_name ?? u.displayName ?? u.username ?? null);
    }
  }
  const channels = new Map();
  for (const c of Array.isArray(message.mentionChannelsRaw) ? message.mentionChannelsRaw : []) {
    if (c && c.id != null) channels.set(String(c.id), c.name ?? null);
  }
  return (kind, id) => {
    if (kind === "user") return users.get(id) ?? null;
    if (kind === "channel") return channels.get(id) ?? null;
    return null;
  };
}

/**
 * The one-line reply header (spec §10.5 Replies): `↪ in reply to {display}:
 * {snippet}` — snippet neutralized, one line, sliceSafe 80. Empty reference
 * content becomes "attachment", "sticker", or "voice message".
 *
 * @param {object|null|undefined} referenced the referenced source message
 *   (present only when the source payload carried it — PR 6's fetch path fills
 *   the rest)
 * @param {import("./mentions").MentionLookup} lookup
 * @returns {string|null}
 */
function buildReplyHeader(referenced, lookup) {
  if (!referenced || typeof referenced !== "object") return null;
  const display =
    referenced.authorDisplayName ?? referenced.author?.username ?? referenced.username ?? "user";
  let snippet = String(referenced.content ?? "")
    .replace(/\s+/g, " ")
    .trim();
  snippet = neutralizeContent(snippet, referenced.mentions, lookup);
  if (snippet === "") {
    if (Array.isArray(referenced.attachments) && referenced.attachments.length > 0) {
      snippet = "attachment";
    } else if (Array.isArray(referenced.stickers) && referenced.stickers.length > 0) {
      snippet = "sticker";
    } else if (referenced.type === 6) {
      snippet = "voice message";
    } else {
      snippet = "message";
    }
  }
  return `↪ in reply to ${String(display)}: ${sliceSafe(snippet, 80)}`;
}

/**
 * Compose the durable payload_json for a source message (spec §10.8 payload
 * shape; schemaVersion STAYS 1 — the PR 5 additions (author.handle,
 * author.avatarUrl, voiceCaption, declaredBytes, spoolIndex, enqueuedAt) are
 * additive fields, and the shipped PR 4 readers pin schemaVersion 1). The
 * spool index/capacity fields media fills in replace the "spool-not-wired"
 * descriptors; no CDN URLs, no tokens, no credential.
 *
 * @param {object} message
 * @param {object} opts
 * @param {object} opts.bridge bridges row
 * @param {"a_to_b"|"b_to_a"} opts.direction
 * @param {number} opts.srcCommunityId
 * @param {import("./mentions").MentionLookup} opts.lookup
 * @returns {object}
 */
function buildRelayPayload(message, { bridge, direction, srcCommunityId, lookup }) {
  const attachments = (Array.isArray(message.attachments) ? message.attachments : []).map(
    (a) => ({
      sourceAttachmentId: a?.id != null ? String(a.id) : null,
      filename: typeof a?.name === "string" ? a.name : "",
      contentType: a?.contentType ?? null,
      // Fluxer IS_SPOILER = 1 << 3 (spec §10.8 Spoilers).
      spoiler: (Number(a?.flags ?? 0) & 8) === 8,
      // Fluxer CONTAINS_EXPLICIT_MEDIA = 1 << 4, preserved onto re-uploads
      // to Fluxer (spec §10.8 "Explicit-media flag").
      explicitMedia: (Number(a?.flags ?? 0) & 16) === 16,
      bytes: null,
      declaredBytes: Number.isFinite(Number(a?.size)) ? Math.max(0, Math.trunc(Number(a.size))) : null,
      skipReason: "spool-not-wired",
    }),
  );

  const stickers = (Array.isArray(message.stickers) ? message.stickers : [])
    .filter((s) => s && s.name != null)
    .map((s) => ({ id: String(s.id), name: String(s.name) }));

  const embeds = (Array.isArray(message.embeds) ? message.embeds : [])
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      title: e.title ?? null,
      description: e.description ?? null,
      url: e.url ?? null,
      color: typeof e.color === "number" ? e.color : null,
      fields: Array.isArray(e.fields)
        ? e.fields.map((f) => ({
            name: String(f?.name ?? ""),
            value: String(f?.value ?? ""),
            inline: Boolean(f?.inline),
          }))
        : [],
    }));

  const reference = message.messageReference ?? message.message_reference ?? null;
  const referenced = message.referencedMessage ?? message.referenced_message ?? null;
  const replyHeader = reference ? buildReplyHeader(referenced, lookup) : null;

  return {
    schemaVersion: 1,
    publicId: bridge.public_id,
    direction,
    srcCommunityId,
    srcChannelId: String(message.channelId ?? message.channel?.id ?? ""),
    srcMessageId: String(message.id),
    author: {
      id: String(message.authorId ?? message.author?.id ?? ""),
      display: message.authorDisplayName ?? message.author?.username ?? "",
      // §10.7 attribution: the handle lets the worker compose the username
      // override ("display (@handle)" when they differ); avatarUrl is the
      // best-effort https source avatar (Fluxer → Discord sends none — the
      // worker applies that rule at send time).
      handle: String(message.author?.username ?? ""),
      avatarUrl: httpsAvatarUrl(message),
    },
    text: neutralizeContent(message.content ?? "", message.mentions, lookup),
    replyHeader,
    // Voice messages cross as a plain attachment + this caption (spec §10.8);
    // only Fluxer's type 6 is a voice message (§10.5: Discord's type 6 is a
    // legacy reply, and the enqueue does not relay it).
    voiceCaption: Number(message.type) === 6 && message.platform === "fluxer"
      ? "Voice message"
      : null,
    // Message-level Fluxer CONTAINS_EXPLICIT_MEDIA (1 << 4).
    explicitMedia: (Number(message.flags ?? 0) & 16) === 16,
    stickers,
    embeds,
    attachments,
  };
}

/**
 * Best-effort source avatar URL (spec §10.7): https only, taken from the
 * message payload only — never a URL found in message text.
 * @param {object} message
 * @returns {string|null}
 */
function httpsAvatarUrl(message) {
  const raw =
    message?.author?.avatarURL ??
    message?.author?.avatarUrl ??
    message?.author?.avatar ??
    null;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("https://")) return null;
  return trimmed;
}

/**
 * Enqueue one source message for relay (spec §10.4 "Enqueue" + §10.8 spool-
 * at-enqueue). Two phases:
 *   1. SYNCHRONOUS — every gate (author, type, end, direction, connected_at
 *      window) runs with no network, and the durable outbox row is inserted
 *      BEFORE the first await. A bridge fault is caught HERE and logged — it
 *      can never skip XP for a human message.
 *   2. ASYNC spool — media only (signed-URL downloads with no bot credential),
 *      then ONE payload_json UPDATE while the row is still 'pending'. A row
 *      the worker already claimed (state moved) gets its spool deleted
 *      (ack-then-delete semantics: the claimed execution owns the payload).
 * The function never rejects: the row's text copy is durable even if the
 * spool phase throws.
 *
 * @param {object} message NormalizedMessage
 * @param {object} [deps]
 * @param {object} [deps.repo] bridges repository (tests)
 * @param {object} [deps.db] db handle for the payload update (tests)
 * @param {import("./mentions").MentionLookup} [deps.mentionLookup]
 * @param {object} [deps.media] media seams: { fetchImpl, resolveHost,
 *   downloadTimeoutMs, bridgeSpoolCapBytes, processSpoolCapBytes } (tests)
 * @returns {Promise<{ enqueued: true, outboxId: number }|null>}
 */
async function enqueueBridgeMessage(message, deps = {}) {
  let ctx = null;
  try {
    if (!message || typeof message !== "object") return null;
    const repo = deps.repo ?? require("../../db/repositories/bridges");

    const messageId = message.id != null ? String(message.id) : null;
    const channelId = message.channelId ?? message.channel?.id ?? null;
    const authorId = message.authorId ?? message.author?.id ?? null;
    if (!messageId || !channelId || !authorId) return null;

    // Human authors only; bot/webhook traffic died at the gate (this is
    // defense-in-depth, spec §10.6).
    if (message.authorBot === true || message.author?.bot === true) return null;

    // Types: DEFAULT, REPLY, and Fluxer voice messages (§10.5/§10.8).
    // Discord system messages are type 0 with the `system` duck flag — they
    // never copy (spec §10.5).
    if (message.system === true) return null;
    if (!isRelayableType(message.platform, message.type)) return null;

    const communityId = message.communityId;
    if (communityId == null) return null;

    const end = repo.getBridgeEndForChannel(communityId, String(channelId));
    if (!end) return null;
    const bridge = repo.getBridgeById(end.bridge_id);
    if (!bridge || bridge.state !== "active") return null;

    const direction = relayDirectionForEnd(end.position, bridge.direction);
    if (!direction) return null;

    // connected_at window (spec §10.5): ignore messages older than
    // connected_at - 2000 ms so a resume burst is never a backfill.
    const connectedAt = Number(bridge.connected_at);
    if (Number.isFinite(connectedAt) && bridge.connected_at != null) {
      let ts = null;
      try {
        ts = snowflakeTimeMs(messageId, message.platform);
      } catch (err) {
        console.error(
          `[bridge] enqueue skipped: message ${messageId} has no decodable snowflake: ${err?.message || err}`,
        );
        return null;
      }
      if (!Number.isFinite(ts)) return null;
      if (ts < connectedAt - CONNECT_GRACE_MS) return null;
    }

    const lookup = deps.mentionLookup ?? mentionLookupFromMessage(message);
    const payload = buildRelayPayload(message, {
      bridge,
      direction,
      srcCommunityId: communityId,
      lookup,
    });
    // Stamped BEFORE the first await: the enqueue time of a spool is its
    // source message's, not the download's (spec §10.8 FIFO context).
    payload.enqueuedAt = Date.now();

    const row = repo.enqueueBridgeOutbox(bridge.id, {
      direction,
      kind: "create",
      srcMessageId: messageId,
      payload,
    });
    ctx = { repo, bridge, direction, messageId, payload, row };
  } catch (err) {
    if (err?.code === "bridge_outbox_duplicate") return null; // idempotent replay
    console.error("[bridge] enqueue failed:", err?.message || err);
    return null;
  }

  // Phase 2 — spool-at-enqueue (spec §10.8). Media only; no bot credential.
  const { repo, bridge, direction, messageId, payload, row } = ctx;
  try {
    const seams = deps.media ?? {};
    const ends = resolveDirectionEnds(repo, bridge, direction);
    if (!ends.ok) {
      // No resolvable destination: keep the metadata descriptors (the worker
      // will park the row with the named ends error — text never stalls).
      console.error(`[bridge] spool: ${ends.error}`);
    } else {
      const { descriptors, notices } = await media.spoolAttachments({
        publicId: bridge.public_id,
        srcMessageId: messageId,
        attachments: Array.isArray(message.attachments) ? message.attachments : [],
        destinationPlatform: ends.dstCommunity.platform,
        direction,
        opts: {
          fetchImpl: seams.fetchImpl,
          resolveHost: seams.resolveHost,
          downloadTimeoutMs: seams.downloadTimeoutMs,
          bridgeSpoolCapBytes: seams.bridgeSpoolCapBytes,
          processSpoolCapBytes: seams.processSpoolCapBytes,
        },
      });
      payload.attachments = descriptors;
      if (notices.length > 0) payload.spoolNotices = notices;
      const db = deps.db ?? require("../../db/connection").db;
      const updated = db
        .prepare("UPDATE bridge_outbox SET payload_json = ? WHERE id = ? AND state = 'pending'")
        .run(JSON.stringify(payload), row.id);
      if (!updated || updated.changes === 0) {
        // The row left 'pending' mid-spool (worker claim / supersession):
        // that execution's payload is frozen — the spool is unowned, delete.
        media.deleteSpoolDir(bridge.public_id, messageId);
      }
    }
  } catch (err) {
    // The durable row keeps the metadata descriptors (skipReason
    // "spool-not-wired"): text and media state are visible in status.
    console.error(
      `[bridge] media spool failed for message ${messageId}: ${err?.message || err}`,
    );
  }
  return { enqueued: true, outboxId: Number(row.id) };
}

/**
 * The (platform, instanceKey) slice for the DESTINATION end of one direction
 * and the source end for notices — resolved from bridge_ends + communities.
 * @param {object} repo bridges repository
 * @param {object} bridge bridges row
 * @param {"a_to_b"|"b_to_a"} direction
 * @returns {{ ok: true, srcEnd: object|null, dstEnd: object,
 *              srcCommunity: object|null, dstCommunity: object }|{ ok: false, error: string }}
 */
function resolveDirectionEnds(repo, bridge, direction) {
  const ends = repo.listBridgeEnds(bridge.id);
  const srcPos = direction === "a_to_b" ? "a" : "b";
  const dstPos = srcPos === "a" ? "b" : "a";
  const srcEnd = ends.find((e) => e.position === srcPos) ?? null;
  const dstEnd = ends.find((e) => e.position === dstPos) ?? null;
  if (!dstEnd) {
    return { ok: false, error: `bridge ${bridge.public_id} has no ${dstPos}-side end` };
  }
  const communityRow = (id) => {
    try {
      return getCommunityById(id) ?? null;
    } catch {
      return null;
    }
  };
  const dstCommunity = communityRow(dstEnd.community_id);
  if (!dstCommunity) {
    return {
      ok: false,
      error: `community ${dstEnd.community_id} (bridge ${bridge.public_id} ${dstPos} end) has no communities row`,
    };
  }
  return {
    ok: true,
    srcEnd,
    dstEnd,
    srcCommunity: srcEnd ? communityRow(srcEnd.community_id) : null,
    dstCommunity,
  };
}

// ---------------------------------------------------------------------------
// The at-least-once relay worker (spec §10.10) — NOT wired to boot (KD 22)
// ---------------------------------------------------------------------------

/** Content ceilings by destination platform (spec §10.7 Chunking). */
const FLUXER_CONTENT_LIMIT = 4000;
const DISCORD_CONTENT_LIMIT = 2000;

/** Fluxer message flags: SUPPRESS_NOTIFICATIONS (1<<12) rides EVERY relay
 *  send (§10.11); CONTAINS_EXPLICIT_MEDIA (1<<4) is preserved (§10.8). */
const FLAG_SUPPRESS_NOTIFICATIONS = 1 << 12;
const FLAG_CONTAINS_EXPLICIT_MEDIA = 1 << 4;

/** Continuation prefix on every part after the first (spec §10.7). */
const CONTINUATION_PREFIX = "(continued) ";

/** Backoff ladder for generic failures (ms), indexed by attempt-1 (§10.10). */
const BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 16000]);

/** 429 / SLOWMODE wait at the head — the Retry-After cap (§10.10). */
const RATE_LIMIT_WAIT_MS = 60_000;

/** Consecutive 429 waits before the row falls through to the normal ladder
 *  (spec bounds each wait at 60 s; this bounds the whole storm: 8 × 60 s). */
const MAX_RATE_LIMIT_WAITS = 8;

/** Platform rate-limit codes (Fluxer strings, Discord numeric-as-string). */
const RATE_LIMIT_CODES = new Set(["RATE_LIMITED", "SLOWMODE_RATE_LIMITED", "429"]);

/** Process-wide concurrent executes (spec §10.10: cap 4). */
const MAX_CONCURRENT_SENDS = 4;

/** Scheduler cadence for the relay tick (startBridgeLoops; spec §10.4). */
const RELAY_TICK_MS = 250;

/**
 * §10.7 username override: guild nickname (payload display) if present,
 * else username; append " (@username)" when they differ; sliceSafe 80.
 * @param {{ display?: string, handle?: string }} author
 * @returns {string}
 */
function attributionName(author) {
  const display = String(author?.display ?? "").trim();
  const handle = String(author?.handle ?? "").trim();
  const base = display === "" ? (handle === "" ? "user" : handle) : display;
  const composed = handle !== "" && handle !== base ? `${base} (@${handle})` : base;
  return sliceSafe(composed, 80);
}

/**
 * §10.6 idempotency: nonce = SHA-256(publicId:srcMessageId:kind:partIndex),
 * first 32 hex characters. Deterministic — the spool makes re-execution
 * byte-identical, so a timeout retry inside Fluxer's 5-minute nonce window
 * can never double-post.
 */
function relayNonce(publicId, srcMessageId, kind, partIndex) {
  return crypto
    .createHash("sha256")
    .update(`${publicId}:${srcMessageId}:${kind}:${partIndex}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function contentLimitFor(platform) {
  return platform === "discord" ? DISCORD_CONTENT_LIMIT : FLUXER_CONTENT_LIMIT;
}

function isRateLimitedResult(res) {
  if (res?.code != null && RATE_LIMIT_CODES.has(String(res.code))) return true;
  const text = String(res?.error ?? "");
  return /\bHTTP 429\b|\bstatus 429\b|slowmode/i.test(text);
}

function isUnknownWebhookResult(res) {
  return String(res?.code ?? "").toUpperCase() === "UNKNOWN_WEBHOOK";
}

function isAvatarSuspect(res) {
  const text = String(res?.error ?? "");
  return (
    /HTTP 400|status 400|50035|Invalid Form Body/i.test(text) && /avatar/i.test(text)
  );
}

/**
 * Slice a body into ≤ limit-sized parts; every part after the first starts
 * with "(continued) " (spec §10.7: sliceSafe at the destination limit, the
 * reply header rides part 0 and consumes its budget).
 * @param {string} text
 * @param {number} limit destination content limit
 * @returns {string[]} ordered part bodies
 */
function chunkBodyForSend(text, limit) {
  const parts = [];
  let remaining = String(text ?? "");
  let first = true;
  let guard = 0;
  while (remaining.length > 0 && guard < 10000) {
    guard += 1;
    const budget = Math.max(1, first ? limit : limit - CONTINUATION_PREFIX.length);
    const piece = sliceSafe(remaining, budget);
    if (piece.length === 0) break; // sliceSafe clamps; a zero slice means done
    parts.push(first ? piece : `${CONTINUATION_PREFIX}${piece}`);
    remaining = remaining.slice(piece.length);
    first = false;
  }
  return parts;
}

/**
 * Build the ordered send parts for a create payload (spec §10.7 Chunking +
 * §10.8 stickers/voice/skip lines/10-file batches). A webhook execute carries
 * content AND files together, so the file batches ride the text parts
 * (batch i attaches to part i); overflow past MAX_FILES_PER_EXECUTE files
 * becomes dedicated file-only parts — "more executes, same FIFO slot".
 * @param {object} payload parsed payload_json
 * @param {string} destPlatform "discord" | "fluxer"
 * @param {(descriptor: object) => Buffer|null} resolveFile
 * @returns {{ parts: Array<{ content: string|null, files: object[], partIndex: number }>, skipLines: string[] }}
 */
function buildSendParts(payload, destPlatform, resolveFile) {
  const limit = contentLimitFor(destPlatform);
  const fileCap = media.FILE_SIZE_LIMITS[destPlatform];
  const descriptors = Array.isArray(payload.attachments) ? payload.attachments : [];
  const files = [];
  for (const d of descriptors) {
    if (!d || typeof d !== "object") continue;
    if (d.skipReason != null) continue; // over-cap / spool-full / fetch-failed
    files.push({
      // §10.8 spoilers: Discord destinations get the SPOILER_ prefix from the
      // descriptor flag; Fluxer destinations never carry the prefix.
      name: media.applySpoilerForDestination(
        media.sanitizeOutboundFilename(d.filename),
        Boolean(d.spoiler),
        destPlatform,
      ),
      data: resolveFile(d),
      contentType: d.contentType ?? "application/octet-stream",
    });
  }

  const skipLines = [];
  for (const d of descriptors) {
    if (!d || typeof d !== "object" || d.skipReason == null) continue;
    if (d.skipReason === "over-cap") {
      // The named line quotes the per-FILE ceiling (§10.8 table), not the
      // content limit: 20 MiB Discord / 50 MiB Fluxer.
      const size = Number.isFinite(Number(d.declaredBytes)) ? Number(d.declaredBytes) : 0;
      skipLines.push(media.buildOverCapLine(d.filename, size, fileCap));
    } else {
      skipLines.push(media.buildSkipLine(d.filename, d.skipReason));
    }
  }

  const headLines = [];
  if (payload.replyHeader) headLines.push(String(payload.replyHeader));
  if (payload.voiceCaption) headLines.push(String(payload.voiceCaption));
  const body = [headLines.join("\n"), String(payload.text ?? "")]
    .filter((s) => s !== "")
    .join("\n");
  // Stickers are not native on either end: append `Sticker: {name}` lines
  // (spec §10.8 — the service names them, the worker appends).
  const trailerLines = (Array.isArray(payload.stickers) ? payload.stickers : [])
    .filter((s) => s && s.name != null)
    .map((s) => `Sticker: ${s.name}`)
    .concat(skipLines);
  const full = [body, trailerLines.join("\n")].filter((s) => s !== "").join("\n");

  const parts = chunkBodyForSend(full, limit).map((content, i) => ({
    content,
    files: [],
    partIndex: i,
  }));
  // Attach each ≤10-file batch to its text part (batch i → part i); batches
  // beyond the text parts become file-only executes (content null — a
  // media-only message starts with a single full-body part below).
  let batchIndex = 0;
  for (let i = 0; i < files.length; i += media.MAX_FILES_PER_EXECUTE) {
    const batch = files.slice(i, i + media.MAX_FILES_PER_EXECUTE);
    const target = parts[batchIndex];
    if (target) {
      target.files = target.files.concat(batch);
    } else {
      parts.push({
        content: parts.length === 0 ? full : null,
        files: batch,
        partIndex: batchIndex,
      });
    }
    batchIndex += 1;
  }
  return { parts, skipLines };
}

/**
 * The relay worker (spec §10.10). Pure-ish and fully seam-injected:
 *   repo, db, getWebhookApi(platform, instanceKey), getOutbound(platform,
 *   instanceKey), keyGetter, sendMessage, sleep(ms), fetchImpl, resolveHost,
 *   downloadTimeoutMs.
 *
 * Concurrency model: tick() claims the OLDEST pending row per (bridge,
 * direction) (FIFO via the repo's claim CAS), one in-flight per direction,
 * at most MAX_CONCURRENT_SENDS running. A 429/SLOWMODE parks the row AT THE
 * HEAD with a capped Retry-After sleep and NO attempt burn; generic failures
 * walk the 1/2/4/8/16 s ladder (each burns one attempt); the 5th parks the
 * row as 'failed', records last_error, and posts the §10.10 poison notice in
 * the SOURCE channel. Success = every part ACKed: links rows are inserted
 * per part (id-synchronous commit), the row is marked done, and the spool
 * directory is deleted LAST (ack-then-delete).
 *
 * @param {object} deps
 * @returns {{ tick: (o?: { drain?: boolean }) => Promise<{ started: number }>,
 *             drainAll: (maxRounds?: number) => Promise<void>,
 *             runRow: (row: object) => Promise<void>,
 *             inFlightCount: () => number }}
 */
function createRelayWorker(deps = {}) {
  const repo = deps.repo ?? require("../../db/repositories/bridges");
  const db = deps.db ?? require("../../db/connection").db;
  const getWebhookApi =
    typeof deps.getWebhookApi === "function" ? deps.getWebhookApi : () => null;
  const getOutbound = typeof deps.getOutbound === "function" ? deps.getOutbound : () => null;
  const keyGetter = deps.keyGetter;
  const sendMessage =
    typeof deps.sendMessage === "function" ? deps.sendMessage : async () => ({ ok: true });
  const sleep =
    typeof deps.sleep === "function"
      ? deps.sleep
      : (ms) =>
          new Promise((resolve) => {
            const t = setTimeout(resolve, ms);
            if (typeof t.unref === "function") t.unref();
          });
  const mediaOpts = {
    fetchImpl: deps.fetchImpl,
    resolveHost: deps.resolveHost,
    downloadTimeoutMs: deps.downloadTimeoutMs,
  };

  const outboundCache = new Map();
  /** @type {Map<string, Promise<void>>} directionKey → in-flight execution */
  const inFlight = new Map();

  function outboundFor(platform, instanceKey) {
    const key = deploymentKey(platform, instanceKey);
    let port = outboundCache.get(key);
    if (!port) {
      const seams = {
        platform,
        instanceKey,
        getWebhookApi: (p, k) => getWebhookApi(p, k),
        getOutbound: (p, k) => getOutbound(p, k),
        keyGetter,
      };
      port =
        platform === "fluxer"
          ? createFluxerBridgeOutbound(seams)
          : createDiscordBridgeOutbound(seams);
      outboundCache.set(key, port);
    }
    return port;
  }

  /** Notice sends: awaited by callers so tests observe them; a failed
   *  notice never requeues a send (log only). Returns the settlement promise. */
  function sendNoticeSafe(communityId, channelId, content, label) {
    return Promise.resolve()
      .then(() => sendMessage(communityId, channelId, content))
      .then((res) => {
        if (res && res.ok === false) {
          console.error(`[bridge] worker: ${label} notice send failed: ${res.error}`);
        }
      })
      .catch((err) =>
        console.error(`[bridge] worker: ${label} notice send failed: ${err?.message || err}`),
      );
  }

  function logWorkerThrow(publicId, row, err) {
    // Spec §10.10: "Worker throw — log `[bridge] worker failed:` with public
    // id; reschedule. Never exit the process."
    console.error(
      `[bridge] worker failed: bridge ${publicId} outbox ${row.id}: ${err?.message || err}`,
    );
  }

  /**
   * Resolve spool bytes for one descriptor; a spool MISS refetches the
   * source message for fresh signed URLs (spec §10.10 Restart: "Missing
   * spool → fetchMessage fallback", best-effort — the source may be gone).
   */
  async function resolveSpooledBytes(descriptor, payload, sourcePort) {
    const spoolIndex = Number.isInteger(descriptor.spoolIndex)
      ? descriptor.spoolIndex
      : Number.parseInt(String(descriptor.spoolIndex ?? ""), 10);
    if (Number.isInteger(spoolIndex) && spoolIndex >= 0) {
      const bytes = media.readSpooledFile(payload.publicId, payload.srcMessageId, spoolIndex);
      if (bytes) return { bytes };
    }
    const fetched = await sourcePort.fetchSourceMessage(
      payload.srcCommunityId,
      payload.srcChannelId,
      payload.srcMessageId,
    );
    if (!fetched.ok) return { error: `spool missing and source refetch failed: ${fetched.error}` };
    const source = (Array.isArray(fetched.message?.attachments) ? fetched.message.attachments : [])
      .find((a) => a && String(a.id) === String(descriptor.sourceAttachmentId));
    if (!source || !source.url) {
      return { error: "spool missing and the source attachment no longer carries a url" };
    }
    const dl = await media.downloadSignedUrl(source.url, mediaOpts);
    if (!dl.ok) return { error: `spool missing and re-download failed: ${dl.reason}` };
    return { bytes: dl.bytes };
  }

  /** One part send with the §10.10 ladder. Returns { ok } or { parked } / { degraded }. */
  async function sendPartWithLadder({
    port,
    webhookRef,
    payload,
    part,
    row,
    destPlatform,
    username,
    flags,
    avatarUrl,
    maxAttempts,
    onWebhookRecreated,
  }) {
    let attempts = 0;
    let rateLimitWaits = 0;
    let avatarDropped = false;
    let recreateTried = false;
    for (;;) {
      const opts = {
        content: part.content == null ? undefined : part.content,
        username,
        allowedMentions: destPlatform === "discord" ? NO_PING : {},
        nonce: relayNonce(payload.publicId, payload.srcMessageId, row.kind, part.partIndex),
        files: part.files,
        wait: true,
      };
      if (typeof flags === "number") opts.flags = flags;
      if (avatarUrl != null && !avatarDropped) opts.avatarUrl = avatarUrl;

      let res;
      try {
        res = await port.executeRelay(webhookRef.current, opts);
      } catch (err) {
        // A throwing transport is a generic failure (AGENTS.md rule 6: the
        // worker keeps the cause, the ladder keeps the cadence).
        res = { ok: false, error: String(err?.message || err), retryable: true };
      }

      if (res.ok === true) {
        if (res.messageId != null) return { ok: true, messageId: res.messageId };
        if (destPlatform !== "discord") return { ok: true, messageId: null };
        // Discord id-synchronous rule (§10.6): a send that produced NO id may
        // be retried; one that produced an id never is.
        attempts += 1;
        const reason = "send produced no message id";
        const updated = repo.recordOutboxFailure(row.id, reason, { maxAttempts });
        if (updated && updated.state === "failed") {
          return { parked: true, reason };
        }
        await sleep(BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]);
        continue;
      }

      const reason = res.error ?? "webhook send failed";

      // 429 / SLOWMODE: stay at the head, wait (Retry-After cap 60 s), do
      // NOT count toward the poison limit (spec §10.10 table). A bounded
      // storm of waits keeps a permanently-limited endpoint from spinning.
      if (isRateLimitedResult(res) && rateLimitWaits < MAX_RATE_LIMIT_WAITS) {
        rateLimitWaits += 1;
        const declared = Number(res.retryAfterMs);
        const waitMs = Number.isFinite(declared)
          ? Math.min(Math.max(declared, 0), RATE_LIMIT_WAIT_MS)
          : RATE_LIMIT_WAIT_MS;
        await sleep(waitMs);
        continue;
      }

      // §10.7 avatar rule: a 400 whose only suspect is avatar_url — retry
      // once with no avatar (no attempt burn).
      if (avatarUrl != null && !avatarDropped && isAvatarSuspect(res)) {
        avatarDropped = true;
        continue;
      }

      // §10.10 "Webhook deleted by a moderator": one recreate attempt, then
      // degraded bot-authored send for THIS part (creates only).
      if (isUnknownWebhookResult(res) && !recreateTried) {
        recreateTried = true;
        const recreated = await port.createRelayWebhook(
          payload.dstCommunityId,
          payload.dstChannelId,
        );
        if (recreated.ok) {
          webhookRef.current = recreated.webhook;
          onWebhookRecreated(recreated);
          continue;
        }
        // Degraded fallback: bot-authored, quote prefix first line (spec
        // §10.7). One message; last_error records the failure.
        const quote = `**${username}** (@${String(payload.author?.handle ?? "user")} on ${payload.srcPlatform ?? "source"})`;
        const degradedBody = sliceSafe(
          `${quote}\n${part.content == null || part.content === "" ? "[media attached]" : part.content}`,
          contentLimitFor(destPlatform),
        );
        const sent = await port.sendNotice(
          payload.dstCommunityId,
          payload.dstChannelId,
          degradedBody,
        );
        const reasonText = `${reason} | webhook recreate failed: ${recreated?.error ?? "unknown"} | degraded send ${sent.ok ? "delivered" : `failed: ${sent.error}`}`;
        return { degraded: true, reason: reasonText };
      }

      attempts += 1;
      const updated = repo.recordOutboxFailure(row.id, reason, { maxAttempts });
      if (!updated) return { parked: true, reason }; // row vanished (disconnect raced)
      if (updated.state === "failed") return { parked: true, reason };
      await sleep(BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]);
    }
  }

  /**
   * Execute ONE outbox row end to end. Never throws: every expected failure
   * lands on the ladder; an UNEXPECTED throw is logged with the public id
   * and rescheduled (the row goes back to pending).
   */
  async function runRow(row) {
    let publicId = `bridge ${row.bridge_id}`;
    try {
      const bridge = repo.getBridgeById(row.bridge_id);
      if (!bridge) {
        // The bridge row is gone; disconnect cascades outbox rows, so a
        // leftover is a vanished bridge — the row has no destination.
        console.warn(
          `[bridge] worker: outbox ${row.id} references deleted bridge ${row.bridge_id}; marking done`,
        );
        repo.markOutboxDone(row.id);
        return;
      }
      publicId = bridge.public_id;

      let payload;
      try {
        payload = JSON.parse(row.payload_json);
      } catch (err) {
        console.error(
          `[bridge] worker: outbox ${row.id} payload_json is not parseable: ${err?.message || err}`,
        );
        repo.recordOutboxFailure(row.id, "payload_json is not valid JSON", { maxAttempts: 1 });
        return;
      }

      if (row.kind !== "create") {
        // PR 5 ships create relay; edit/delete execution lands with PR 6.
        // Park with a named reason so the ladder never spins on them.
        repo.recordOutboxFailure(row.id, "edit/delete relay executes with the edit/delete PR", {
          maxAttempts: 1,
        });
        return;
      }

      const ends = resolveDirectionEnds(repo, bridge, row.direction);
      if (!ends.ok) {
        repo.recordOutboxFailure(row.id, ends.error, { maxAttempts: 1 });
        repo.setBridgeLastError(bridge.id, ends.error);
        return;
      }
      const dstCommunity = ends.dstCommunity;
      const srcCommunity = ends.srcCommunity;
      const destPlatform = dstCommunity.platform;
      // community.js rows are camelCase (instanceKey), NOT the SQL column
      // name — the deployment slice key must match the gateway's own
      // (platform, instanceKey) slice, spec §10.4.
      const port = outboundFor(destPlatform, dstCommunity.instanceKey);
      // The SOURCE-side port serves fetchSourceMessage (spool-loss re-sign
      // fallback, spec §10.10 Restart).
      const sourcePort = outboundFor(
        srcCommunity?.platform ?? destPlatform,
        srcCommunity?.instanceKey ?? dstCommunity.instanceKey,
      );

      const wh = port.webhookForEnd(ends.dstEnd);
      if (!wh.ok) {
        repo.recordOutboxFailure(row.id, wh.error, { maxAttempts: 1 });
        repo.setBridgeLastError(bridge.id, wh.error);
        return;
      }
      const webhookRef = { current: wh.webhook };

      // Resolve every file's bytes BEFORE sending (partial-failure rule):
      // a late resolve failure is named in the body, same sentence as create.
      const descriptors = Array.isArray(payload.attachments) ? payload.attachments : [];
      const resolveErrors = [];
      for (const d of descriptors) {
        if (!d || typeof d !== "object" || d.skipReason != null) continue;
        const resolved = await resolveSpooledBytes(d, payload, sourcePort);
        if (resolved.bytes != null) {
          d.bytes = resolved.bytes.length;
          d.data = resolved.bytes; // in-memory for this execution only
        } else {
          d.skipReason = `fetch-failed: ${resolved.error}`;
          resolveErrors.push(resolved.error);
        }
      }

      const username = attributionName(payload.author);
      // §10.8: CONTAINS_EXPLICIT_MEDIA is preserved onto the relayed message
      // when ANY source attachment carried it (the descriptor builder extracts
      // the flag per attachment); message-level flags ride every send.
      const anyExplicitMedia =
        payload.explicitMedia === true ||
        (Array.isArray(payload.attachments) &&
          payload.attachments.some((a) => a && a.explicitMedia === true));
      const flags =
        destPlatform === "fluxer"
          ? FLAG_SUPPRESS_NOTIFICATIONS | (anyExplicitMedia ? FLAG_CONTAINS_EXPLICIT_MEDIA : 0)
          : undefined;
      // §10.7 avatars: Discord → Fluxer sends the source avatar URL (https
      // only, captured at enqueue); Fluxer → Discord sends NO avatar_url.
      const avatarUrl =
        destPlatform === "fluxer" && payload.author?.avatarUrl ? payload.author.avatarUrl : null;

      const sendCtx = {
        ...payload,
        dstCommunityId: ends.dstEnd.community_id,
        dstChannelId: ends.dstEnd.channel_id,
        srcPlatform: srcCommunity?.platform ?? null,
      };
      const { parts } = buildSendParts(payload, destPlatform, (d) => d.data ?? null);

      const createdIds = [];
      for (const part of parts) {
        const result = await sendPartWithLadder({
          port,
          webhookRef,
          payload: sendCtx,
          part,
          row,
          destPlatform,
          username,
          flags,
          avatarUrl,
          maxAttempts: repo.BRIDGE_OUTBOX_MAX_ATTEMPTS,
          onWebhookRecreated: (recreated) => {
            try {
              repo.setBridgeEndWebhook(bridge.id, ends.dstEnd.position, {
                webhookId: recreated.webhook.id,
                tokenEnc: recreated.tokenEnc,
                uploadLimitBytes: ends.dstEnd.upload_limit_bytes ?? null,
              });
              registerRelayWebhookId(
                dstCommunity.platform,
                dstCommunity.instanceKey,
                recreated.webhook.id,
              );
            } catch (err) {
              console.error(
                `[bridge] worker: webhook recreate persist failed for ${publicId}: ${err?.message || err}`,
              );
            }
          },
        });

        if (result.parked) {
          // Poison park (spec §10.10): state 'failed' + last_error (status
          // shows it) + the source-channel notice. Continue with the next
          // message — the ladder already burned the 5 attempts.
          repo.setBridgeLastError(bridge.id, result.reason);
          await sendNoticeSafe(
            payload.srcCommunityId,
            payload.srcChannelId,
            `Bridge ${publicId} could not copy message ${payload.srcMessageId} after 5 attempts: ${result.reason}. Later messages are still being copied.`,
            "poison park",
          );
          return;
        }
        if (result.degraded) {
          // The degraded send IS the delivery of this part; no link can be
          // recorded (bot-authored message id is not a relay copy id we own
          // for PATCH/DELETE — edits skip degraded parts, spec §10.7).
          repo.setBridgeLastError(bridge.id, result.reason);
        }
        if (result.ok && result.messageId != null) {
          createdIds.push({ partIndex: part.partIndex, messageId: result.messageId });
        }
      }

      // Ack-then-delete: links rows + dest id + done FIRST, spool dir LAST
      // (spec §10.10: a crash before the delete leaves a durable row whose
      // re-execution is deduped by the Fluxer nonce).
      for (const link of createdIds) {
        repo.addBridgeMessageLink({
          bridgeId: bridge.id,
          srcCommunityId: payload.srcCommunityId,
          srcMessageId: payload.srcMessageId,
          partIndex: link.partIndex,
          dstMessageId: link.messageId,
        });
        noteRelayedDestination(dstCommunity.platform, dstCommunity.instanceKey, link.messageId);
      }
      if (createdIds.length > 0) {
        db.prepare("UPDATE bridge_outbox SET dest_message_id = ? WHERE id = ?").run(
          createdIds[0].messageId,
          row.id,
        );
      }
      if (resolveErrors.length > 0) {
        // Names what the body named (partial-failure report on the row).
        db.prepare("UPDATE bridge_outbox SET last_error = ? WHERE id = ?").run(
          sliceSafe(`partial: ${resolveErrors.join("; ")}`, 480),
          row.id,
        );
      }
      const done = repo.markOutboxDone(row.id);
      if (done && resolveErrors.length === 0) repo.setBridgeLastError(bridge.id, null);

      // Latched spool notices ride the payload (enqueue armed the latch;
      // the worker sends once, spec §10.8).
      for (const notice of Array.isArray(payload.spoolNotices) ? payload.spoolNotices : []) {
        if (notice?.kind === "spool_full") {
          await sendNoticeSafe(
            payload.srcCommunityId,
            payload.srcChannelId,
            media.buildSpoolFullNotice(publicId, notice.detail ?? "cap reached"),
            "spool full",
          );
        }
      }

      if (done) media.deleteSpoolDir(payload.publicId, payload.srcMessageId);
    } catch (err) {
      logWorkerThrow(publicId, row, err);
      try {
        repo.recordOutboxFailure(row.id, String(err?.message || err)); // → pending, rescheduled
      } catch (innerErr) {
        console.error(
          `[bridge] worker: reschedule of outbox ${row.id} failed: ${innerErr?.message || innerErr}`,
        );
      }
    }
  }

  /** Distinct (bridge, direction) pairs that have pending rows (FIFO heads). */
  function queuedPairs() {
    return db
      .prepare(
        `SELECT DISTINCT bridge_id, direction FROM bridge_outbox
         WHERE state = 'pending'
         ORDER BY bridge_id ASC, direction ASC`,
      )
      .all();
  }

  /**
   * One worker pass: claim one head row per direction (respecting the 4-wide
   * process cap) and launch it. drain: await every launched execution
   * (tests drive deterministically; the scheduler job does not drain).
   */
  async function tick(opts = {}) {
    const drain = opts.drain !== false;
    let started = 0;
    for (const pair of queuedPairs()) {
      if (inFlight.size >= MAX_CONCURRENT_SENDS) break;
      const key = `${pair.bridge_id}|${pair.direction}`;
      if (inFlight.has(key)) continue; // one in-flight per direction (FIFO)
      let row = null;
      try {
        row = repo.claimNextOutboxRow(pair.bridge_id, pair.direction);
      } catch (err) {
        console.error(`[bridge] worker: outbox claim failed: ${err?.message || err}`);
        continue;
      }
      if (!row) continue;
      started += 1;
      const run = runRow(row).catch(() => {}); // runRow never throws; belt
      inFlight.set(key, run);
      run.finally(() => inFlight.delete(key));
    }
    if (drain) {
      let guard = 0;
      while (inFlight.size > 0 && guard < 1000) {
        guard += 1;
        await Promise.allSettled([...inFlight.values()]);
      }
    }
    return { started };
  }

  /** Drive ticks until nothing starts AND the queue is empty (tests drive a
   *  full drain; a cap-saturated tick starts 0 rows while work remains, so
   *  "started 0" alone must not end the drain). */
  async function drainAll(maxRounds = 50) {
    for (let i = 0; i < maxRounds; i += 1) {
      const { started } = await tick({ drain: true });
      if (started === 0 && inFlight.size === 0 && queuedPairs().length === 0) return;
    }
  }

  return {
    tick,
    drainAll,
    runRow,
    inFlightCount: () => inFlight.size,
  };
}

/**
 * Start-shape hook the ACTIVATION PR wires into boot (KD 22: nothing calls
 * this in the current build; src/features/bridge/index.js exports it as
 * `startBridgeLoops`, never as the `start` key load.js consumes).
 *
 * Order (spec §10.10 Restart + §10.8): rebuild spool accounting from disk,
 * return abandoned 'sending' rows to 'pending', reload the relay/echo maps,
 * run the start-time orphan-spool pass, then register the worker tick and
 * the 60-second expiry sweeper with the scheduler. Guarded against
 * double-start (the spec's "guarded against double-start").
 *
 * @param {object} [supervisor] platform supervisor (activation PR; the seam
 *   functions below take precedence when provided)
 * @param {object} [opts] worker seams (repo, db, getWebhookApi, getOutbound,
 *   keyGetter, sendMessage, sleep, fetchImpl, resolveHost, scheduler, ...)
 * @returns {{ stop: () => void, worker: object }|null} loop handle
 */
function startBridgeLoops(supervisor = null, opts = {}) {
  if (loopHandle) return loopHandle;

  const scheduler = opts.scheduler ?? require("../../core/scheduler");
  const repo = opts.repo ?? require("../../db/repositories/bridges");

  // 1. Spool accounting from disk (process-wide caps must see previous-run bytes).
  media.initSpoolAccounting();

  // 2. Restart recovery: 'sending' rows (a crash mid-execution) replay.
  try {
    const requeued = repo.requeueStaleOutbox();
    if (requeued > 0) {
      console.log(`[bridge] restart: requeued ${requeued} outbox row(s) from 'sending'`);
    }
  } catch (err) {
    console.error("[bridge] restart requeue failed:", err?.message || err);
  }

  // 3. Relay/echo maps from SQLite (per-deployment slices, spec §10.4).
  refreshRelayMaps();

  // 4. Start-time orphan-spool pass (spec §10.8 / Data Model).
  try {
    const { removed } = media.sweepOrphanSpools({
      isKnownPublicId: opts.isKnownPublicId ?? ((id) => !!repo.getBridgeByPublicId(id)),
    });
    if (removed.length > 0) {
      console.log(`[bridge] removed ${removed.length} orphan spool director${removed.length === 1 ? "y" : "ies"}`);
    }
  } catch (err) {
    console.error("[bridge] orphan spool pass failed:", err?.message || err);
  }

  // 5. The worker + the sweeper on the scheduler.
  const worker = createRelayWorker(
    supervisor && opts.getWebhookApi == null && opts.getOutbound == null
      ? { ...opts, ...supervisorOutboundSeams(supervisor) }
      : opts,
  );
  const jobs = [];
  try {
    scheduler.registerJob({
      name: "bridge-relay",
      intervalMs: Number.isFinite(opts.tickIntervalMs) ? opts.tickIntervalMs : RELAY_TICK_MS,
      run: () => worker.tick({ drain: false }),
    });
    jobs.push("bridge-relay");
  } catch (err) {
    console.error("[bridge] worker job registration failed:", err?.message || err);
  }
  try {
    scheduler.registerJob(require("./expire").createSweepJobSpec());
    jobs.push("bridge-expiry");
  } catch (err) {
    console.error("[bridge] sweeper job registration failed:", err?.message || err);
  }

  loopHandle = {
    worker,
    stop() {
      for (const name of jobs) {
        try {
          scheduler.stop(name);
        } catch (err) {
          console.error(`[bridge] stopping ${name} failed:`, err?.message || err);
        }
      }
      loopHandle = null;
    },
  };
  return loopHandle;
}

/** @type {object|null} module-level double-start guard */
let loopHandle = null;

/**
 * Production seam defaults derived from the supervisor (the shape handlers.js
 * builds for the service): webhook api + OutboundClient per community, and
 * the bot-authored sendMessage that dies at the loop gate.
 * @param {object} supervisor { discord, fluxer, clientForCommunity }
 */
function supervisorOutboundSeams(supervisor) {
  const { createDiscordWebhooks } = require("../../platform/discord/webhooks");
  const { createFluxerWebhooks } = require("../../platform/fluxer/webhooks");
  const { getDiscordOutbound } = require("../../platform/discord/outbound");
  const { createFluxerOutbound } = require("../../platform/fluxer/outbound");
  return {
    getWebhookApi: (platform, instanceKey) => {
      try {
        if (platform === "discord") {
          return supervisor.discord ? createDiscordWebhooks(supervisor.discord) : null;
        }
        const handle = supervisor.fluxer?.get?.(instanceKey) ?? null;
        return handle ? createFluxerWebhooks({ rest: handle.rest, apiOrigin: "" }) : null;
      } catch (err) {
        console.error(
          `[bridge] webhook api build failed for ${platform}:${instanceKey}: ${err?.message || err}`,
        );
        return null;
      }
    },
    getOutbound: (platform, instanceKey) => {
      try {
        if (platform === "discord") {
          return supervisor.discord ? getDiscordOutbound(supervisor.discord) : null;
        }
        const handle = supervisor.fluxer?.get?.(instanceKey) ?? null;
        if (!handle) return null;
        // The client caches the OutboundClient on the handle (client.js:
        // handle.outbound = createFluxerOutbound(handle)) — reuse it.
        return handle.outbound ?? createFluxerOutbound(handle);
      } catch (err) {
        console.error(
          `[bridge] outbound build failed for ${platform}:${instanceKey}: ${err?.message || err}`,
        );
        return null;
      }
    },
    keyGetter: () => process.env.BRIDGE_TOKEN_KEY,
    sendMessage: async (communityId, channelId, content) => {
      let outbound = null;
      try {
        outbound = supervisor?.clientForCommunity?.(communityId) ?? null;
      } catch (err) {
        return { ok: false, error: `outbound lookup failed: ${err?.message || err}` };
      }
      if (!outbound || typeof outbound.sendChannel !== "function") {
        return { ok: false, error: `no outbound client for community ${communityId}` };
      }
      try {
        return await outbound.sendChannel(String(channelId), {
          content,
          allowedMentions: NO_PING,
        });
      } catch (err) {
        return { ok: false, error: `send to channel ${channelId} failed: ${err?.message || err}` };
      }
    },
  };
}

module.exports = {
  DESTINATION_TTL_MS,
  CONNECT_GRACE_MS,
  RELAY_TICK_MS,
  FLUXER_CONTENT_LIMIT,
  DISCORD_CONTENT_LIMIT,
  MAX_CONCURRENT_SENDS,
  FLAG_SUPPRESS_NOTIFICATIONS,
  FLAG_CONTAINS_EXPLICIT_MEDIA,
  deploymentKey,
  reloadRelayMaps,
  refreshRelayMaps,
  registerRelayWebhookId,
  setBotUserId,
  noteRelayedDestination,
  clearRelayState,
  isRelayedEcho,
  isRelayedDestinationForTest,
  createLoopGate,
  isBridgeCommandLine,
  relayDirectionForEnd,
  mentionLookupFromMessage,
  buildReplyHeader,
  buildRelayPayload,
  httpsAvatarUrl,
  enqueueBridgeMessage,
  // PR 5: worker + start-shape hook (NOT wired to boot — KD 22)
  resolveDirectionEnds,
  attributionName,
  relayNonce,
  chunkBodyForSend,
  buildSendParts,
  createRelayWorker,
  startBridgeLoops,
};
