/**
 * Delivery-error classification shared by the outbound notifiers (#827).
 *
 * A DELETED notify channel and a MOOTED guild are permanent by definition:
 * every retry of the same payload fails identically, so the retry valves
 * (youtube / githubReleases tickers) treat them differently from transient
 * failures — no attempt budget is wasted on a channel that will never
 * exist again. Everything else (permission revocations, rate-limit
 * bursts, transient API errors) stays in the capped-retry lane.
 *
 * Classification runs on the CAUSE STRING because OutboundClient.sendChannel
 * flattens DiscordAPIError into `error` text (discord.js renders
 * `DiscordAPIError[10003]: Unknown Channel`), exactly like the sanctioned
 * tickets `formatChannelCreateError` translation reads the same strings. */

/** Discord API codes meaning "the destination is GONE" for a send. */
const GONE_DELIVERY_CODES = Object.freeze({
  10003: "Unknown Channel (the notification channel no longer exists)",
  10004: "Unknown Guild (the community is gone or the bot was removed)",
});

/**
 * @param {unknown} error cause string from a failed send ({ok:false,error})
 * @returns {boolean} true when retrying the same channel can never succeed
 */
function isGoneDeliveryError(error) {
  const text = String(error || "");
  if (/\b(10003|10004)\b/.test(text)) return true;
  return /unknown (channel|guild)/i.test(text);
}

/**
 * Human cause for audit/log copy: the code's named meaning when recognized,
 * the raw string otherwise (never "unknown error" — AGENTS error rule 3).
 *
 * @param {unknown} error
 * @returns {string}
 */
function describeGoneDeliveryError(error) {
  const text = String(error || "");
  const code = text.match(/\b(10003|10004)\b/)?.[1];
  const named = code ? GONE_DELIVERY_CODES[Number(code)] : null;
  if (named) return `${named} — ${text}`;
  if (/unknown channel/i.test(text)) {
    return `${GONE_DELIVERY_CODES[10003]} — ${text}`;
  }
  if (/unknown guild/i.test(text)) {
    return `${GONE_DELIVERY_CODES[10004]} — ${text}`;
  }
  return text || "delivery failed";
}

module.exports = {
  GONE_DELIVERY_CODES,
  isGoneDeliveryError,
  describeGoneDeliveryError,
};
