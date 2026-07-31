const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildDefaultRegistry, createRegistry } = require("../src/commands/registry");
const features = require("../src/features");

describe("command definitions via registry", () => {
  it("exports 15 slash commands with unique names", () => {
    const { commands } = buildDefaultRegistry();
    assert.equal(commands.length, 15);
    const names = commands.map((c) => c.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes("eventreminder"));
    assert.ok(names.includes("note"));
  });
});

describe("buildDefaultRegistry", () => {
  it("registers a handler for every defined command", () => {
    const registry = buildDefaultRegistry();
    for (const cmd of registry.commands) {
      assert.equal(
        typeof registry.getHandler(cmd.name),
        "function",
        `missing handler for /${cmd.name}`
      );
    }
  });

  it("registers youtube autocomplete", () => {
    const registry = buildDefaultRegistry();
    assert.equal(typeof registry.getAutocomplete("youtube"), "function");
  });

  it("registers eventreminder autocomplete and modal handler", () => {
    const registry = buildDefaultRegistry();
    assert.equal(typeof registry.getAutocomplete("eventreminder"), "function");
    assert.equal(
      typeof registry.getModalHandler("er:create:abc123"),
      "function"
    );
  });

  it("loads feature modules by name", () => {
    const names = features.map((f) => f.name);
    for (const expected of [
      "settings",
      "commandChannels",
      "xp",
      "decay",
      "voice",
      "levelRoles",
      "logs",
      "youtube",
      "honeypot",
      "reactionRoles",
      "eventReminders",
      "staffNotes",
    ]) {
      assert.ok(names.includes(expected), `missing feature ${expected}`);
    }
    assert.equal(features.length, 12);
  });
});

describe("createRegistry", () => {
  it("throws on invalid handler registration", () => {
    const registry = createRegistry();
    assert.throws(() => registry.registerHandler("", () => {}), /name required/);
    assert.throws(() => registry.registerHandler("foo", null), /fn must be a function/);
  });

  it("throws on duplicate command names", () => {
    const registry = createRegistry();
    const fake = { toJSON: () => ({ name: "dup" }) };
    registry.addCommand(fake);
    assert.throws(() => registry.addCommand(fake), /duplicate/);
  });
});
