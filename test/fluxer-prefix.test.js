/**
 * Unit tests for src/platform/fluxer/commands.js — the FULL prefix grammar
 * (roadmap/fluxer.md § Prefix grammar, lines 433–506). The real registry JSON
 * (buildDefaultRegistry()) is the command tree: the spec pins "the command
 * tree IS the registry's existing JSON + the Fluxer-only overlay".
 *
 * The parser is SYNC and SDK-free. `prefix: "!"` is passed explicitly so the
 * suite is independent of FLUXER_COMMAND_PREFIX in the ambient environment
 * (the K1 default is "!" — the same value, asserted separately at the end).
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { cleanup } = loadDb();

const {
  parsePrefix,
  K10_USER_COPY,
} = require("../src/platform/fluxer/commands");
const { buildDefaultRegistry } = require("../src/commands/registry");

after(cleanup);

const registryCommands = buildDefaultRegistry().commands;
const OPTS = { registryCommands, prefix: "!" };
const EMPTY_MENTIONS = { users: [], roles: [], channels: [] };

describe("fluxer/commands — prefix grammar step 1–4: command matching", () => {
  it("!xp parses to a bare command with no options", () => {
    const p = parsePrefix("!xp", OPTS);
    assert.ok(p);
    assert.equal(p.commandName, "xp");
    assert.equal(p.subcommand, null);
    assert.equal(p.subcommandGroup, null);
    assert.deepEqual(p.options, []);
    assert.equal(p.help, null);
    assert.equal(p.usageError, null);
  });

  it("leading whitespace is trimmed; a non-prefix line is not a command", () => {
    assert.equal(parsePrefix("  !xp", OPTS).commandName, "xp");
    assert.equal(parsePrefix("hello", OPTS), null);
    assert.equal(parsePrefix("x!xp", OPTS), null);
    assert.equal(parsePrefix("？!xp", OPTS), null);
  });

  it("the bare prefix and empty remainder are not commands", () => {
    assert.equal(parsePrefix("!", OPTS), null);
    assert.equal(parsePrefix("!   ", OPTS), null);
    assert.equal(parsePrefix("\t!", OPTS), null);
  });

  it("unknown commands are NOT commands (null — the message can earn XP)", () => {
    assert.equal(parsePrefix("!frobnicate x 5", OPTS), null);
    assert.equal(parsePrefix("!xp123", OPTS), null);
  });

  it("an explicit prefix overrides the config default", () => {
    const opts = { registryCommands, prefix: "?" };
    assert.equal(parsePrefix("!xp", opts), null, "! is not a command under ?");
    assert.equal(parsePrefix("?xp", opts).commandName, "xp");
  });

  it("a malformed explicit prefix is a programmer error (throws, specific)", () => {
    assert.throws(() => parsePrefix("!xp", { registryCommands, prefix: "" }), /1-8 characters/);
    assert.throws(() => parsePrefix("!xp", { registryCommands, prefix: "ab c" }), /no whitespace/);
    assert.throws(() => parsePrefix("!xp", { registryCommands, prefix: "<x>" }), /no < or >/);
  });
});

describe("fluxer/commands — prefix grammar step 6: named option pairs", () => {
  it("!setxp message 5 reaction 2 → two named integer pairs", () => {
    const p = parsePrefix("!setxp message 5 reaction 2", OPTS);
    assert.equal(p.usageError, null);
    assert.equal(p.commandName, "setxp");
    assert.deepEqual(
      p.options.map((o) => [o.name, o.type, o.value, o.mentionIndex]),
      [
        ["message", 4, "5", null],
        ["reaction", 4, "2", null],
      ],
    );
  });

  it("!setxp 5 is a usage error — 5 is not an option name (no positional grammar)", () => {
    const p = parsePrefix("!setxp 5", OPTS);
    assert.ok(p.usageError, "expected a usage error");
    assert.equal(p.commandName, "setxp");
    assert.match(p.usageError.reason, /"5"/);
    assert.equal(p.help, null);
  });

  it('!warn add user 123456 reason "too many words" silent true → quoted string, then pairs', () => {
    // Spec § Prefix grammar: named pairs only — the quoted multi-word value
    // belongs to the option name preceding it (spec's own example is
    // `reason "too many words"`; a bare quoted token is an unknown name).
    const p = parsePrefix('!warn add user 123456 reason "too many words" silent true', OPTS);
    assert.equal(p.usageError, null);
    assert.equal(p.commandName, "warn");
    assert.equal(p.subcommand, "add");
    assert.deepEqual(
      p.options.map((o) => [o.name, o.type, o.value]),
      [
        ["user", 6, "123456"],
        ["reason", 3, "too many words"],
        ["silent", 5, "true"],
      ],
    );
  });

  it("a quoted token is exactly one token; the rest of the line is not consumed", () => {
    const p = parsePrefix('!note add user 123456 content "a \\\"quoted\\" note" ', OPTS);
    assert.equal(p.usageError, null);
    const content = p.options.find((o) => o.name === "content");
    assert.equal(content.value, 'a "quoted" note', "backslash escapes inside quotes");
  });

  it("an unclosed quote on a KNOWN command is a usage error", () => {
    const p = parsePrefix('!warn add user 123456 reason "too many words', OPTS);
    assert.ok(p.usageError);
    assert.match(p.usageError.reason, /Unclosed quote/);
    assert.equal(p.commandName, "warn");
    assert.equal(p.subcommand, null, "navigation did not run — quoted tail is untrusted");
  });

  it("an unclosed quote on an UNKNOWN command is null (not a command)", () => {
    assert.equal(parsePrefix('!frobnicate reason "never closed', OPTS), null);
  });

  it("boolean coercion accepts true|false|yes|no|on|off|1|0 case-insensitively", () => {
    const yes = parsePrefix("!setwarn dm enabled yes", OPTS);
    assert.equal(yes.usageError, null);
    assert.deepEqual(
      yes.options.map((o) => [o.name, o.type, o.value]),
      [["enabled", 5, "true"]],
    );
    for (const token of ["TRUE", "On", "1", "yes"]) {
      assert.equal(
        parsePrefix(`!setwarn dm enabled ${token}`, OPTS).options[0].value,
        "true",
        token,
      );
    }
    for (const token of ["FALSE", "off", "0", "no"]) {
      assert.equal(
        parsePrefix(`!setwarn dm enabled ${token}`, OPTS).options[0].value,
        "false",
        token,
      );
    }
    const bogus = parsePrefix("!setwarn dm enabled yep", OPTS);
    assert.ok(bogus.usageError);
    assert.match(bogus.usageError.reason, /true, false, yes, no, on, off, 1, 0/);
  });

  it("integer bounds come from the builder JSON and name the bound", () => {
    const p = parsePrefix("!leaderboard limit 500", OPTS);
    assert.ok(p.usageError, "limit max is 20");
    assert.match(p.usageError.reason, /"limit"/);
    assert.match(p.usageError.reason, /20/);

    const ok = parsePrefix("!leaderboard limit 20", OPTS);
    assert.equal(ok.usageError, null);
    assert.equal(ok.options[0].value, "20");

    const low = parsePrefix("!leaderboard limit 0", OPTS);
    assert.ok(low.usageError);
    assert.match(low.usageError.reason, /at least 1/);

    const notInt = parsePrefix("!leaderboard limit 1.5", OPTS);
    assert.ok(notInt.usageError);
    assert.match(notInt.usageError.reason, /whole number/);
  });

  it("string choices accept name or value case-insensitively and store the VALUE", () => {
    const p = parsePrefix(
      "!activityconfig ignore add kind CHANNEL target 123456",
      OPTS,
    );
    assert.equal(p.usageError, null);
    assert.equal(p.commandName, "activityconfig");
    assert.equal(p.subcommandGroup, "ignore");
    assert.equal(p.subcommand, "add");
    const kind = p.options.find((o) => o.name === "kind");
    assert.equal(kind.value, "channel", "stored value, not the given casing");
    const target = p.options.find((o) => o.name === "target");
    assert.equal(target.type, 7);
    assert.equal(target.value, "123456");
    assert.deepEqual(target.allowedChannelTypes, [0, 5, 4, 15, 2], "builder declaration order");
  });

  it("an out-of-choice string value is a usage error naming the choices", () => {
    const p = parsePrefix("!activityconfig ignore add kind notez target 123456", OPTS);
    assert.ok(p.usageError);
    assert.match(p.usageError.reason, /must be one of: channel, category/);
  });

  it("channel_types from the builder are carried on the parsed option", () => {
    // Real-registry channel_types surface (setwarn log channel = text + announcement).
    const p = parsePrefix("!setwarn log channel 12345", OPTS);
    assert.equal(p.usageError, null);
    assert.equal(p.subcommand, "log");
    const ch = p.options.find((o) => o.name === "channel");
    assert.equal(ch.type, 7);
    assert.deepEqual(ch.allowedChannelTypes, [0, 5], "channel types ride to dispatch");
  });

  it("duplicate option names are a usage error", () => {
    const p = parsePrefix("!setxp message 5 message 6", OPTS);
    assert.ok(p.usageError);
    assert.match(p.usageError.reason, /twice/);
  });

  it("a trailing option name with no value is a usage error", () => {
    const p = parsePrefix("!setxp message", OPTS);
    assert.ok(p.usageError);
    assert.match(p.usageError.reason, /no value/);
  });

  it("a missing required option is a usage error (!warn add)", () => {
    const p = parsePrefix("!warn add", OPTS);
    assert.ok(p.usageError);
    assert.equal(p.subcommand, "add");
    assert.match(p.usageError.reason, /Missing required option "user"/);
  });

  it("a positional id is a usage error: !userinfo 123456 … (named grammar only)", () => {
    const p = parsePrefix("!userinfo 123456", OPTS);
    assert.ok(p.usageError, "123456 is not an option name");
    assert.match(p.usageError.reason, /"123456"/);
  });
});

describe("fluxer/commands — step 7 / K10: mention references", () => {
  it("a bare decimal id (5–20 digits) is stored verbatim", () => {
    const p = parsePrefix("!userinfo user 123456", OPTS);
    assert.equal(p.usageError, null);
    assert.deepEqual(
      p.options.map((o) => [o.name, o.type, o.value, o.mentionIndex]),
      [["user", 6, "123456", null]],
    );
  });

  it("a bare id shorter than 5 digits is a usage error (42 is not a user id)", () => {
    const p = parsePrefix("!grantxp user 42 amount 5", OPTS);
    assert.ok(p.usageError);
    assert.match(p.usageError.reason, /5–20 digits/);
    assert.match(p.usageError.reason, /"42"/);
  });

  it("a markup-shaped token with EMPTY mentions gets the exact K10 line", () => {
    const p = parsePrefix("!grantxp user <@123> amount 5", {
      ...OPTS,
      mentions: EMPTY_MENTIONS,
    });
    assert.ok(p.usageError);
    assert.equal(p.usageError.reason, K10_USER_COPY);
    assert.equal(
      p.usageError.reason,
      "Pass a user id. This bot does not read mention markup in the command text.",
    );
  });

  it("the parser NEVER decodes ids out of markup: no numeric id on disk", () => {
    const p = parsePrefix("!grantxp user <@123> amount 5", OPTS);
    // With no mentions supplied, the token becomes a mention INDEX reference —
    // never the id 123 (K10: the parser does not extract ids from markup).
    assert.equal(p.usageError, null);
    const user = p.options.find((o) => o.name === "user");
    assert.equal(user.value, "<@123>", "raw token preserved");
    assert.equal(user.mentionIndex, 0, "next unused users[] index");
  });

  it("a non-numeric token consumes the next unused mention index", () => {
    const p = parsePrefix(
      "!warn add user someuser reason \"r\" user otheruser silent true",
      OPTS,
    );
    // Duplicate "user" names are a usage error — first check the single case:
    assert.ok(p.usageError);
    assert.match(p.usageError.reason, /twice/);

    const q = parsePrefix("!warn add user someone reason hello", OPTS);
    assert.equal(q.usageError, null);
    assert.equal(q.options[0].mentionIndex, 0);
    assert.equal(q.options[0].value, "someone");
  });

  it("a non-id non-numeric token with empty mentions is a usage error", () => {
    const p = parsePrefix("!grantxp user bob amount 5", {
      ...OPTS,
      mentions: EMPTY_MENTIONS,
    });
    assert.ok(p.usageError);
    assert.match(p.usageError.reason, /is not an id/);
    assert.match(p.usageError.reason, /no user mentions/);
  });
});

describe("fluxer/commands — step 4b: synthetic help", () => {
  it("!help, !HELP, and !HeLp are the help command", () => {
    for (const line of ["!help", "!HELP", "!HeLp"]) {
      const p = parsePrefix(line, OPTS);
      assert.equal(p.commandName, "help", line);
      assert.deepEqual(p.help.tokens, [], line);
      assert.equal(p.usageError, null, line);
    }
  });

  it("!help warn → token 1 is the command name", () => {
    const p = parsePrefix("!help warn", OPTS);
    assert.deepEqual(p.help.tokens, ["warn"]);
  });

  it("!help warn add → subcommand token", () => {
    const p = parsePrefix("!help warn add", OPTS);
    assert.deepEqual(p.help.tokens, ["warn", "add"]);
  });

  it("!help warnx → unknown name is a help topic, not a usage error, not null", () => {
    const p = parsePrefix("!help warnx", OPTS);
    assert.equal(p.commandName, "help");
    assert.deepEqual(p.help.tokens, ["warnx"]);
    assert.equal(p.usageError, null);
  });

  it("!help honeypot channel → the group form", () => {
    const p = parsePrefix("!help honeypot channel", OPTS);
    assert.deepEqual(p.help.tokens, ["honeypot", "channel"]);
  });

  it("!help honeypot channel add → a third token IS allowed in group form", () => {
    const p = parsePrefix("!help honeypot channel add", OPTS);
    assert.deepEqual(p.help.tokens, ["honeypot", "channel", "add"]);
  });

  it("a third token outside the group shape collapses to the token-1 help line", () => {
    // warn has no groups: `!help warn add x` is NOT group form, so the help
    // renderer shows the help line for token 1 only (spec step 4b: "the reply
    // is the help line for token 1. … not a usage error and not null").
    const p = parsePrefix("!help warn add x", OPTS);
    assert.deepEqual(p.help.tokens, ["warn"]);
    const q = parsePrefix("!help warn add xyz", OPTS);
    assert.deepEqual(q.help.tokens, ["warn"]);
    // help tokens are bare tokens, never name/value pairs (spec step 4b/6):
    const r = parsePrefix("!help xp 5", OPTS);
    assert.deepEqual(r.help.tokens, ["xp", "5"]);
    assert.equal(r.usageError, null, "a bare help token is not an option name");
  });
});

describe("fluxer/commands — step 5: group/subcommand navigation", () => {
  it("a missing subcommand is a usage error naming the command", () => {
    const p = parsePrefix("!warn", OPTS);
    assert.ok(p.usageError);
    assert.match(p.usageError.reason, /needs a subcommand/);
    assert.match(p.usageError.reason, /add/);
  });

  it("an unknown subcommand is a usage error listing the valid ones", () => {
    const p = parsePrefix("!warn bogus 1", OPTS);
    assert.ok(p.usageError);
    assert.match(p.usageError.reason, /Unknown subcommand "bogus"/);
    assert.match(p.usageError.reason, /add, list/);
  });

  it("a group needs its subcommand (!warn has none; honeypot does)", () => {
    const p = parsePrefix("!honeypot channel", OPTS);
    assert.ok(p.usageError);
    assert.match(p.usageError.reason, /needs a subcommand/);
    assert.match(p.usageError.reason, /add/);
  });

  it("group → subcommand navigation sets both fields", () => {
    const p = parsePrefix("!honeypot channel list", OPTS);
    assert.equal(p.usageError, null);
    assert.equal(p.subcommandGroup, "channel");
    assert.equal(p.subcommand, "list");
  });

  it("direct subcommands coexist with groups (activityconfig status)", () => {
    const p = parsePrefix("!activityconfig status", OPTS);
    assert.equal(p.usageError, null);
    assert.equal(p.subcommand, "status");
    assert.equal(p.subcommandGroup, null);
  });
});

describe("fluxer/commands — Fluxer-only overlay", () => {
  it("note add without content is a usage error (overlay makes content required)", () => {
    const p = parsePrefix("!note add user 123456", OPTS);
    assert.ok(p.usageError, "content is required on Fluxer — the modal branch never runs");
    assert.match(p.usageError.reason, /Missing required option "content"/);
    assert.equal(p.subcommand, "add");
  });

  it("note add with content parses", () => {
    const p = parsePrefix('!note add user 123456 content "stayed up late raiding"', OPTS);
    assert.equal(p.usageError, null);
    assert.equal(p.subcommand, "add");
    assert.equal(p.options.find((o) => o.name === "content").value, "stayed up late raiding");
  });

  it("note edit without content is a usage error", () => {
    const p = parsePrefix("!note edit id 12", OPTS);
    assert.ok(p.usageError);
    assert.match(p.usageError.reason, /Missing required option "content"/);
  });

  it("!userinfo user 123456 view notes window 7 parses overlay option names", () => {
    const p = parsePrefix("!userinfo user 123456 view notes window 7", OPTS);
    assert.equal(p.usageError, null);
    assert.deepEqual(
      p.options.map((o) => [o.name, o.type, o.value]),
      [
        ["user", 6, "123456"],
        ["view", 3, "notes"],
        ["window", 3, "7"],
      ],
    );
  });

  it("userinfo page is an overlay integer with a minimum", () => {
    assert.equal(
      parsePrefix("!userinfo user 123456 page 3", OPTS).options.find((o) => o.name === "page").value,
      "3",
    );
    const bad = parsePrefix("!userinfo user 123456 page 0", OPTS);
    assert.ok(bad.usageError);
    assert.match(bad.usageError.reason, /at least 1/);
  });

  it("userinfo rejects an unknown view value", () => {
    const p = parsePrefix("!userinfo user 123456 view everything", OPTS);
    assert.ok(p.usageError);
    assert.match(p.usageError.reason, /must be one of: overview, notes/);
  });
});

describe("fluxer/commands — prefix source (K1)", () => {
  it("the default prefix is ! when no override is given", () => {
    // No opts.prefix: config.getFluxerCommandPrefix() (FLUXER_COMMAND_PREFIX
    // env, default "!"). A bare "!" default parse must work in a clean env.
    if (process.env.FLUXER_COMMAND_PREFIX) return; // operator override set — default asserted via opts above
    const p = parsePrefix("!xp", { registryCommands });
    assert.equal(p.commandName, "xp");
  });
});

describe("fluxer/commands — default tree (prod dispatch path)", () => {
  it("parsePrefix with NO opts resolves the built-in registry tree", () => {
    // Regression (prod 2026-10-01): defaultTree() required the registry via a
    // broken relative path, so EVERY prod prefix command threw
    // "Cannot find module" inside the pipeline — invisible to every existing
    // test because they all pass registryCommands explicitly.
    const p = parsePrefix("!xp");
    assert.ok(p, "default-tree parse must succeed, not throw");
    assert.equal(p.commandName, "xp");
    assert.deepEqual(p.options, []);
  });
});
