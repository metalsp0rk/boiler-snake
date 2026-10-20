/**
 * `/gork role` command tests (issue #174 — role-mention invocation).
 *
 * Same fake-interaction style as the other gork command suites: real db
 * facade on a temp SQLite via loadDb() (which also proves migration 058
 * adds the nullable `gork_role_id` column — every settings read on a fresh
 * DB carries it), real requireStaff gating, and the REAL logConfigChange
 * path inspected through the guild's fake audit channel.
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
let cleanup;

before(() => {
  // Contract: loadDb() before every src/ require (fresh temp DB_PATH +
  // require-cache reset) so the project DB is never opened.
  ({ api, cleanup } = loadDb());
  gork = require("../src/features/gork/index.js");
});

after(() => cleanup?.());

// ---------- harness ----------

const GORK_ROLE = { id: "412345678901234567", name: "gork-role" };
const OTHER_ROLE = { id: "498765432109876543", name: "mod" };

function makeEnv(guildId) {
  const guild = createGuild({ id: guildId });
  const auditChannel = createTextChannel({ id: `audit-${guildId}`, guild, name: "audit" });
  guild.addChannel(auditChannel);
  const client = createClient();
  client.addGuild(guild);
  api.updateGuildSettings(communityKey(guildId), { audit_log_channel_id: auditChannel.id });

  const staffUser = createUser({ id: `staff-${guildId}` });
  const staffMember = createMember({ guild, user: staffUser, admin: true });
  guild.addMember(staffMember);

  return { guild, auditChannel, client, staffUser, staffMember };
}

async function runGork(guildId, subcommand, options, env) {
  const interaction = createChatInputInteraction({
    commandName: "gork",
    subcommand,
    guild: env.guild,
    user: env.staffUser,
    member: env.staffMember,
    options,
    client: env.client,
  });
  const { buildDiscordCommandContext } = require("../src/platform/discord/context");
  await gork.handlers.gork(
    buildDiscordCommandContext(interaction, { client: env.client }),
    { client: env.client },
  );
  return interaction;
}

/** Embed JSONs sent to a fake channel. */
function sentEmbeds(channel) {
  return (channel.sent || []).map((p) =>
    (p && p.embeds && p.embeds[0] && (p.embeds[0].toJSON ? p.embeds[0].toJSON() : p.embeds[0])) || null,
  );
}

/** Fields of the last embed reply (status embeds). */
function embedFields(interaction) {
  const reply = interaction.replies[interaction.replies.length - 1];
  const embed = reply && reply.embeds && reply.embeds[0];
  const data = embed ? (embed.toJSON ? embed.toJSON() : embed) : null;
  return (data && data.fields) || [];
}

function fieldOf(interaction, name) {
  return (embedFields(interaction).find((f) => f.name === name) || {}).value;
}

// ---------- command surface ----------

describe("/gork role command surface", () => {
  it("registers role with a role picker + clear toggle (both optional)", () => {
    const cmd = gork.commands[0].toJSON();
    const sub = cmd.options.find((o) => o.name === "role");
    assert.ok(sub, "role subcommand exists");
    const roleOpt = sub.options.find((o) => o.name === "role");
    const clearOpt = sub.options.find((o) => o.name === "clear");
    assert.ok(roleOpt, "role option exists");
    assert.equal(roleOpt.type, 8, "role is a role-picker option");
    assert.equal(roleOpt.required, false, "role is optional (clear XOR role)");
    assert.ok(clearOpt, "clear option exists");
    assert.equal(clearOpt.type, 5, "clear is a boolean option");
  });
});

// ---------- migration / storage ----------

describe("guild_settings.gork_role_id (migration 058)", () => {
  it("defaults to NULL on a fresh database", () => {
    const env = makeEnv("role-col");
    const settings = api.getGuildSettings(communityKey("role-col"));
    assert.ok("gork_role_id" in settings, "column exists after migrations");
    assert.equal(settings.gork_role_id, null, "NULL = role path not configured");
  });

  it("stores trimmed ids; blank clears; over-length keeps the prior value", () => {
    const g = communityKey("role-norm");
    assert.equal(
      api.updateGuildSettings(g, { gork_role_id: " 412345678901234567 " }).gork_role_id,
      "412345678901234567",
    );
    assert.equal(api.updateGuildSettings(g, { gork_role_id: "   " }).gork_role_id, null);
    assert.equal(
      api.updateGuildSettings(g, { gork_role_id: "x".repeat(65) }).gork_role_id,
      null,
      "over-length rejected — prior value kept (already null here)",
    );
  });
});

// ---------- /gork role handler ----------

describe("/gork role — set", () => {
  it("persists gork_role_id, confirms the role, and logs the change to the audit channel", async () => {
    const env = makeEnv("role-set");
    const interaction = await runGork("role-set", "role", { role: GORK_ROLE }, env);
    const settings = api.getGuildSettings(communityKey("role-set"));
    assert.equal(settings.gork_role_id, GORK_ROLE.id);
    assert.ok(
      lastReplyContent(interaction).includes(`<@&${GORK_ROLE.id}>`),
      "reply names the new trigger role",
    );
    assert.ok(
      sentEmbeds(env.auditChannel).some((e) => e?.title === "Gork role trigger updated"),
      "config-change embed posted to the audit channel",
    );
  });

  it("replacing the configured role records the old → new change", async () => {
    const env = makeEnv("role-swap");
    await runGork("role-swap", "role", { role: GORK_ROLE }, env);
    await runGork("role-swap", "role", { role: OTHER_ROLE }, env);
    assert.equal(
      api.getGuildSettings(communityKey("role-swap")).gork_role_id,
      OTHER_ROLE.id,
    );
    const change = sentEmbeds(env.auditChannel).find(
      (e) => e?.title === "Gork role trigger updated",
      );
    const all = sentEmbeds(env.auditChannel)
      .filter((e) => e?.title === "Gork role trigger updated")
      .map((e) => JSON.stringify(e));
    assert.ok(all.some((s) => s.includes(`<@&${GORK_ROLE.id}> → <@&${OTHER_ROLE.id}>`)), all.join("\n"));
    void change;
  });

  it("asks for a role when neither role nor clear is given", async () => {
    const env = makeEnv("role-none");
    const interaction = await runGork("role-none", "role", {}, env);
    assert.ok(
      lastReplyContent(interaction).includes("Provide a `role`"),
      "guidance reply",
    );
    assert.equal(
      api.getGuildSettings(communityKey("role-none")).gork_role_id,
      null,
      "nothing persisted",
    );
  });

  it("refuses role + clear together", async () => {
    const env = makeEnv("role-both");
    const interaction = await runGork(
      "role-both",
      "role",
      { role: GORK_ROLE, clear: true },
      env,
    );
    assert.ok(
      lastReplyContent(interaction).includes("not both"),
      "XOR guidance reply",
    );
    assert.equal(
      api.getGuildSettings(communityKey("role-both")).gork_role_id,
      null,
      "nothing persisted",
    );
  });

  it("refuses @everyone with the serializability reason", async () => {
    const env = makeEnv("role-everyone");
    const interaction = await runGork(
      "role-everyone",
      "role",
      { role: { id: env.guild.id, name: "@everyone" } },
      env,
    );
    assert.ok(
      lastReplyContent(interaction).includes("@everyone"),
      "specific @everyone refusal",
    );
    assert.equal(
      api.getGuildSettings(communityKey("role-everyone")).gork_role_id,
      null,
      "not persisted",
    );
  });
});

describe("/gork role — clear", () => {
  it("resets to NULL and explains the keyword is untouched", async () => {
    const env = makeEnv("role-clear");
    await runGork("role-clear", "role", { role: GORK_ROLE }, env);
    const interaction = await runGork("role-clear", "role", { clear: true }, env);
    assert.equal(
      api.getGuildSettings(communityKey("role-clear")).gork_role_id,
      null,
    );
    assert.ok(
      lastReplyContent(interaction).toLowerCase().includes("keyword trigger stays"),
      "reply states the keyword path is unaffected",
    );
  });

  it("clearing when nothing is configured is a clean no-op notice", async () => {
    const env = makeEnv("role-clear-noop");
    const interaction = await runGork("role-clear-noop", "role", { clear: true }, env);
    assert.ok(
      lastReplyContent(interaction).includes("No gork role trigger"),
      "noop notice, not an error",
    );
    assert.equal(
      env.auditChannel.sent.length,
      0,
      "no config-change noise for a no-op",
    );
  });
});

// ---------- surfaces ----------

describe("/gork status and the role trigger", () => {
  it('shows "not set" by default and the role mention once configured', async () => {
    const env = makeEnv("role-status");
    let interaction = await runGork("role-status", "status", {}, env);
    assert.equal(fieldOf(interaction, "Role trigger"), "not set");

    await runGork("role-status", "role", { role: GORK_ROLE }, env);
    interaction = await runGork("role-status", "status", {}, env);
    assert.equal(fieldOf(interaction, "Role trigger"), `<@&${GORK_ROLE.id}>`);
  });
});
