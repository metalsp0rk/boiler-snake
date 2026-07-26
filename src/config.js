/**
 * Process environment used by the bot.
 * Values are read where needed; this module documents the contract.
 *
 * Required:
 *   DISCORD_TOKEN  — bot token
 *   CLIENT_ID      — application id (slash registration)
 *
 * Optional:
 *   DEV_GUILD_ID   — register commands to one guild instantly
 *   DATA_DIR       — directory for xpbot.sqlite (default: project root)
 *   DB_PATH        — full path to sqlite file (wins over DATA_DIR)
 *   YOUTUBE_API_KEY — YouTube Data API (live detection / channel resolve)
 */

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

/**
 * Validate required env vars at boot (login still uses process.env.DISCORD_TOKEN).
 */
function assertRuntimeEnv() {
  requireEnv("DISCORD_TOKEN");
}

module.exports = {
  requireEnv,
  assertRuntimeEnv,
};
