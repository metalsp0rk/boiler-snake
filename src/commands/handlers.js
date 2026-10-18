// #461 (H1-1): same silent-stub exclusion as definitions.js — a no-op call
// that succeeds forever without a word. Now warns once per process like
// every other shim, and joins the docs table so v2.0 removes it too.
const { warnDeprecated } = require("../core/deprecation");
warnDeprecated(
  "src/commands/handlers.js",
  "per-feature handlers under src/features (the registry dispatches them)"
);

/**
 * @deprecated Command handlers now live on each feature under src/features.
 * Kept so old require("./commands/handlers") does not break.
 */
function registerResidualHandlers() {}

module.exports = {
  registerResidualHandlers,
  registerHandlers: registerResidualHandlers,
};
