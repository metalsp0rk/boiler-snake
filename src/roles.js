/** @deprecated prefer require("./features/levelRoles/sync") */
const { warnDeprecated } = require("./core/deprecation");
warnDeprecated("src/roles.js", "src/features/levelRoles/sync");

module.exports = require("./features/levelRoles/sync");
