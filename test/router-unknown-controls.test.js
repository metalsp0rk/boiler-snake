/**
 * #467 (A2-6): the router's button/modal arms used to `return` on an
 * unmatched customId — SILENT drop: the clicker stared at Discord's eternal
 * spinner and the server log stayed empty (an old panel message after a
 * customId rename is the classic trigger; AGENTS rule 1/2 — never a silent
 * drop, log with context).
 *
 * Pins: unmatched ⇒ one [router] warn naming kind + customId AND an
 * ephemeral "older version" notice (truth, not an invented generic — rule
 * 4's exception per the audit); matched ⇒ NO warn, handler runs.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");
const { cleanup } = loadDb(); // CONTRACT: fresh DB before any src/ require

const { handleInteraction } = require("../src/commands/router");

after(cleanup);

const fakeClient = {
  user: { id: "9" },
  users: { cache: new Map() },
  guilds: { cache: new Map() },
  channels: { cache: new Map() },
};

function makeRegistry({ button = null, modal = null }) {
  return {
    getAutocomplete: () => null,
    getModalHandler: () => modal,
    getButtonHandler: () => button,
    getHandler: () => null,
    getHandlerApi: () => "context",
  };
}

const base = (over = {}) => ({
  guildId: "9001",
  guild: { id: "9001", ownerId: "1" },
  user: { id: "4242", username: "mod", discriminator: "0", bot: false },
  channelId: "77",
  customId: "legacy-panel:do-thing",
  deferred: false,
  replied: false,
  deliveries: [],
  async reply(p) {
    this.deliveries.push(p);
    return {};
  },
  isAutocomplete: () => false,
  isChatInputCommand: () => false,
  isButton: () => false,
  isModalSubmit: () => false,
  ...over,
});

/** Capture console.warn + console.error lines for one dispatch. */
async function captureLogs(fn) {
  const warns = [];
  const errs = [];
  const ow = console.warn;
  const oe = console.error;
  console.warn = (...a) => warns.push(a.join(" "));
  console.error = (...a) => errs.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.warn = ow;
    console.error = oe;
  }
  return { warns, errs };
}

describe("router unmatched customIds are loud + answered (#467 A2-6)", () => {
  const ctx = {
    supervisor: { discord: fakeClient },
    registry: makeRegistry({}),
    ensureHoneypotWarning: null,
  };

  it("unmatched BUTTON: warn names the customId, clicker gets the honest ephemeral", async () => {
    const interaction = base({ isButton: () => true });
    const { warns, errs } = await captureLogs(() => handleInteraction(interaction, ctx));
    assert.ok(
      warns.some(
        (l) => l.includes("no button handler for customId") && l.includes("legacy-panel:do-thing")
      ),
      `warn with the identity (warns: ${JSON.stringify(warns)}, errs: ${JSON.stringify(errs)})`
    );
    assert.equal(errs.length, 0, "this is the truth, not a handler failure");
    assert.equal(interaction.deliveries.length, 1);
    const payload = interaction.deliveries[0];
    assert.match(payload.content, /older version/);
    assert.notEqual(payload.flags, undefined, "answered EPHEMERALLY");
  });

  it("unmatched MODAL: same closure", async () => {
    const interaction = base({ isModalSubmit: () => true, customId: "old-form:v1" });
    const { warns } = await captureLogs(() => handleInteraction(interaction, ctx));
    assert.ok(warns.some((l) => l.includes("no modal handler for customId") && l.includes("old-form:v1")));
    assert.equal(interaction.deliveries.length, 1);
  });

  it("MATCHED handlers: silent as before (no false alarms, handler runs)", async () => {
    let ran = 0;
    const ctxMatched = {
      ...ctx,
      registry: makeRegistry({
        button: async () => {
          ran += 1;
        },
      }),
    };
    const interaction = base({ isButton: () => true });
    const { warns } = await captureLogs(() => handleInteraction(interaction, ctxMatched));
    assert.equal(ran, 1, "handler executed");
    assert.deepEqual(warns, [], "no warn when a handler exists");
    assert.equal(interaction.deliveries.length, 0, "no unasked reply");
  });
});
