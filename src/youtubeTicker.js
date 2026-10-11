const { warnDeprecated } = require("./core/deprecation");
warnDeprecated("src/youtubeTicker.js", "src/features/youtube/ticker");

module.exports = require("./features/youtube/ticker");
