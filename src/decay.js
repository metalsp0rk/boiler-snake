// Compatibility re-export — prefer require("./features/decay")
const { warnDeprecated } = require("./core/deprecation");
warnDeprecated("src/decay.js", "src/features/decay (startDecayScheduler, runDecayForGuild)");

const {
  startDecayScheduler,
  runDecayForGuild,
} = require("./features/decay");

module.exports = { startDecayScheduler, runDecayForGuild };
