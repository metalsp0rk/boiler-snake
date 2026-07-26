/**
 * @deprecated Command handlers now live on each feature under src/features.
 * Kept so old require("./commands/handlers") does not break.
 */
function registerResidualHandlers() {}

module.exports = {
  registerResidualHandlers,
  registerHandlers: registerResidualHandlers,
};
