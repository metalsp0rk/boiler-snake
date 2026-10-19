/**
 * #469 (F2-5): bot traffic no longer blinds the honeypot.
 *
 * Pre-fix the pipeline's bot-author gate ran BEFORE the trap, so a bot
 * posting into a honeypot channel was silently NOTHING — no delete, no
 * ban, no log — and a bot-built raid could litter the trap permanently.
 * Now: an outside bot's post is deleted + recorded in the admin audit
 * (`honeypot.bot_post`); our OWN trap warnings still pass untouched (the
 * loop guard); no ban is issued (the human ban flow DMs a person — the
 * audit row gives staff the evidence to ban deliberately).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const { IDS } = require("../helpers/fixtures");

describe("integration: honeypot vs bot traffic (#469 F2-5)", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let hp;

  after(() => env?.cleanup());

  before(async () => {
    env = await createIntegrationEnv();
    hp = require("../../src/features/honeypot");
    env.db.addHoneypotChannel(env.communityId, IDS.channelHoneypot);
  });

  const botUser = (id) => env.createUser({ id, username: "raidbot", bot: true });

  it("an outside bot posting into the trap is DELETED and AUDITED, not banned", async () => {
    const bot = botUser("bot-raid-1");
    const message = env.createMessage({
      guild: env.guild,
      channel: env.channels.honeypot,
      author: bot,
      member: null,
      content: "JOIN MY DISCORD GIFT",
    });
    env.guild._bans.length = 0;

    await env.onMessageCreate(message);

    assert.ok(message._wasDeleted(), "the trap deletes bot litter (pre-fix: silence)");
    assert.equal(env.guild._bans.length, 0, "no ban: the human flow DMs a person");

    const audit = env.db
      .listAdminAudit(env.communityId, { limit: 100 })
      .find((r) => r.action === "honeypot.bot_post");
    assert.ok(audit, "the audit row exists — staff can see and act");
    assert.equal(audit.target_id ?? audit.targetId, bot.id);
  });

  it("a bot post OUTSIDE a honeypot channel stays invisible (old shape)", async () => {
    const message = env.createMessage({
      guild: env.guild,
      channel: env.channels.general,
      author: botUser("bot-quiet"),
      member: null,
      content: "normal bot chatter",
    });
    await env.onMessageCreate(message);
    assert.ok(!message._wasDeleted(), "nothing outside the trap changes");
  });

  describe("handleHoneypotBotMessage — the loop guard", () => {
    it("our OWN post (the trap warning) is never touched", async () => {
      const message = env.createMessage({
        guild: env.guild,
        channel: env.channels.honeypot,
        author: env.client.user,
        member: null,
        content: "Do not post here",
      });
      const hit = await hp.handleHoneypotBotMessage(message, {
        selfId: env.client.user.id,
      });
      assert.equal(hit, false, "self-authored = not traffic (no self-delete loop)");
      assert.ok(!message._wasDeleted(), "the warning message survives");
    });

    it("an unknown selfId degrades to the old invisible behaviour, never a wipe", async () => {
      const message = env.createMessage({
        guild: env.guild,
        channel: env.channels.honeypot,
        author: botUser("bot-maybe"),
        member: null,
        content: "am I ours?",
      });
      const hit = await hp.handleHoneypotBotMessage(message, { selfId: null });
      assert.equal(hit, false);
      assert.ok(!message._wasDeleted(), "without identity proof NOTHING is deleted");
    });

    it("non-honeypot channels return false without touching anything", async () => {
      const message = env.createMessage({
        guild: env.guild,
        channel: env.channels.general,
        author: botUser("bot-harmless"),
        member: null,
        content: "hello",
      });
      const hit = await hp.handleHoneypotBotMessage(message, {
        selfId: env.client.user.id,
      });
      assert.equal(hit, false);
      assert.ok(!message._wasDeleted());
    });
  });
});
