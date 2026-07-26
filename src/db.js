/**
 * Compatibility entry: `require("./db")` resolves here.
 * Implementation lives under `src/db/` (connection, migrations, repositories).
 */
module.exports = require("./db/index");
