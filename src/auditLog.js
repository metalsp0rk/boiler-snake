const { warnDeprecated } = require("./core/deprecation");
warnDeprecated("src/auditLog.js", "src/features/logs/auditLog");

module.exports = require("./features/logs/auditLog");
