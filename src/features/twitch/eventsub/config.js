/**
 * EventSub webhook configuration (roadmap/twitch-notifications.md).
 *
 * EventSub webhooks need three things beyond the app credentials the
 * poller already uses:
 *  1. TWITCH_EVENTSUB_SECRET — the HMAC-SHA256 secret (10–100 ASCII chars)
 *     registered with each subscription and used to verify every delivery
 *     (generate one with `openssl rand -hex 32`).
 *  2. A PUBLIC HTTPS callback URL on port 443 (Twitch refuses anything
 *     else) — derived from PUBLIC_BASE_URL + /hooks/twitch, or pinned
 *     exactly with TWITCH_EVENTSUB_CALLBACK_URL. The public HTTP server
 *     must be running behind TLS for it to be reachable.
 *  3. Subscription quota — stream.online/stream.offline each cost 1 per
 *     broadcaster unless the broadcaster OAuth'd the app, and a fresh app
 *     has a small max_total_cost. TWITCH_EVENTSUB_MAX_CHANNELS caps how
 *     many broadcasters we auto-subscribe; the rest stay on polling
 *     (the fast path is an OPTIMIZATION — polling remains the fallback).
 *
 * Missing any requirement => EventSub is disabled and the polling ticker
 * is the whole feature (never an error state). Secret VALUES are never
 * logged or serialized — only var names in `missing`.
 */

const { getPublicHttpConfig } = require("../../commandPermissions/config");

const CALLBACK_PATH = "/hooks/twitch";
const SECRET_MIN = 10;
const SECRET_MAX = 100;
const DEFAULT_MAX_CHANNELS = 50;

/**
 * @returns {{
 *   enabled: boolean,
 *   clientId: string|null,
 *   clientSecret: string|null,
 *   secret: string|null,
 *   callbackUrl: string|null,
 *   maxChannels: number,
 *   missing: string[],
 * }}
 */
function getEventsubConfig() {
  const clientId = process.env.TWITCH_CLIENT_ID
    ? String(process.env.TWITCH_CLIENT_ID).trim()
    : null;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET
    ? String(process.env.TWITCH_CLIENT_SECRET).trim()
    : null;
  const secret = process.env.TWITCH_EVENTSUB_SECRET
    ? String(process.env.TWITCH_EVENTSUB_SECRET).trim()
    : null;

  const missing = [];
  if (!clientId) missing.push("TWITCH_CLIENT_ID");
  if (!clientSecret) missing.push("TWITCH_CLIENT_SECRET");

  // Twitch: "The secret must be an ASCII string that's a minimum of 10
  // characters long and a maximum of 100 characters long."
  let secretOk = true;
  if (!secret) {
    missing.push("TWITCH_EVENTSUB_SECRET");
    secretOk = false;
  } else if (secret.length < SECRET_MIN || secret.length > SECRET_MAX) {
    missing.push("TWITCH_EVENTSUB_SECRET (must be 10-100 chars)");
    secretOk = false;
  }

  const explicit = process.env.TWITCH_EVENTSUB_CALLBACK_URL
    ? String(process.env.TWITCH_EVENTSUB_CALLBACK_URL).trim().replace(/\/+$/, "")
    : "";
  let callbackUrl = explicit;
  if (!callbackUrl) {
    const { publicBaseUrl } = getPublicHttpConfig();
    if (publicBaseUrl) callbackUrl = `${publicBaseUrl}${CALLBACK_PATH}`;
  }

  if (!callbackUrl) {
    missing.push("PUBLIC_BASE_URL (or TWITCH_EVENTSUB_CALLBACK_URL)");
  } else {
    let proto = null;
    try {
      proto = new URL(callbackUrl).protocol;
    } catch {
      proto = null;
    }
    // Twitch webhooks: "Your callback must use SSL and listen on port 443."
    if (proto !== "https:") {
      missing.push(
        "a HTTPS callback URL (Twitch webhooks require SSL on port 443)",
      );
    }
  }

  const maxRaw = Number(process.env.TWITCH_EVENTSUB_MAX_CHANNELS);
  const maxChannels =
    Number.isFinite(maxRaw) && maxRaw > 0 ? Math.round(maxRaw) : DEFAULT_MAX_CHANNELS;

  return {
    enabled: missing.length === 0 && !!clientId && !!clientSecret && secretOk,
    clientId,
    clientSecret,
    secret: secretOk ? secret : null,
    callbackUrl,
    maxChannels,
    missing,
  };
}

module.exports = {
  CALLBACK_PATH,
  SECRET_MIN,
  SECRET_MAX,
  DEFAULT_MAX_CHANNELS,
  getEventsubConfig,
};
