// Compatibility re-export — prefer require("./core/xpMath") in new code.
const { warnDeprecated } = require("./core/deprecation");
warnDeprecated("src/xp.js", "src/core/xpMath (levelFromXp)");

const { levelFromXp } = require("./core/xpMath");

module.exports = { levelFromXp };
