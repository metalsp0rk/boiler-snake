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
 * APPLICATION_COMMAND_TOO_LARGE pre-API payload guard.
 *
 * Discord rejects any top-level command whose serialized payload exceeds
 * 8000 characters, and — same atomic-PUT trap as issue #291 — one oversized
 * command took the whole guild registration down. `/event` grew to 21,136
 * chars and `npm run register` failed with
 * `Invalid Form Body 20[APPLICATION_COMMAND_TOO_LARGE]`; the split into
 * /event + /eventsignup + /eventconfig + /eventchannels is that fix. This
 * walk is the offline check that was missing.
 */

/** Discord's hard per-command serialization cap (characters). */
const MAX_COMMAND_SIZE = 8000;

describe("command payload size (Discord 8000-char cap)", () => {
  it("every registered command serializes under 8000 characters", () => {
    const { commands } = buildDefaultRegistry();
    assert.ok(commands.length > 0, "expected a non-empty default registry");

    const oversize = [];
    for (const raw of commands) {
      // Registry JSON is already toJSON()-normalized; accept raw builders too.
      const cmd = typeof raw.toJSON === "function" ? raw.toJSON() : raw;
      const size = JSON.stringify(cmd).length;
      if (size >= MAX_COMMAND_SIZE) {
        oversize.push(`/${cmd.name} — ${size} chars`);
      }
    }

    assert.deepEqual(
      oversize,
      [],
      oversize.length
        ? `Discord would reject ${oversize.length} command(s) with ` +
            `APPLICATION_COMMAND_TOO_LARGE (maximum size ${MAX_COMMAND_SIZE}):\n  ${oversize.join("\n  ")}`
        : "",
    );
  });
});
