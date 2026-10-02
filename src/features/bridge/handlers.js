/**
 * /bridge handlers (roadmap/bridge.md §10.2 "Replies", PR 4).
 *
 * The ONE reply site for the bridge (spec § Architecture: "handlers.js is the
 * only reply site"). The service decides what to say (`{ ok:false, error }`
 * carries the verbatim §10.2 sentence); this file only maps the
 * CommandContext onto service arguments and the service result onto replies.
 *
 * Import posture (AGENTS.md / spec §10.13): ZERO discord.js and ZERO
 * Fluxer SDK core imports — the handler speaks only the platform-neutral
 * CommandContext vocabulary. All platform access reaches the service through
 * the injected `deps` seam below, built from `featureCtx.supervisor`.
 *
 * All Discord replies are `sensitive: true` (ephemeral on the Discord adapter,
 * spec §10.2 "Replies"): the create credential may never be a public message.
 * The one public piece is the connect NOTICE follow-up, which names only the
 * handle and the direction — never the far channel id (spec §10.10).
 */

const service = require("./service");
const { getCommunityById } = require("../../platform/community");
const { NO_PING } = require("./mentions");
const { createDiscordWebhooks } = require("../../platform/discord/webhooks");
const { createFluxerWebhooks } = require("../../platform/fluxer/webhooks");

/**
 * Fluxer guild channels in PR 4 (spec PR plan: `!bridge` replies "not
 * available on Fluxer yet" until the activation PR).
 */
const MSG_FLUXER_NOT_AVAILABLE = "Bridge commands are not available on Fluxer yet.";

// Permission bits (Discord numbering; BigInt masks). Local constants because
// importing PermissionFlagsBits from discord.js is forbidden for this module.
const MANAGE_GUILD = 1n << 5n;
const VIEW_CHANNEL = 1n << 10n;

// ---------------------------------------------------------------------------
// Context → service argument mapping
// ---------------------------------------------------------------------------

/**
 * The staff facts the service re-checks (the slash picker is visibility-only;
 * handlers are the security source of truth). Manage Guild comes out of the
 * invoker's channel-scoped permission mask.
 * @param {import("../../platform/context").CommandContext} ctx
 * @returns {{ hasManageGuild: boolean, memberRoleIds: string[] }}
 */
function staffFacts(ctx) {
  let hasManageGuild = false;
  try {
    hasManageGuild = (BigInt(ctx.channelPermissions ?? 0n) & MANAGE_GUILD) === MANAGE_GUILD;
  } catch {
    hasManageGuild = false;
  }
  return {
    hasManageGuild,
    memberRoleIds: Array.isArray(ctx.memberRoleIds) ? ctx.memberRoleIds.map(String) : [],
  };
}

/**
 * Reduce a discord.js PermissionsBitField-shaped value (real: `.bitfield`
 * bigint; duck-typed mocks: `.has()`) to a BigInt mask. Unreadable shapes
 * become a sentinel STRING: BigInt("<sentinel>") throws inside the service's
 * toBitMask, which is exactly how the service distinguishes "mask is zero"
 * from "mask could not be read" (§10.2 bot-perms-unreadable sentence).
 *
 * @param {unknown} permLike
 * @returns {bigint|string}
 */
function maskOf(permLike) {
  if (permLike == null) return "unmeasurable";
  if (typeof permLike.bitfield === "bigint") return permLike.bitfield;
  if (typeof permLike.has === "function") {
    let mask = 0n;
    for (const bit of [1n << 3n, MANAGE_GUILD, VIEW_CHANNEL, 1n << 11n, 1n << 14n, 1n << 15n, 1n << 28n]) {
      try {
        if (permLike.has(bit)) mask |= bit;
      } catch {
        // has() throwing on a specific bit: treat that bit as not granted.
      }
    }
    return mask;
  }
  return "unmeasurable";
}

/**
 * The invoker's channel-scoped mask for a channel other than the invocation
 * channel (the invocation channel's mask is authoritative on ctx already).
 * @returns {Promise<bigint|string>} mask, or the "unresolvable" sentinel
 */
async function memberMaskFor(guild, userId, channel) {
  try {
    let member = guild.members?.cache?.get?.(String(userId)) ?? null;
    if (!member && typeof guild.members?.fetch === "function") {
      member = await guild.members.fetch(String(userId)).catch(() => null);
    }
    if (!member) return "unresolvable";
    if (typeof channel.permissionsFor !== "function") return "unmeasurable";
    return maskOf(channel.permissionsFor(member));
  } catch {
    return "unresolvable";
  }
}

/**
 * The bot's channel-scoped mask on a channel (§10.7 step 5 probe).
 * @returns {Promise<bigint|string>} mask, or the "unmeasurable" sentinel
 */
async function botMaskFor(guild, client, channel) {
  if (typeof channel.permissionsFor !== "function") return "unmeasurable";
  try {
    let me = guild.members?.me ?? null;
    if (!me && client?.user?.id && typeof guild.members?.fetch === "function") {
      me = await guild.members.fetch(String(client.user.id)).catch(() => null);
    }
    if (!me) return "unmeasurable";
    return maskOf(channel.permissionsFor(me));
  } catch {
    return "unmeasurable";
  }
}

/**
 * True when @everyone is DENIED View Channel on this channel's overwrites
 * (the "private channel" half of the §10.7 step-2 warning pair).
 * @returns {boolean}
 */
function everyoneDeniedView(channel, guild) {
  try {
    const everyoneId = String(guild.roles?.everyone?.id ?? guild.id);
    const ow = channel.permissionOverwrites?.cache?.get?.(everyoneId);
    if (!ow) return false;
    const deny = BigInt(ow.deny ?? 0n);
    return (deny & VIEW_CHANNEL) === VIEW_CHANNEL;
  } catch {
    return false;
  }
}

/**
 * deps.resolveChannel for the Discord surface: guild + channel lookup with
 * the §10.7 probe facts attached (type, nsfw, @everyone view, invoker mask,
 * bot mask). Channel ids are resolved THROUGH the community's guild, so a
 * foreign-guild id reads as "not found" (same isolation as fetchMessage).
 */
function makeResolveChannel(ctx, supervisor) {
  return async function resolveChannel(community, channelId) {
    const client = supervisor?.discord ?? null;
    if (!client) {
      return { ok: false, error: "this process has no Discord client" };
    }
    if (community?.platform !== "discord") {
      return {
        ok: false,
        error: `the Discord command surface cannot read ${community?.platform ?? "unknown"} channels`,
      };
    }
    let guild = client.guilds?.cache?.get?.(community.externalGuildId) ?? null;
    if (!guild && typeof client.guilds?.fetch === "function") {
      guild = await client.guilds.fetch(community.externalGuildId).catch(() => null);
    }
    if (!guild) {
      return {
        ok: false,
        error: `guild ${community.externalGuildId} is not available to the bot (cache read and API fetch both failed)`,
      };
    }
    let channel = null;
    try {
      channel = (await guild.channels.fetch(String(channelId))) ?? null;
    } catch (err) {
      return { ok: false, error: `channel ${channelId}: ${err?.message || err}` };
    }
    if (!channel) {
      return {
        ok: false,
        error: `channel ${channelId} not found in guild ${community.externalGuildId}`,
      };
    }

    // Invoker view mask: authoritative on the invocation channel; member
    // lookup on any other channel of the invoker's own community. Never
    // attempted for the peer community (the service does not gate views there).
    let invokerPermissions = "unresolvable";
    if (community.id === ctx.communityId) {
      invokerPermissions =
        String(channelId) === String(ctx.channelId)
          ? ctx.channelPermissions ?? 0n
          : await memberMaskFor(guild, ctx.userId, channel);
    }

    return {
      ok: true,
      channel: {
        type: Number(channel.type),
        nsfw: channel.nsfw === true,
        everyoneDeniedView: everyoneDeniedView(channel, guild),
        invokerPermissions,
        botPermissions: await botMaskFor(guild, client, channel),
      },
    };
  };
}

/**
 * deps.sendMessage: post a plain notice in one community channel through the
 * supervisor's OutboundClient (used by disconnect's in-channel notice).
 * Mention-pinned: notices must never ping.
 */
function makeSendMessage(supervisor) {
  return async function sendMessage(communityId, channelId, content) {
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
      return await outbound.sendChannel(String(channelId), { content, allowedMentions: NO_PING });
    } catch (err) {
      return { ok: false, error: `send to channel ${channelId} failed: ${err?.message || err}` };
    }
  };
}

/**
 * deps.webhookApiFor: the webhook lifecycle pair for one community, built
 * from the supervisor (spec §10.3: adapter modules, bridge-free). Synchronous
 * by contract with the service (the connect path awaits the API object, never
 * a promise of one). apiOrigin defaults to "" — create (the only connect-path
 * method) rides the bot-authorized rest facade; token endpoints are PR 5.
 */
function webhookApiFor(supervisor, platform, instanceKey) {
  if (!supervisor) return null;
  if (platform === "discord") {
    if (!supervisor.discord) return null;
    try {
      return createDiscordWebhooks(supervisor.discord);
    } catch (err) {
      console.error("[bridge] Discord webhook api build failed:", err?.message || err);
      return null;
    }
  }
  if (platform === "fluxer") {
    let handle = null;
    try {
      handle = supervisor.fluxer?.get?.(instanceKey) ?? null;
    } catch {
      handle = null;
    }
    if (!handle) return null;
    try {
      return createFluxerWebhooks({ rest: handle.rest, apiOrigin: "" });
    } catch (err) {
      console.error(`[bridge] Fluxer webhook api build failed for ${instanceKey}:`, err?.message || err);
      return null;
    }
  }
  return null;
}

/**
 * Assemble the injected seam the service consumes (spec § Service: "outbound
 * functions are injected so unit tests pass fakes").
 * @param {import("../../platform/context").CommandContext} ctx
 * @param {object} featureCtx
 */
function buildDeps(ctx, featureCtx) {
  const supervisor = featureCtx?.supervisor ?? null;
  return {
    resolveChannel: makeResolveChannel(ctx, supervisor),
    sendMessage: makeSendMessage(supervisor),
    webhookApiFor: (platform, instanceKey) => webhookApiFor(supervisor, platform, instanceKey),
    keyGetter: () => process.env.BRIDGE_TOKEN_KEY,
    // PR 4 (KD 22): NO activateBridge is injected — the service refuses
    // connect with the relay-not-wired sentence before any webhook create.
  };
}

// ---------------------------------------------------------------------------
// Reply text composition (§10.2 "Replies"; the service owns every error sentence)
// ---------------------------------------------------------------------------

/** ISO timestamp without the zone suffix, for "{iso} UTC" sentences. */
function isoUtc(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return String(ms);
  return new Date(n).toISOString().replace(/Z$/, "");
}

function createSuccessText(result, rawDirection) {
  const direction =
    typeof rawDirection === "string" && rawDirection.trim() !== ""
      ? rawDirection.trim().toLowerCase()
      : "both";
  return (
    `Bridge ${result.publicId}. Connect will not accept that handle. ` +
    `Connect credential, shown once, expires ${isoUtc(result.expiresAt)} UTC: ${result.code}. ` +
    "On Discord the other side runs /bridge connect with the credential. " +
    "On Fluxer they DM the bot: !bridge connect <credential> <channel>. " +
    "The credential is the capability. Do not post it in a channel. " +
    "The handle is safe to post. " +
    `Direction: ${direction}.`
  );
}

function connectSuccessText(result, surfaceCmd) {
  return (
    `Connected bridge ${result.publicId}. This channel is paired with ` +
    `${result.peer.platformLabel} (${result.peer.instanceKey}) channel ${result.peer.channelId}. ` +
    `Messages flow ${result.directionLabel}. The connect credential is spent. ` +
    "People in the receiving channel will be able to read what the source side posts, " +
    `including edits and deletions. Stop it with ${surfaceCmd} disconnect.`
  );
}

function withWarnings(content, warnings) {
  const list = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
  return list.length ? `${content}\n${list.join("\n")}` : content;
}

function formatStatusItem(item) {
  const lines = [
    `Bridge ${item.publicId} — state: ${item.state}, direction: ${item.directionLabel}.`,
    `  outbox: a→b ${item.outboxDepth.a_to_b}, b→a ${item.outboxDepth.b_to_a}; spool: ${item.spoolBytes} bytes`,
  ];
  for (const end of item.ends) {
    lines.push(`  end ${end.position}: ${end.platform} (${end.instanceKey}) channel ${end.channelId}`);
  }
  if (item.lastError) lines.push(`  last error: ${item.lastError}`);
  if (item.state === "pending" && item.expiresAt != null) {
    lines.push(`  pairing expires: ${isoUtc(item.expiresAt)} UTC`);
  }
  if (item.connectedAt != null) {
    lines.push(`  connected: ${isoUtc(item.connectedAt)} UTC`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Subcommand handlers (all Discord replies ephemeral: sensitive: true)
// ---------------------------------------------------------------------------

async function handleCreate(ctx, featureCtx) {
  const result = await service.createBridge({
    community: getCommunityById(ctx.communityId),
    invocationChannelId: ctx.channelId || null,
    targetChannelId: ctx.options.getChannel("channel")?.id ?? ctx.channelId ?? null,
    direction: ctx.options.getString("direction") ?? "both",
    actorUserId: ctx.userId,
    surfaceCmd: "/bridge",
    staff: staffFacts(ctx),
    deps: buildDeps(ctx, featureCtx),
  });
  if (!result.ok) return ctx.reply({ content: result.error, sensitive: true });
  return ctx.reply({
    content: createSuccessText(result, ctx.options.getString("direction")),
    sensitive: true,
  });
}

async function handleConnect(ctx, featureCtx) {
  const result = await service.connectBridge({
    community: getCommunityById(ctx.communityId),
    invocationChannelId: ctx.channelId || null,
    targetChannelId: ctx.options.getChannel("channel")?.id ?? ctx.channelId ?? null,
    rawCode: ctx.options.getString("code", true),
    actorUserId: ctx.userId,
    surfaceCmd: "/bridge",
    via: "slash",
    staff: staffFacts(ctx),
    deps: buildDeps(ctx, featureCtx),
  });
  if (!result.ok) return ctx.reply({ content: result.error, sensitive: true });

  // Ephemeral detail (peer ids are staff-visible only, §10.2 "Replies")…
  await ctx.reply({
    content: withWarnings(connectSuccessText(result, "/bridge"), result.warnings),
    sensitive: true,
  });
  // …plus the public in-channel notice: handle + direction, never the far
  // channel id (spec §10.10 — "the in-channel connect notice says the channel
  // is bridged without naming the far channel").
  try {
    await ctx.followUp?.({
      content: `Bridge ${result.publicId} connected. Direction: ${result.directionLabel}.`,
      allowedMentions: NO_PING,
    });
  } catch (err) {
    console.error(
      `[bridge] connect notice follow-up failed for bridge ${result.publicId}:`,
      err?.message || err,
    );
  }
  return undefined;
}

async function handleDisconnect(ctx, featureCtx) {
  const handle = ctx.options.getString("bridge");
  const channelOpt = ctx.options.getChannel("channel");
  // No explicit argument: the invocation channel is the local channel.
  const targetChannelId =
    handle != null ? null : channelOpt?.id ?? ctx.channelId ?? null;

  const result = await service.disconnectBridge({
    community: getCommunityById(ctx.communityId),
    invocationChannelId: ctx.channelId || null,
    targetChannelId,
    publicId: handle,
    actorUserId: ctx.userId,
    surfaceCmd: "/bridge",
    staff: staffFacts(ctx),
    deps: buildDeps(ctx, featureCtx),
  });
  if (!result.ok) return ctx.reply({ content: result.error, sensitive: true });
  return ctx.reply({
    content: withWarnings(
      `Disconnected bridge ${result.publicId}. Both channels are released.`,
      result.warnings,
    ),
    sensitive: true,
  });
}

async function handleStatus(ctx, featureCtx) {
  const handle = ctx.options.getString("bridge");
  const channelOpt = ctx.options.getChannel("channel");
  const result = service.statusBridge({
    community: getCommunityById(ctx.communityId),
    invocationChannelId: ctx.channelId || null,
    targetChannelId:
      handle != null ? channelOpt?.id ?? null : channelOpt?.id ?? ctx.channelId ?? null,
    publicId: handle,
    surfaceCmd: "/bridge",
    staff: staffFacts(ctx),
    deps: buildDeps(ctx, featureCtx),
  });
  if (!result.ok) return ctx.reply({ content: result.error, sensitive: true });
  const body = result.items.map(formatStatusItem).join("\n\n");
  return ctx.reply({ content: body, sensitive: true });
}

async function handleList(ctx, featureCtx) {
  const result = service.listBridges({
    community: getCommunityById(ctx.communityId),
    invocationChannelId: ctx.channelId || null,
    surfaceCmd: "/bridge",
    staff: staffFacts(ctx),
    deps: buildDeps(ctx, featureCtx),
  });
  if (!result.ok) return ctx.reply({ content: result.error, sensitive: true });
  if (!result.items.length) {
    return ctx.reply({ content: result.emptyMessage, sensitive: true });
  }
  return ctx.reply({
    content: result.items.map(formatStatusItem).join("\n\n"),
    sensitive: true,
  });
}

// ---------------------------------------------------------------------------
// Entry point (registry handler name: "bridge")
// ---------------------------------------------------------------------------

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleBridge(commandCtx, featureCtx) {
  // Fluxer guild channels: the shipped prefix dispatcher routes `!bridge …`
  // here (registry handlerApi: "context"). PR 4 is Discord-only.
  if (commandCtx.platform !== "discord") {
    await commandCtx.reply({ content: MSG_FLUXER_NOT_AVAILABLE, sensitive: true });
    return;
  }

  if (!Number.isSafeInteger(commandCtx.communityId) || !getCommunityById(commandCtx.communityId)) {
    await commandCtx.reply({
      content:
        "This guild is not registered as a community in this process, so bridges cannot be managed here.",
      sensitive: true,
    });
    return;
  }

  const sub = commandCtx.subcommand;
  if (sub === "create") return handleCreate(commandCtx, featureCtx);
  if (sub === "connect") return handleConnect(commandCtx, featureCtx);
  if (sub === "disconnect") return handleDisconnect(commandCtx, featureCtx);
  if (sub === "status") return handleStatus(commandCtx, featureCtx);
  if (sub === "list") return handleList(commandCtx, featureCtx);

  await commandCtx.reply({
    content: `Unknown subcommand: \`${sub}\``,
    sensitive: true,
  });
}

module.exports = {
  handleBridge,
  // exported for tests:
  createSuccessText,
  connectSuccessText,
  staffFacts,
  maskOf,
  isoUtc,
  MSG_FLUXER_NOT_AVAILABLE,
};
