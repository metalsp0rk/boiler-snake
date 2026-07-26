/**
 * Feature module loader.
 *
 * Each feature may export:
 *   name: string
 *   commands: SlashCommandBuilder[]
 *   handlers: { [commandName]: async (interaction, ctx) => void }
 *   autocomplete: { [commandName]: async (interaction, ctx) => void }
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
  }
}

/**
 * @param {import("discord.js").Client} client
 * @param {object[]} features
 * @param {object} ctx
 */
function registerAllFeatureEvents(client, features, ctx) {
  for (const feature of features) {
    if (typeof feature.registerEvents === "function") {
      feature.registerEvents(client, ctx);
    }
  }
}

/**
 * @param {import("discord.js").Client} client
 * @param {object[]} features
 * @param {object} ctx
 */
function startAllFeatures(client, features, ctx) {
  for (const feature of features) {
    if (typeof feature.start === "function") {
      feature.start(client, ctx);
    }
  }
}

module.exports = {
  applyFeaturesToRegistry,
  registerAllFeatureEvents,
  startAllFeatures,
};
