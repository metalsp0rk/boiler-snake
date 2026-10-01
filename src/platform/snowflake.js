/**
 * Snowflake → wall-clock decoding (roadmap/fluxer.md § Topology:
 * `snowflake.js # snowflakeTimeMs(id, platform) — shift 22, epoch
 * 1420070400000 for both today`).
 *
 * Discord and Fluxer share the 2015-01-01 epoch (1420070400000 ms) and the
 * 22-bit right shift (spec "Facts": both platforms; Phase 0 confirmed Fluxer
 * ids are 64-bit snowflakes). Keeping the platform parameter in the signature
 * now means a future divergence is a one-line change at the seam, not a
 * sweep of call sites.
 *
 * ids are strings of digits — a snowflake is larger than Number.MAX_SAFE_INTEGER,
 * so a numeric id is rejected outright (spec: "throws on non-digit-string ids").
 */

/** Milliseconds between the Unix epoch and the Discord/Fluxer epoch (2015-01-01T00:00:00Z). */
const SNOWFLAKE_EPOCH_MS = 1420070400000n;

/** Bit shift applied to a snowflake to recover the millisecond offset. */
const SNOWFLAKE_SHIFT = 22n;

/** Platforms with a known snowflake layout (both share epoch + shift today). */
const KNOWN_PLATFORMS = new Set(["discord", "fluxer"]);

/**
 * Decode a snowflake id to its creation timestamp in Unix milliseconds.
 *
 * @param {string} id digit-string snowflake
 * @param {"discord"|"fluxer"} platform platform that issued the id
 * @returns {number} Unix epoch milliseconds (may be in the future for ids
 *   whose timestamp bits are set by a remote clock — callers clamp if that
 *   matters)
 * @throws {Error} on an unknown platform, a non-string id, a non-digit id,
 *   or a value too large to be a 64-bit id
 */
function snowflakeTimeMs(id, platform) {
  if (typeof platform !== "string" || !KNOWN_PLATFORMS.has(platform)) {
    throw new Error(
      `snowflakeTimeMs: unknown platform ${JSON.stringify(String(platform))} (expected "discord" or "fluxer")`,
    );
  }
  if (typeof id !== "string" || !/^\d+$/.test(id)) {
    const shown = typeof id === "string" ? JSON.stringify(id) : typeof id;
    throw new Error(`snowflakeTimeMs: id must be a digit string, got ${shown}`);
  }
  if (id.length > 20) {
    // 2^63-1 = 9223372036854775807 has 19 digits; 20 digits can still fit
    // unsigned 64-bit space. Beyond 20 it is not a snowflake.
    throw new Error(
      `snowflakeTimeMs: id "${id}" is too large to be a 64-bit snowflake`,
    );
  }
  return Number((BigInt(id) >> SNOWFLAKE_SHIFT) + SNOWFLAKE_EPOCH_MS);
}

module.exports = {
  SNOWFLAKE_EPOCH_MS,
  SNOWFLAKE_SHIFT,
  snowflakeTimeMs,
};
