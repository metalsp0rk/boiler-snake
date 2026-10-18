/**
 * #467 (A2-10): applyFeaturesToRegistry guarded COMMAND builders against
 * duplicates (addCommand throws) but handler/autocomplete/modal/button KEY
 * collisions across features were silent last-writer-wins — the shadowed
 * feature's buttons/modals executed the other feature's handler tree with
 * zero diagnostics (easy to hit: Fluxer-only prefix handlers have no
 * builder companion). Boot now fails loudly naming both owners.
 *
 * + #467 (A2-13): the dead module-level `getRegisteredCommands` / `commands`
 * getter (zero importers, O(everything) rebuild per property access) must
 * STAY deleted — the live path is buildDefaultRegistry().commands.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");
const { cleanup } = loadDb(); // CONTRACT: fresh DB before any src/ require
after(cleanup);

const { applyFeaturesToRegistry } = require("../src/features/load");
const registryModule = require("../src/commands/registry");

function miniRegistry() {
  const noop = () => {};
  return {
    commands: [],
    addCommand(b) {
      this.commands.push(b);
    },
    registerHandler: noop,
    registerAutocomplete: noop,
    registerModalHandler: noop,
    registerButtonHandler: noop,
  };
}

describe("feature handler collisions fail the boot loudly (#467 A2-10)", () => {
  it("the SAME handler key from two features throws naming both owners", () => {
    const reg = miniRegistry();
    assert.throws(
      () =>
        applyFeaturesToRegistry(
          [
            { name: "warnings", handlers: { "warn:menu": async () => {} } },
            { name: "tickets", handlers: { "warn:menu": async () => {} } },
          ],
          reg
        ),
      (err) =>
        /warn:menu/.test(err.message) &&
        /"warnings"/.test(err.message) &&
        /"tickets"/.test(err.message) &&
        /shadow/.test(err.message)
    );
  });

  it("modal/button/autocomplete namespaces each collide on their own", () => {
    const reg = miniRegistry();
    // Same key in TWO DIFFERENT namespaces = fine…
    assert.doesNotThrow(() =>
      applyFeaturesToRegistry(
        [
          { name: "a", modalHandlers: { "x:": async () => {} } },
          { name: "b", buttonHandlers: { "x:": async () => {} } },
          { name: "c", autocomplete: { x: async () => {} } },
        ],
        reg
      )
    );
    // …the SAME namespace across features = throw.
    assert.throws(
      () =>
        applyFeaturesToRegistry(
          [
            { name: "a", buttonHandlers: { "x:": async () => {} } },
            { name: "b", buttonHandlers: { "x:": async () => {} } },
          ],
          miniRegistry()
        ),
      /buttonHandler "x:"/
    );
  });

  it("distinct keys apply cleanly (the guard is a scalpel, not a ban)", () => {
    assert.doesNotThrow(() =>
      applyFeaturesToRegistry(
        [
          { name: "warnings", handlers: { "warn:do": async () => {} } },
          { name: "tickets", handlers: { "ticket:do": async () => {} } },
        ],
        miniRegistry()
      )
    );
  });
});

describe("dead registry exports stay deleted (#467 A2-13)", () => {
  it("no module-level getRegisteredCommands / rebuilding `commands` getter", () => {
    assert.equal(registryModule.getRegisteredCommands, undefined);
    assert.equal("commands" in registryModule, false, "the O(everything) getter is gone");
    assert.equal(typeof registryModule.buildDefaultRegistry, "function");
    assert.equal(typeof registryModule.createRegistry, "function");
  });
});
