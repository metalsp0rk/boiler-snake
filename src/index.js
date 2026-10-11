// src/index.js — thin entry: env gate, registry, boot (Discord + Fluxer endpoints)
require("dotenv").config();

const { assertRuntimeEnv } = require("./config");
const { buildDefaultRegistry } = require("./commands/registry");
const { boot } = require("./platform/boot");
const { drainAndExit } = require("./core/lifecycle");

// Boot gate (spec § Boot rules 1-3): at least one platform credential, and a
// malformed FLUXER_INSTANCES block throws even when DISCORD_TOKEN is set.
assertRuntimeEnv();

/**
 * Start every configured endpoint. Feature events/start hooks are wired by
 * boot() exactly as this entry point did inline before PR 6 (console parity:
 * "Boiler Snake logged in as <tag>" on Discord ready).
 */
async function main() {
  const registry = buildDefaultRegistry();
  const result = await boot({ registry });
  // Spec: exit non-zero only when EVERY configured endpoint failed. The
  // exit lives here — not in boot() — so tests can exercise boot() safely.
  if (result.ok === false) {
    console.error(
      `[boot] all configured endpoints failed to start; draining, then exiting with code ${result.exitCode}`,
    );
    // Audit C9 + issue #190: the terminal all-endpoints-failed path exits
    // THROUGH the lifecycle drain (endpoint stop handles LIFO, each logged)
    // instead of a bare process.exit hard-cutting sockets/WAL. The exit
    // goes through core/lifecycle's injectable seam, so tests can drive
    // the exact path without killing their own worker (#185 lesson).
    await drainAndExit({
      reason: "boot: every configured endpoint failed",
      exitCode: result.exitCode,
    });
  }
}

main().catch((err) => {
  // Last-resort net for a rejection that escaped boot (e.g. a malformed
  // FLUXER_INSTANCES block that assertRuntimeEnv's twin in boot re-threw).
  console.error("[boot] fatal startup error:", err?.message || err);
  process.exit(1);
});
