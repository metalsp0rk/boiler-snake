/**
 * Command registry: slash definitions + name→handler maps from feature modules.
 */

/**
 * @typedef {object} CommandRegistry
 * @property {object[]} commands REST-ready JSON bodies
 * @property {import("discord.js").SlashCommandBuilder[]} commandBuilders
 * @property {Map<string, Function>} handlers
 * @property {Map<string, Function>} autocomplete
 * @property {(builder: object) => void} addCommand
 * @property {(name: string, fn: Function) => void} registerHandler
 * @property {(name: string, fn: Function) => void} registerAutocomplete
 * @property {(name: string) => Function|undefined} getHandler
 * @property {(name: string) => Function|undefined} getAutocomplete
 */

/**
 * @returns {CommandRegistry}
 */
function createRegistry() {
  /** @type {import("discord.js").SlashCommandBuilder[]} */
  const commandBuilders = [];
  /** @type {object[]} */
  let commands = [];
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  /** @type {Map<string, Function>} */
  const autocomplete = new Map();
  /** @type {Set<string>} */
  const commandNames = new Set();

  function rebuildJson() {
    commands = commandBuilders.map((c) =>
      typeof c.toJSON === "function" ? c.toJSON() : c
    );
  }

  return {
    get commands() {
      return commands;
    },
    get commandBuilders() {
      return commandBuilders;
    },
    handlers,
    autocomplete,

    addCommand(builder) {
      if (!builder) throw new Error("addCommand: builder required");
      const name =
        typeof builder.toJSON === "function"
          ? builder.toJSON().name
          : builder.name;
      if (!name) throw new Error("addCommand: command missing name");
      if (commandNames.has(name)) {
        throw new Error(`addCommand: duplicate command /${name}`);
      }
      commandNames.add(name);
      commandBuilders.push(builder);
      rebuildJson();
    },

    registerHandler(name, fn) {
      if (typeof name !== "string" || !name) {
        throw new Error("registerHandler: name required");
      }
      if (typeof fn !== "function") {
        throw new Error(`registerHandler(${name}): fn must be a function`);
      }
      handlers.set(name, fn);
    },

    registerAutocomplete(name, fn) {
      if (typeof name !== "string" || !name) {
        throw new Error("registerAutocomplete: name required");
      }
      if (typeof fn !== "function") {
        throw new Error(`registerAutocomplete(${name}): fn must be a function`);
      }
      autocomplete.set(name, fn);
    },

    getHandler(name) {
      return handlers.get(name);
    },

    getAutocomplete(name) {
      return autocomplete.get(name);
    },
  };
}

/**
 * Build the default registry from all feature modules.
 * @returns {CommandRegistry}
 */
function buildDefaultRegistry() {
  const registry = createRegistry();
  const features = require("../features");
  const { applyFeaturesToRegistry } = require("../features/load");
  applyFeaturesToRegistry(features, registry);
  return registry;
}

function getRegisteredCommands() {
  return buildDefaultRegistry().commands;
}

module.exports = {
  createRegistry,
  buildDefaultRegistry,
  getRegisteredCommands,
  get commands() {
    return getRegisteredCommands();
  },
};
