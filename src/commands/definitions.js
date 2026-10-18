// #461 (H1-1): this stub was EXCLUDED from the repo's own #206 deprecation
// regime — a JSDoc tag but no runtime warning, invisible in the docs compat
// table: an external require got an empty array with ZERO signal (the exact
// silent-drop pattern #206 was created to end), and the v2.0 sweep enumerates
// only the warned shims, so this file would outlive its own removal plan.
const { warnDeprecated } = require("../core/deprecation");
warnDeprecated(
  "src/commands/definitions.js",
  "per-feature definitions under src/features (the registry collects them)"
);

/**
 * @deprecated Slash definitions now live on each feature under src/features.
 * Kept so old require("./commands/definitions") does not break.
 */
module.exports = {
  residualBuilders: [],
  commandBuilders: [],
  commands: [],
};
