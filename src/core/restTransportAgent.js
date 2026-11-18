/**
 * Pinned REST transport agent (#855).
 *
 * The problem: `@discordjs/rest` passes no explicit `dispatcher` on its
 * requests, so every send inherits the PROCESS-GLOBAL undici dispatcher
 * (read through `Symbol.for('undici.globalDispatcher.1')`). That global is
 * shared — and hijackable — across every vendored copy of undici in the
 * process. jsdom vendors undici@8 (loaded lazily by gork `readPage`); when
 * its `lib/global.js` initializes it only checks the NEWER
 * `undici.globalDispatcher.2` symbol (which the undici@6 copy that
 * `@discordjs/rest` resolved never sets), concludes no dispatcher exists,
 * installs its own, and OVERWRITES the legacy `.1` symbol that undici@6
 * reads. From then on every discord.js REST send runs through undici@8's
 * core request builder — which rejects the native `FormData` that
 * `@discordjs/rest` builds for multipart replies ("body must be a FormData
 * created by this undici package instance…"), killing every file-carrying
 * reply (e.g. /leaderboard's PNG) while JSON-body commands keep working.
 *
 * The fix: hand REST an explicit dispatcher — an Agent from the SAME undici
 * instance that `@discordjs/rest` itself resolves — so the process-global
 * dispatcher is never consulted. Module identity matters: the Agent class
 * and the request builder that consumes it must come from one copy, hence
 * the createRequire from rest's own resolution site (npm hoisting changes
 * or a future rest-side nested copy both keep the pair consistent).
 */

const Module = require("node:module");

let cachedAgent = null;
let built = false;

function createTransportAgent() {
  try {
    // Resolve undici exactly as @discordjs/rest does (from the rest
    // package's own location), so the Agent class identity matches the
    // request builder that consumes it.
    const reqFromRest = Module.createRequire(require.resolve("@discordjs/rest"));
    const { Agent } = reqFromRest("undici");
    return new Agent();
  } catch (err) {
    // Degraded, never fatal: REST keeps its default global-dispatcher
    // behaviour (i.e. pre-#855 status quo) if resolution ever fails.
    console.warn(
      "[client] could not build the pinned REST transport agent — falling back to the global undici dispatcher (file-carrying replies may break once jsdom's vendored undici initializes, see #855):",
      err?.message || err,
    );
    return null;
  }
}

/**
 * Lazily built singleton Agent for discord.js REST options
 * (`Client({ rest: { agent } })` / `new REST({ agent })`).
 *
 * @returns {object|null} the pinned dispatcher, or null when undici could
 *   not be resolved from @discordjs/rest's location (warned once).
 */
function restTransportAgent() {
  if (!built) {
    built = true;
    cachedAgent = createTransportAgent();
  }
  return cachedAgent;
}

module.exports = { restTransportAgent };
