const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// Loading the registry pulls in every feature module, which opens SQLite at
// require time (db facade side effect). CONTRACT: loadDb() must stay above
// every `src/` require in this file — it points this process at a private
// temp DB (fresh DB_PATH + src require-cache reset) before those requires
// load, because the project-root default (xpbot.sqlite) is racy when
// node --test runs files in parallel (SQLITE_ERROR flakes).
const { cleanup } = loadDb();

const { buildDefaultRegistry } = require("../src/commands/registry");

// Closes the tracked DB handles and removes the temp dir (idempotent,
// never throws).
after(cleanup);

/**
 * issue #291 pre-API payload guard.
 *
 * Discord rejects a slash-command payload with
 * APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID whenever a required option
 * follows a non-required one in the same `options` array, and the guild
 * registration PUT is atomic: ONE badly ordered subcommand made every
 * command fail to register. The registry built fine offline, so nothing
 * caught it until the live API did. This walk is that missing check.
 */

/** ApplicationCommandOptionType values for subcommands — never themselves required, only nested. */
const SUBCOMMAND_TYPES = new Set([1, 2]); // SUB_COMMAND, SUB_COMMAND_GROUP

/**
 * Recursively walk one `options` array, recording every required-after-
 * optional violation as "<command path> > <option>: follows optional <x>".
 *
 * @param {object[]} options serialized options (registry JSON already went through toJSON())
 * @param {string} path dotted display path, e.g. "/event > reminders > add"
 * @param {string[]} violations accumulated offenders
 */
function walkOptions(options, path, violations) {
  let firstOptionalName = null;
  for (const opt of options) {
    if (!SUBCOMMAND_TYPES.has(opt.type)) {
      if (opt.required === true && firstOptionalName !== null) {
        violations.push(
          `${path} > ${opt.name}: required option follows optional "${firstOptionalName}"`,
        );
      } else if (opt.required !== true && firstOptionalName === null) {
        firstOptionalName = opt.name;
      }
    }
    if (Array.isArray(opt.options)) {
      walkOptions(opt.options, `${path} > ${opt.name}`, violations);
    }
  }
}

describe("command payload option order (issue #291)", () => {
  it("has no required option after a non-required option in any command", () => {
    const { commands } = buildDefaultRegistry();
    assert.ok(commands.length > 0, "expected a non-empty default registry");

    const violations = [];
    for (const raw of commands) {
      // Registry JSON is already toJSON()-normalized; accept raw builders too.
      const cmd = typeof raw.toJSON === "function" ? raw.toJSON() : raw;
      walkOptions(cmd.options ?? [], `/${cmd.name}`, violations);
    }

    assert.deepEqual(
      violations,
      [],
      violations.length
        ? `Discord would reject ${violations.length} option(s) with ` +
            `APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID ` +
            `(Required options must be placed before non-required options):\n  ${violations.join("\n  ")}`
        : "",
    );
  });
});
