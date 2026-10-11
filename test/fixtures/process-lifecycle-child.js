/**
 * Child-process fixture for test/integration/process-lifecycle.test.js.
 *
 * Runs the REAL boot() path offline (no DISCORD_TOKEN / FLUXER_INSTANCES →
 * zero endpoints, no network, temp DB from env) so the process guards under
 * test are exactly what `npm start` installs. Mode comes from argv[2]:
 *
 *   reject      — after boot wiring, fire escaped promise rejections: the C8
 *                 net must LOG them and keep the process alive.
 *   hang        — additionally register a wedged shutdown handle; the drain
 *                 never finishes, so the SECOND signal must force-exit (C9).
 *   fatal       — throw synchronously out of a timer after boot: the
 *                 uncaughtException net must log, drain, and exit 1.
 *   indexfail   — run the REAL src/index.js entry point with every configured
 *                 endpoint failing (issue #190 / audit C7): the Fluxer
 *                 factory is stubbed BEFORE index/boot load (one configured
 *                 entry, deterministically failed, zero network), so index
 *                 must log the terminal fatals, drain through core/lifecycle,
 *                 and exit 1. The parent passes FLUXER_INSTANCES in env.
 *
 * The process stays alive via a keep-alive interval; the parent drives it with
 * real SIGTERM/SIGINT and asserts on exit codes + emitted logs.
 */
const mode = process.argv[2] || "reject";

if (mode === "indexfail") {
  // Stub the Fluxer endpoint factory BEFORE anything requires it (boot
  // destructures it at module load): one configured endpoint, deterministically
  // failed, offline. Everything else — assertRuntimeEnv, registry, boot, the
  // drain-and-exit — is the real production entry path.
  const fluxerClient = require("../../src/platform/fluxer/client");
  fluxerClient.createFluxerHandle = async () => null;
  require("../../src/index");
} else {
  const { boot } = require("../../src/platform/boot");
  const lifecycle = require("../../src/core/lifecycle");

  boot()
    .then((result) => {
      // Machine-readable handshake for the parent test.
      console.log(`BOOT ok=${result.ok}`);
      console.log(`HANDLES ${lifecycle.shutdownHandleNames().join(",")}`);

      if (mode === "reject") {
        // C8: the exact class the boot.js/pipelines.js .catch() work defends —
        // an escaped rejection must be logged, not fatal.
        Promise.reject(new Error("simulated escaped rejection"));
        void (async () => {
          throw new Error("simulated async escape");
        })();
      }

      if (mode === "hang") {
        lifecycle.registerShutdownHandle("wedged", () => new Promise(() => {}));
        console.log("WEDGED armed");
      }

      if (mode === "fatal") {
        // UncaughtException net: sync throw outside any try/catch → log, drain,
        // exit 1 (documented policy — the supervisor restarts the process).
        setTimeout(() => {
          null.boom();
        }, 25);
      }

      // Hold the event loop until the parent signals us.
      setInterval(() => {}, 1 << 30);
    })
    .catch((err) => {
      console.error("FIXTURE BOOT FAILED:", err?.stack || err);
      process.exit(9);
    });
}
