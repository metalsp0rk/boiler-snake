/**
 * `/gork logchannel` + the gork Q&A log stream — unit tests.
 *
 * The "Gork Q&A" embeds (completed exchanges + failure one-liners) move to a
 * dedicated per-guild channel (`gork_log_channel_id`, set via
 * `/gork logchannel`), falling back to the general audit log channel when
 * unset — the warn-stream pattern. Memory and summarize entries stay in the
 * audit channel (scope pin).
 *
 * Real db facade on a temp SQLite, real dispatcher + requireStaff gating,
 * real audit.js / logs-auditLog routing, fake discord.js I/O.
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
let audit;
let cleanup;

before(() => {
  // Contract: loadDb() before every src/ require (temp DB + cache reset).
  ({ api, cleanup } = loadDb());
  gork = require("../src/features/gork/index.js");
  audit = require("../src/features/gork/audit");
});

after(() => cleanup?.());

// ---------- harness ----------

/** Guild with audit + dedicated Q&A channels wired into the fake client. */
function makeEnv(guildId, { gorkChannel = false } = {}) {
  const guild = createGuild({ id: guildId });
  const auditChannel = createTextChannel({ id: `audit-${guildId}`, guild, name: "audit" });
  const qaChannel = createTextChannel({ id: `qa-${guildId}`, guild, name: "gork-qa" });
  guild.addChannel(auditChannel);
  guild.addChannel(qaChannel);
  const client = createClient();
  client.addGuild(guild);
  api.updateGuildSettings(communityKey(guildId), {
    audit_log_channel_id: auditChannel.id,
    ...(gorkChannel ? { gork_log_channel_id: qaChannel.id } : {}),
  });

  const staffUser = createUser({ id: `staff-${guildId}` });
  const staffMember = createMember({ guild, user: staffUser, admin: true });
  guild.addMember(staffMember);

  return { guild, auditChannel, qaChannel, client, staffUser, staffMember };
}

/** Guild with NO log channels configured at all (console-fallback branch). */
function makeBareEnv(guildId) {
  const guild = createGuild({ id: guildId });
  const client = createClient();
  client.addGuild(guild);
  return { guild, client };
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

function embedTitle(embed) {
  return embed ? embed.title : undefined;
}

/** Fields of the last embed reply (status embeds). */
function embedFields(interaction) {
  const reply = interaction.replies[interaction.replies.length - 1];
  const embed = reply && reply.embeds && reply.embeds[0];
  const data = embed ? (embed.toJSON ? embed.toJSON() : embed) : null;
  return (data && data.fields) || [];
}

/** Run async `fn` with console.log captured; resolves to the lines. */
async function captureConsoleLogAsync(fn) {
  const real = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = real;
  }
  return lines;
}

// ---------- command surface ----------

describe("/gork logchannel command surface", () => {
  it("registers logchannel with a channel picker + clear toggle", () => {
    const cmd = gork.commands[0].toJSON();
    const sub = cmd.options.find((o) => o.name === "logchannel");
    assert.ok(sub, "logchannel subcommand exists");
    const channelOpt = sub.options.find((o) => o.name === "channel");
    const clearOpt = sub.options.find((o) => o.name === "clear");
    assert.ok(channelOpt, "channel option exists");
    assert.equal(channelOpt.required, false, "channel is optional (clear XOR channel)");
    assert.deepEqual(
      channelOpt.channel_types,
      [0, 5],
      "text + announcement channels only",
    );
    assert.ok(clearOpt, "clear option exists");
    assert.equal(clearOpt.type, 5, "clear is a boolean option");
  });
});

// ---------- /gork logchannel handler ----------

describe("/gork logchannel — set / clear", () => {
  it("sets gork_log_channel_id and confirms the channel in the reply", async () => {
    const env = makeEnv("lc-set");
    const interaction = await runGork(
      "lc-set",
      "logchannel",
      { channel: { id: env.qaChannel.id, name: "gork-qa", type: 0 } },
      env,
    );
    const settings = api.getGuildSettings(communityKey("lc-set"));
    assert.equal(settings.gork_log_channel_id, env.qaChannel.id);
    assert.ok(
      lastReplyContent(interaction).includes(`<#${env.qaChannel.id}>`),
      "reply names the new Q&A channel",
    );
    // Config-change embed lands in the (still general) audit channel.
    assert.ok(
      sentEmbeds(env.auditChannel).some((e) => embedTitle(e) === "Gork Q&A log channel set"),
      "config-change embed posted to the audit channel",
    );
  });

  it("asks for a channel when neither channel nor clear is given", async () => {
    const env = makeEnv("lc-none");
    const interaction = await runGork("lc-none", "logchannel", {}, env);
    assert.ok(
      lastReplyContent(interaction).includes("Provide a `channel`"),
      "guidance reply",
    );
    const settings = api.getGuildSettings(communityKey("lc-none"));
    assert.equal(settings.gork_log_channel_id, null, "nothing persisted");
  });

  it("replies with the specific cause when the channel can't be fetched", async () => {
    const env = makeEnv("lc-bad");
    const interaction = await runGork(
      "lc-bad",
      "logchannel",
      { channel: { id: "999999999999999999", name: "ghost", type: 0 } },
      env,
    );
    assert.ok(
      lastReplyContent(interaction).includes("can't find channel"),
      "specific failure reply (AGENTS.md: never a generic dead-end)",
    );
    const settings = api.getGuildSettings(communityKey("lc-bad"));
    assert.equal(settings.gork_log_channel_id, null, "invalid channel not persisted");
  });

  it("clear resets to the audit-log fallback", async () => {
    const env = makeEnv("lc-clear", { gorkChannel: true });
    const interaction = await runGork("lc-clear", "logchannel", { clear: true }, env);
    const settings = api.getGuildSettings(communityKey("lc-clear"));
    assert.equal(settings.gork_log_channel_id, null);
    assert.ok(
      lastReplyContent(interaction).toLowerCase().includes("audit log"),
      "reply explains the fallback",
    );
  });

  it("/gork status shows the Q&A log channel (fallback label when unset)", async () => {
    const env = makeEnv("lc-status");
    const fieldOf = (interaction, name) =>
      (embedFields(interaction).find((f) => f.name === name) || {}).value;

    let interaction = await runGork("lc-status", "status", {}, env);
    assert.equal(fieldOf(interaction, "Q&A Log"), "audit log (fallback)");

    await runGork(
      "lc-status",
      "logchannel",
      { channel: { id: env.qaChannel.id, name: "gork-qa", type: 0 } },
      env,
    );
    interaction = await runGork("lc-status", "status", {}, env);
    assert.equal(fieldOf(interaction, "Q&A Log"), `<#${env.qaChannel.id}>`);
  });
});

// ---------- routing: Q&A / failure stream ----------

describe("gork Q&A audit routing — dedicated channel + audit fallback", () => {
  it("Q&A embed posts to the gork channel when gork_log_channel_id is set", async () => {
    const env = makeEnv("rt-qa", { gorkChannel: true });
    await audit.logGorkQa(env.client, "rt-qa", {
      user: { id: "u1", username: "asker" },
      question: "why is the sky blue",
      answer: "scattering",
      model: "test-model",
      durationMs: 10,
    });
    assert.equal(env.qaChannel.sent.length, 1, "embed lands in the Q&A channel");
    assert.equal(embedTitle(sentEmbeds(env.qaChannel)[0]), "Gork Q&A");
    assert.equal(env.auditChannel.sent.length, 0, "audit channel stays clean");
  });

  it("Q&A embed falls back to the audit channel when unset", async () => {
    const env = makeEnv("rt-fb");
    await audit.logGorkQa(env.client, "rt-fb", {
      user: { id: "u1", username: "asker" },
      question: "hello there",
      answer: "hi",
    });
    assert.equal(env.auditChannel.sent.length, 1, "fallback to the audit channel");
    assert.equal(embedTitle(sentEmbeds(env.auditChannel)[0]), "Gork Q&A");
  });

  it("failure one-liner follows the same dedicated-then-fallback order", async () => {
    const set = makeEnv("rt-fail-set", { gorkChannel: true });
    await audit.logGorkFailure(set.client, "rt-fail-set", {
      user: { id: "u1", username: "asker" },
      question: "boom?",
      reason: "provider timeout",
    });
    assert.equal(set.qaChannel.sent.length, 1, "dedicated channel wins when set");
    assert.equal(set.auditChannel.sent.length, 0);

    const fb = makeEnv("rt-fail-fb");
    await audit.logGorkFailure(fb.client, "rt-fail-fb", {
      user: { id: "u1", username: "asker" },
      question: "boom?",
      reason: "provider timeout",
    });
    assert.equal(fb.auditChannel.sent.length, 1, "falls back to the audit channel");
  });

  it("no channel at all → console one-liner, never a crash", async () => {
    const env = makeBareEnv("rt-console");
    const lines = await captureConsoleLogAsync(() =>
      audit.logGorkQa(env.client, "rt-console", {
        user: { id: "u1", username: "asker" },
        question: "hello there",
        answer: "hi",
      }),
    );
    assert.ok(
      lines.some((l) => l.includes("[gork] Q&A (no audit channel)") && l.includes("hello there")),
      "degrades to the console one-liner",
    );
  });

  it("memory + summarize entries stay in the audit channel even with a Q&A channel set (scope pin)", async () => {
    const env = makeEnv("rt-scope", { gorkChannel: true });
    await audit.logGorkMemory(env.client, "rt-scope", {
      stored: 2,
      skippedInvalid: 0,
      indexed: 3,
    });
    await audit.logGorkSummarize(env.client, "rt-scope", {
      user: { id: "u1", username: "staff" },
      mode: "last",
      lastCount: 50,
      channelLabel: "#general",
      messageCount: 50,
      model: "test-model",
      durationMs: 100,
      rundown: "**Headline** — talk",
    });
    const titles = sentEmbeds(env.auditChannel).map(embedTitle);
    assert.ok(titles.includes("Gork memory"), "memory entry stays in the audit channel");
    assert.ok(
      titles.includes("Gork summarize"),
      "summarize entry stays in the audit channel",
    );
    assert.equal(env.qaChannel.sent.length, 0, "Q&A channel only carries Q&A embeds");
  });
});
