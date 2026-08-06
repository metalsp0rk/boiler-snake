/**
 * Command registry: slash definitions + name→handler maps from feature modules.
 */

/**
 * @typedef {object} CommandRegistry
 * @property {object[]} commands REST-ready JSON bodies
 * @property {import("discord.js").SlashCommandBuilder[]} commandBuilders
 * @property {Map<string, Function>} handlers
 * @property {Map<string, Function>} autocomplete
 * @property {Map<string, Function>} modalHandlers customId prefix → handler
 * @property {Map<string, Function>} buttonHandlers customId prefix → handler
 * @property {(builder: object) => void} addCommand
 * @property {(name: string, fn: Function) => void} registerHandler
 * @property {(name: string, fn: Function) => void} registerAutocomplete
 * @property {(prefix: string, fn: Function) => void} registerModalHandler
 * @property {(prefix: string, fn: Function) => void} registerButtonHandler
 * @property {(name: string) => Function|undefined} getHandler
 * @property {(name: string) => Function|undefined} getAutocomplete
 * @property {(customId: string) => Function|undefined} getModalHandler
 * @property {(customId: string) => Function|undefined} getButtonHandler
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
  /** @type {Map<string, Function>} customId prefix → handler */
  const modalHandlers = new Map();
  /** @type {Map<string, Function>} customId prefix → handler */
  const buttonHandlers = new Map();
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
    modalHandlers,
    buttonHandlers,

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

    registerModalHandler(prefix, fn) {
      if (typeof prefix !== "string" || !prefix) {
        throw new Error("registerModalHandler: prefix required");
      }
      if (typeof fn !== "function") {
        throw new Error(
          `registerModalHandler(${prefix}): fn must be a function`
        );
      }
      modalHandlers.set(prefix, fn);
    },

    registerButtonHandler(prefix, fn) {
      if (typeof prefix !== "string" || !prefix) {
        throw new Error("registerButtonHandler: prefix required");
      }
      if (typeof fn !== "function") {
        throw new Error(
          `registerButtonHandler(${prefix}): fn must be a function`
        );
      }
      buttonHandlers.set(prefix, fn);
    },

    getHandler(name) {
      return handlers.get(name);
    },

    getAutocomplete(name) {
      return autocomplete.get(name);
    },

    getModalHandler(customId) {
      return matchPrefixHandler(modalHandlers, customId);
    },

    getButtonHandler(customId) {
      return matchPrefixHandler(buttonHandlers, customId);
    },
  };
}

/**
 * Prefer longest matching customId prefix.
 * @param {Map<string, Function>} map
 * @param {string} customId
 * @returns {Function|undefined}
 */
function matchPrefixHandler(map, customId) {
  if (!customId) return undefined;
  let best;
  let bestLen = -1;
  for (const [prefix, fn] of map) {
    if (customId.startsWith(prefix) && prefix.length > bestLen) {
      best = fn;
      bestLen = prefix.length;
    }
  }
  return best;
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
