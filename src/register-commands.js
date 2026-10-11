/**
 * Back-compat entrypoint for command registration.
 * Prefer: node src/commands/register.js  (npm run register)
 */
const { warnDeprecated } = require("./core/deprecation");
warnDeprecated(
  "src/register-commands.js",
  "src/commands/register.js (npm run register)",
);

const { main } = require("./commands/register");

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
