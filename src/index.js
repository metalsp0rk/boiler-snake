// src/index.js — thin entry: env gate, registry, boot (Discord + Fluxer endpoints)
require("dotenv").config();

const { assertRuntimeEnv } = require("./config");
const { buildDefaultRegistry } = require("./commands/registry");
const { boot } = require("./platform/boot");

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
      `[boot] all configured endpoints failed to start; exiting with code ${result.exitCode}`,
    );
    process.exit(result.exitCode);
  }
}

main().catch((err) => {
  // Last-resort net for a rejection that escaped boot (e.g. a malformed
  // FLUXER_INSTANCES block that assertRuntimeEnv's twin in boot re-threw).
  console.error("[boot] fatal startup error:", err?.message || err);
  process.exit(1);
});
