/**
 * #470 (G2-7): determinism guardrail — the corpus may not read the REAL wall
 * clock's hour/day fields anywhere a FORCED execution clock drives behavior.
 *
 * The audited incident (#382): an e2e digest test configured `hour_utc` from
 * `new Date().getUTCHours()` while ticking with `nowMs = real + 3h`. After
 * UTC 20:00 the forced tick crosses midnight, the daily boundary lands in the
 * future, the digest never fires — CI was green purely by schedule luck.
 * The class rule (test/README.md #5): forced EXECUTION clock ⇒ derive ALL
 * clock-shaped CONFIG from the same forced instant (test/e2e/helpers/time.js
 * exports forcedHourFor). This scan pins that no new site sneaks in.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DIRS = ["test/e2e", "test/integration"].map((d) => path.join(__dirname, "..", d));

// new Date().getHours()/getUTCHours()/getDay()/getDate()/getUTCDate()/
// getMinutes()/getMonth() — real-clock FIELD READS as a one-liner.
const FIELD_READ = /new Date\(\)\s*\.get(Utc|UTC|Hour|Hours|Day|Date|Minutes|Month)/i;

function testFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => path.join(dir, f));
}

// Audited self-consistent sites (G2-7 sibling scan): events.test.js reads the
// real weekday for setup AND ticks un-injected — real clock end-to-end, no
// MIX. The finding is forbidden only where a real-clock read configures a
// FORCED tick. Any addition here needs the same audit note.
const ALLOWED = new Set([
  path.join(__dirname, "..", "test", "integration", "events.test.js"),
]);

describe("#470 (G2-7): forced-clock tests never configure off the real clock", () => {
  it("no e2e/integration test reads real wall-clock fields inline", () => {
    const offenders = [];
    for (const dir of DIRS) {
      for (const file of testFiles(dir)) {
        if (ALLOWED.has(file)) continue;
        fs.readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (FIELD_READ.test(line) && !line.trim().startsWith("//")) {
              offenders.push(
                `${path.relative(path.join(__dirname, ".."), file)}:${i + 1}: ${line.trim()}`,
              );
            }
          });
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "derive clock-shaped config from the FORCED nowMs (see test/e2e/helpers/time.js)",
    );
  });

  it("the anchor helper derives from the FORCED instant, not the wall clock", () => {
    const { forcedHourFor } = require("./e2e/helpers/time");
    assert.equal(forcedHourFor(Date.UTC(2026, 9, 18, 23, 30, 0)), 23);
    // the #382 window: real-now 23:30 + 90 min → the tick runs at hour 0
    assert.equal(forcedHourFor(Date.UTC(2026, 9, 18, 23, 30, 0) + 60 * 60_000), 0, "23:30 + 60min = 00:30 → hour 0");
    assert.equal(forcedHourFor(new Date("2026-10-18T04:00:00Z").getTime()), 4);
  });
});
