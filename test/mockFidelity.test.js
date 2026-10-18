/**
 * Offline-mock fidelity rules (#449, audit G2-4).
 *
 * The pre-#449 chat-input mock was an ALWAYS-OK world: `editReply` could
 * never throw, `channel.send` never failed, and a missing `messages.fetch(id)`
 * returned null while real discord.js REJECTS with 10008. That made the
 * #341/#354 class — a destructive step deletes THIS channel and the
 * confirmation reply dies with it — structurally uncatchable at tiers 1–3:
 * code that forgot gone-handling passed green offline and failed in
 * production. These pins lock the mock to discord.js's real contracts (same
 * error-code shape the button mock has always used) so the class CANNOT
 * silently return. If a rule here breaks, the mock — not the test — is wrong.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { cleanup } = loadDb();

const {
  createClient,
  createGuild,
  createUser,
  createMember,
  createTextChannel,
  createChatInputInteraction,
} = require("./helpers/discord");
const { IDS } = require("./helpers/fixtures");

after(cleanup);

function setup() {
  const client = createClient();
  const guild = createGuild({ id: IDS.guild });
  client.addGuild(guild);
  const user = createUser({ id: IDS.member, username: "member" });
  const member = createMember({ guild, user, admin: true });
  const channel = createTextChannel({ id: "chan-fidelity", guild });
  guild.channels.cache.set(channel.id, channel);
  const interaction = createChatInputInteraction({
    commandName: "ticket",
    subcommand: "archive",
    guild,
    user,
    member,
    client,
    channel,
    channelId: channel.id,
  });
  return { client, guild, user, member, channel, interaction };
}

async function rejection(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return null;
}

describe("chat-input ack lifecycle (#449)", () => {
  it("deferReply → editReply is the supported path and records content", async () => {
    const { interaction } = setup();
    await interaction.deferReply();
    await interaction.editReply({ content: "done" });
    assert.equal(interaction.deferred, true);
    const last = interaction.replies.at(-1);
    assert.equal(last.content, "done");
    assert.equal(last._edited, true);
  });

  it("editReply with NO ack rejects 40060 (real Discord)", async () => {
    const { interaction } = setup();
    const err = await rejection(() => interaction.editReply({ content: "too soon" }));
    assert.ok(err, "must throw — an unacknowledged interaction has no @original");
    assert.equal(Number(err.code), 40060);
  });

  it("deferReply twice rejects InteractionAlreadyReplied (button-mock shape)", async () => {
    const { interaction } = setup();
    await interaction.deferReply();
    const err = await rejection(() => interaction.deferReply());
    assert.ok(err);
    assert.equal(err.code, "InteractionAlreadyReplied");
  });

  it("reply after an ack rejects InteractionAlreadyReplied", async () => {
    const { interaction } = setup();
    await interaction.reply({ content: "one" });
    const err = await rejection(() => interaction.reply({ content: "two" }));
    assert.ok(err);
    assert.equal(err.code, "InteractionAlreadyReplied");
  });

  it("editReply AFTER this interaction's channel was deleted rejects 10008 — the #341 class", async () => {
    const { interaction, channel } = setup();
    await interaction.deferReply();
    await channel.delete("destructive step ran first");
    const err = await rejection(() =>
      interaction.editReply({ content: "confirmation nobody sees" }),
    );
    assert.ok(err, "the @original died with the channel — exactly production");
    assert.equal(Number(err.code), 10008);
  });

  it("followUp/reply on a deleted channel reject 10008 too", async () => {
    const { interaction, channel } = setup();
    await channel.delete("gone");
    assert.ok(await rejection(() => interaction.reply({ content: "x" })));
    const fu = await rejection(() => interaction.followUp({ content: "y" }));
    assert.equal(Number(fu?.code), 10008);
  });

  it("a DIFFERENT channel dying does not blind the interaction", async () => {
    const { interaction, guild } = setup();
    const other = createTextChannel({ id: "chan-other", guild });
    guild.channels.cache.set(other.id, other);
    await interaction.deferReply();
    await other.delete("collateral");
    await interaction.editReply({ content: "still here" }); // must NOT throw
    assert.equal(interaction.replies.at(-1).content, "still here");
  });
});

describe("channel-level transport fidelity (#449)", () => {
  it("send on a deleted channel rejects 10003 Unknown Channel", async () => {
    const { channel } = setup();
    await channel.delete("gone");
    const err = await rejection(() => channel.send({ content: "into the void" }));
    assert.ok(err);
    assert.equal(Number(err.code), 10003);
  });

  it("send failure queue seam (__failSends) rejects with the armed error, then recovers", async () => {
    const { channel } = setup();
    channel.__failSends = [
      Object.assign(new Error("Missing Permissions"), { code: 50013 }),
    ];
    const err = await rejection(() => channel.send({ content: "first" }));
    assert.equal(Number(err?.code), 50013, "armed failure fires");
    const msg = await channel.send({ content: "second" });
    assert.ok(msg, "queue drains — later sends succeed");
    assert.equal(channel.sent.length, 1, "only the surviving send recorded");
  });

  it("messages.fetch(missingId) REJECTS 10008 like real discord.js (no silent null)", async () => {
    const { channel } = setup();
    const err = await rejection(() => channel.messages.fetch("never-existed"));
    assert.ok(err, "real discord.js never resolves null for a missing id");
    assert.equal(Number(err.code), 10008);
  });

  it("messages.fetch(missingId) with .catch(()=>null) keeps the null-contract consumers intact", async () => {
    const { channel } = setup();
    const msg = await channel.messages.fetch("never-existed").catch(() => null);
    assert.equal(msg, null, "the documented consumer pattern still works");
  });

  it("existing ids resolve; the collection branch is untouched", async () => {
    const { channel } = setup();
    channel.addMessage({ id: "100", content: "one" });
    channel.addMessage({ id: "200", content: "two" });
    assert.equal((await channel.messages.fetch("100")).id, "100");
    const batch = await channel.messages.fetch({ limit: 50 });
    assert.equal(batch.size, 2, "bulk fetch still returns the collection");
  });
});
