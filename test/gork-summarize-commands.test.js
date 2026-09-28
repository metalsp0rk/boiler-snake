/**
 * `/gork summarize` command-shape tests (roadmap/gork.md §7.21.1 — decision 53).
 *
 * Shape-only: asserts the REAL SlashCommandBuilder chain through
 * commands[0].toJSON() — the summarize subcommand rides the existing staff-gated
 * /gork command with six optional options carrying Discord-enforced bounds
 * (last 1–1000, focus ≤200, lang ≤40, channel picker). Mode exclusivity is
 * handler-enforced (subtask 08), so nothing here may be required. Same
 * surface-assertion style as the budget/memory command suites.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// commands.js is DB-free (builders + constants only) — the loadDb() contract
// applies to suites that require the feature index/handlers; this one doesn't.
const { commands } = require("../src/features/gork/commands.js");
const {
  GORK_SUMMARIZE_LAST_MIN,
  GORK_SUMMARIZE_LAST_MAX,
  GORK_SUMMARIZE_FOCUS_MAX,
  GORK_SUMMARIZE_LANG_MAX,
  GORK_SUMMARIZE_RANGE_MAX_MESSAGES,
} = require("../src/features/gork/constants.js");
const { PermissionFlagsBits } = require("./helpers/discord.js");

// Discord option type codes (ApplicationCommandOptionType).
const T_SUB = 1;
const T_STRING = 3;
const T_INT = 4;
const T_CHANNEL = 7;

function gorkJson() {
  return commands[0].toJSON();
}

function summarizeJson() {
  const sum = gorkJson().options.find((o) => o.name === "summarize");
  assert.ok(sum, "summarize subcommand present on /gork");
  return sum;
}

describe("/gork summarize command surface", () => {
  it("rides the existing staff-gated /gork command (no new top-level command)", () => {
    const cmd = gorkJson();
    assert.equal(commands.length, 1, "gork family stays a single top-level command");
    assert.equal(cmd.name, "gork");
    assert.equal(
      String(cmd.default_member_permissions),
      String(PermissionFlagsBits.ManageGuild),
      "command-level ManageGuild gate unchanged",
    );
    const sum = summarizeJson();
    assert.equal(sum.type, T_SUB, "sub-command");
    assert.ok(
      !sum.options.some((o) => o.type === T_SUB || o.type === 2),
      "no nesting — Discord option depth stays at 2",
    );
  });

  it("exposes exactly the six mode options, all optional (decision 53)", () => {
    const names = summarizeJson().options.map((o) => o.name);
    assert.deepEqual(
      [...names].sort(),
      ["channel", "focus", "from", "lang", "last", "to"],
      "the three modes ride: from+to / from→now / last:N",
    );
    for (const opt of summarizeJson().options) {
      assert.equal(opt.required, false, `\`${opt.name}\` optional — exclusivity is handler-side`);
    }
  });

  it("anchors `from`/`to` are free-text strings (link or bare id grammar)", () => {
    const sum = summarizeJson();
    for (const name of ["from", "to"]) {
      const opt = sum.options.find((o) => o.name === name);
      assert.ok(opt, `${name} option present`);
      assert.equal(opt.type, T_STRING, `${name} string option`);
    }
  });

  it("bounds `last` 1-1000 from constants (keeps N inside the range cap)", () => {
    const last = summarizeJson().options.find((o) => o.name === "last");
    assert.ok(last, "last option present");
    assert.equal(last.type, T_INT, "integer option");
    assert.equal(last.min_value, 1, "min 1");
    assert.equal(last.max_value, 1000, "max 1000");
    assert.equal(last.min_value, GORK_SUMMARIZE_LAST_MIN, "bound from constants.js");
    assert.equal(last.max_value, GORK_SUMMARIZE_LAST_MAX, "bound from constants.js");
    assert.equal(
      GORK_SUMMARIZE_LAST_MAX,
      GORK_SUMMARIZE_RANGE_MAX_MESSAGES,
      "last: upper bound matches the hard range cap (§7.21.2)",
    );
  });

  it("types `channel` as a text/thread picker (no categories, no forums)", () => {
    const channel = summarizeJson().options.find((o) => o.name === "channel");
    assert.ok(channel, "channel option present");
    assert.equal(channel.type, T_CHANNEL, "channel option");
    assert.ok(channel.channel_types.includes(0), "text pickable");
    assert.ok(channel.channel_types.includes(5), "announcement pickable");
    assert.ok(channel.channel_types.includes(11), "public thread pickable");
    assert.ok(channel.channel_types.includes(12), "private thread pickable");
    assert.ok(!channel.channel_types.includes(4), "category not pickable");
    assert.ok(!channel.channel_types.includes(15), "forum not pickable (§7.21.1)");
  });

  it("caps `focus` at 200 and `lang` at 40 chars from constants (§7.21.1)", () => {
    const sum = summarizeJson();
    const focus = sum.options.find((o) => o.name === "focus");
    assert.equal(focus.type, T_STRING, "focus string option");
    assert.equal(focus.max_length, 200, "focus max 200");
    assert.equal(focus.max_length, GORK_SUMMARIZE_FOCUS_MAX, "cap from constants.js");

    const lang = sum.options.find((o) => o.name === "lang");
    assert.equal(lang.type, T_STRING, "lang string option");
    assert.equal(lang.max_length, 40, "lang max 40");
    assert.equal(lang.max_length, GORK_SUMMARIZE_LANG_MAX, "cap from constants.js");
  });

  it("descriptions fit Discord's limits and name the modes", () => {
    const cmd = gorkJson();
    assert.ok(cmd.description.length <= 100, "top-level description ≤ 100");
    const sum = summarizeJson();
    assert.ok(sum.description.length <= 100, "subcommand description ≤ 100");
    assert.match(sum.description, /from\+to/);
    assert.match(sum.description, /from→now/);
    assert.match(sum.description, /last:N/);
    for (const opt of sum.options) {
      assert.ok(
        opt.description.length >= 1 && opt.description.length <= 125,
        `\`${opt.name}\` description within 1-125 chars`,
      );
    }
    const last = sum.options.find((o) => o.name === "last");
    assert.match(last.description, /1-1000/, "bounds disclosed in the description");
  });
});
