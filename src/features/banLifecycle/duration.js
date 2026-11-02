/**
 * Ban-duration parsing (#772 §1) — pure: takes (raw, nowMs), reads no clock
 * or file of its own, and has zero side effects. `nowMs` defaults to the wall
 * clock only at the call boundary (events/timeParse.js exemplar); tests pass
 * it explicitly and get deterministic output.
 *
 * Grammar (locked by the issue's modal table):
 *   permanent / "" / null / undefined  → permanent ban (expiresAtMs: null)
 *   <n><s|m|h|d>                       → "24h", "7d", "90m", "30s"
 *                                        (case-insensitive, inner whitespace ok)
 *   anything else                      → REFUSED, naming the exact field with
 *                                        an example — never act on a misread
 *                                        (#745; tone mirrors the refusal
 *                                        helpers in automod/constants.js).
 *
 * Bounds: floor DURATION_MIN_MS (60 s), cap DURATION_MAX_MS (365 d). Exactly
 * at a bound is valid; beyond it is refused (never clamped silently).
 *
 * On success: { ok: true, expiresAtMs } — expiresAtMs (ms) = nowMs + parsed
 * span, or null for a permanent ban. On failure: { ok: false, error } where
 * error is reply-ready copy (caller surfaces it verbatim, ephemeral).
 */

const {
  DURATION_MIN_MS,
  DURATION_MAX_MS,
  DURATION_EXAMPLES,
  MODAL_LABEL_DURATION,
} = require("./constants");

/** `<n><s|m|h|d>` after whitespace stripping. */
const DURATION_PATTERN = /^(\d+)([smhd])$/i;

const UNIT_MS = Object.freeze({
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
});

/** Human form of the bounds derived from the constants (never hardcoded). */
const FLOOR_LABEL = `${Math.round(DURATION_MIN_MS / 1_000)}s`;
const CAP_LABEL = `${Math.round(DURATION_MAX_MS / UNIT_MS.d)}d`;

/** Shared refusal shape: names the exact field, gives an example, states
 * that nothing happened (#745 never-act-on-misread rule). */
function refusalDuration(shown, problem) {
  return (
    `**${MODAL_LABEL_DURATION}:** \`${shown}\` ${problem} ` +
    `Use ${DURATION_EXAMPLES} (seconds, minutes, hours, or days), or type \`permanent\`. ` +
    "Nothing was banned."
  );
}

/**
 * Parse the Duration modal field (and the future `/ban duration:` option).
 *
 * @param {string|null|undefined} raw raw user input
 * @param {number} [nowMs] reference instant for the expiry (injectable for tests)
 * @returns {{ ok: true, expiresAtMs: number|null } | { ok: false, error: string }}
 */
function parseDuration(raw, nowMs = Date.now()) {
  const text = String(raw ?? "").trim();

  // permanent / empty → no expiry
  if (text === "" || /^permanent$/i.test(text)) {
    return { ok: true, expiresAtMs: null };
  }

  const m = DURATION_PATTERN.exec(text.replace(/\s+/g, ""));
  if (!m) {
    return {
      ok: false,
      error: refusalDuration(
        text,
        "isn't a duration (a number followed by `s`, `m`, `h`, or `d`).",
      ),
    };
  }

  const n = Number(m[1]);
  const spanMs = n * UNIT_MS[m[2].toLowerCase()];
  if (!Number.isFinite(spanMs)) {
    // absurd digit counts overflow to Infinity → same cap refusal
    return {
      ok: false,
      error: refusalDuration(text, `is longer than the ${CAP_LABEL} maximum.`),
    };
  }

  if (spanMs < DURATION_MIN_MS) {
    return {
      ok: false,
      error: refusalDuration(text, `is shorter than the ${FLOOR_LABEL} minimum.`),
    };
  }
  if (spanMs > DURATION_MAX_MS) {
    return {
      ok: false,
      error: refusalDuration(text, `is longer than the ${CAP_LABEL} maximum.`),
    };
  }

  return { ok: true, expiresAtMs: nowMs + spanMs };
}

module.exports = { parseDuration };
