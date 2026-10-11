const { warnDeprecated } = require("./core/deprecation");
warnDeprecated("src/renderHoneypotWarning.js", "src/features/honeypot/renderWarning");

module.exports = require("./features/honeypot/renderWarning");
