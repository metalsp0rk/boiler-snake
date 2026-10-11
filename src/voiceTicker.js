// Compatibility re-export — prefer require("./features/voice")
const { warnDeprecated } = require("./core/deprecation");
warnDeprecated("src/voiceTicker.js", "src/features/voice (startVoiceTicker)");

const { startVoiceTicker } = require("./features/voice");

module.exports = { startVoiceTicker };
