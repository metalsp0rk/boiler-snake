/**
 * Discord bridge OUTBOUND PORT (roadmap/bridge.md § "Outbound port
 * (feature-facing)"). The mirror of fluxerOutbound.js over the adapter-owned
 * Discord webhook module (src/platform/discord/webhooks.js) plus tokenCrypto:
 * tokens are ENCRYPTED on store and DECRYPTED in memory, `fetchSourceMessage`
 * rides the adapter's §10.3 fetchMessage, and bot-authored notices ride the
 * OutboundClient's channel send.
 *
 * Discord webhook execute has NO idempotency token (§10.6): the caller (the
 * relay worker) owns the retry rule — a Discord send is retried ONLY when it
 * produced no message id. This port passes results through unchanged so the
 * worker can apply it.
 *
 * Constructor seams (unit tests inject fakes, production wires the
 * supervisor): { getWebhookApi(platform, instanceKey) → PR 3 api,
 * getOutbound(platform, instanceKey) → OutboundClient, keyGetter → the
 * BRIDGE_TOKEN_KEY source, platform, instanceKey }.
 *
 * This module imports discord.js only through the injected adapter api — it
 * requires no SDK package itself.
 */

const { encryptWebhookToken, decryptWebhookToken } = require("./tokenCrypto");
const { sanitizeOutboundFilename } = require("./media");

/** Webhook name for both ends (spec §10.7 step 6; ≤ 80 chars). */
const WEBHOOK_NAME = "Boiler Snake Bridge";

/**
 * Attach the plaintext token to a relay-webhook handle as a NON-ENUMERABLE
 * property: `webhook.token` works for the transport, JSON.stringify (logs,
 * fixtures) never serializes the credential.
 * @param {object} handle
 * @param {string} token
 * @returns {object} the same handle, for chaining
 */
function hideToken(handle, token) {
  Object.defineProperty(handle, "token", {
    value: token,
    enumerable: false,
    writable: false,
  });
  return handle;
}

/**
 * Validate one bridge_ends row's webhook fields.
 * @returns {string|null} error text, null when usable.
 */
function endWebhookError(end) {
  if (!end || typeof end !== "object") return "bridge end is missing";
  if (end.webhook_id == null || String(end.webhook_id) === "") {
    return "the bridge end has no relay webhook (connect creates it)";
  }
  if (typeof end.webhook_token_enc !== "string" || end.webhook_token_enc === "") {
    return `relay webhook ${String(end.webhook_id)} has no stored token envelope`;
  }
  return null;
}

/**
 * Build the Discord-side outbound port.
 * @param {{
 *   getWebhookApi: (platform: string, instanceKey: string) => object|null,
 *   getOutbound: (platform: string, instanceKey: string) => object|null,
 *   keyGetter?: () => unknown,
 *   platform?: string,
 *   instanceKey?: string,
 * }} seams
 */
function createDiscordBridgeOutbound(seams = {}) {
  const platform = seams.platform ?? "discord";
  const instanceKey = seams.instanceKey ?? "discord";

  function apiResult(method) {
    const api =
      typeof seams.getWebhookApi === "function"
        ? seams.getWebhookApi(platform, instanceKey)
        : null;
    if (!api || typeof api[method] !== "function") {
      return {
        ok: false,
        error: `${method}: no Discord webhook api for ${platform}:${instanceKey}`,
      };
    }
    return { api };
  }

  function outboundResult(method) {
    const outbound =
      typeof seams.getOutbound === "function"
        ? seams.getOutbound(platform, instanceKey)
        : null;
    if (!outbound || typeof outbound[method] !== "function") {
      return {
        ok: false,
        error: `${method}: no Discord outbound client for ${platform}:${instanceKey} (method ${method} unavailable)`,
      };
    }
    return { outbound };
  }

  return {
    /** The adapter api object (diagnostics/tests); null when unresolvable. */
    rawApi() {
      try {
        return seams.getWebhookApi?.(platform, instanceKey) ?? null;
      } catch {
        return null;
      }
    },

    /**
     * Create the channel relay webhook; returns the in-memory handle plus
     * the encrypted envelope for bridge_ends. A missing BRIDGE_TOKEN_KEY
     * fails the create (a token that cannot be stored must not be kept).
     */
    async createRelayWebhook(communityId, channelId) {
      const built = apiResult("createRelayWebhook");
      if (built.error) return { ok: false, error: built.error };
      const created = await built.api.createRelayWebhook(communityId, channelId, {
        name: WEBHOOK_NAME,
      });
      if (!created || created.ok !== true) {
        return {
          ok: false,
          error: created?.error ?? "createRelayWebhook: webhook api returned no result",
          ...(created?.code != null ? { code: created.code } : {}),
        };
      }
      const tokenEnc = encryptWebhookToken(created.webhook.token, {
        keyGetter: seams.keyGetter,
      });
      if (tokenEnc == null) {
        return {
          ok: false,
          error:
            "createRelayWebhook: BRIDGE_TOKEN_KEY is not configured — the webhook token cannot be stored",
          code: "bridge_token_key_missing",
        };
      }
      return { ok: true, webhook: created.webhook, tokenEnc };
    },

    /**
     * Decrypt one stored end's token into an in-memory RelayWebhook handle.
     * The token is a NON-ENUMERABLE property: transports read it as
     * `webhook.token`, but JSON serialization (logs, fixtures, asserts) can
     * never leak the plaintext credential.
     * @param {{ webhook_id: string, webhook_token_enc: string }} end
     */
    webhookForEnd(end) {
      const invalid = endWebhookError(end);
      if (invalid) return { ok: false, error: invalid };
      let token;
      try {
        token = decryptWebhookToken(end.webhook_token_enc, { keyGetter: seams.keyGetter });
      } catch (err) {
        return {
          ok: false,
          error: `webhook ${String(end.webhook_id)} token could not be decrypted: ${String(err?.message || err)}`,
          code: err?.code,
        };
      }
      return { ok: true, webhook: hideToken({ id: String(end.webhook_id) }, token) };
    },

    /**
     * One already-chunked execute. The multipart `filename` is sanitized here
     * (120 cap). `nonce` is passed through for forward-compat; the id-absent
     * result the worker's retry rule keys on rides through unchanged.
     */
    async executeRelay(webhook, options = {}) {
      const built = apiResult("executeRelayWebhook");
      if (built.error) return { ok: false, error: built.error, retryable: false };
      const files = Array.isArray(options.files)
        ? options.files.map((f) => (f && typeof f === "object" ? { ...f, name: sanitizeOutboundFilename(f.name) } : f))
        : undefined;
      const opts = { ...options };
      if (files) opts.files = files;
      const res = await built.api.executeRelayWebhook(webhook, opts);
      if (!res || res.ok !== true) {
        return {
          ok: false,
          error: res?.error ?? "executeRelay: webhook api returned no result",
          retryable: res?.retryable === true,
          ...(res?.code != null ? { code: res.code } : {}),
        };
      }
      // Discord has no idempotency token: a success with no message id is
      // UNCONFIRMED. The worker retries only that case (spec §10.6).
      return { ok: true, messageId: res.messageId ?? null };
    },

    /** PATCH a relayed copy (edit relay lands with PR 6; the port ships it). */
    async patchRelayMessage(webhook, messageId, options = {}) {
      const built = apiResult("patchRelayMessage");
      if (built.error) return { ok: false, error: built.error };
      const res = await built.api.patchRelayMessage(webhook, messageId, options);
      if (!res || res.ok !== true) {
        return {
          ok: false,
          error: res?.error ?? "patchRelayMessage: webhook api returned no result",
          ...(res?.code != null ? { code: res.code } : {}),
        };
      }
      return { ok: true };
    },

    /** DELETE a relayed copy (delete relay lands with PR 6). 404 = already gone. */
    async deleteRelayMessage(webhook, messageId) {
      const built = apiResult("deleteRelayMessage");
      if (built.error) return { ok: false, error: built.error };
      const res = await built.api.deleteRelayMessage(webhook, messageId);
      if (!res || res.ok !== true) {
        return {
          ok: false,
          error: res?.error ?? "deleteRelayMessage: webhook api returned no result",
          ...(res?.code != null ? { code: res.code } : {}),
        };
      }
      return { ok: true };
    },

    /** DELETE the relay webhook itself (disconnect cleanup). */
    async deleteRelayWebhook(webhook) {
      const built = apiResult("deleteRelayWebhook");
      if (built.error) return { ok: false, error: built.error };
      const res = await built.api.deleteRelayWebhook(webhook);
      if (!res || res.ok !== true) {
        return { ok: false, error: res?.error ?? "deleteRelayWebhook: webhook api returned no result" };
      }
      return { ok: true };
    },

    /**
     * Re-read ONE source message (§10.3 fetchMessage). Media refresh, edit
     * payloads, and the spool-loss re-sign fallback ride this.
     */
    async fetchSourceMessage(communityId, channelId, messageId) {
      const built = outboundResult("fetchMessage");
      if (built.error) return { ok: false, error: built.error };
      const res = await built.outbound.fetchMessage(communityId, channelId, messageId);
      if (!res || res.ok !== true) {
        return {
          ok: false,
          error: res?.error ?? "fetchSourceMessage: outbound returned no result",
          ...(res?.code != null ? { code: res.code } : {}),
        };
      }
      return { ok: true, message: res.message };
    },

    /**
     * Bot-authored channel send (notices: poison park, spool-full, paused).
     * Never the relay webhook — notices die at the loop gate (spec §10.4).
     */
    async sendNotice(communityId, channelId, content) {
      const built = outboundResult("sendChannel");
      if (built.error) return { ok: false, error: built.error };
      try {
        const res = await built.outbound.sendChannel(String(channelId), { content });
        return { ok: true, messageId: res?.id != null ? String(res.id) : null };
      } catch (err) {
        return {
          ok: false,
          error: `sendNotice: channel ${String(channelId)} send failed: ${String(err?.message || err)}`,
        };
      }
    },
  };
}

module.exports = { createDiscordBridgeOutbound, WEBHOOK_NAME };
