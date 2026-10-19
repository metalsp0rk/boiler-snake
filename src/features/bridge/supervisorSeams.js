/**
 * #475 (BRG-14): the ONE bridge production-seam builder.
 *
 * handlers.js (command/connect path) and relay.js (worker loop) each carried
 * a clone pair — the sendMessage wrapper (byte-identical error strings) and
 * the webhook-api construction (the audit-C1-safe apiOrigin form). They had
 * ALREADY drifted in their failure logs (two different sentences for the
 * same fault), and any C1-class seam change had to be made twice. Both files
 * now build their deps from THIS function.
 *
 * Spec §10.3: adapter modules, bridge-free — the seams only project the
 * supervisor onto (platform, instanceKey) callables.
 */
const { createDiscordWebhooks } = require("../../platform/discord/webhooks");
const { createFluxerWebhooks } = require("../../platform/fluxer/webhooks");
const { getDiscordOutbound } = require("../../platform/discord/outbound");
const { createFluxerOutbound } = require("../../platform/fluxer/outbound");
const { NO_PING } = require("./mentions");

/**
 * @param {object|null} supervisor bridge supervisor ({ discord, fluxer, clientForCommunity })
 * @returns {{
 *   getWebhookApi: (platform: string, instanceKey?: string) => object|null,
 *   getOutbound: (platform: string, instanceKey?: string) => object|null,
 *   keyGetter: () => string|undefined,
 *   sendMessage: (
 *     communityId: number|string, channelId: string, content: string
 *   ) => Promise<{ ok: boolean, error?: string }>,
 * }}
 */
function buildSupervisorSeams(supervisor) {
  return {
    getWebhookApi: (platform, instanceKey) => {
      if (!supervisor) return null;
      try {
        if (platform === "discord") {
          return supervisor.discord ? createDiscordWebhooks(supervisor.discord) : null;
        }
        const handle = supervisor.fluxer?.get?.(instanceKey) ?? null;
        // handle.apiOrigin is discovery's endpoints.api_public (audit C1):
        // the ONLY authority for absolute webhook URLs. When discovery never
        // resolved it (null/""), createFluxerWebhooks throws HERE — caught
        // just below, logged naming the instance, and this seam returns null
        // so the caller fails closed with its own specific sentence instead
        // of fetching relative /v1/webhooks/… URLs forever (the C1 outage).
        return handle
          ? createFluxerWebhooks({ rest: handle.rest, apiOrigin: handle.apiOrigin })
          : null;
      } catch (err) {
        console.error(
          `[bridge] webhook api build failed for ${platform}:${instanceKey}: ${err?.message || err}`,
        );
        return null;
      }
    },
    getOutbound: (platform, instanceKey) => {
      if (!supervisor) return null;
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
        // Mention-pinned: notices must never ping.
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

module.exports = { buildSupervisorSeams };
