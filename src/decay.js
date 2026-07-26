// Compatibility re-export — prefer require("./features/decay")
const {
  startDecayScheduler,
  runDecayForGuild,
} = require("./features/decay");

module.exports = { startDecayScheduler, runDecayForGuild };
