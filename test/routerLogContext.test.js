/**
 * #391 (A2-5, error rule 2): the router is the LAST logging layer for a
 * handler failure — the handler died before it could name itself. Every
 * router failure site must therefore log a grep-able [router] line
 * carrying the ids a human needs to reproduce from logs alone:
 * kind, guild, user, command, customId — and must survive hostile/absent
 * interaction fields while doing it.
 *
 * No Discord, no network: the registry handlers simply throw.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");
const { cleanup } = loadDb(); // CONTRACT: fresh DB before any src/ require

const { handleInteraction } = require("../src/commands/router");

after(cleanup);

function captureErrors(fn) {
  const seen = [];
  const orig = console.error;
  console.error = (...args) => seen.push(args.map(String).join(" "));
  try {
    return fn().then(
      () => ({ errs: seen }),
      (err) => ({ errs: seen, threw: err }),
    );
  } finally {
    console.error = orig;
  }
}

const BOOM = "handler exploded";
const registry = {
  getAutocomplete: () => () => { throw new Error(BOOM); },
  getModalHandler: () => () => { throw new Error(BOOM); },
  getButtonHandler: () => () => { throw new Error(BOOM); },
  getHandler: () => () => { throw new Error(BOOM); },
  getHandlerApi: () => "raw", // never "context" — the raw handler gets the interaction
};
const ctx = { supervisor: null, registry, ensureHoneypotWarning: null };

const base = (over = {}) => ({
  guildId: "9001",
  guild: { id: "9001" },
  user: { id: "4242" },
  channel: { id: "77" },
  deferred: false,
  replied: false,
  reply: async () => {},
  followUp: async () => {},
  respond: async () => {},
  isAutocomplete: () => false,
  isModalSubmit: () => false,
  isButton: () => false,
  isChatInputCommand: () => false,
  ...over,
});

const cases = [
  {
    label: "autocomplete",
    interaction: base({ isAutocomplete: () => true, commandName: "xp" }),
    expect: /kind=autocomplete.*guild=9001.*user=4242.*command=\/xp/,
  },
  {
    label: "modal",
    interaction: base({ isModalSubmit: () => true, customId: "ticket_close:7" }),
    expect: /kind=modal.*guild=9001.*user=4242.*customId=ticket_close:7/,
  },
  {
    label: "button",
    interaction: base({ isButton: () => true, customId: "rr:role:1" }),
    expect: /kind=button.*customId=rr:role:1/,
  },
  {
    label: "chat",
    interaction: base({ isChatInputCommand: () => true, commandName: "warn" }),
    expect: /kind=chat.*command=\/warn/,
  },
];

describe("router failure logs — [router] prefix + ids (rule 2, #391)", () => {
  for (const { label, interaction, expect } of cases) {
    it(`a throwing ${label} handler is logged as one grep-able [router] line with ids + the cause`, async () => {
      const { errs, threw } = await captureErrors(() => handleInteraction(interaction, ctx));
      assert.equal(threw, undefined, "the router must not rethrow");
      assert.equal(errs.length, 1, `exactly one log line for ${label}`);
      assert.match(errs[0], /^\[router\] .+ failed:/, "grep-able prefix first");
      assert.match(errs[0], expect, "the ids a triage pass needs (kind/guild/user/command/customId)");
      assert.ok(errs[0].includes(BOOM), "the CAUSE rides the same line");
    });
  }

  it("hostile interaction fields cannot kill the failure logger", async () => {
    // The GUARD fields (guild/user presence) stay real — the router's
    // pre-try guards live outside this contract (boot's InteractionCreate
    // catch owns those). INSIDE the failure logger, any field read may
    // still throw or be absent: the report must never die formatting.
    const hostile = base({ isChatInputCommand: () => true, commandName: "boom" });
    Object.defineProperty(hostile, "guildId", {
      get() {
        throw new Error("getter explodes");
      },
    });
    Object.defineProperty(hostile, "user", { get() { return null; } });

    const { errs, threw } = await captureErrors(() => handleInteraction(hostile, ctx));
    assert.equal(threw, undefined, "a hostile logger field never escapes to boot()");
    assert.equal(errs.length, 1);
    assert.match(errs[0], /kind=chat/);
    assert.match(
      errs[0],
      /guild=\?/,
      "an exploding getter degrades to ? — the report itself never dies",
    );
    assert.ok(errs[0].includes("command=/boom"), "the readable ids still land");
    assert.match(errs[0], /user=\?/, "the unusable read degrades to ?, not a crash");
  });

  it("a monstrous customId is capped — a 10 KB button id never becomes a 10 KB log line", async () => {
    const long = "x".repeat(10_000);
    const interaction = base({ isButton: () => true, customId: long });
    const { errs } = await captureErrors(() => handleInteraction(interaction, ctx));
    assert.equal(errs.length, 1);
    assert.ok(errs[0].length < 500, `log line stays bounded (got ${errs[0].length})`);
    assert.ok(!errs[0].includes(`${"x".repeat(200)}`), "no 200-char x-run survived the cap");
  });

  it("the autocomplete failure still answers respond([]) — Discord never hangs", async () => {
    let responded = false;
    const interaction = base({
      isAutocomplete: () => true,
      commandName: "xp",
      respond: async () => { responded = true; },
    });
    await captureErrors(() => handleInteraction(interaction, ctx));
    assert.ok(responded);
  });
});
