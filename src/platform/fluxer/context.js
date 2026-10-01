/**
 * Fluxer CommandContext builder (roadmap/fluxer.md § CommandContext, 268–333;
 * bundle contract 6).
 *
 * Mirrors the method list of the Discord builder (src/platform/discord/context.js)
 * with NO `rawInteraction` property — Fluxer contexts never carry it (spec 270,
 * the documented Discord-only escape hatch).
 *
 * K2 reply policy (Key Decision, spec line 75):
 * - `sensitive: true` → DM the author.
 * - DM disabled/failing → the CHANNEL reply carries the SPECIFIC ERROR ONLY
 *   (`"I could not DM you the result: <error>"`) and never the sensitive body —
 *   notes, warnings, userinfo, and /xp output must not leak into the channel.
 *
 * Option values arrive PRE-RESOLVED from dispatch (dispatch step 3 resolves
 * mentions, fetches unknown ids, and checks channel types; the builder stays
 * sync like its Discord twin). `options.getX(name, required)` throws the same
 * `Missing required option: <name>` text the Discord builder throws (shared
 * helper in src/platform/context.js).
 */

const {
  missingOptionError,
  normalizeReplyPayload,
} = require("../context");

/**
 * Build the Fluxer CommandContext for one parsed prefix command.
 *
 * @param {object} parsed ParsedCommand (src/platform/fluxer/commands.js)
 * @param {object} message NormalizedMessage (normalizeFluxerMessage output;
 *   dispatch has filled `communityId` and the async option resolutions)
 * @param {object} deps
 * @param {object} deps.outbound OutboundClient (createFluxerOutbound)
 * @param {Map<string, *>} [deps.resolved] option name → resolved value
 *   (user ResolvedUser / {id,type} / number / boolean / string). Falls back to
 *   string values from `parsed.options` for options dispatch did not transform.
 * @returns {object} CommandContext
 */
function buildFluxerCommandContext(parsed, message, { outbound, resolved = null } = {}) {
  if (!parsed || typeof parsed.commandName !== "string") {
    throw new Error("buildFluxerCommandContext: parsed.commandName required");
  }
  if (!message || typeof message.channelId !== "string") {
    throw new Error("buildFluxerCommandContext: message.channelId required");
  }
  if (!outbound) {
    throw new Error(
      `buildFluxerCommandContext: outbound required for command "/${parsed.commandName}"`,
    );
  }

  const authorRaw = message.authorRaw ?? null;
  /** @type {ResolvedUser|null} */
  const user = {
    id: String(message.authorId),
    username: authorRaw?.username ?? null,
    bot: Boolean(message.authorBot),
  };

  // Option values by name. Types that need structure (user/channel) come from
  // dispatch's resolved map; scalars keep the parser's string form and are
  // coerced at read time by the getters below.
  const values = new Map();
  for (const opt of parsed.options ?? []) {
    values.set(opt.name, resolved?.has?.(opt.name) ? resolved.get(opt.name) : opt.value);
  }

  const state = {
    deferred: false,
    deferSensitive: false,
    replied: false,
    // Message id of the first successful send — editReply edits that one.
    messageId: null,
  };

  /**
   * Read an option, enforcing the required flag like discord.js (spec 274–279).
   * @param {string} name
   * @param {boolean} required
   * @param {string} expectedType parser type for the string→scalar coercion
   * @returns {*}
   */
  function getOption(name, required, expectedType) {
    const present = values.has(name);
    const value = values.get(name);
    if (!present || value == null) {
      if (required) throw new Error(missingOptionError(name));
      return null;
    }
    if (expectedType === "integer") {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    if (expectedType === "number") {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    if (expectedType === "boolean") return value === true || value === "true";
    return value;
  }

  const options = {
    getString: (name, required = false) => getOption(name, required, "string"),
    getInteger: (name, required = false) => getOption(name, required, "integer"),
    getNumber: (name, required = false) => getOption(name, required, "number"),
    getBoolean: (name, required = false) => getOption(name, required, "boolean"),
    getUser: (name, required = false) => getOption(name, required, "user"),
    getRole: (name, required = false) => getOption(name, required, "role"),
    getChannel: (name, required = false) => getOption(name, required, "channel"),
    getSubcommand: () => parsed.subcommand ?? null,
    getSubcommandGroup: () => parsed.subcommandGroup ?? null,
  };

  /**
   * Send a payload honoring K2. `sensitive` is stripped from the wire payload
   * (it is seam vocabulary, like the Discord adapter does with the flag).
   *
   * @param {object|string|null} payload
   * @param {boolean} forceDm true when defer({sensitive:true}) set the tone
   * @returns {Promise<void>}
   */
  async function sendPayload(payload, forceDm) {
    const normalized = normalizeReplyPayload(payload);
    const sensitive = normalized.sensitive === true || forceDm === true;
    delete normalized.sensitive;

    state.replied = true;

    if (sensitive) {
      let result;
      try {
        result = await outbound.sendDm(message.authorId, normalized);
      } catch (err) {
        result = { ok: false, error: String(err?.message || err) };
      }
      if (!result?.ok) {
        // K2: the channel reply is the SPECIFIC ERROR only — never the body.
        console.error(
          `[fluxer] DM to ${message.authorId} failed: ${result?.error || "unknown sendDm failure"}`,
        );
        let fallback;
        try {
          fallback = await outbound.sendChannel(message.channelId, {
            content: `I could not DM you the result: ${result?.error || "the DM send failed"}`,
          });
        } catch (err) {
          fallback = { ok: false, error: String(err?.message || err) };
        }
        if (!fallback?.ok) {
          console.error(
            `[fluxer] K2 channel fallback in ${message.channelId} failed: ${fallback?.error || "unknown sendChannel failure"}`,
          );
        }
        return;
      }
      if (state.messageId == null && result.id != null) state.messageId = String(result.id);
      return;
    }

    let result;
    try {
      result = await outbound.sendChannel(message.channelId, normalized);
    } catch (err) {
      result = { ok: false, error: String(err?.message || err) };
    }
    if (!result?.ok) {
      console.error(
        `[fluxer] channel reply in ${message.channelId} failed: ${result?.error || "unknown sendChannel failure"}`,
      );
      return;
    }
    if (state.messageId == null && result.id != null) state.messageId = String(result.id);
  }

  const ctx = {
    platform: "fluxer",
    instanceKey: message.instanceKey ?? "fluxer",
    communityId: message.communityId,
    externalGuildId: message.externalGuildId ?? null,
    channelId: message.channelId,
    userId: String(message.authorId),
    user,
    commandName: parsed.commandName,
    subcommandGroup: parsed.subcommandGroup ?? null,
    subcommand: parsed.subcommand ?? null,
    options,
    // Mask algorithm is PR 8 (spec § Permissions); PR 6 ships zeros.
    channelPermissions: 0n,
    memberRoleIds: Array.isArray(message.memberRoleIds) ? message.memberRoleIds : [],
    guildOwner: false,
    // State getters mirror the Discord builder's live view of the interaction.
    get deferred() {
      return state.deferred;
    },
    get replied() {
      return state.replied;
    },
    outbound,

    /**
     * @param {object|string} payload ReplyPayload; `sensitive: true` → DM (K2).
     */
    reply: async (payload) => {
      // First reply after defer({sensitive:true}) inherits the private tone
      // (discord.js parity: a deferred ephemeral response stays ephemeral).
      await sendPayload(payload, state.deferred && state.deferSensitive);
    },

    /**
     * @param {object|string} payload
     */
    followUp: async (payload) => {
      await sendPayload(payload, false);
    },

    /**
     * Edit the first sent reply (spec: after a successful send).
     * @param {object|string} payload
     */
    editReply: async (payload) => {
      if (state.messageId == null) {
        throw new Error(
          `editReply: /${parsed.commandName} has no sent message to edit (reply first)`,
        );
      }
      const normalized = normalizeReplyPayload(payload);
      delete normalized.sensitive;
      const result = await outbound.editMessage(
        {
          communityId: message.communityId,
          channelId: message.channelId,
          messageId: state.messageId,
        },
        normalized,
      );
      if (!result?.ok) {
        console.error(
          `[fluxer] editReply for /${parsed.commandName} in channel ${message.channelId} failed: ${result?.error || "unknown editMessage failure"}`,
        );
      }
    },

    /**
     * @param {{sensitive?: boolean}} [opts]
     */
    defer: async (opts) => {
      state.deferred = true;
      state.deferSensitive = opts?.sensitive === true;
    },
  };

  // Contract 6: Fluxer contexts NEVER carry rawInteraction (the Discord-only
  // modal escape hatch). ctx.rawInteraction stays undefined by construction.
  return ctx;
}

module.exports = { buildFluxerCommandContext };
