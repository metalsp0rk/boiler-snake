/**
 * Bridge pipeline gates + enqueue (roadmap/bridge.md §10.4, §10.5, §10.12).
 *
 * PR 4 scope (KD 22): the gates and the enqueue. The relay WORKER is PR 5 —
 * this module has no worker, no startBridgeLoops, and nothing here is wired
 * to boot. The enqueue writes the durable `bridge_outbox` row (kind `create`)
 * with a metadata-only payload; spool bytes land with the media PR.
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
 * parsePrefix and snowflakeTimeMs are SDK-free adapter modules.
 */

const { parsePrefix } = require("../../platform/fluxer/commands");
const { snowflakeTimeMs } = require("../../platform/snowflake");
const { neutralizeContent } = require("./mentions");
const { sliceSafe } = require("../../core/text");

/** Destination-id map TTL (spec §10.4: TTL 10 minutes). */
const DESTINATION_TTL_MS = 10 * 60 * 1000;

/** Grace applied to the connected_at comparison (spec §10.5: 2000 ms). */
const CONNECT_GRACE_MS = 2000;

/** Relayable source message types (spec §10.5: DEFAULT and REPLY only). */
const RELAYABLE_TYPES = new Set([0, 19]);

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
  const { sliceSafe } = require("../core/text");
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
 * shape; PR 4 ships metadata only — no spool bytes, no CDN URLs, no tokens,
 * no credential).
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
      bytes: null,
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
    },
    text: neutralizeContent(message.content ?? "", message.mentions, lookup),
    replyHeader,
    stickers,
    embeds,
    attachments,
  };
}

/**
 * Enqueue one source message for relay (spec §10.4 "Enqueue": runs after
 * honeypot, before activity/XP; synchronous, no network; a bridge fault is
 * caught HERE and logged — it can never skip XP for a human message).
 *
 * @param {object} message NormalizedMessage
 * @param {object} [deps]
 * @param {object} [deps.repo] bridges repository (tests)
 * @param {import("./mentions").MentionLookup} [deps.mentionLookup]
 * @returns {{ enqueued: true, outboxId: number }|null}
 */
function enqueueBridgeMessage(message, deps = {}) {
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

    // Types: DEFAULT and REPLY only; Discord system messages are type 0 with
    // the `system` duck flag — they never copy (spec §10.5).
    if (message.system === true) return null;
    if (message.type != null && !RELAYABLE_TYPES.has(message.type)) return null;

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

    const row = repo.enqueueBridgeOutbox(bridge.id, {
      direction,
      kind: "create",
      srcMessageId: messageId,
      payload,
    });
    return { enqueued: true, outboxId: Number(row.id) };
  } catch (err) {
    if (err?.code === "bridge_outbox_duplicate") return null; // idempotent replay
    console.error("[bridge] enqueue failed:", err?.message || err);
    return null;
  }
}

module.exports = {
  DESTINATION_TTL_MS,
  CONNECT_GRACE_MS,
  deploymentKey,
  reloadRelayMaps,
  refreshRelayMaps,
  registerRelayWebhookId,
  setBotUserId,
  noteRelayedDestination,
  clearRelayState,
  isRelayedEcho,
  createLoopGate,
  isBridgeCommandLine,
  relayDirectionForEnd,
  mentionLookupFromMessage,
  buildReplyHeader,
  buildRelayPayload,
  enqueueBridgeMessage,
};
