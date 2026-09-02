const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildDefaultRegistry, createRegistry } = require("../src/commands/registry");
const features = require("../src/features");

describe("command definitions via registry", () => {
  it("exports 26 slash commands with unique names", () => {
    const { commands } = buildDefaultRegistry();
    assert.equal(commands.length, 26);
    const names = commands.map((c) => c.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes("eventreminder"));
    assert.ok(names.includes("note"));
    assert.ok(names.includes("staff"));
    assert.ok(names.includes("warn"));
    assert.ok(names.includes("setwarn"));
    assert.ok(names.includes("userinfo"));
    assert.ok(names.includes("activityconfig"));
    assert.ok(names.includes("ticket"));
    assert.ok(names.includes("grantxp"));
    assert.ok(names.includes("play"));
    assert.ok(names.includes("music"));
    assert.ok(names.includes("twitch"));
    assert.ok(names.includes("settwitch"));
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
      "twitch",
      "honeypot",
      "reactionRoles",
      "eventReminders",
      "staffRoles",
      "commandPermissions",
      "staffNotes",
      "warnings",
      "userinfo",
      "userActivity",
      "tickets",
      "music",
    ]) {
      assert.ok(names.includes(expected), `missing feature ${expected}`);
    }
    assert.equal(features.length, 20);
  });

  it("registers userinfo button handler", () => {
    const registry = buildDefaultRegistry();
    assert.equal(typeof registry.getButtonHandler("ui:n:123"), "function");
  });

  it("registers music button handler", () => {
    const registry = buildDefaultRegistry();
    assert.equal(typeof registry.getButtonHandler("music:skip"), "function");
    assert.equal(typeof registry.getButtonHandler("music:pause"), "function");
  });

  it("registers ticket panel button and modal handlers", () => {
    const registry = buildDefaultRegistry();
    assert.equal(typeof registry.getButtonHandler("tk:open"), "function");
    assert.equal(typeof registry.getModalHandler("tk:create"), "function");
    assert.equal(typeof registry.getButtonHandler("tk:sn:42"), "function");
    assert.equal(typeof registry.getModalHandler("tk:snm:42"), "function");
  });

  it("registers staff note modal handlers", () => {
    const registry = buildDefaultRegistry();
    assert.equal(
      typeof registry.getModalHandler("note:add:1234567890"),
      "function"
    );
    assert.equal(typeof registry.getModalHandler("note:edit:12"), "function");
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
