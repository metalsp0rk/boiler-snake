/**
 * #457 (A2-2 / H1-9): the router's CONTEXT ARM now passes every
 * CommandContext through assertCommandContext before the handler sees it.
 *
 * The guard existed (src/platform/context.js) and its unit tests were green
 * for exactly the wrong reason: zero production callers. A builder field
 * rename/omission therefore died three frames deep inside some handler as
 * a confusing TypeError while platform-context.test.js kept passing.
 *
 * This suite pins the WIRING at both platform boundaries' Discord side:
 *  - the happy path still reaches the handler with a valid ctx (the guard
 *    must not gatekeep working commands);
 *  - a malformed ctx (the duck-typed shapes the prior audit named) fails
 *    AT THE BOUNDARY: the handler never runs, one [router] log line names
 *    the exact contract clause, and safeErrorReply still answers the user.
 *
 * No Discord, no network: the registry handler is a spy; the DB is real.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");
const { cleanup } = loadDb(); // CONTRACT: fresh DB before any src/ require

const { handleInteraction } = require("../src/commands/router");
const { MSG_GENERIC_ERROR } = require("../src/core/theme");

after(cleanup);

/** Minimal client the outbound adapter is happy to wrap lazily. */
const fakeClient = {
  user: { id: "9" },
  users: { cache: new Map() },
  guilds: { cache: new Map() },
  channels: { cache: new Map() },
};

/** Spy registry: every chat-input command is a context-arm handler that
 *  RECORDS the ctx it received (old code: recorded even broken shapes). */
const seen = [];
const registry = {
  getAutocomplete: () => null,
  getModalHandler: () => null,
  getButtonHandler: () => null,
  getHandler: () => async (commandCtx) => {
    seen.push(commandCtx);
  },
  getHandlerApi: () => "context",
};
const ctx = { supervisor: { discord: fakeClient }, registry, ensureHoneypotWarning: null };

const optionsStub = () => ({
  getSubcommand: () => null,
  getSubcommandGroup: () => null,
  getString: () => null,
  getInteger: () => null,
  getNumber: () => null,
  getBoolean: () => null,
  getUser: () => null,
  getRole: () => null,
  getChannel: () => null,
});

const base = (over = {}) => ({
  guildId: "9001",
  guild: { id: "9001", ownerId: "1" },
  user: { id: "4242", username: "mod", discriminator: "0", bot: false },
  channelId: "77",
  commandName: "xp",
  options: optionsStub(),
  deferred: false,
  replied: false,
  deliveries: [],
  async reply(p) {
    this.deliveries.push(p);
    return {};
  },
  async followUp(p) {
    this.deliveries.push(p);
    return {};
  },
  async deferReply() {
    this.deferred = true;
    return {};
  },
  isAutocomplete: () => false,
  isModalSubmit: () => false,
  isButton: () => false,
  isChatInputCommand: () => true,
  ...over,
});

async function captureErrors(fn) {
  const errs = [];
  const orig = console.error;
  console.error = (...args) => errs.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return errs;
}

describe("router context arm runs every CommandContext through assertCommandContext (#457)", () => {
  it("a valid interaction reaches the handler with a guard-passing context", async () => {
    seen.length = 0;
    const errs = await captureErrors(() => handleInteraction(base(), ctx));
    assert.deepEqual(errs, [], "the happy path logs nothing");
    assert.equal(seen.length, 1, "the handler ran");
    const c = seen[0];
    assert.equal(c.platform, "discord");
    assert.ok(Number.isSafeInteger(c.communityId), "ensureCommunity filled the contract integer");
    assert.equal(c.userId, "4242");
    assert.equal(c.commandName, "xp");
    assert.equal(typeof c.reply, "function");
    assert.equal(typeof c.options.getString, "function");
  });

  it("a context missing userId (duck-typed shape) dies AT THE BOUNDARY, not in a handler", async () => {
    seen.length = 0;
    const interaction = base({ user: null });
    const errs = await captureErrors(() => handleInteraction(interaction, ctx));

    assert.deepEqual(seen, [], "the guard fires BEFORE the handler — no deep TypeError possible");
    assert.equal(errs.length, 1, "one [router] line owns the failure");
    assert.match(errs[0], /^\[router\] .+ failed:/);
    assert.match(errs[0], /CommandContext: userId required/, "the log NAMES the contract clause");
    assert.ok(
      interaction.deliveries.some((d) => String(d?.content || "").includes(MSG_GENERIC_ERROR)),
      "the user still gets the sanctioned generic copy (safeErrorReply)",
    );
  });

  it("a context missing commandName is caught by the same boundary with its own clause", async () => {
    seen.length = 0;
    const interaction = base({ commandName: undefined });
    const errs = await captureErrors(() => handleInteraction(interaction, ctx));

    assert.deepEqual(seen, [], "no handler ever saw the malformed shape");
    assert.equal(errs.length, 1);
    assert.match(errs[0], /CommandContext: commandName required/);
  });
});
