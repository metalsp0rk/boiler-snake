/**
 * Feature module loader.
 *
 * Each feature may export:
 *   name: string
 *   commands: SlashCommandBuilder[]
 *   handlers: { [commandName]: async (interaction, ctx) => void }
 *   handlerApi: { [commandName]: "context" }  // opt a handler into the
 *     CommandContext calling convention (spec § Handler migration rule);
 *     unlisted handlers default to the "interaction" arm.
 *   autocomplete: { [commandName]: async (interaction, ctx) => void }
 *   modalHandlers: { [customIdPrefix]: async (interaction, ctx) => void }
 *   buttonHandlers: { [customIdPrefix]: async (interaction, ctx) => void }
 *   registerEvents(supervisor, ctx): void
 *   start(supervisor, ctx): void   // ClientReady tickers/schedulers
 *     // may return a loop handle `{ stop() }` (e.g. the bridge relay) —
 *     // load.js registers it for the SIGTERM/SIGINT drain (core/lifecycle).
 *
 * PR 7 cutover (roadmap/fluxer.md § Supervisor): the first argument is the
 * platform Supervisor ({ discord, fluxer, clientForCommunity }), not the
 * Discord client. Features read supervisor.discord where they used the client.
 */

const { registerShutdownHandle } = require("../core/lifecycle");

/**
 * @param {object[]} features
 * @param {import("../commands/registry").CommandRegistry} registry
 */
function applyFeaturesToRegistry(features, registry) {
  for (const feature of features) {
    if (!feature?.name) {
      throw new Error("Feature module missing name");
    }

    for (const builder of feature.commands || []) {
      registry.addCommand(builder);
    }

    for (const [name, fn] of Object.entries(feature.handlers || {})) {
      registry.registerHandler(name, fn, {
        api: feature.handlerApi?.[name] ?? "interaction",
      });
    }

    for (const [name, fn] of Object.entries(feature.autocomplete || {})) {
      registry.registerAutocomplete(name, fn);
    }

    for (const [prefix, fn] of Object.entries(feature.modalHandlers || {})) {
      registry.registerModalHandler(prefix, fn);
    }

    for (const [prefix, fn] of Object.entries(feature.buttonHandlers || {})) {
      registry.registerButtonHandler(prefix, fn);
    }
  }
}

/**
 * Run one lifecycle hook across all features, isolating failures: a throwing
 * feature is logged (with feature + hook context) and skipped instead of
 * killing the boot loop / login. See AGENTS.md → Error Handling.
 *
 * Graceful-shutdown contract (audit C9 + A2-4/#390):
 *  - a hook that RETURNS a loop handle ({ stop() }, e.g. the bridge relay
 *    worker) gets it registered with `core/lifecycle`;
 *  - a hook that acquires resources BEFORE it can return registers them
 *    through the third-argument seam `registerStop(fn)` — on a clean return
 *    they join the drain; if the hook then THROWS, load.js stops them
 *    itself, LIFO, before moving on. Registration-before-return used to be
 *    the blind spot: the drain skipped exactly the resource the failed hook
 *    created, and "drain complete" lied about degraded boots;
 *  - handles are keyed feature:index:hook — a feature's start handle can
 *    no longer silently REPLACE its registerEvents handle (lifecycle is
 *    delete-then-set), and two features without a `name` can no longer
 *    collide on `feature:unknown`.
 *
 * @param {import("../platform/boot").Supervisor} supervisor
 * @param {object[]} features
 * @param {object} ctx
 * @param {string} hookName
 * @returns {string[]} descriptors of failed hooks (empty on success)
 */
function runFeatureHook(supervisor, features, ctx, hookName) {
  const failed = [];
  for (const [index, feature] of features.entries()) {
    if (typeof feature?.[hookName] !== "function") continue;
    // Display identity stays the human one (pins + logs); the handle key
    // additionally carries the index and the hook (#390).
    const display = `${feature.name || "unknown"}.${hookName}`;
    const handleKey = (slot) =>
      `feature:${feature.name || "unknown"}#${index}:${hookName}` +
      (slot === 0 ? "" : `#${slot}`);
    /** @type {Array<() => (void|Promise<void>)>} resources owned by THIS
     *  hook since its call — committed to the drain only on a clean return. */
    const owned = [];
    const registerStop = (fn) => {
      if (typeof fn !== "function") {
        throw new TypeError(`registerStop(${display}): stop function required`);
      }
      owned.push(fn);
    };
    try {
      const result = feature[hookName](supervisor, ctx, registerStop);
      for (let i = 0; i < owned.length; i += 1) {
        registerShutdownHandle(handleKey(i), owned[i]);
      }
      if (result && typeof result.stop === "function") {
        registerShutdownHandle(handleKey(owned.length), () => result.stop());
      }
    } catch (err) {
      console.error(`[features] ${display} failed:`, err?.message || err);
      // #390 (A2-4): resources this hook took but never committed are
      // load.js's to release — LIFO, each failure logged, and a broken
      // cleanup never masks the original error.
      for (let i = owned.length - 1; i >= 0; i -= 1) {
        try {
          const stopResult = owned[i]();
          if (stopResult && typeof stopResult.catch === "function") {
            stopResult.catch((stopErr) =>
              console.error(
                `[features] ${display} partial-stop failed:`,
                stopErr?.message || stopErr,
              ),
            );
          }
        } catch (stopErr) {
          console.error(
            `[features] ${display} partial-stop failed:`,
            stopErr?.message || stopErr,
          );
        }
      }
      failed.push(display);
    }
  }
  if (failed.length) {
    console.error(
      `[features] boot continuing with degraded features: ${failed.join(", ")}`
    );
  }
  return failed;
}

/**
 * @param {import("../platform/boot").Supervisor} supervisor
 * @param {object[]} features
 * @param {object} ctx
 * @returns {string[]} failed hook descriptors
 */
function registerAllFeatureEvents(supervisor, features, ctx) {
  return runFeatureHook(supervisor, features, ctx, "registerEvents");
}

/**
 * @param {import("../platform/boot").Supervisor} supervisor
 * @param {object[]} features
 * @param {object} ctx
 * @returns {string[]} failed hook descriptors
 */
function startAllFeatures(supervisor, features, ctx) {
  return runFeatureHook(supervisor, features, ctx, "start");
}

module.exports = {
  applyFeaturesToRegistry,
  registerAllFeatureEvents,
  startAllFeatures,
};
