/**
 * #397 (B2-5): the bridges repo is the SOLE OWNER of the bridge tables —
 * relay.js used to hold its own connection and write bridge_outbox/
 * bridge_ends/bridge_message_links with raw SQL (against the repo header
 * and AGENTS.md). The statements moved home; this file pins the CONTRACT
 * of the move: relay.js contains no SQL at all, and every raw statement
 * it used to run has an owned, named replacement.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RELAY_SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "features", "bridge", "relay.js"),
  "utf8",
);

/** Strip block + line comments so the scan judges CODE, not prose. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}

describe("bridge table sole ownership (#397/B2-5)", () => {
  const code = stripComments(RELAY_SRC);

  it("relay.js contains no prepared statements of any kind", () => {
    assert.equal(
      /\.prepare\s*\(/.test(code),
      false,
      "relay.js must not touch better-sqlite3 directly — the repos own the SQL",
    );
  });

  it("relay.js never requires the raw connection", () => {
    assert.equal(
      /require\(["']\.\.\/\.\.\/db\/connection["']\)/.test(code),
      false,
      "no direct connection handle — everything goes through repositories (AGENTS.md: features don't do raw SQL)",
    );
  });

  it("no SQL text anywhere in relay.js mentions a bridge table", () => {
    const offenders = [];
    const sqlOnBridgeTable =
      /\b(?:FROM|UPDATE|INTO|JOIN)\s+bridge_\w+/gi;
    let m;
    while ((m = sqlOnBridgeTable.exec(code)) !== null) offenders.push(m[0]);
    assert.deepEqual(
      offenders,
      [],
      `raw SQL over bridge tables in relay.js (moved to src/db/repositories/bridges.js): ${offenders.join(", ")}`,
    );
  });

  it("every relay statement from the audit has an owned replacement exported", () => {
    const bridges = require("../src/db/repositories/bridges");
    for (const name of [
      // map reloads (was: two JOIN queries in reloadRelayMaps)
      "listActiveEndWebhookRows",
      "listEchoDestinationRows",
      // edit intake (was: createRow read, pendingDelete guard, BRG-1 pre-delete)
      "getLatestOutboxPayloadJson",
      "hasBlockingDeleteRow",
      "clearTerminalEditRows",
      // spool payload re-write (was: UPDATE ... AND state='pending' ×2)
      "updateOutboxPayloadIfPending",
      // worker annotations + first-copy record (was: raw UPDATE last_error/dest ×3)
      "annotateOutboxError",
      "setOutboxDestMessageId",
      // worker pair chooser + reclaim gate (was: raw SELECT ×2)
      "listPendingOutboxPairs",
      "hasLiveOutboxRows",
      // takedown enqueue (the #398 sibling)
      "enqueueBridgeDeleteOutbox",
    ]) {
      assert.equal(
        typeof bridges[name],
        "function",
        `bridges.js must own ${name} (the relay's former raw site)`,
      );
    }

    const facade = require("../src/db");
    for (const name of ["listPendingOutboxPairs", "hasLiveOutboxRows", "annotateOutboxError"]) {
      assert.equal(typeof facade[name], "function", `facade re-export: ${name}`);
    }
  });
});
