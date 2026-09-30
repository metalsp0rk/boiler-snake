/**
 * Discord OutboundClient (roadmap/fluxer.md § Outbound client).
 *
 * The adapter the tickers and services call in place of raw discord.js
 * objects. Every method is keyed the way the spec types it: guild-scoped
 * methods take an internal numeric `communityId` (resolved through the
 * `communities` registry to the Discord snowflake), channel-scoped methods
 * take the external channel id directly.
 *
 * Contract (AGENTS.md § Error Handling 6):
 * - Expected platform failures (missing guild/channel/message, Discord API
 *   errors) resolve to `{ ok: false, error }` with a specific, actionable
 *   message — never an uncaught throw, never a reply to Discord.
 * - `assertCommunityId` violations DO throw: a snowflake passed where a
 *   community id belongs is a programmer error; the router catches those.
 * - Fetch methods resolve the null/[] shapes of the typedef and log their
 *   cause with context (AGENTS.md § Error Handling 2).
 *
 * Hard rule (spec line 425): the Discord path NEVER reads the community
 * capability flags (elevated / voice-state completeness columns). Role sync
 * keeps running through the discord.js member objects exactly as awardXp
 * does today; those columns belong to the Fluxer outbound only.
 */

const { assertCommunityId, getCommunityById } = require("../community");

/** ChannelOverwrite.kind → discord.js OverwriteType (0 = role, 1 = member). */
const OVERWRITE_KIND_TYPES = Object.freeze({ role: 0, member: 1 });

/**
 * Specific, human-readable cause for an unknown thrown value.
 * @param {unknown} err
 * @returns {string}
 */
function causeOf(err) {
  return String(err?.message || err);
}

/**
 * Discord API error code as a decimal string ("50013"), when present.
 * The OutboundClient typedef types `code` as a string; discord.js exposes a
 * number on DiscordAPIError, so it is stringified at this boundary.
 * @param {unknown} err
 * @returns {string|undefined}
 */
function codeOf(err) {
  return err?.code != null ? String(err.code) : undefined;
}

/**
 * Allow/deny bit expressions arrive as decimal strings (spec § Outbound
 * client). Discord accepts bitfields, so convert to BigInt here. Named-flag
 * strings and numbers are accepted for the same reason the Discord adapter
 * may keep OR-ing PermissionFlagsBits locally.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {bigint}
 */
function toBitField(value, label) {
  if (value == null || value === "") return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${label} is not a safe integer: ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
    if (/^0x[0-9a-f]+$/i.test(trimmed)) return BigInt(trimmed);
    // Named discord.js flag strings ("ViewChannel") pass through untouched;
    // discord.js resolves them against its own flag table.
    return trimmed;
  }
  throw new Error(`${label} must be a decimal string, bigint, number, or flag name, got ${typeof value}`);
}

/**
 * ChannelOverwrite { id, kind, allow, deny } → discord.js overwrite shape
 * ({ id, type, allow, deny }). Throws a specific Error on a bad shape.
 * @param {object} ow
 * @param {string} context method name for the error message
 * @returns {{ id: string, type: number, allow: bigint|string, deny: bigint|string }}
 */
function toDiscordOverwrite(ow, context) {
  if (!ow || typeof ow !== "object") {
    throw new Error(`${context}: overwrite must be an object, got ${typeof ow}`);
  }
  const kind = ow.kind;
  const type = OVERWRITE_KIND_TYPES[kind];
  if (type == null) {
    throw new Error(
      `${context}: overwrite for ${ow.id ?? "<no id>"} has kind ${JSON.stringify(kind)}; expected "role" or "member"`,
    );
  }
  return {
    id: String(ow.id ?? ""),
    type,
    allow: toBitField(ow.allow, `overwrite ${ow.id ?? "<no id>"} allow`),
    deny: toBitField(ow.deny, `overwrite ${ow.id ?? "<no id>"} deny`),
  };
}

/**
 * discord.js Message → NormalizedMessage (spec: id, authorId, authorBot,
 * content, createdAt).
 * @param {object} msg
 * @returns {{ id: string, authorId: string|null, authorBot: boolean, content: string, createdAt: string|null }}
 */
function normalizeMessage(msg) {
  return {
    id: String(msg.id),
    authorId: msg.author?.id != null ? String(msg.author.id) : null,
    authorBot: Boolean(msg.author?.bot),
    content: msg.content ?? "",
    createdAt:
      msg.createdTimestamp != null
        ? new Date(Number(msg.createdTimestamp)).toISOString()
        : null,
  };
}

/**
 * Resolve communityId → Discord Guild. The communities lookup is a programmer
 * error (throw, via getCommunityById); a missing guild (bot kicked, intents
 * gap, transient API failure) is an expected failure resolved as { error }.
 *
 * @param {import("discord.js").Client} client
 * @param {number} communityId
 * @param {string} method calling method name, for specific error messages
 * @returns {Promise<{ guild: import("discord.js").Guild, externalGuildId: string }|{ error: string }>}
 */
async function lookupGuild(client, communityId, method) {
  const community = getCommunityById(communityId); // throws on non-integer ids
  if (!community) {
    return { error: `${method}: no communities row for id ${communityId}` };
  }
  if (community.platform !== "discord") {
    return {
      error: `${method}: community ${communityId} is platform "${community.platform}", not discord`,
    };
  }
  let guild = client.guilds?.cache?.get?.(community.externalGuildId) ?? null;
  if (!guild) {
    guild = await client.guilds.fetch(community.externalGuildId).catch(() => null);
  }
  if (!guild) {
    return {
      error: `${method}: guild ${community.externalGuildId} for community ${communityId} is not available to the bot (cached fetch and API fetch both failed)`,
    };
  }
  return { guild, externalGuildId: community.externalGuildId };
}

/**
 * Resolve an external channel id via the client's channel manager.
 * @param {import("discord.js").Client} client
 * @param {string} channelId
 * @param {string} method
 * @returns {Promise<{ channel: object }|{ error: string }>}
 */
async function lookupChannel(client, channelId, method) {
  const id = String(channelId);
  let channel = null;
  try {
    channel = await client.channels.fetch(id);
  } catch (err) {
    return {
      error: `${method}: channel ${id} lookup failed: ${causeOf(err)}`,
      code: codeOf(err),
    };
  }
  if (!channel) {
    return { error: `${method}: channel ${id} not found` };
  }
  return { channel };
}

/**
 * Resolve a message inside a channel (cache first, then REST).
 * @param {object} channel
 * @param {string} messageId
 * @param {string} method
 * @returns {Promise<{ message: object }|{ error: string }>}
 */
async function lookupMessage(channel, messageId, method) {
  const id = String(messageId);
  let message = channel.messages?.cache?.get?.(id) ?? null;
  if (!message) {
    try {
      message = (await channel.messages?.fetch?.(id)) ?? null;
    } catch (err) {
      return {
        error: `${method}: message ${id} in channel ${channel.id} fetch failed: ${causeOf(err)}`,
        code: codeOf(err),
      };
    }
  }
  if (!message) {
    return { error: `${method}: message ${id} in channel ${channel.id} not found` };
  }
  return { message };
}

/**
 * Fetch-shape failure: log with context, resolve the typedef's null/[] value.
 * @param {string} method
 * @param {*} detail
 * @param {unknown} err
 */
function logFetchFailure(method, detail, err) {
  console.error(`[discord-outbound] ${method} ${detail} failed: ${causeOf(err)}`);
}

/**
 * Build the Discord OutboundClient for a logged-in client.
 *
 * Implements the spec § Outbound client typedef in full:
 * platform, instanceKey, botUserId, fetchGuild, fetchChannel, fetchUser,
 * fetchMember, fetchRoles, sendChannel, sendDm, editMessage, addRole,
 * removeRole, addReaction, removeUserReaction, removeEmojiReaction,
 * createChannel, setOverwrites, banMember, fetchMessages.
 *
 * @param {import("discord.js").Client} client
 * @returns {object} OutboundClient
 */
function createDiscordOutbound(client) {
  if (!client) {
    throw new Error("createDiscordOutbound requires a Discord client");
  }

  // Ready user id (spec: "Ready user id. Not client.user."). Read lazily from
  // client.user so an outbound constructed at boot — before login — picks the
  // id up once Ready fires (the pipelines wire their outbound at boot).
  // Tickets/honeypot compare against this value.

  /**
   * @param {number} communityId
   * @param {string} userId
   * @returns {Promise<{ member: object }|{ error: string }>}
   */
  async function lookupMember(communityId, userId, method) {
    const found = await lookupGuild(client, communityId, method);
    if (found.error) return { error: found.error };
    try {
      const member = await found.guild.members.fetch(String(userId));
      if (!member) {
        return { error: `${method}: member ${userId} not found in community ${communityId}` };
      }
      return { member };
    } catch (err) {
      return {
        error: `${method}: member ${userId} in community ${communityId} fetch failed: ${causeOf(err)}`,
        code: codeOf(err),
      };
    }
  }

  const outbound = {
    platform: "discord",
    instanceKey: "discord",
    get botUserId() {
      return client.user?.id != null ? String(client.user.id) : "";
    },

    /**
     * @param {number} communityId
     * @returns {Promise<{ id: string, name: string, ownerId: string|null, afkChannelId: string|null }|null>}
     */
    async fetchGuild(communityId) {
      assertCommunityId(communityId);
      try {
        const found = await lookupGuild(client, communityId, "fetchGuild");
        if (found.error) {
          logFetchFailure("fetchGuild", `community ${communityId}`, found.error);
          return null;
        }
        const { guild } = found;
        return {
          id: String(guild.id),
          name: guild.name,
          ownerId: guild.ownerId ?? null,
          afkChannelId: guild.afkChannelId ?? null,
        };
      } catch (err) {
        logFetchFailure("fetchGuild", `community ${communityId}`, err);
        return null;
      }
    },

    /**
     * @param {number} communityId
     * @param {string} channelId
     * @returns {Promise<object|null>} ChannelHandle (discord.js channel: id, type, permissionOverwrites)
     */
    async fetchChannel(communityId, channelId) {
      assertCommunityId(communityId);
      try {
        const found = await lookupGuild(client, communityId, "fetchChannel");
        if (found.error) {
          logFetchFailure("fetchChannel", `community ${communityId}`, found.error);
          return null;
        }
        const guild = found.guild;
        const cached = guild.channels?.cache?.get?.(String(channelId));
        if (cached) return cached;
        return (await guild.channels.fetch(String(channelId))) ?? null;
      } catch (err) {
        logFetchFailure("fetchChannel", `community ${communityId} channel ${channelId}`, err);
        return null;
      }
    },

    /**
     * @param {number} communityId
     * @param {string} userId
     * @returns {Promise<{ id: string, username: string, bot: boolean }|null>}
     */
    async fetchUser(communityId, userId) {
      assertCommunityId(communityId);
      try {
        const user = await client.users.fetch(String(userId));
        if (!user) return null;
        return {
          id: String(user.id),
          username: user.username ?? "",
          bot: Boolean(user.bot),
        };
      } catch (err) {
        logFetchFailure("fetchUser", `community ${communityId} user ${userId}`, err);
        return null;
      }
    },

    /**
     * @param {number} communityId
     * @param {string} userId
     * @returns {Promise<{ id: string, username: string, bot: boolean, roleIds: string[] }|null>} MemberHandle
     */
    async fetchMember(communityId, userId) {
      assertCommunityId(communityId);
      try {
        const found = await lookupMember(communityId, userId, "fetchMember");
        if (found.error) {
          logFetchFailure("fetchMember", `community ${communityId}`, found.error);
          return null;
        }
        const member = found.member;
        return {
          id: String(member.id),
          username: member.user?.username ?? "",
          bot: Boolean(member.user?.bot),
          roleIds: [...(member.roles?.cache?.keys?.() ?? [])].map(String),
        };
      } catch (err) {
        logFetchFailure("fetchMember", `community ${communityId} user ${userId}`, err);
        return null;
      }
    },

    /**
     * @param {number} communityId
     * @returns {Promise<Array<{ id: string, name: string, position: number, permissions: string }>>} RoleHandle[] — permissions is a decimal string, never a JS number
     */
    async fetchRoles(communityId) {
      assertCommunityId(communityId);
      try {
        const found = await lookupGuild(client, communityId, "fetchRoles");
        if (found.error) {
          logFetchFailure("fetchRoles", `community ${communityId}`, found.error);
          return [];
        }
        const roles = [];
        for (const role of found.guild.roles?.cache?.values?.() ?? []) {
          roles.push({
            id: String(role.id),
            name: role.name,
            position: role.position,
            // Decimal string at the boundary (spec): BigInt/number/string all
            // stringify to decimal; JS numbers never escape this method.
            permissions: String(role.permissions?.bitfield ?? role.permissions ?? 0n),
          });
        }
        return roles;
      } catch (err) {
        logFetchFailure("fetchRoles", `community ${communityId}`, err);
        return [];
      }
    },

    /**
     * @param {string} channelId
     * @param {object} payload ReplyPayload (string or message options)
     * @returns {Promise<{ ok: true, id: string }|{ ok: false, error: string }>}
     */
    async sendChannel(channelId, payload) {
      try {
        const found = await lookupChannel(client, channelId, "sendChannel");
        if (found.error) return { ok: false, error: found.error };
        const message = await found.channel.send(payload);
        return { ok: true, id: String(message?.id) };
      } catch (err) {
        return { ok: false, error: `sendChannel: send to channel ${channelId} failed: ${causeOf(err)}` };
      }
    },

    /**
     * @param {string} userId
     * @param {object} payload ReplyPayload
     * @returns {Promise<{ ok: true, id: string }|{ ok: false, error: string }>}
     */
    async sendDm(userId, payload) {
      try {
        const user = await client.users.fetch(String(userId));
        if (!user) {
          return { ok: false, error: `sendDm: user ${userId} not found` };
        }
        // discord.js opens DMs through createDM(); plain user-like handles
        // (tests, future adapters) expose send() directly.
        const channel = typeof user.createDM === "function" ? await user.createDM() : user;
        const message = await channel.send(payload);
        return { ok: true, id: String(message?.id) };
      } catch (err) {
        return { ok: false, error: `sendDm: DM to user ${userId} failed: ${causeOf(err)}` };
      }
    },

    /**
     * @param {{ communityId: number, channelId: string, messageId: string }} ref
     * @param {object} payload ReplyPayload
     * @returns {Promise<{ ok: true }|{ ok: false, error: string }>}
     */
    async editMessage(ref, payload) {
      // Programmer errors throw (spec § Repository boundary): a snowflake in
      // ref.communityId must surface, not hide inside { ok: false }.
      assertCommunityId(ref?.communityId);
      try {
        const found = await lookupChannel(client, ref?.channelId, "editMessage");
        if (found.error) return { ok: false, error: found.error };
        const message = await lookupMessage(found.channel, ref?.messageId, "editMessage");
        if (message.error) return { ok: false, error: message.error };
        await message.message.edit(payload);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: `editMessage: edit ${ref?.messageId} in channel ${ref?.channelId} failed: ${causeOf(err)}`,
        };
      }
    },

    /**
     * @param {number} communityId
     * @param {string} userId
     * @param {string} roleId
     * @returns {Promise<{ ok: true }|{ ok: false, error: string, code?: string }>}
     */
    async addRole(communityId, userId, roleId) {
      assertCommunityId(communityId);
      try {
        const found = await lookupMember(communityId, userId, "addRole");
        if (found.error) {
          return { ok: false, error: found.error, ...(found.code ? { code: found.code } : {}) };
        }
        await found.member.roles.add(String(roleId));
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: `addRole: role ${roleId} for user ${userId} in community ${communityId} failed: ${causeOf(err)}`,
          code: codeOf(err),
        };
      }
    },

    /**
     * @param {number} communityId
     * @param {string} userId
     * @param {string} roleId
     * @returns {Promise<{ ok: true }|{ ok: false, error: string, code?: string }>}
     */
    async removeRole(communityId, userId, roleId) {
      assertCommunityId(communityId);
      try {
        const found = await lookupMember(communityId, userId, "removeRole");
        if (found.error) {
          return { ok: false, error: found.error, ...(found.code ? { code: found.code } : {}) };
        }
        await found.member.roles.remove(String(roleId));
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: `removeRole: role ${roleId} for user ${userId} in community ${communityId} failed: ${causeOf(err)}`,
          code: codeOf(err),
        };
      }
    },

    /**
     * @param {string} channelId
     * @param {string} messageId
     * @param {string} emojiKey
     * @returns {Promise<{ ok: true }|{ ok: false, error: string }>}
     */
    async addReaction(channelId, messageId, emojiKey) {
      try {
        const found = await lookupChannel(client, channelId, "addReaction");
        if (found.error) return { ok: false, error: found.error };
        const message = await lookupMessage(found.channel, messageId, "addReaction");
        if (message.error) return { ok: false, error: message.error };
        await message.message.react(emojiKey);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: `addReaction: ${emojiKey} on message ${messageId} in channel ${channelId} failed: ${causeOf(err)}`,
        };
      }
    },

    /**
     * @param {string} channelId
     * @param {string} messageId
     * @param {string} emojiKey
     * @param {string} userId
     * @returns {Promise<{ ok: true }|{ ok: false, error: string }>}
     */
    async removeUserReaction(channelId, messageId, emojiKey, userId) {
      try {
        const found = await lookupChannel(client, channelId, "removeUserReaction");
        if (found.error) return { ok: false, error: found.error };
        const message = await lookupMessage(found.channel, messageId, "removeUserReaction");
        if (message.error) return { ok: false, error: message.error };
        const reaction = await message.message.react(emojiKey);
        await reaction.users.remove(String(userId));
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: `removeUserReaction: ${emojiKey} by user ${userId} on message ${messageId} in channel ${channelId} failed: ${causeOf(err)}`,
        };
      }
    },

    /**
     * Clears every user's reaction for one emoji (reaction-role panel reset).
     * An emoji that is not on the message is a no-op success.
     *
     * @param {string} channelId
     * @param {string} messageId
     * @param {string} emojiKey
     * @returns {Promise<{ ok: true }|{ ok: false, error: string }>}
     */
    async removeEmojiReaction(channelId, messageId, emojiKey) {
      try {
        const found = await lookupChannel(client, channelId, "removeEmojiReaction");
        if (found.error) return { ok: false, error: found.error };
        const message = await lookupMessage(found.channel, messageId, "removeEmojiReaction");
        if (message.error) return { ok: false, error: message.error };
        const reactions = message.message.reactions;
        const reaction =
          reactions?.resolve?.(emojiKey) ?? reactions?.cache?.get?.(emojiKey) ?? null;
        if (reaction && typeof reaction.remove === "function") {
          await reaction.remove();
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: `removeEmojiReaction: ${emojiKey} on message ${messageId} in channel ${channelId} failed: ${causeOf(err)}`,
        };
      }
    },

    /**
     * @param {{ communityId: number, name: string, parentId: string|null, type: number, overwrites: object[] }} args CreateChannelArgs
     * @returns {Promise<{ ok: true, id: string }|{ ok: false, error: string, code?: string }>}
     */
    async createChannel(args) {
      const communityId = args?.communityId;
      assertCommunityId(communityId);
      try {
        const found = await lookupGuild(client, communityId, "createChannel");
        if (found.error) return { ok: false, error: found.error };
        let permissionOverwrites;
        try {
          permissionOverwrites = (args.overwrites ?? []).map((ow) =>
            toDiscordOverwrite(ow, "createChannel"),
          );
        } catch (err) {
          return { ok: false, error: causeOf(err) };
        }
        const data = {
          name: String(args.name ?? ""),
          type: args.type,
          permissionOverwrites,
        };
        if (args.parentId != null) data.parent = String(args.parentId);
        const channel = await found.guild.channels.create(data);
        return { ok: true, id: String(channel?.id) };
      } catch (err) {
        return {
          ok: false,
          error: `createChannel: "${args?.name}" in community ${communityId} failed: ${causeOf(err)}`,
          code: codeOf(err),
        };
      }
    },

    /**
     * Applies channel permission overwrites. Per-overwrite rejections are
     * collected in `skipped` (spec return shape) so a single role above the
     * bot never fails the whole set silently.
     *
     * @param {string} channelId
     * @param {Array<{ id: string, kind: "role"|"member", allow: string, deny: string }>} overwrites ChannelOverwrite[]
     * @returns {Promise<{ ok: true }|{ ok: false, error: string, skipped: Array<{ id: string, reason: string }> }>}
     */
    async setOverwrites(channelId, overwrites) {
      const skipped = [];
      let list;
      try {
        list = (overwrites ?? []).map((ow) => toDiscordOverwrite(ow, "setOverwrites"));
      } catch (err) {
        return { ok: false, error: causeOf(err), skipped };
      }
      try {
        const found = await lookupChannel(client, channelId, "setOverwrites");
        if (found.error) {
          return {
            ok: false,
            error: found.error,
            skipped: list.map((ow) => ({ id: ow.id, reason: found.error })),
          };
        }
        await found.channel.permissionOverwrites.set(list);
        return { ok: true };
      } catch (err) {
        const reason = causeOf(err);
        return {
          ok: false,
          error: `setOverwrites: applying ${list.length} overwrite(s) to channel ${channelId} failed: ${reason}`,
          skipped: [
            ...skipped,
            ...list.map((ow) => ({ id: ow.id, reason })),
          ],
        };
      }
    },

    /**
     * @param {number} communityId
     * @param {string} userId
     * @param {string} reason
     * @returns {Promise<{ ok: true }|{ ok: false, error: string, code?: string }>}
     */
    async banMember(communityId, userId, reason) {
      assertCommunityId(communityId);
      try {
        const found = await lookupGuild(client, communityId, "banMember");
        if (found.error) return { ok: false, error: found.error };
        await found.guild.members.ban(String(userId), { reason: String(reason ?? "") });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: `banMember: user ${userId} in community ${communityId} failed: ${causeOf(err)}`,
          code: codeOf(err),
        };
      }
    },

    /**
     * History page for activity backfill and gork read_history.
     * @param {string} channelId
     * @param {{ before?: string, after?: string, limit: number }} query
     * @returns {Promise<{ ok: true, messages: object[] }|{ ok: false, error: string }>}
     */
    async fetchMessages(channelId, query) {
      try {
        const found = await lookupChannel(client, channelId, "fetchMessages");
        if (found.error) return { ok: false, error: found.error };
        const options = { limit: Number.isSafeInteger(query?.limit) ? query.limit : 100 };
        if (query?.before) options.before = String(query.before);
        if (query?.after) options.after = String(query.after);
        const page = await found.channel.messages.fetch(options);
        const messages = [];
        for (const msg of page?.values?.() ?? []) {
          messages.push(normalizeMessage(msg));
        }
        return { ok: true, messages };
      } catch (err) {
        return {
          ok: false,
          error: `fetchMessages: history for channel ${channelId} failed: ${causeOf(err)}`,
        };
      }
    },
  };

  return outbound;
}

// One OutboundClient per Discord client instance. Features call this at their
// edge (post-Ready in production); botUserId is snapshotted at first use, so
// the factory must not be called before login completes.
const _outboundCache = new WeakMap();

/**
 * Cached Discord OutboundClient for a logged-in client.
 * @param {import("discord.js").Client} client
 * @returns {ReturnType<typeof createDiscordOutbound>}
 */
function getDiscordOutbound(client) {
  let ob = _outboundCache.get(client);
  if (!ob) {
    ob = createDiscordOutbound(client);
    _outboundCache.set(client, ob);
  }
  return ob;
}

module.exports = { createDiscordOutbound, getDiscordOutbound };
