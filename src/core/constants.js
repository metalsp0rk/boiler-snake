// Shared numeric / policy constants used across XP and command validation.

/** Cap on a single XP award event (message, reaction, voice tick, admin set). */
const MAX_XP_AWARD = 1_000_000_000;

/** JS-safe XP total cap (prevents Infinity / precision loss in Node). */
const MAX_SAFE_XP = Number.MAX_SAFE_INTEGER; // 9,007,199,254,740,991

module.exports = {
  MAX_XP_AWARD,
  MAX_SAFE_XP,
};
