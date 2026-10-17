const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * #450 (audit G2-5): the e2e mock Discord is host-global — port 3100, one
 * shared data dir, deterministic suite namespaces — while every e2e job
 * lands on the SAME self-hosted runner. A per-ref concurrency group let a
 * PR run and a push-to-main run overlap: provision()'s setup wipe killed
 * the other suite's guild mid-run, and a patch-pin mismatch on either
 * branch RESTARTED THE SHARED MOCK under the running suite (dead gateway
 * sockets — the unreproducible flake class). All e2e runs must serialize
 * behind ONE fixed group, with cancel-in-progress off (a queued run must
 * not cancel the run holding the mock, and a cancelled suite would strand
 * mock state mid-run). Same shared-resource rationale as the
 * docker-publish workflow's fixed group.
 */
function concurrencyBlock(workflowFile) {
  const wf = fs.readFileSync(
    path.join(__dirname, "../.github/workflows", workflowFile),
    "utf8",
  );
  const m = wf.match(/^concurrency:\r?\n((?:(?:[ ]+)\S.*\r?\n?)+)/m);
  return m ? m[1] : null;
}

test("e2e workflow serializes ALL runs behind one fixed concurrency group (#450)", () => {
  const block = concurrencyBlock("e2e.yml");
  assert.ok(block, "e2e.yml must declare a concurrency block");
  assert.match(block, /group:[ \t]*fauxcord-e2e[ \t]*$/m, "fixed shared group");
  assert.doesNotMatch(
    block,
    /github\.ref/,
    "a per-ref group lets two refs share the host-global mock at once",
  );
  assert.match(
    block,
    /cancel-in-progress:\s*false/,
    "queued runs must wait, not cancel the run holding the mock",
  );
});
