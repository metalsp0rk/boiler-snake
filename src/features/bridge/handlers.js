/**
 * /bridge handlers (roadmap/bridge.md §10.2 "Replies", PR 4 + PR 7 activation).
 *
 * The ONE reply site for the bridge (spec § Architecture: "handlers.js is the
 * only reply site"). The service decides what to say (`{ ok:false, error }`
 * carries the verbatim §10.2 sentence); this file only maps the
 * CommandContext onto service arguments and the service result onto replies.
 *
 * Surfaces wired by PR 7 (the activation PR):
 *  - Discord slash `/bridge …` (unchanged routing; the handlers gained the
 *    BRIDGE_ENABLED command-time rejection and the production activator).
 *  - Fluxer guild `!bridge …` — the SHIPPED prefix dispatcher (dispatch.js)
 *    routes the line to this context handler (KD 17: single entry, no second
 *    listener). Guild-channel `connect` runs the service's burn path via:
 *    "guild" (§10.1): a credential pasted in a channel is destroyed, never used.
 *  - Fluxer DM `!bridge connect <code> <channel>` via handleDmMessage — the
 *    §10.3 ingestion consumer (via: "dm", invocationChannelId null: the
 *    allow-list is skipped, the target is still checked; §10.2).
 *
 * Import posture (AGENTS.md / spec §10.13): ZERO discord.js and ZERO
 * Fluxer SDK core imports — the handler speaks only the platform-neutral
 * CommandContext vocabulary, the SDK-free fluxer adapter modules
 * (commands parser, permissions), and the bridge's own config module.
 * All platform access reaches the service through the injected `deps` seam
 * below, built from `featureCtx.supervisor`.
 *
 * All Discord replies are `sensitive: true` (ephemeral on the Discord adapter,
 * spec §10.2 "Replies"): the create credential may never be a public message.
 * The one public piece is the connect NOTICE, which names only the handle and
 * the direction — never the far channel id (spec §10.10).
 */

const service = require("./service");
const { getCommunityById, getCommunityByExternal } = require("../../platform/community");
const { NO_PING } = require("./mentions");
const { createDiscordWebhooks } = require("../../platform/discord/webhooks");
const { createFluxerWebhooks } = require("../../platform/fluxer/webhooks");
const { parsePrefix } = require("../../platform/fluxer/commands");
const {
  computeChannelPermissions,
  parsePermissionsBits,
  resolveFluxerPermissions,
} = require("../../platform/fluxer/permissions");
const { getFluxerCommandPrefix } = require("../../config");
const { isBridgeEnabled } = require("./config");

/**
 * The DM-side usage sentence for `!bridge connect` (spec §10.2 "Fluxer
 * connect is a DM": `!bridge connect <code> <channel>` — the channel argument
 * is required, a DM has no current channel). One source, used by every DM
 * guidance reply so the grammar never drifts from the spec form.
 * @param {string} prefix the live command prefix (K1, read at call time)
 */
function dmUsageText(prefix) {
  return (
    `DMs run one bridge command: ${prefix}bridge connect <code> <channel>. ` +
    "Paste the BRG- code from bridge create, then the id of the Fluxer " +
    "channel to pair with the bridged Discord channel."
  );
}

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
function memberMaskFor(guild, userId, channel) {
  return (async () => {
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
  })();
}

/**
 * The bot's channel-scoped mask on a channel (§10.7 step 5 probe).
 * @returns {Promise<bigint|string>} mask, or the "unmeasurable" sentinel
 */
function botMaskFor(guild, client, channel) {
  return (async () => {
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
  })();
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
 *
 * PR 7: `ctx` may be null — the DM surface (handleDmMessage) supplies a
 * synthetic context for the target channel, so this resolver never runs for a
 * DM (the community is Fluxer). The invoker-mask block is guarded on ctx's
 * ids, so a null ctx simply yields the "unresolvable" invoker mask.
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
    if (ctx && community.id === ctx.communityId) {
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
 * The Fluxer channel's §10.9 "hidden from @everyone" fact: a VIEW_CHANNEL
 * DENY on the @everyone overwrite (Phase 0: the everyone role id equals the
 * guild id; the wire overwrite field is `type`, allow/deny are decimal
 * strings — parsed through parsePermissionsBits, never BigInt() directly).
 * @returns {boolean}
 */
function everyoneDeniedViewFluxer(channelRecord, guild) {
  try {
    if (!guild || guild.id == null) return false;
    const everyoneId = String(guild.id);
    for (const ow of Array.isArray(channelRecord?.permissionOverwrites) ? channelRecord.permissionOverwrites : []) {
      if (ow && String(ow.id) === everyoneId) {
        const deny = parsePermissionsBits(ow.deny);
        if ((deny & VIEW_CHANNEL) === VIEW_CHANNEL) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * deps.resolveChannel for the FLUXER surface (PR 7): reads the channel over
 * the instance's REST facade (type / nsfw / permission_overwrites live on the
 * REST channel record), pins the channel to the community's guild (same
 * isolation rule as the Discord resolver: a foreign-guild id is "not found"),
 * and computes the invoker/bot permission MASKS with the shipped adapter
 * algorithm (computeChannelPermissions over the member, guild, roles, and the
 * channel's overwrites). Fail-closed on every unreadable shape:
 * "unresolvable" (no member record) / "unmeasurable" (no bot member record) —
 * the service maps both to their specific §10.2 sentences.
 *
 * ctx is the command context of the SURFACE (guild prefix: the dispatcher's
 * ctx; DM connect: the synthetic ctx handleDmMessage builds, whose channelId
 * is the target channel and whose channelPermissions are the DM author's
 * computed mask — the authoritative path in the invoker block below).
 */
function makeFluxerResolveChannel(ctx, supervisor) {
  return async function resolveChannelFluxer(community, channelId) {
    const id = String(channelId ?? "").trim();
    let handle = null;
    try {
      handle = supervisor?.fluxer?.get?.(community?.instanceKey) ?? null;
    } catch {
      handle = null;
    }
    if (!handle || typeof handle.rest?.request !== "function") {
      return {
        ok: false,
        error: `this process has no Fluxer client for instance ${community?.instanceKey ?? "unknown"}, so channel ${id} can't be read`,
      };
    }
    const outbound = handle.outbound ?? null;
    const safeFetchMember = async (userId) => {
      if (!outbound || typeof outbound.fetchMember !== "function") return null;
      try {
        return (await outbound.fetchMember(community.id, String(userId))) ?? null;
      } catch {
        return null;
      }
    };

    let roles = [];
    if (outbound && typeof outbound.fetchRoles === "function") {
      try {
        roles = (await outbound.fetchRoles(community.id)) ?? [];
      } catch {
        roles = [];
      }
    }
    let guild = null;
    if (typeof handle.fetchGuild === "function") {
      try {
        guild = (await handle.fetchGuild(String(community.externalGuildId))) ?? null;
      } catch {
        guild = null;
      }
    }

    // The REST channel record is the source for type / nsfw / permission_overwrites.
    let raw = null;
    try {
      raw = await handle.rest.request("GET", `/v1/channels/${encodeURIComponent(id)}`);
    } catch (err) {
      return { ok: false, error: `channel ${id}: ${err?.message || err}` };
    }
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: `channel ${id} not found on instance ${community?.instanceKey ?? "unknown"}` };
    }
    // Resolved THROUGH the community's guild: a channel of any other guild
    // (or a DM) is "not found" for this community.
    const guildId = String(raw.guild_id ?? raw.guildId ?? "");
    if (guildId !== String(community.externalGuildId)) {
      return {
        ok: false,
        error: `channel ${id} is not a channel of guild ${community.externalGuildId} on instance ${community.instanceKey}`,
      };
    }
    const channelRecord = {
      id,
      permissionOverwrites: Array.isArray(raw.permission_overwrites) ? raw.permission_overwrites : null,
    };

    // Invoker mask: authoritative on ctx for the invocation channel (dispatch
    // step 2.5 computed the real mask; the DM surface supplies the author's
    // computed mask the same way); a member-record compute on any other
    // channel of the invoker's own community. Skipped for foreign communities.
    let invokerPermissions = "unresolvable";
    if (ctx && Number.isSafeInteger(community.id) && community.id === ctx.communityId) {
      if (String(id) === String(ctx.channelId)) {
        invokerPermissions = ctx.channelPermissions ?? 0n;
      } else {
        const invokerMember = await safeFetchMember(ctx.userId);
        invokerPermissions = invokerMember
          ? computeChannelPermissions(
              {
                member: { id: String(invokerMember.id), roleIds: invokerMember.roleIds ?? [] },
                guild,
                channel: channelRecord,
                roles,
              },
              community.instanceKey,
            )
          : "unresolvable";
      }
    }

    // Bot mask via the bot's own member record (fail-closed "unmeasurable").
    let botPermissions = "unmeasurable";
    const botId = handle.userId != null ? String(handle.userId) : null;
    if (botId != null) {
      const botMember = await safeFetchMember(botId);
      if (botMember) {
        try {
          botPermissions = computeChannelPermissions(
            {
              member: { id: String(botMember.id), roleIds: botMember.roleIds ?? [] },
              guild,
              channel: channelRecord,
              roles,
            },
            community.instanceKey,
          );
        } catch {
          botPermissions = "unmeasurable";
        }
      }
    }

    return {
      ok: true,
      channel: {
        type: Number(raw.type ?? 0),
        nsfw: raw.nsfw === true,
        everyoneDeniedView: everyoneDeniedViewFluxer(channelRecord, guild),
        invokerPermissions,
        botPermissions,
      },
    };
  };
}

/**
 * deps.resolveChannel for a mixed-platform command: the target community's
 * platform picks the resolver (create runs where the staff member stands;
 * connect additionally resolves the PEER end's community — the other platform).
 */
function makeResolveChannelAnyPlatform(ctx, supervisor) {
  const discordResolver = makeResolveChannel(ctx, supervisor);
  const fluxerResolver = makeFluxerResolveChannel(ctx, supervisor);
  return function resolveChannel(community, channelId) {
    if (community?.platform === "fluxer") return fluxerResolver(community, channelId);
    return discordResolver(community, channelId);
  };
}

/**
 * The `{cmd}` token in every §10.2 sentence: "/bridge" on the Discord slash,
 * "{prefix}bridge" on the Fluxer prefix (K1 prefix read at call time — the
 * operator's configured prefix, never a hardcoded "!").
 */
function surfaceCmdFor(ctx) {
  return ctx && ctx.platform === "fluxer" ? `${getFluxerCommandPrefix()}bridge` : "/bridge";
}

/**
 * deps.sendMessage: post a plain notice in one community channel through the
 * supervisor's OutboundClient (used by disconnect's in-channel notice and by
 * the DM connect path's target-channel notice). Mention-pinned: notices must
 * never ping.
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
    resolveChannel: makeResolveChannelAnyPlatform(ctx, supervisor),
    sendMessage: makeSendMessage(supervisor),
    webhookApiFor: (platform, instanceKey) => webhookApiFor(supervisor, platform, instanceKey),
    keyGetter: () => process.env.BRIDGE_TOKEN_KEY,
    // PR 7 (KD 22 lifted): the real §10.7 step-8 activator. Production
    // connect now flips pending → active; the service still refuses with the
    // relay-not-wired sentence when NO activator is injected (unit tests, and
    // the service's own fail-closed defense-in-depth).
    activateBridge: (dbHandle, args) => service.activateBridgeTx(dbHandle, args),
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

async function handleCreate(ctx, featureCtx, surfaceCmd) {
  const result = await service.createBridge({
    community: getCommunityById(ctx.communityId),
    invocationChannelId: ctx.channelId || null,
    targetChannelId: ctx.options.getChannel("channel")?.id ?? ctx.channelId ?? null,
    direction: ctx.options.getString("direction") ?? "both",
    actorUserId: ctx.userId,
    surfaceCmd,
    staff: staffFacts(ctx),
    deps: buildDeps(ctx, featureCtx),
  });
  if (!result.ok) return ctx.reply({ content: result.error, sensitive: true });
  return ctx.reply({
    content: createSuccessText(result, ctx.options.getString("direction")),
    sensitive: true,
  });
}

/**
 * The connect verb on every surface (§10.2). `via` records the ingestion
 * surface for audit and for the service's burn-path semantics:
 *  - "slash"  — Discord slash (ctx from the router)
 *  - "guild"  — Fluxer guild prefix (the credential-burn path, KD 24: the
 *    posted code is destroyed, never used; anyone's paste can burn it)
 *  - "dm"     — Fluxer DM (handleDmMessage builds a synthetic ctx whose
 *    channelId is the TARGET and whose invocationChannelId is null — the
 *    §10.2 "the allow-list is skipped" rule)
 * Surface replies: the service's success sentence (+ §10.9 warnings) on the
 * invoker's reply channel, plus the public in-channel NOTICE on the target
 * (handle + direction only — never the far id, §10.10).
 */
async function handleConnect(ctx, featureCtx, surfaceCmd, via = ctx.platform === "fluxer" ? "guild" : "slash") {
  const result = await service.connectBridge({
    community: getCommunityById(ctx.communityId),
    // The DM surface sets ctx.invocationChannelId = null explicitly (§10.2:
    // "invocationChannelId null (Fluxer DM connect) skips the allow-list").
    invocationChannelId:
      ctx.invocationChannelId !== undefined ? ctx.invocationChannelId : ctx.channelId || null,
    targetChannelId: ctx.options.getChannel("channel")?.id ?? ctx.channelId ?? null,
    rawCode: ctx.options.getString("code", true),
    actorUserId: ctx.userId,
    surfaceCmd,
    via,
    staff: staffFacts(ctx),
    deps: buildDeps(ctx, featureCtx),
  });
  if (!result.ok) return ctx.reply({ content: result.error, sensitive: true });

  // The credential-burn case (§10.1 / §10.2, test 15): a guild-message connect
  // replies the service's public sentence IN the channel (not ephemeral — it
  // is the public ack) and deletes the credential message best-effort. Slash
  // and DM connects have no burn (the code never sits in a channel message).
  if (result.ok && result.burned === true) {
    let reply = { content: result.message, allowedMentions: NO_PING };
    try {
      reply = await ctx.reply(reply);
    } catch (err) {
      console.error(
        `[bridge] connect burn reply failed for bridge ${result.publicId}:`,
        err?.message || err,
      );
    }
    // Best-effort delete of the posted credential line. The shipped Fluxer
    // CommandContext exposes no message-delete surface (spec §10.9: the delete
    // is best-effort; "its absence never fails connect and is not what
    // consumes a code"). When a surface provides one, failures append the
    // §10.2 sentence to the burn reply.
    if (ctx.messageId && typeof ctx.deleteInvokingMessage === "function") {
      try {
        await ctx.deleteInvokingMessage();
      } catch (err) {
        const why = err?.message || err;
        console.error(
          `[bridge] connect burn message-delete failed for bridge ${result.publicId}:`,
          why,
        );
        // §10.2 verbatim: append the delete-failure sentence to the burn reply.
        await appendNote(reply, `I could not delete your message: ${why}.`);
      }
    }
    return reply;
  }

  // Ephemeral detail (peer ids are staff-visible only, §10.2 "Replies")…
  await ctx.reply({
    content: withWarnings(connectSuccessText(result, surfaceCmd), result.warnings),
    sensitive: true,
  });
  // …plus the public in-channel notice: handle + direction, never the far
  // channel id (spec §10.10 — "the in-channel connect notice says the channel
  // is bridged without naming the far channel"). On the DM surface ctx.followUp
  // posts it into the TARGET channel (spec: "the bot posts a notice in the
  // target channel").
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

async function handleDisconnect(ctx, featureCtx, surfaceCmd) {
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
    surfaceCmd,
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

async function handleStatus(ctx, featureCtx, surfaceCmd) {
  const handle = ctx.options.getString("bridge");
  const channelOpt = ctx.options.getChannel("channel");
  const result = service.statusBridge({
    community: getCommunityById(ctx.communityId),
    invocationChannelId: ctx.channelId || null,
    targetChannelId:
      handle != null ? channelOpt?.id ?? null : channelOpt?.id ?? ctx.channelId ?? null,
    publicId: handle,
    surfaceCmd,
    staff: staffFacts(ctx),
    deps: buildDeps(ctx, featureCtx),
  });
  if (!result.ok) return ctx.reply({ content: result.error, sensitive: true });
  const body = result.items.map(formatStatusItem).join("\n\n");
  return ctx.reply({ content: body, sensitive: true });
}

async function handleList(ctx, featureCtx, surfaceCmd) {
  const result = service.listBridges({
    community: getCommunityById(ctx.communityId),
    invocationChannelId: ctx.channelId || null,
    surfaceCmd,
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
// Entry points (registry handler name: "bridge"; DM entry for §10.10)
// ---------------------------------------------------------------------------

/** Append a best-effort note to a reply already present on a platform. */
async function appendNote(reply, text) {
  if (!reply) return;
  try {
    if (typeof reply.edit === "function") {
      const content = `${reply.content ?? ""}\n${text}`.slice(0, 2000);
      await reply.edit({ content, allowedMentions: NO_PING });
      return;
    }
  } catch (err) {
    console.error("[bridge] burn-note edit failed:", err?.message || err);
  }
  try {
    if (typeof reply.channel?.send === "function") {
      await reply.channel.send({ content: text, allowedMentions: NO_PING });
    }
  } catch (err) {
    console.error("[bridge] burn-note send failed:", err?.message || err);
  }
}

/**
 * Extract a channel id from a prefix channel argument (plain 5–20 digit id
 * or a `<#id>` mention token — both accepted forms, spec §10.2 line 219).
 * @returns {{ channelId: string }|null}
 */
function parseChannelArg(raw) {
  const m = /^(?:<#)?(\d{5,20})(?:>)?$/.exec(String(raw).trim());
  return m ? { channelId: m[1] } : null;
}

/**
 * The §10.10 "notice in the target channel" for the DM connect path, as the
 * synthetic ctx's followUp. The notice is the public half of the connect
 * reply: handle + direction, never the far id. Failure is logged, never
 * thrown (the DM reply already carries the authoritative result).
 */
async function sendTargetNotice(supervisor, community, channelId, payload) {
  let outbound = null;
  try {
    outbound = supervisor?.clientForCommunity?.(community.id) ?? null;
  } catch (err) {
    console.error(
      `[bridge] DM-connect notice: no outbound client for community ${community?.id}:`,
      err?.message || err,
    );
    return null;
  }
  if (!outbound?.sendChannel) {
    console.error(
      `[bridge] DM-connect notice skipped: no outbound client for community ${community?.id}`,
    );
    return null;
  }
  try {
    const res = await outbound.sendChannel(String(channelId), {
      content: payload?.content ?? "",
      allowedMentions: NO_PING,
    });
    if (res && res.ok === false) {
      console.error(`[bridge] DM-connect target notice failed: ${res.error}`);
    }
    return res;
  } catch (err) {
    console.error("[bridge] DM-connect target notice failed:", err?.message || err);
    return null;
  }
}

/**
 * DM connect path (spec §10.10 / §10.2: "Connect on Fluxer is a DM"). The
 * client's `onDmMessage` hook hands the normalized message (NormalizedDmMessage
 * — §10.3 delta 1; it carries NO community: a DM has none) to this entry.
 * Every reply goes back in the DM (spec: "Every reply comes back in the DM")
 * through the K2 `outbound.sendDm` path, and every reply carries a SPECIFIC
 * sentence (the service's §10.2 text for verb outcomes, the §10.10 grammar
 * guidance for the DM-only cases, the kill-switch sentence when paused).
 * Non-bridge DM text is ignored silently: "A DM that is not the bridge
 * command is ignored."
 *
 * @param {import("../../platform/fluxer/normalize").NormalizedDmMessage} dm
 * @param {{supervisor?: object}} [featureCtx]
 * @returns {Promise<unknown>} the platform send result of the final reply
 */
async function handleDmMessage(dm, featureCtx) {
  const prefix = getFluxerCommandPrefix();
  const surfaceCmd = `${prefix}bridge`;
  // Fast path first: this consumer runs on EVERY DM; non-`bridge` text is
  // ignored (mentions are passed so the K10 markup rules apply verbatim).
  if (parsePrefix(dm.content, { prefix, mentions: dm.mentions })?.commandName !== "bridge") {
    return null;
  }

  const supervisor = featureCtx?.supervisor ?? null;
  let handle = null;
  try {
    handle = supervisor?.fluxer?.get?.(dm.instanceKey) ?? null;
  } catch {
    handle = null;
  }

  // Replies ride the shipped K2 DM path (spec §10.3: outbound.sendDm).
  const send = async (content) => {
    if (!handle?.outbound?.sendDm) {
      console.error(
        `[bridge] DM reply dropped (no Fluxer outbound for instance "${dm.instanceKey}", user ${dm.authorId}): ${String(content).slice(0, 120)}`,
      );
      return null;
    }
    try {
      return await handle.outbound.sendDm(dm.authorId, { content, allowedMentions: NO_PING });
    } catch (err) {
      console.error(`[bridge] DM reply to user ${dm.authorId} failed:`, err?.message || err);
      return null;
    }
  };

  // Kill switch (Rollout: "Commands reject" — the DM surface obeys the
  // switch too, with the §10.2 kill-switch sentence, never a generic).
  if (!isBridgeEnabled()) return send(service.BRIDGE_MESSAGES.killSwitch);

  const parsed = parsePrefix(dm.content, { prefix, mentions: dm.mentions });
  if (!parsed || parsed.usageError) {
    // Specific reason first (the parser's exact grammar line), then the DM
    // usage form — never a generic "usage error".
    const reason = parsed?.usageError ? `${parsed.usageError.reason} ` : "";
    return send(`${reason}${dmUsageText(prefix)}`);
  }

  const { subcommand, options } = parsed;
  if (subcommand === "help") return send(dmUsageText(prefix));

  if (subcommand !== "connect") {
    // §10.2: the DM SURFACE is connect. create runs in the channel to bridge;
    // status/list results are delivered BY DM from the guild-channel command;
    // disconnect runs in a guild channel. Guide to the right surface.
    return send(
      `The "${subcommand}" verb runs in a guild channel: run ${surfaceCmd} ${subcommand} there (status and list results come back by DM). DMs support ${surfaceCmd} connect <code> <channel>.`,
    );
  }

  const code = String(options.find((o) => o.name === "code")?.value ?? "").trim();
  const channelArg = String(options.find((o) => o.name === "channel")?.value ?? "").trim();
  if (code === "") return send(dmUsageText(prefix));

  const ch = parseChannelArg(channelArg);
  if (!ch) {
    // §10.10: "The DM channel itself is not a valid target. The reply says
    // so specifically."
    return send(
      `The channel argument must be a channel id (5–20 digits) or a <#channel> mention from the guild channel you want to pair. The DM channel itself is not a valid target. Use ${surfaceCmd} connect <code> <channel>.`,
    );
  }

  // The target CHANNEL argument pins the community: a DM has no community
  // (§10.3: "Consumers key by (platform, instanceKey, authorId)"), so the
  // channel being paired identifies which community the DM talks about.
  if (!handle?.rest?.request || !handle?.outbound?.sendDm) {
    return send(
      `This process has no Fluxer client for ${dm.instanceKey}, so that end can't be checked or written. Fix the Fluxer endpoint and try again.`,
    );
  }

  // Channel record → guild id → community. The raw REST channel record is
  // the source (outbound.fetchChannel drops guild_id).
  let rawChannel = null;
  try {
    rawChannel = await handle.rest.request("GET", `/v1/channels/${encodeURIComponent(ch.channelId)}`);
  } catch (err) {
    return send(
      `The bot could not read channel ${ch.channelId} on instance ${dm.instanceKey}: ${err?.message || err}. Check the channel id and try again.`,
    );
  }
  if (!rawChannel || typeof rawChannel !== "object") {
    return send(
      `Channel ${ch.channelId} was not found on instance ${dm.instanceKey}, so it can't be paired. Run ${surfaceCmd} create in the channel to bridge, then connect its code to the target channel id.`,
    );
  }
  const guildId = String(rawChannel.guild_id ?? rawChannel.guildId ?? "");
  if (!/^\d{5,20}$/.test(guildId)) {
    return send(
      `Channel ${ch.channelId} is not a guild channel on instance ${dm.instanceKey}, so it can't be paired from a DM. Pass the id of a guild text channel.`,
    );
  }
  // getCommunityByExternal returns the ROW id (not the row); the rest of
  // this flow needs the row object (sendTargetNotice, service args).
  const communityId = getCommunityByExternal("fluxer", dm.instanceKey, guildId);
  const community = communityId ? getCommunityById(communityId) : null;
  if (!community) {
    return send(
      `Fluxer guild ${guildId} (the guild of channel ${ch.channelId} on instance ${dm.instanceKey}) is not registered as a community in this process, so its channels can't be paired. Ask an admin to register that guild as a community first.`,
    );
  }

  // Staff facts: the DM author's COMPUTED mask on the target channel (spec
  // §10.2 line 223: the Fluxer staff gate is Manage Guild OR staff_roles on
  // the computed bigint mask — the same gate as the guild surface, computed
  // from the author's member record). "The bot reads the guild membership of
  // the DM author": a non-member fails member resolution with the shipped
  // specific copy (service rule-1 text), never the generic fallback.
  let facts;
  try {
    facts = await resolveFluxerPermissions({
      outbound: handle.outbound,
      communityId: community.id,
      userId: String(dm.authorId),
      channelId: ch.channelId,
      instanceKey: dm.instanceKey,
    });
  } catch (err) {
    console.error(
      `[bridge] DM-connect permission resolve threw for channel ${ch.channelId} (instance ${dm.instanceKey}):`,
      err?.message || err,
    );
    facts = {
      ok: false,
      error: `The bot could not check your permissions in channel ${ch.channelId}: ${err?.message || err}. Try again, or run the command in the guild channel.`,
    };
  }
  if (!facts.ok) return send(facts.error);

  // Synthetic command context: the DM author "stands" at the TARGET channel
  // (the invoker-view probe, the staff mask, and the audit actor all resolve
  // from it). invocationChannelId null → the service skips the command-channel
  // allow-list (§10.2 line 221). The service's own §10.2 sentence drives the
  // reply; the DM send is the surface's reply channel.
  const dmCtx = {
    platform: "fluxer",
    instanceKey: dm.instanceKey,
    communityId: community.id,
    channelId: ch.channelId,
    invocationChannelId: null,
    userId: String(dm.authorId),
    memberRoleIds: facts.memberRoleIds,
    channelPermissions: facts.channelPermissions,
    subcommand: "connect",
    options: {
      getString: (name) => (name === "code" ? code : null),
      getChannel: (name) => (name === "channel" ? { id: ch.channelId } : null),
    },
    reply: async (payload) => send(String(payload?.content ?? "")),
    followUp: (payload) => sendTargetNotice(supervisor, community, ch.channelId, payload),
  };
  return handleConnect(dmCtx, featureCtx, surfaceCmd, "dm");
}

/**
 * Guild-surface entry: Discord slash contexts AND the shipped prefix
 * dispatcher (Fluxer guild channels — `!bridge …`, KD 17: single entry,
 * no second listener).
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleBridge(commandCtx, featureCtx) {
  // Kill switch first (Rollout): "The command checks BRIDGE_ENABLED at
  // command time." Every subcommand, both platforms.
  if (!isBridgeEnabled()) {
    await commandCtx.reply({ content: service.BRIDGE_MESSAGES.killSwitch, sensitive: true });
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

  const surfaceCmd = surfaceCmdFor(commandCtx);
  const sub = commandCtx.subcommand;
  if (sub === "create") return handleCreate(commandCtx, featureCtx, surfaceCmd);
  if (sub === "connect") return handleConnect(commandCtx, featureCtx, surfaceCmd);
  if (sub === "disconnect") return handleDisconnect(commandCtx, featureCtx, surfaceCmd);
  if (sub === "status") return handleStatus(commandCtx, featureCtx, surfaceCmd);
  if (sub === "list") return handleList(commandCtx, featureCtx, surfaceCmd);

  await commandCtx.reply({
    content: `Unknown subcommand: \`${sub}\``,
    sensitive: true,
  });
}

module.exports = {
  handleBridge,
  handleDmMessage,
  // exported for tests:
  createSuccessText,
  connectSuccessText,
  staffFacts,
  maskOf,
  isoUtc,
};
