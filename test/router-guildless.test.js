/**
 * #328 (gap-7 review): the router's guild-less drops were SILENT for OUR
 * controls — a guild-scoped button/modal that somehow surfaced in a DM
 * spun forever with zero server trace, exactly the #467 class one guard
 * earlier in the arm. The drop itself stays (security posture: handlers
 * assume a guild; features with a sanctioned DM lane — banAppeals'
 * `appeal:*` in its own events.js listener — are NOT registry-registered,
 * so they keep flowing silently by design).
 *
 * Pins (per arm: button / modal / command):
 *  - guild-less + OUR id/command  ⇒ exactly one [router] warn, NO reply,
 *    handler NEVER runs (drop is still a drop);
 *  - guild-less + unknown id      ⇒ fully silent, NO reply — a DM user
 *    must not be able to probe the registry via reply side effects.
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

function makeRegistry({ button = null, modal = null, command = null }) {
  return {
    getAutocomplete: () => null,
    getModalHandler: () => modal,
    getButtonHandler: () => button,
    getHandler: () => command,
    getHandlerApi: () => "context",
  };
}

/** Guild-LESS interaction shape: guildId/guild are absent, as discord.js
 * delivers a real DM interaction. */
const guildless = (over = {}) => ({
  guildId: null,
  guild: null,
  user: { id: "4242", username: "dm-user", discriminator: "0", bot: false },
  channelId: "88",
  customId: "panel:do-thing",
  commandName: "linked",
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
  isMessageContextMenuCommand: () => false,
  isUserContextMenuCommand: () => false,
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

const ctxFor = (registry) => ({
  supervisor: { discord: fakeClient },
  registry,
  ensureHoneypotWarning: null,
});

describe("router guild-less drops: loud for OUR ids, silent for strangers (#328 gap-7)", () => {
  it("guild-less BUTTON with a REGISTERED customId: warned once, never answered, handler never runs", async () => {
    let ran = 0;
    const ctx = ctxFor(
      makeRegistry({
        button: async () => {
          ran += 1;
        },
      }),
    );
    const interaction = guildless({ isButton: () => true });
    const { warns, errs } = await captureLogs(() =>
      handleInteraction(interaction, ctx),
    );
    assert.equal(ran, 0, "the drop is still a drop — no guild, no handler");
    assert.ok(
      warns.some(
        (l) =>
          l.includes("dropping guild-scoped button outside a guild") &&
          l.includes("panel:do-thing"),
      ),
      `warn names the kind + customId (warns: ${JSON.stringify(warns)})`,
    );
    assert.equal(warns.length, 1, "exactly one warn line");
    assert.equal(errs.length, 0, "a visibility warn is not an error");
    assert.equal(interaction.deliveries.length, 0, "NEVER reply guild-less");
  });

  it("guild-less BUTTON with an UNREGISTERED customId: fully silent (banAppeals lane + anti-probe)", async () => {
    const ctx = ctxFor(makeRegistry({}));
    const interaction = guildless({
      isButton: () => true,
      customId: "appeal:7",
    });
    const { warns, errs } = await captureLogs(() =>
      handleInteraction(interaction, ctx),
    );
    assert.deepEqual(warns, [], "unknown ids must not be echoed guild-less");
    assert.equal(errs.length, 0);
    assert.equal(interaction.deliveries.length, 0);
  });

  it("guild-less MODAL with a REGISTERED customId: warned, not answered, not run", async () => {
    let ran = 0;
    const ctx = ctxFor(
      makeRegistry({
        modal: async () => {
          ran += 1;
        },
      }),
    );
    const interaction = guildless({
      isModalSubmit: () => true,
      customId: "tk:rep:m:deadbeef",
    });
    const { warns } = await captureLogs(() =>
      handleInteraction(interaction, ctx),
    );
    assert.equal(ran, 0);
    assert.ok(
      warns.some(
        (l) =>
          l.includes("dropping guild-scoped modal outside a guild") &&
          l.includes("tk:rep:m:deadbeef"),
      ),
      `warn names the kind + customId (warns: ${JSON.stringify(warns)})`,
    );
    assert.equal(interaction.deliveries.length, 0);
  });

  it("guild-less MODAL with an UNREGISTERED customId: silent (the appeal:s: lane)", async () => {
    const ctx = ctxFor(makeRegistry({}));
    const interaction = guildless({
      isModalSubmit: () => true,
      customId: "appeal:s:12",
    });
    const { warns } = await captureLogs(() =>
      handleInteraction(interaction, ctx),
    );
    assert.deepEqual(warns, []);
    assert.equal(interaction.deliveries.length, 0);
  });

  it("guild-less invocation of one of OUR commands: warned, no ephemeral", async () => {
    const ctx = ctxFor(makeRegistry({ command: async () => {} }));
    const interaction = guildless({
      isChatInputCommand: () => true,
      commandName: "link",
    });
    const { warns } = await captureLogs(() =>
      handleInteraction(interaction, ctx),
    );
    assert.ok(
      warns.some((l) =>
        l.includes("dropping guild-less command invocation"),
      ),
      `warn carries the identity (warns: ${JSON.stringify(warns)})`,
    );
    assert.equal(interaction.deliveries.length, 0, "no 'Unhandled command' reply in DMs");
  });

  it("guild-less invocation of an UNKNOWN command: silent", async () => {
    const ctx = ctxFor(makeRegistry({}));
    const interaction = guildless({
      isChatInputCommand: () => true,
      commandName: "not-ours",
    });
    const { warns } = await captureLogs(() =>
      handleInteraction(interaction, ctx),
    );
    assert.deepEqual(warns, []);
    assert.equal(interaction.deliveries.length, 0);
  });
});
