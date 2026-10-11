/** @deprecated prefer require("./render/leaderboard") */
const { warnDeprecated } = require("./core/deprecation");
warnDeprecated("src/renderLeaderboard.js", "src/render/leaderboard");

module.exports = require("./render/leaderboard");
