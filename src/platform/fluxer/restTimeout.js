/**
 * Fluxer REST timeout policy (#436, audit F1-3).
 *
 * The Fluxer platform layer shipped ZERO timeout/abort primitives: a wedged
 * or dead instance left every awaiting caller pinned at the undici default
 * (~300 s headers timeout) — serially per call, and for gork INSIDE the
 * single per-community queue slot, which turns one hung socket into
 * "gork off for this community for minutes per trigger" while the queue
 * fills. Discord is bounded by discord.js `requestTimeout`; this closes the
 * platform asymmetry at the transport choke points.
 *
 * Deliberately dependency-free (client.js requires outbound.js, so a helper
 * in either direction would cycle — both require THIS module instead).
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 15000; // mirrors discord.js' requestTimeout default
const MAX_REQUEST_TIMEOUT_MS = 600000; // 10 min sanity ceiling for misconfigured envs

/**
 * Per-request deadline in ms: `FLUXER_REQUEST_TIMEOUT_MS`, default 15000.
 * Read per call so ops (and tests) can retune without a restart. Invalid,
 * <1, or absurd values fall back to the default — the transport must ALWAYS
 * be bounded; there is no "off" switch.
 *
 * @returns {number}
 */
function fluxerRequestTimeoutMs() {
  const raw = Number(process.env.FLUXER_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw < 1 || raw > MAX_REQUEST_TIMEOUT_MS) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return Math.floor(raw);
}

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  fluxerRequestTimeoutMs,
};
