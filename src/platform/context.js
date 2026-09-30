/**
 * Platform-neutral CommandContext seam (roadmap/fluxer.md § CommandContext).
 *
 * Pure module: it MUST NOT import discord.js (or any gateway library) so the
 * helpers stay unit-testable without a client. Adapters (src/platform/discord/*)
 * translate the shapes defined here onto their gateway payloads; handlers on
 * the context arm speak only this vocabulary.
 */

/**
 * The invoker or a resolved user option, flattened to what handlers need.
 * `bot` is always a real boolean so `if (target.bot)` never sees undefined.
 *
 * @typedef {object} ResolvedUser
 * @property {string} id
 * @property {string} username
 * @property {boolean} bot
 */

/**
 * @typedef {object} NormalizedEmbedField
 * @property {string} name
 * @property {string} value
 * @property {boolean} inline
 */

/**
 * Platform-neutral embed shape. The Discord adapter maps it to EmbedBuilder;
 * the Fluxer adapter maps it to the wire shape Phase 0 confirms.
 *
 * @typedef {object} NormalizedEmbed
 * @property {string|null} title
 * @property {string|null} description
 * @property {string|null} url
 * @property {number|null} color
 * @property {NormalizedEmbedField[]} fields
 * @property {{ text: string }|null} footer
 * @property {string|number|Date|null} timestamp
 * @property {{ name: string }|null} author
 */

/**
 * @typedef {object} ReplyFile
 * @property {string} name
 * @property {Buffer|string} data
 * @property {string} [contentType]
 */

/**
 * @typedef {object} ReplyPayload
 * @property {string} [content]
 * @property {NormalizedEmbed[]|object[]} [embeds]
 * @property {ReplyFile[]|object[]} [files]
 * @property {object} [allowedMentions]
 * @property {boolean} [sensitive] true → Discord ephemeral; Fluxer DM policy (K2)
 */

/**
 * What every contextual command handler receives as its first argument
 * (roadmap/fluxer.md § CommandContext, lines 297–329). Plain object, never a
 * fake interaction; handlers stay Discord-free by construction.
 *
 * @typedef {object} CommandContext
 * @property {"discord"|"fluxer"} platform
 * @property {string} instanceKey
 * @property {number} communityId
 * @property {string} externalGuildId
 * @property {string} channelId
 * @property {string} userId
 * @property {ResolvedUser} user          // the invoker; /xp uses getUser("user") ?? user
 * @property {string} commandName
 * @property {string|null} subcommandGroup
 * @property {string|null} subcommand
 * @property {object} options              // CommandOptions: getString/getInteger/getNumber/getBoolean/getUser/getRole/getChannel/getSubcommand/getSubcommandGroup
 * @property {bigint} channelPermissions   // channel-scoped mask
 * @property {string[]} memberRoleIds
 * @property {boolean} guildOwner
 * @property {boolean} deferred
 * @property {boolean} replied
 * @property {(payload: ReplyPayload|string) => Promise<void>} reply
 * @property {(payload: ReplyPayload|string) => Promise<void>} editReply
 * @property {(payload: ReplyPayload|string) => Promise<void>} followUp
 * @property {(opts?: { sensitive?: boolean }) => Promise<void>} defer
 * @property {object} outbound             // OutboundClient
 */

/**
 * The one denial copy for a missing required option. Call sites throw:
 * `throw new Error(missingOptionError(name))`. Mirrors what discord.js raises
 * for `getString("user", true)` on an absent option.
 *
 * @param {string} name option name
 * @returns {string} the Error message (NOT an Error instance)
 */
function missingOptionError(name) {
  return `Missing required option: ${name}`;
}

/**
 * Flatten any user-like object (gateway user, GuildMember#user, MemberHandle)
 * to the ResolvedUser typedef. null/undefined pass through as null.
 *
 * @param {object|null|undefined} user
 * @returns {ResolvedUser|null}
 */
function normalizeResolvedUser(user) {
  if (user == null) return null;
  return {
    id: String(user.id),
    username: String(user.username ?? ""),
    bot: Boolean(user.bot),
  };
}

/**
 * Normalize an embed to the NormalizedEmbed typedef.
 * - null/undefined → null
 * - legacy EmbedBuilder (anything with toJSON) → its toJSON() output, untouched
 * - plain object → shallow-normalized copy with string fields, coerced
 *   field list, and footer/author blocks reduced to their usable keys.
 *
 * @param {object|null|undefined} embed
 * @returns {NormalizedEmbed|object|null}
 */
function normalizeEmbed(embed) {
  if (embed == null) return null;
  if (typeof embed.toJSON === "function") return embed.toJSON();
  return {
    title: embed.title ?? null,
    description: embed.description ?? null,
    url: embed.url ?? null,
    color: embed.color ?? null,
    fields: Array.isArray(embed.fields)
      ? embed.fields.map((f) => ({
          name: String(f?.name ?? ""),
          value: String(f?.value ?? ""),
          inline: Boolean(f?.inline),
        }))
      : [],
    footer: embed.footer?.text ? { text: String(embed.footer.text) } : null,
    timestamp: embed.timestamp ?? null,
    author: embed.author?.name ? { name: String(embed.author.name) } : null,
  };
}

/**
 * Validate the platform-neutral `files` entries (spec ReplyPayload.files):
 * AttachmentBuilder-like objects (they expose setName) pass through untouched —
 * migrated handlers may still hand them in. Plain descriptors must carry a
 * non-empty string `name` and Buffer/string `data`, or the payload is rejected
 * with a specific, actionable message (AGENTS.md § Error Handling).
 *
 * @param {Array<object>} files
 * @returns {object[]} shallow-copied valid entries; builders by reference
 */
function normalizeReplyFiles(files) {
  if (!Array.isArray(files)) {
    throw new Error(`ReplyPayload: files must be an array, got ${typeof files}`);
  }
  return files.map((file, index) => {
    // AttachmentBuilder (and any builder exposing setName) is already a
    // platform-native file object — the Discord adapter accepts it as-is.
    if (file && typeof file.setName === "function") return file;
    const hasName = typeof file?.name === "string" && file.name !== "";
    const hasData = Buffer.isBuffer(file?.data) || typeof file?.data === "string";
    if (!hasName || !hasData) {
      throw new Error(
        `ReplyPayload: file at index ${index} needs { name, data }`,
      );
    }
    return { ...file };
  });
}

/**
 * Normalize a handler's reply argument to a shallow ReplyPayload copy.
 * - string → { content: string }
 * - null/undefined → {} (a send-nothing payload is legal: embeds-only, files-only)
 * - object → shallow copy; `files` entries validated (never deep-cloned, so
 *   AttachmentBuilder instances survive the trip). `sensitive: true` is PRESERVED
 *   here — translating it to platform flags (e.g. Discord's Ephemeral) is the
 *   adapter's job (see src/platform/discord/context.js).
 *
 * @param {ReplyPayload|string|null|undefined} payload
 * @returns {object} a fresh payload object
 */
function normalizeReplyPayload(payload) {
  if (typeof payload === "string") return { content: payload };
  if (payload == null) return {};
  const normalized = { ...payload };
  if (normalized.files != null) {
    normalized.files = normalizeReplyFiles(normalized.files);
  }
  return normalized;
}

/**
 * Fail fast when a platform adapter hands a handler an incomplete context.
 * Every throw names the missing field so a handler crash is diagnosable from
 * the log line alone. Programmer errors — the router surfaces them via
 * safeErrorReply, exactly like a handler bug.
 *
 * @param {CommandContext} ctx
 * @returns {void}
 */
function assertCommandContext(ctx) {
  if (!ctx) {
    throw new Error("CommandContext: ctx required");
  }
  if (typeof ctx.platform !== "string") {
    throw new Error("CommandContext: platform required");
  }
  if (!Number.isSafeInteger(ctx.communityId)) {
    throw new Error("CommandContext: communityId required");
  }
  if (typeof ctx.userId !== "string" || ctx.userId === "") {
    throw new Error("CommandContext: userId required");
  }
  if (typeof ctx.commandName !== "string" || ctx.commandName === "") {
    throw new Error("CommandContext: commandName required");
  }
  if (typeof ctx.reply !== "function") {
    throw new Error("CommandContext: reply required");
  }
  if (!ctx.options || typeof ctx.options !== "object") {
    throw new Error("CommandContext: options required");
  }
  if (typeof ctx.options.getString !== "function") {
    throw new Error("CommandContext: options.getString required");
  }
}

module.exports = {
  missingOptionError,
  normalizeResolvedUser,
  normalizeEmbed,
  normalizeReplyPayload,
  assertCommandContext,
};
