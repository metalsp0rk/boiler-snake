/**
 * `/gork toolrounds` — per-guild tool-round budget + derived loop deadline
 * (issue #705) — unit tests.
 *
 * Covers the whole #705 spine:
 *   - command surface (integer option, 5-300 picker bounds, staff family);
 *   - round-trip: persist → audit → config log → disclose-the-deadline reply;
 *   - the handler range gate (the security source of truth under the picker);
 *   - the guildSettings whitelist: write-clamp 5–300, NULL = NEVER SET
 *     (the state that keeps GORK_LLM_MAX_TOOL_ROUNDS the fallback);
 *   - constants.resolveMaxToolRounds / deriveToolTimeoutMs precedence +
 *     clamp tables (guild > global env > 50; min(BASE + 40s×rounds, 45min);
 *     explicit GORK_LLM_TIMEOUT_MS overrides the derivation wholesale);
 *   - /gork status "Tool rounds" field + the /settings Gork line's Rounds
 *     segment.
 *
 * Real db facade on a temp SQLite, real dispatcher + requireStaff gating,
 * fake discord.js I/O.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");
const {
  createChatInputInteraction,
  createClient,
  createGuild,
  createMember,
  createTextChannel,
  createUser,
  lastReplyContent,
} = require("./helpers/discord");

let api;
let gork;
let settingsFeature;
let constants;
let cleanup;

before(() => {
  // Contract: loadDb() before every src/ require (temp DB + cache reset).
  ({ api, cleanup } = loadDb());
  gork = require("../src/features/gork/index.js");
  settingsFeature = require("../src/features/settings/index.js");
  constants = require("../src/features/gork/constants.js");
});

after(() => cleanup?.());

/** Run `fn` with the legacy rounds/timeout env knobs absent. */
function withCleanLlmEnv(fn) {
  const saved = {};
  for (const k of ["GORK_LLM_MAX_TOOL_ROUNDS", "GORK_LLM_TIMEOUT_MS"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------- harness ----------

function makeEnv(guildId) {
  const guild = createGuild({ id: guildId });
  const auditChannel = createTextChannel({ id: `audit-${guildId}`, guild, name: "audit" });
  guild.addChannel(auditChannel);
  const client = createClient();
  client.addGuild(guild);
  api.updateGuildSettings(communityKey(guildId), {
    audit_log_channel_id: auditChannel.id,
  });
  const staffUser = createUser({ id: `staff-${guildId}` });
  const staffMember = createMember({ guild, user: staffUser, admin: true });
  guild.addMember(staffMember);
  return { guild, auditChannel, client, staffUser, staffMember };
}

async function runSlash(feature, commandName, guildId, env, subcommand, options) {
  const interaction = createChatInputInteraction({
    commandName,
    subcommand,
    guild: env.guild,
    user: env.staffUser,
    member: env.staffMember,
    options,
    client: env.client,
  });
  const { buildDiscordCommandContext } = require("../src/platform/discord/context");
  await feature.handlers[commandName](
    buildDiscordCommandContext(interaction, { client: env.client }),
    { client: env.client },
  );
  return interaction;
}

const runGork = (guildId, env, sub, options) =>
  runSlash(gork, "gork", guildId, env, sub, options);

function embedFields(interaction) {
  const reply = interaction.replies[interaction.replies.length - 1];
  const embed = reply && reply.embeds && reply.embeds[0];
  const data = embed ? (embed.toJSON ? embed.toJSON() : embed) : null;
  return (data && data.fields) || [];
}

// ---------- command surface ----------

describe("/gork toolrounds command surface (#705)", () => {
  it("registers toolrounds with a required integer option clamped 5-300", () => {
    const cmd = gork.commands[0].toJSON();
    const sub = cmd.options.find((o) => o.name === "toolrounds");
    assert.ok(sub, "toolrounds subcommand exists");
    const rounds = sub.options.find((o) => o.name === "rounds");
    assert.ok(rounds, "rounds option exists");
    assert.equal(rounds.type, 4, "INTEGER option");
    assert.equal(rounds.required, true);
    assert.equal(Number(rounds.min_value), 5);
    assert.equal(Number(rounds.max_value), 300);
  });
});

// ---------- round trip ----------

describe("/gork toolrounds round trip", () => {
  it("persists, audits, config-logs, and discloses the derived deadline", async () => {
    const guildId = "9700001";
    const env = makeEnv(guildId);
    await withCleanLlmEnv(async () => {
      const interaction = await runGork(guildId, env, "toolrounds", { rounds: 20 });
      // 90s + 20×40s = 890s = 14.8 min — the reply names what the guild
      // just authorized (clamp-and-disclose, the context_window idiom).
      assert.match(lastReplyContent(interaction), /set to \*\*20\*\*/);
      assert.match(lastReplyContent(interaction), /~14\.8 min/);
    });
    const row = api.getGuildSettings(communityKey(guildId));
    assert.equal(row.gork_max_tool_rounds, 20, "stored value");
    const auditRows = api.listAdminAudit(communityKey(guildId), { limit: 25 });
    assert.ok(
      auditRows.some((r) => r.action === "gork.tool_rounds_set"),
      "slash audit recorded gork.tool_rounds_set",
    );
    const logged = (env.auditChannel.sent || []).some((p) =>
      JSON.stringify(p).includes("Max tool rounds: 20"),
    );
    assert.ok(logged, "config-change log names the new value");
  });

  it("flags the global timeout override when one is in effect", async () => {
    const guildId = "9700002";
    const env = makeEnv(guildId);
    const saved = process.env.GORK_LLM_TIMEOUT_MS;
    process.env.GORK_LLM_TIMEOUT_MS = "180000";
    try {
      const interaction = await runGork(guildId, env, "toolrounds", { rounds: 12 });
      assert.match(lastReplyContent(interaction), /outranks this derivation/);
    } finally {
      if (saved === undefined) delete process.env.GORK_LLM_TIMEOUT_MS;
      else process.env.GORK_LLM_TIMEOUT_MS = saved;
    }
  });

  it("handler gate: out-of-range is refused with the allowed span (picker-less callers)", async () => {
    const guildId = "9700003";
    const env = makeEnv(guildId);
    const interaction = await runGork(guildId, env, "toolrounds", { rounds: 500 });
    assert.match(lastReplyContent(interaction), /must be 5-300 rounds/);
    assert.equal(
      api.getGuildSettings(communityKey(guildId)).gork_max_tool_rounds,
      null,
      "the refusal writes NOTHING",
    );
  });
});

// ---------- whitelist write-clamp ----------

describe("guild_settings gork_max_tool_rounds whitelist (#705)", () => {
  it("clamps out-of-range writes and preserves the NEVER-SET null", () => {
    const cid = communityKey("9700004");
    assert.equal(
      api.updateGuildSettings(cid, { gork_max_tool_rounds: 500 }).gork_max_tool_rounds,
      300,
      "above max clamps down (defense under the handler gate)",
    );
    assert.equal(
      api.updateGuildSettings(cid, { gork_max_tool_rounds: 3 }).gork_max_tool_rounds,
      5,
      "below min clamps up",
    );
    assert.equal(
      api.updateGuildSettings(cid, { gork_max_tool_rounds: "42" }).gork_max_tool_rounds,
      42,
      "numeric strings land as integers",
    );
    assert.equal(
      api.updateGuildSettings(cid, { gork_max_tool_rounds: null }).gork_max_tool_rounds,
      null,
      "explicit null keeps the NEVER-SET state representable (env fallback rides)",
    );
    assert.equal(
      api.updateGuildSettings(cid, { gork_max_tool_rounds: "nonsense" }).gork_max_tool_rounds,
      null,
      "garbage degrades to never-set, same posture as context_window's default fallback",
    );
  });
});

// ---------- resolution + derivation tables ----------

describe("resolveMaxToolRounds precedence (guild > global env > 50)", () => {
  const { resolveMaxToolRounds, deriveToolTimeoutMs } = constants;

  it("guild value wins and clamps to 5-300 on read", () => {
    const env = {};
    assert.equal(resolveMaxToolRounds(20, env), 20);
    assert.equal(resolveMaxToolRounds(5, env), 5, "min edge");
    assert.equal(resolveMaxToolRounds(300, env), 300, "max edge");
    assert.equal(resolveMaxToolRounds(4, env), 5, "clamped up");
    assert.equal(resolveMaxToolRounds(301, env), 300, "clamped down");
    assert.equal(resolveMaxToolRounds(100000, env), 300, "hand-poisoned row cannot run away");
  });

  it("NULL/garbage guild value falls back to the legacy env knob, then 50", () => {
    assert.equal(resolveMaxToolRounds(null, { GORK_LLM_MAX_TOOL_ROUNDS: "3" }), 3, "env-pinned deployment keeps its number");
    assert.equal(resolveMaxToolRounds(undefined, { GORK_LLM_MAX_TOOL_ROUNDS: "1" }), 1, "env escape hatch below the guild min still works");
    assert.equal(resolveMaxToolRounds(null, { GORK_LLM_MAX_TOOL_ROUNDS: "bogus" }), 50, "garbage env → 50");
    assert.equal(resolveMaxToolRounds(null, {}), 50, "nothing set → 50");
    assert.equal(resolveMaxToolRounds("nonsense", {}), 50, "garbage guild value reads as never-set");
  });
});

describe("deriveToolTimeoutMs: min(90s + 40s×rounds, 45 min)", () => {
  const { deriveToolTimeoutMs } = constants;

  it("grows with the rounds budget the guild authorized", () => {
    assert.equal(deriveToolTimeoutMs(5, {}), 90_000 + 5 * 40_000, "5 rounds → 290s");
    assert.equal(deriveToolTimeoutMs(50, {}), 90_000 + 50 * 40_000, "50 rounds → 34.8 min");
    assert.equal(deriveToolTimeoutMs(300, {}), 45 * 60_000, "300 rounds → capped at 45 min");
  });

  it("operator knobs: per-round cost and the hard cap", () => {
    assert.equal(
      deriveToolTimeoutMs(10, { GORK_LLM_TIMEOUT_PER_ROUND_MS: "10000" }),
      90_000 + 100_000,
      "slow-model operators raise the per-round cost",
    );
    assert.equal(
      deriveToolTimeoutMs(300, { GORK_LLM_TIMEOUT_CAP_MS: "600000" }),
      600_000,
      "operators can lower the ceiling",
    );
  });

  it("an explicit GORK_LLM_TIMEOUT_MS overrides the WHOLE derivation", () => {
    assert.equal(deriveToolTimeoutMs(300, { GORK_LLM_TIMEOUT_MS: "180000" }), 180000);
    assert.equal(
      deriveToolTimeoutMs(300, { GORK_LLM_TIMEOUT_MS: "bogus" }),
      45 * 60_000,
      "garbage override falls back to the derivation (never a 0 deadline)",
    );
  });
});

// ---------- surfaces ----------

describe("#705 surfaces: /gork status + /settings", () => {
  it("status shows the effective rounds, flagging the global inheritance", async () => {
    const guildId = "9700005";
    const env = makeEnv(guildId);
    await withCleanLlmEnv(async () => {
      const untouched = await runGork(guildId, env, "status", {});
      const f0 = embedFields(untouched).find((f) => f.name === "Tool rounds");
      assert.ok(f0, "status carries the Tool rounds field");
      assert.equal(f0.value, "50 (global)", "never-set guild inherits the global default");

      await runGork(guildId, env, "toolrounds", { rounds: 42 });
      const touched = await runGork(guildId, env, "status", {});
      const f1 = embedFields(touched).find((f) => f.name === "Tool rounds");
      assert.equal(f1.value, "42", "a guild-set budget shows plain");
    });
  });

  it("the /settings Gork line carries the Rounds segment", async () => {
    const guildId = "9700006";
    const env = makeEnv(guildId);
    await runGork(guildId, env, "toolrounds", { rounds: 33 });
    const interaction = await runSlash(settingsFeature, "settings", guildId, env, null, {});
    const gorkField = embedFields(interaction).find((f) => f.name === "Gork");
    assert.ok(gorkField, "Gork field exists");
    assert.match(gorkField.value, /Rounds \*\*33\*\*/, "effective rounds on the settings line");
  });
});
