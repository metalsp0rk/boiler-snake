/**
 * Platform-aware "jump to message/channel" URLs (roadmap/fluxer.md § Live
 * E2E verification, gap #2).
 *
 * The codebase hardcoded `https://discord.com/channels/…` at four sites, so
 * Fluxer replies shipped dead links — which Fluxer additionally auto-embeds,
 * attaching a Discord marketing OpenGraph card to the message (verified live
 * 2026-10-02). The Fluxer scheme is the instance's discovered webapp base
 * (`endpoints.webapp`) + the same `/channels/{guild}/{channel}[/{message}]`
 * path shape (live-verified against the running instance).
 */

/** Discord's fixed webapp origin (no per-instance discovery exists). */
const DISCORD_WEBAPP_BASE = "https://discord.com";

/**
 * Normalize a discovered webapp base: must be an http(s) URL; trailing
 * slashes are stripped so callers can append `/channels/...` directly.
 *
 * @param {unknown} value  endpoints.webapp (or equivalent) from discovery
 * @returns {string|null}  normalized base, null when unusable
 */
function normalizeWebappBase(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return trimmed.replace(/\/+$/, "");
}

/**
 * Build a jump URL for a guild channel (and optionally a message in it).
 *
 * @param {object} opts
 * @param {string|null|undefined} [opts.platform]  "fluxer" → Fluxer scheme;
 *   anything else (including undefined) keeps the Discord scheme.
 * @param {string|number|null|undefined} opts.guildId  guild / external guild id
 * @param {string|number|null|undefined} opts.channelId  channel id
 * @param {string|number|null} [opts.messageId]  message id; omit for a
 *   channel-only link
 * @param {string|null|undefined} [opts.webappBaseUrl]  Fluxer instance webapp
 *   base (OutboundClient.webappBaseUrl). Null on fluxer → null URL.
 * @returns {string|null}  the URL, or null when ids/base are missing —
 *   callers treat null as "no link" (render nothing, never a dead link)
 */
function buildMessageJumpUrl(opts = {}) {
  const { platform, guildId, channelId, messageId = null, webappBaseUrl = null } = opts;
  if (guildId == null || channelId == null) return null;
  if (String(guildId).trim() === "" || String(channelId).trim() === "") return null;
  const base =
    platform === "fluxer" ? normalizeWebappBase(webappBaseUrl) : DISCORD_WEBAPP_BASE;
  if (!base) return null;
  const tail =
    messageId != null && String(messageId).trim() !== ""
      ? `/${String(messageId).trim()}`
      : "";
  return `${base}/channels/${String(guildId).trim()}/${String(channelId).trim()}${tail}`;
}

module.exports = { buildMessageJumpUrl, normalizeWebappBase, DISCORD_WEBAPP_BASE };
