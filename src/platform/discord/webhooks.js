/**
 * Discord webhook lifecycle module (roadmap/bridge.md §10.3 delta 3).
 *
 * Mirrors src/platform/fluxer/webhooks.js against the discord.js client —
 * the same five functions, the same { ok, ... } result shapes, the same
 * RelayWebhook handle { id, token }. Adapter-owned: ZERO bridge, pairing,
 * state, or audit references (KD 1).
 *
 * Transport = the logged-in discord.js client (how src/platform/discord/
 * outbound.js accesses the platform — same lookup helpers, same error
 * vocabulary). Token-scoped operations resolve a partial Webhook through
 * `client.webhooks.create(id, token)` (the token-endpoint pattern: send /
 * editMessage / deleteMessage / delete all authenticate with the webhook
 * token, NOT the bot credential — so disconnect cleanup and relay sends keep
 * working after the bot loses Manage Webhooks).
 *
 * Token hygiene (AGENTS.md): the webhook token appears only in module RETURN
 * values; error strings name the webhook by ID only.
 */

const { assertCommunityId, getCommunityById } = require("../community");

/**
 * Specific, human-readable cause for an unknown thrown value.
 * @param {unknown} err
 * @returns {string}
 */
function causeOf(err) {
  return String(err?.message || err);
}

/**
 * Discord API error code as a decimal string ("50013"), when present —
 * same boundary rule as src/platform/discord/outbound.js.
 * @param {unknown} err
 * @returns {string|undefined}
 */
function codeOf(err) {
  return err?.code != null ? String(err.code) : undefined;
}

/** HTTP status from a discord.js DiscordAPIError-shaped error. */
function statusOf(err) {
  const s = Number(err?.status ?? err?.statusCode);
  return Number.isFinite(s) && s > 0 ? s : undefined;
}

/**
 * 429 and 5xx are transient; a throw with no HTTP status (network layer) is
 * transient too. 4xx are terminal. Mirrors the Fluxer module's ladder so the
 * relay worker can treat both platforms with one rule (§10.10).
 * @param {unknown} err
 * @returns {boolean}
 */
function isRetryableError(err) {
  const status = statusOf(err);
  if (status == null) return true;
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * "method: detail failed: cause (status N, code X)" — status + code ride
 * the message (AGENTS.md rule 2); the webhook token never does.
 */
function failureText(method, detail, err) {
  const bits = [];
  const status = statusOf(err);
  const code = codeOf(err);
  if (status != null) bits.push(`status ${status}`);
  if (code != null) bits.push(`code ${code}`);
  const suffix = bits.length ? ` (${bits.join(", ")})` : "";
  return `${method}: ${detail} failed: ${causeOf(err)}${suffix}`;
}

/**
 * Validate the RelayWebhook handle { id, token }. Error text names the
 * METHOD and webhook id — never the token.
 * @param {object} webhook
 * @param {string} method
 * @returns {string|null}
 */
function validateWebhook(webhook, method) {
  if (!webhook || typeof webhook !== "object") {
    return `${method}: webhook must be { id, token }`;
  }
  if (webhook.id == null || String(webhook.id) === "") {
    return `${method}: webhook.id is required`;
  }
  if (typeof webhook.token !== "string" || webhook.token === "") {
    return `${method}: webhook ${String(webhook.id)} has no token`;
  }
  return null;
}

/**
 * ReplyPayload files → discord.js file entries. Accepts the same
 * { name, data, contentType? } descriptors the OutboundClient send paths
 * take (spec § Embeds and attachments vocabulary), including AttachmentBuilder
 * instances (data on `.attachment`).
 *
 * @param {unknown} file
 * @param {number} index
 * @param {string} method
 * @returns {{ ok: true, file: object } | { ok: false, error: string }}
 */
function toDiscordFile(file, index, method) {
  const name = typeof file?.name === "string" && file.name !== "" ? file.name : null;
  if (name == null) {
    return {
      ok: false,
      error: `${method}: files[${index}] needs a non-empty string name (files entries are { name, data, contentType? })`,
    };
  }
  let attachment = null;
  const raw = file?.data ?? file?.attachment;
  if (Buffer.isBuffer(raw)) attachment = raw;
  else if (typeof raw === "string") attachment = Buffer.from(raw, "utf8");
  else if (raw instanceof ArrayBuffer) attachment = Buffer.from(new Uint8Array(raw));
  else if (ArrayBuffer.isView(raw)) attachment = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (attachment == null) {
    return {
      ok: false,
      error:
        `${method}: files[${index}] ("${name}") needs Buffer data, got ` +
        `${raw == null ? String(raw) : typeof raw}`,
    };
  }
  const entry = { attachment, name };
  if (typeof file.contentType === "string" && file.contentType !== "") {
    entry.contentType = file.contentType;
  }
  return { ok: true, file: entry };
}

/**
 * Normalize+validate a files array → discord.js entries.
 * @param {Array<unknown>} filesIn
 * @param {string} method
 * @returns {{ ok: true, files: object[] } | { ok: false, error: string }}
 */
function prepareFiles(filesIn, method) {
  const list = Array.isArray(filesIn) ? filesIn : [];
  const files = [];
  for (let i = 0; i < list.length; i += 1) {
    const norm = toDiscordFile(list[i], i, method);
    if (!norm.ok) return { ok: false, error: norm.error };
    files.push(norm.file);
  }
  return { ok: true, files };
}

/**
 * Resolve communityId → Guild (same contract as discord/outbound.js
 * lookupGuild: communities row must exist and be Discord-platform; the
 * guild is cache-read, then REST-fetched).
 *
 * @param {import("discord.js").Client} client
 * @param {number} communityId
 * @param {string} method
 * @returns {Promise<{ guild: object, externalGuildId: string }|{ error: string }>}
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
 * Build the Discord webhook lifecycle for a logged-in client.
 *
 * @param {import("discord.js").Client} client
 * @returns {{
 *   createRelayWebhook: (communityId: number, channelId: string, opts: { name: string }) => Promise<object>,
 *   executeRelayWebhook: (webhook: object, opts: object) => Promise<object>,
 *   patchRelayMessage: (webhook: object, messageId: string, opts: object) => Promise<object>,
 *   deleteRelayMessage: (webhook: object, messageId: string) => Promise<object>,
 *   deleteRelayWebhook: (webhook: object) => Promise<object>,
 * }}
 */
function createDiscordWebhooks(client) {
  if (!client) {
    throw new Error("createDiscordWebhooks requires a Discord client");
  }

  /**
   * Token-scoped Webhook handle (discord.js `client.webhooks.create(id, token)`
   * fetches the webhook by its token — the execute/patch/delete transport).
   * @param {string} method caller name for specific failures
   */
  async function resolveWebhook(webhook, method) {
    const invalid = validateWebhook(webhook, method);
    if (invalid) return { error: invalid };
    if (typeof client.webhooks?.create !== "function") {
      return {
        error: `${method}: client exposes no webhooks manager (client.webhooks.create) — SDK surface mismatch`,
      };
    }
    try {
      const wh = await client.webhooks.create(String(webhook.id), webhook.token);
      if (!wh) {
        return { error: `${method}: webhook ${String(webhook.id)} could not be resolved by token` };
      }
      return { wh };
    } catch (err) {
      return {
        error: failureText(method, `webhook ${String(webhook.id)} resolve`, err),
        status: statusOf(err),
        code: codeOf(err),
        retryable: isRetryableError(err),
      };
    }
  }

  return {
    /**
     * Create a channel webhook in the community's guild (guild-scoped: the
     * channel resolves THROUGH the community's guild, so a channel id from
     * another guild is "not found" — same isolation as fetchMessage).
     *
     * @param {number} communityId
     * @param {string} channelId
     * @param {{ name: string }} [options]
     * @returns {Promise<{ ok: true, webhook: { id: string, token: string } }|{ ok: false, error: string, code?: string }>}
     */
    async createRelayWebhook(communityId, channelId, options = {}) {
      assertCommunityId(communityId);
      if (typeof options.name !== "string" || options.name.trim() === "") {
        return {
          ok: false,
          error: "createRelayWebhook: { name } needs a non-empty string name",
        };
      }
      try {
        const found = await lookupGuild(client, communityId, "createRelayWebhook");
        if (found.error) return { ok: false, error: found.error };
        let channel = null;
        try {
          channel = (await found.guild.channels.fetch(String(channelId))) ?? null;
        } catch (err) {
          return {
            ok: false,
            error: failureText(
              "createRelayWebhook",
              `channel ${channelId} in community ${communityId} lookup`,
              err,
            ),
            ...(codeOf(err) != null ? { code: codeOf(err) } : {}),
          };
        }
        if (!channel) {
          return {
            ok: false,
            error: `createRelayWebhook: channel ${channelId} not found in community ${communityId}`,
          };
        }
        if (typeof channel.createWebhook !== "function") {
          return {
            ok: false,
            error: `createRelayWebhook: channel ${channelId} does not support webhooks (channel type ${channel.type})`,
          };
        }
        const wh = await channel.createWebhook({ name: options.name.trim() });
        // The create response returns the webhook FULLY, token included.
        if (!wh || wh.id == null) {
          return {
            ok: false,
            error: `createRelayWebhook: webhook create in channel ${channelId} returned no webhook id`,
          };
        }
        if (typeof wh.token !== "string" || wh.token === "") {
          return {
            ok: false,
            error: `createRelayWebhook: webhook ${String(wh.id)} in channel ${channelId} came back without a token`,
          };
        }
        return { ok: true, webhook: { id: String(wh.id), token: wh.token } };
      } catch (err) {
        return {
          ok: false,
          error: failureText(
            "createRelayWebhook",
            `webhook create in channel ${channelId} for community ${communityId}`,
            err,
          ),
          ...(codeOf(err) != null ? { code: codeOf(err) } : {}),
        };
      }
    },

    /**
     * Execute the webhook by token. Discord has no idempotency token for
     * webhook sends (spec §10.6); the relay's `nonce` is passed through for
     * forward-compat and the worker's at-least-once rules own duplication.
     *
     * @param {{ id: string, token: string }} webhook RelayWebhook
     * @param {{ content?: string, username?: string, avatarUrl?: string,
     *   files?: Array<{ name: string, data: Buffer|string, contentType?: string }>,
     *   allowedMentions?: object, flags?: number, nonce?: string }} [options]
     * @returns {Promise<{ ok: true, messageId: string|null }|{ ok: false, error: string, retryable: boolean, code?: string }>}
     */
    async executeRelayWebhook(webhook, options = {}) {
      const resolved = await resolveWebhook(webhook, "executeRelayWebhook");
      if (resolved.error) {
        return {
          ok: false,
          error: resolved.error,
          retryable: resolved.retryable === true,
          ...(resolved.code != null ? { code: resolved.code } : {}),
        };
      }
      const payload = {};
      if (options.content != null) payload.content = String(options.content);
      if (options.username != null) payload.username = String(options.username);
      if (options.avatarUrl != null) payload.avatarURL = String(options.avatarUrl);
      if (options.allowedMentions !== undefined) payload.allowedMentions = options.allowedMentions;
      if (typeof options.flags === "number") payload.flags = options.flags;
      if (options.nonce != null) payload.nonce = String(options.nonce);

      const filesPrep = prepareFiles(options.files, "executeRelayWebhook");
      if (!filesPrep.ok) return { ok: false, error: filesPrep.error, retryable: false };
      if (filesPrep.files.length > 0) payload.files = filesPrep.files;

      try {
        const sent = await resolved.wh.send(payload);
        // A send that returned no message object leaves the id unknown —
        // at-least-once semantics own the unconfirmed-id case (§10.6).
        return { ok: true, messageId: sent?.id != null ? String(sent.id) : null };
      } catch (err) {
        return {
          ok: false,
          error: failureText("executeRelayWebhook", `webhook ${String(webhook.id)} send`, err),
          retryable: isRetryableError(err),
          ...(codeOf(err) != null ? { code: codeOf(err) } : {}),
        };
      }
    },

    /**
     * Edit a message this webhook created (spike B5 gates platform support;
     * a refused PATCH surfaces as { ok: false } with the Discord code).
     *
     * @param {{ id: string, token: string }} webhook RelayWebhook
     * @param {string} messageId
     * @param {{ content?: string, files?: Array<object> }} [options]
     * @returns {Promise<{ ok: true }|{ ok: false, error: string, code?: string }>}
     */
    async patchRelayMessage(webhook, messageId, options = {}) {
      const resolved = await resolveWebhook(webhook, "patchRelayMessage");
      if (resolved.error) {
        return { ok: false, error: resolved.error, ...(resolved.code != null ? { code: resolved.code } : {}) };
      }
      if (messageId == null || String(messageId) === "") {
        return { ok: false, error: "patchRelayMessage: a messageId is required" };
      }
      const payload = {};
      if (options.content != null) payload.content = String(options.content);
      const filesPrep = prepareFiles(options.files, "patchRelayMessage");
      if (!filesPrep.ok) return { ok: false, error: filesPrep.error };
      if (filesPrep.files.length > 0) payload.files = filesPrep.files;

      try {
        await resolved.wh.editMessage(String(messageId), payload);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: failureText(
            "patchRelayMessage",
            `webhook ${String(webhook.id)} edit ${String(messageId)}`,
            err,
          ),
          ...(codeOf(err) != null ? { code: codeOf(err) } : {}),
        };
      }
    },

    /**
     * Delete a message this webhook created. 404 counts as ok: the desired
     * end-state (message gone) is reached (§10.3).
     *
     * @param {{ id: string, token: string }} webhook RelayWebhook
     * @param {string} messageId
     * @returns {Promise<{ ok: true }|{ ok: false, error: string, code?: string }>}
     */
    async deleteRelayMessage(webhook, messageId) {
      const resolved = await resolveWebhook(webhook, "deleteRelayMessage");
      if (resolved.error) {
        return { ok: false, error: resolved.error, ...(resolved.code != null ? { code: resolved.code } : {}) };
      }
      if (messageId == null || String(messageId) === "") {
        return { ok: false, error: "deleteRelayMessage: a messageId is required" };
      }
      try {
        await resolved.wh.deleteMessage(String(messageId));
        return { ok: true };
      } catch (err) {
        if (statusOf(err) === 404) return { ok: true }; // idempotent delete
        return {
          ok: false,
          error: failureText(
            "deleteRelayMessage",
            `webhook ${String(webhook.id)} delete ${String(messageId)}`,
            err,
          ),
          ...(codeOf(err) != null ? { code: codeOf(err) } : {}),
        };
      }
    },

    /**
     * Delete the webhook itself (disconnect cleanup). 404 counts as ok, and
     * per §10.3 the failure shape carries no platform code.
     *
     * @param {{ id: string, token: string }} webhook RelayWebhook
     * @returns {Promise<{ ok: true }|{ ok: false, error: string }>}
     */
    async deleteRelayWebhook(webhook) {
      const resolved = await resolveWebhook(webhook, "deleteRelayWebhook");
      if (resolved.error) return { ok: false, error: resolved.error };
      try {
        await resolved.wh.delete();
        return { ok: true };
      } catch (err) {
        if (statusOf(err) === 404) return { ok: true }; // idempotent delete
        return {
          ok: false,
          error: failureText("deleteRelayWebhook", `webhook ${String(webhook.id)} delete`, err),
        };
      }
    },
  };
}

module.exports = { createDiscordWebhooks };
