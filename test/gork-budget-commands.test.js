/**
 * `/gork budget` command tests (roadmap/gork.md §7.17.7 — decision 37).
 *
 * Same fake-interaction style as the other gork command suites: real db
 * facade on a temp SQLite via loadDb(), real requireStaff gating, and the
 * REAL logConfigChange path inspected through the guild's fake audit channel.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

const {
  createChatInputInteraction,
  createClient,
  createGuild,
  createMember,
  createTextChannel,
  createUser,
  lastReplyContent,
  lastReplyEphemeral,
  PermissionFlagsBits,
} = require("./helpers/discord");

const CATEGORY_TYPE = 4; // ChannelType.GuildCategory

let api;
let gork;
let cleanup;

before(() => {
  // Contract: loadDb() before every src/ require (fresh temp DB_PATH +
  // require-cache reset) so the project DB is never opened.
  ({ api, cleanup } = loadDb());
  gork = require("../src/features/gork/index.js");
});

after(() => cleanup?.());

// ---------- harness ----------

function makeEnv(guildId) {
  const guild = createGuild({ id: guildId });
  const auditChannel = createTextChannel({ id: `audit-${guildId}`, guild, name: "audit" });
  guild.addChannel(auditChannel);
  const client = createClient();
  client.addGuild(guild);
  api.updateGuildSettings(guildId, { audit_log_channel_id: auditChannel.id });

  const staffUser = createUser({ id: `staff-${guildId}` });
  const staffMember = createMember({ guild, user: staffUser, admin: true });
  guild.addMember(staffMember);

  return { guild, auditChannel, client, staffUser, staffMember };
}

async function runBudget(guildId, options, env) {
  const interaction = createChatInputInteraction({
    commandName: "gork",
    subcommand: "budget",
    guild: env.guild,
    user: env.staffUser,
    member: env.staffMember,
    options,
    client: env.client,
  });
  await gork.handlers.gork(interaction, { client: env.client });
  return interaction;
}

async function runStatus(env) {
  const interaction = createChatInputInteraction({
    commandName: "gork",
    subcommand: "status",
    guild: env.guild,
    user: env.staffUser,
    member: env.staffMember,
    options: {},
    client: env.client,
  });
  await gork.handlers.gork(interaction, { client: env.client });
  return interaction;
}

/** Flat searchable text of every embed sent to the audit channel. */
function auditText(env) {
  return env.auditChannel.sent
    .flatMap((payload) => (payload && payload.embeds) || [])
    .map((embed) => JSON.stringify(embed.toJSON ? embed.toJSON() : embed))
    .join("\n");
}

/** Fields of the last embed reply (status/list embeds). */
function embedFields(interaction) {
  const reply = interaction.replies[interaction.replies.length - 1];
  const embed = reply && reply.embeds && reply.embeds[0];
  const data = embed ? (embed.toJSON ? embed.toJSON() : embed) : null;
  return (data && data.fields) || [];
}

const fakeChannel = (id, name = "general", type = 0) => ({ id, name, type });
const fakeCategory = (id, name = "Support") => ({ id, name, type: CATEGORY_TYPE });

// ---------- command surface ----------

describe("/gork budget command surface", () => {
  it("registers budget: action choices + limit bounds + channel picker", () => {
    const cmd = gork.commands[0].toJSON();
    assert.equal(
      String(cmd.default_member_permissions),
      String(PermissionFlagsBits.ManageGuild),
      "command-level ManageGuild gate unchanged",
    );
    const budget = cmd.options.find((o) => o.name === "budget");
    assert.ok(budget, "budget subcommand present");

    const action = budget.options.find((o) => o.name === "action");
    assert.equal(action.required, true);
    assert.deepEqual(
      action.choices.map((c) => c.value),
      ["default", "channel", "category", "remove_channel", "remove_category", "list"],
    );

    const limit = budget.options.find((o) => o.name === "limit");
    assert.equal(limit.type, 4, "integer option");
    assert.equal(limit.min_value, -1, "tri-state lower bound");
    assert.equal(limit.max_value, 1000, "tri-state upper bound");

    const target = budget.options.find((o) => o.name === "target");
    assert.equal(target.type, 7, "channel option");
    assert.ok(target.channel_types.includes(CATEGORY_TYPE), "category pickable");

    assert.ok(budget.options.some((o) => o.name === "id" && o.type === 3));
    assert.ok(
      !budget.options.some((o) => o.type === 1 || o.type === 2),
      "no nesting — Discord option depth stays at 2",
    );
  });
});

// ---------- default ----------

describe("/gork budget default", () => {
  it("stores the tri-state limit, replies, and audits", async () => {
    const G = "g-bud-cmd-default";
    const env = makeEnv(G);
    const interaction = await runBudget(G, { action: "default", limit: 5 }, env);
    assert.ok(lastReplyEphemeral(interaction));
    assert.match(lastReplyContent(interaction), /5\/day/);
    assert.equal(api.getGuildSettings(G).gork_daily_limit, 5);
    assert.match(auditText(env), /Guild-default daily budget: 5\/day/);
  });

  it("-1 stores blocked and 0 stores unlimited", async () => {
    const G = "g-bud-cmd-states";
    const env = makeEnv(G);
    await runBudget(G, { action: "default", limit: -1 }, env);
    assert.equal(api.getGuildSettings(G).gork_daily_limit, -1);
    assert.match(auditText(env), /blocked/i);
    await runBudget(G, { action: "default", limit: 0 }, env);
    assert.equal(api.getGuildSettings(G).gork_daily_limit, 0);
  });

  it("out-of-range input is clamped by the settings layer (never rejected silently)", async () => {
    const G = "g-bud-cmd-clamp";
    const env = makeEnv(G);
    await runBudget(G, { action: "default", limit: 5000 }, env);
    assert.equal(api.getGuildSettings(G).gork_daily_limit, 1000);
  });

  it("missing limit → actionable hint, no write", async () => {
    const G = "g-bud-cmd-nolimit";
    const env = makeEnv(G);
    const interaction = await runBudget(G, { action: "default" }, env);
    assert.match(lastReplyContent(interaction), /Provide `limit`/);
    assert.equal(auditText(env), "", "no audit for a usage error");
  });
});

// ---------- channel / category rules ----------

describe("/gork budget channel|category", () => {
  it("adds a channel rule with provenance and audits it", async () => {
    const G = "g-bud-cmd-ch";
    const env = makeEnv(G);
    const interaction = await runBudget(
      G,
      { action: "channel", target: fakeChannel("111", "general"), limit: 3 },
      env,
    );
    assert.match(lastReplyContent(interaction), /<#111>.*3\/day/);
    const rows = api.listGorkBudgetRules(G);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { kind: rows[0].scope_kind, id: rows[0].target_id, limit: rows[0].daily_limit },
      { kind: "channel", id: "111", limit: 3 },
    );
    assert.equal(rows[0].created_by, `staff-${G}`, "created_by provenance stored");
    assert.match(auditText(env), /channel rule updated/i);
  });

  it("adds a category rule; replace updates in place", async () => {
    const G = "g-bud-cmd-cat";
    const env = makeEnv(G);
    await runBudget(G, { action: "category", target: fakeCategory("222"), limit: 1 }, env);
    await runBudget(G, { action: "category", target: fakeCategory("222"), limit: 10 }, env);
    const rows = api.listGorkBudgetRules(G);
    assert.equal(rows.length, 1, "replace must not stack rows");
    assert.equal(rows[0].daily_limit, 10);
  });

  it("rejects kind/picker mismatches (dead rules are not stored)", async () => {
    const G = "g-bud-cmd-mismatch";
    const env = makeEnv(G);
    let interaction = await runBudget(
      G,
      { action: "channel", target: fakeCategory("333"), limit: 2 },
      env,
    );
    assert.match(lastReplyContent(interaction), /must be a \*\*channel\/thread\*\*/);
    interaction = await runBudget(
      G,
      { action: "category", target: fakeChannel("444"), limit: 2 },
      env,
    );
    assert.match(lastReplyContent(interaction), /must be a \*\*category\*\*/);
    assert.equal(api.listGorkBudgetRules(G).length, 0, "nothing stored");
  });

  it("a THREAD target normalizes to its PARENT channel (no dead thread-id rules)", async () => {
    const G = "g-bud-cmd-thread";
    const env = makeEnv(G);
    const fakeThread = {
      id: "999",
      name: "in-thread",
      type: 11,
      isThread: () => true,
      parent: fakeChannel("888", "general"),
    };
    const interaction = await runBudget(
      G,
      { action: "channel", target: fakeThread, limit: 4 },
      env,
    );
    const rows = api.listGorkBudgetRules(G);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target_id, "888", "rule stores the PARENT channel id, not the thread id");
    assert.match(lastReplyContent(interaction), /parent channel/i, "reply discloses the rebinding");
    assert.match(auditText(env), /`888`/, "audit records the parent id");

    // Removal via the same thread picker must hit the stored (parent) rule.
    const rem = await runBudget(
      G,
      { action: "remove_channel", target: fakeThread },
      env,
    );
    assert.doesNotMatch(lastReplyContent(rem), /No `channel` budget rule/);
    assert.equal(api.listGorkBudgetRules(G).length, 0, "thread-target removal clears the parent rule");
  });

  it("missing target or limit → actionable hints", async () => {
    const G = "g-bud-cmd-hints";
    const env = makeEnv(G);
    let interaction = await runBudget(G, { action: "channel", limit: 2 }, env);
    assert.match(lastReplyContent(interaction), /Pick the channel in `target`/);
    interaction = await runBudget(G, { action: "category", target: fakeCategory("555") }, env);
    assert.match(lastReplyContent(interaction), /Provide `limit`/);
  });
});

// ---------- remove ----------

describe("/gork budget remove_*", () => {
  it("removes via picker, falls back to the raw id, and reports misses", async () => {
    const G = "g-bud-cmd-rm";
    const env = makeEnv(G);
    api.upsertGorkBudgetRule(G, "channel", "666", 4, "staff-x");
    api.upsertGorkBudgetRule(G, "category", "777", 2, "staff-x");

    let interaction = await runBudget(
      G,
      { action: "remove_channel", target: fakeChannel("666") },
      env,
    );
    assert.match(lastReplyContent(interaction), /Removed the channel budget rule for <#666>/);
    assert.match(lastReplyContent(interaction), /category → the guild default/);

    interaction = await runBudget(G, { action: "remove_category", id: "777" }, env);
    assert.match(lastReplyContent(interaction), /Removed the category budget rule/);
    assert.equal(api.listGorkBudgetRules(G).length, 0);

    interaction = await runBudget(G, { action: "remove_channel", id: "999" }, env);
    assert.match(lastReplyContent(interaction), /No `channel` budget rule for `999`/);

    interaction = await runBudget(G, { action: "remove_channel" }, env);
    assert.match(lastReplyContent(interaction), /Pick `target` or type the raw `id`/);
  });
});

// ---------- list + status ----------

describe("/gork budget list & /gork status Budget line", () => {
  it("list: empty guild shows the default + 'none' note", async () => {
    const G = "g-bud-cmd-list-empty";
    const env = makeEnv(G);
    const interaction = await runBudget(G, { action: "list" }, env);
    const fields = embedFields(interaction);
    const by = Object.fromEntries(fields.map((f) => [f.name, f.value]));
    assert.equal(by["Guild default"], "unlimited");
    assert.match(by.Rules, /none/i);
  });

  it("list: rules table with provenance", async () => {
    const G = "g-bud-cmd-list";
    const env = makeEnv(G);
    api.updateGuildSettings(G, { gork_daily_limit: 5 });
    api.upsertGorkBudgetRule(G, "channel", "888", 2, `staff-${G}`);
    api.upsertGorkBudgetRule(G, "category", "999", -1, null);

    const interaction = await runBudget(G, { action: "list" }, env);
    const fields = embedFields(interaction);
    const by = Object.fromEntries(fields.map((f) => [f.name, f.value]));
    assert.equal(by["Guild default"], "5/day");
    assert.match(by.Rules, /Channel <#888> — \*\*2\/day\*\* · by <@staff-/);
    assert.match(by.Rules, /Category `999` — \*\*blocked\*\*/);
  });

  it("status gains the Budget line: default + rule count", async () => {
    const G = "g-bud-cmd-status";
    const env = makeEnv(G);
    let fields = embedFields(await runStatus(env));
    let by = Object.fromEntries(fields.map((f) => [f.name, f.value]));
    assert.equal(by.Budget, "default unlimited · 0 rules");

    api.updateGuildSettings(G, { gork_daily_limit: 5 });
    api.upsertGorkBudgetRule(G, "channel", "888", 2, null);
    fields = embedFields(await runStatus(env));
    by = Object.fromEntries(fields.map((f) => [f.name, f.value]));
    assert.equal(by.Budget, "default 5/day · 1 rule");
  });
});
