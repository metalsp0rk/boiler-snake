/**
 * Feature module loader.
 *
 * Each feature may export:
 *   name: string
 *   commands: SlashCommandBuilder[]
 *   handlers: { [commandName]: async (interaction, ctx) => void }
 *   autocomplete: { [commandName]: async (interaction, ctx) => void }
 *   modalHandlers: { [customIdPrefix]: async (interaction, ctx) => void }
 *   buttonHandlers: { [customIdPrefix]: async (interaction, ctx) => void }
 *   registerEvents(client, ctx): void
 *   start(client, ctx): void   // ClientReady tickers/schedulers
 */

/**
 * @param {object[]} features
 * @param {import("../commands/registry").CommandRegistry} registry
 */
function applyFeaturesToRegistry(features, registry) {
  for (const feature of features) {
    if (!feature?.name) {
      throw new Error("Feature module missing name");
    }

    for (const builder of feature.commands || []) {
      registry.addCommand(builder);
    }

    for (const [name, fn] of Object.entries(feature.handlers || {})) {
      registry.registerHandler(name, fn);
    }

    for (const [name, fn] of Object.entries(feature.autocomplete || {})) {
      registry.registerAutocomplete(name, fn);
    }

    for (const [prefix, fn] of Object.entries(feature.modalHandlers || {})) {
      registry.registerModalHandler(prefix, fn);
    }

    for (const [prefix, fn] of Object.entries(feature.buttonHandlers || {})) {
      registry.registerButtonHandler(prefix, fn);
    }
  }
}

/**
 * Run one lifecycle hook across all features, isolating failures: a throwing
 * feature is logged (with feature + hook context) and skipped instead of
 * killing the boot loop / login. See AGENTS.md → Error Handling.
 * @returns {string[]} descriptors of failed hooks (empty on success)
 */
function runFeatureHook(client, features, ctx, hookName) {
  const failed = [];
  for (const feature of features) {
    if (typeof feature?.[hookName] !== "function") continue;
    try {
      feature[hookName](client, ctx);
    } catch (err) {
      console.error(
        `[features] ${feature.name || "unknown"}.${hookName} failed:`,
        err?.message || err
      );
      failed.push(`${feature.name || "unknown"}.${hookName}`);
    }
  }
  if (failed.length) {
    console.error(
      `[features] boot continuing with degraded features: ${failed.join(", ")}`
    );
  }
  return failed;
}

/**
 * @param {import("discord.js").Client} client
 * @param {object[]} features
 * @param {object} ctx
 * @returns {string[]} failed hook descriptors
 */
function registerAllFeatureEvents(client, features, ctx) {
  return runFeatureHook(client, features, ctx, "registerEvents");
}

/**
 * @param {import("discord.js").Client} client
 * @param {object[]} features
 * @param {object} ctx
 * @returns {string[]} failed hook descriptors
 */
function startAllFeatures(client, features, ctx) {
  return runFeatureHook(client, features, ctx, "start");
}

module.exports = {
  applyFeaturesToRegistry,
  registerAllFeatureEvents,
  startAllFeatures,
};
