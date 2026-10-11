const { warnDeprecated } = require("./core/deprecation");
warnDeprecated("src/reactionRoles.js", "src/features/reactionRoles/service");

module.exports = require("./features/reactionRoles/service");
