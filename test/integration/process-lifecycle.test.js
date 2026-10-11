/**
 * Integration: process-level crash net + graceful shutdown, observed on a
 * REAL spawned OS process running the real boot() path offline (issue #185,
 * audit C8/C9).
 *
 * Full `npm start` spawn is impossible offline (it would need Discord login),
 * so the fixture boots with NO credentials — every code path the guards take
 * in production (guard install, handle registration, signal drain, exit
 * codes) still executes for real; only the network endpoints are absent.
 * The lifecycle MODULE itself is covered in test/processGuards.test.js and
 * the boot wiring in test/bootProcessGuards.test.js.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FIXTURE = path.join(__dirname, "..", "fixtures", "process-lifecycle-child.js");

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawn the boot fixture with a private temp DB and NO platform credentials
 * (boot must stay offline: zero endpoints, zero network).
 * @param {string} mode fixture mode: reject | hang | fatal
 */
function spawnFixture(mode) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boiler-snake-lc-"));
  tmpDirs.push(tmpDir);
  const env = { ...process.env, DB_PATH: path.join(tmpDir, "life.sqlite"), DATA_DIR: tmpDir };
  delete env.DISCORD_TOKEN;
  delete env.FLUXER_INSTANCES;
  const child = spawn(process.execPath, [FIXTURE, mode], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { child, output: "", closed: false };
  child.stdout.on("data", (d) => {
    state.output += d.toString();
  });
  child.stderr.on("data", (d) => {
    state.output += d.toString();
  });
  child.on("close", () => {
    // 'close' = stdio fully drained (Node emits 'exit' FIRST, so output
    // asserted right after exitCode flips can miss the last pipe chunks).
    state.closed = true;
  });
  return state;
}

/** Wait until `needle` appears in the combined child output. */
async function waitForOutput(state, needle, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!state.output.includes(needle)) {
    if (state.child.exitCode !== null || Date.now() > deadline) {
      state.child.kill("SIGKILL");
      assert.fail(
        `child never printed "${needle}" (exit=${state.child.exitCode})\n--- output ---\n${state.output}`,
      );
    }
    await sleep(25);
  }
}

/**
 * Wait for exit AND stdio close; SIGKILL + fail if the exit never happens.
 * Waiting for 'close' matters: 'exit' can fire while the child's final
 * stdout/stderr chunks are still in flight through the pipe, and the callers
 * assert on those last logs right after.
 */
async function waitForExit(state, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (state.child.exitCode === null || !state.closed) {
    if (state.child.exitCode !== null && state.closed) break;
    if (Date.now() > deadline) {
      state.child.kill("SIGKILL");
      assert.fail(
        `child did not exit+close within ${timeoutMs}ms (exit=${state.child.exitCode})\n--- output ---\n${state.output}`,
      );
    }
    await sleep(25);
  }
  return state.child.exitCode;
}

function killQuiet(state) {
  try {
    state.child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

describe("process lifecycle on a real spawned boot (C8/C9)", () => {
  it("escaped rejections are logged, the bot stays alive; SIGTERM drains and exits 0", async () => {
    const state = spawnFixture("reject");
    try {
      await waitForOutput(state, "BOOT ok=false");
      // The handshake prints BOOT and HANDLES as SEPARATE pipe writes — wait
      // for the second chunk too before asserting (under suite load the
      // parent can observe BOOT one poll-cycle before HANDLES lands).
      await waitForOutput(state, "HANDLES ");
      // The endpoint handles boot registers must be drained on shutdown.
      assert.match(state.output, /HANDLES [^\n]*discord/);

      // Give the escaped rejections time to KILL us the way they would have
      // pre-fix (Node ≥15 exits on the next tick); the net must hold instead.
      await sleep(400);
      assert.equal(state.child.exitCode, null, "escaped rejection must NOT kill the process");
      assert.ok(
        state.output.includes("[process] unhandledRejection"),
        `expected the crash-net log, got:\n${state.output}`,
      );
      assert.ok(state.output.includes("simulated escaped rejection"));
      assert.ok(state.output.includes("simulated async escape"));

      // C9: docker-stop path — SIGTERM drains the registered handles, exit 0.
      state.child.kill("SIGTERM");
      const code = await waitForExit(state);
      assert.equal(code, 0, `clean drain must exit 0\n--- output ---\n${state.output}`);
      assert.match(
        state.output,
        /\[shutdown\] signal SIGTERM: draining \d+ shutdown handle\(s\)/,
      );
      assert.match(state.output, /\[shutdown\] drain complete/);
    } finally {
      killQuiet(state);
    }
  });

  it("second signal while the drain is wedged forces an immediate exit", async () => {
    const state = spawnFixture("hang");
    try {
      await waitForOutput(state, "WEDGED armed");
      state.child.kill("SIGTERM");
      await sleep(400);
      assert.equal(state.child.exitCode, null, "first drain waits for the wedged handle");

      state.child.kill("SIGINT");
      const code = await waitForExit(state);
      assert.equal(code, 1, `forced exit must be non-zero\n--- output ---\n${state.output}`);
      assert.ok(
        state.output.includes("forcing immediate exit"),
        `expected the force-exit log, got:\n${state.output}`,
      );
    } finally {
      killQuiet(state);
    }
  });

  it("uncaughtException logs with the cause, drains, and exits 1 (documented policy)", async () => {
    const state = spawnFixture("fatal");
    try {
      const code = await waitForExit(state);
      assert.equal(code, 1, `fatal path must exit 1\n--- output ---\n${state.output}`);
      assert.ok(
        state.output.includes("[process] uncaughtException"),
        `expected the fatal-net log, got:\n${state.output}`,
      );
      assert.ok(
        state.output.includes("Cannot read properties of null"),
        "the specific cause is logged (AGENTS.md: never a generic error)",
      );
      assert.ok(
        state.output.includes("[shutdown] uncaughtException: draining"),
        "the fatal path drains through the same shutdown handles",
      );
    } finally {
      killQuiet(state);
    }
  });
});
