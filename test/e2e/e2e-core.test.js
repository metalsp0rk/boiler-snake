const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { createE2eEnv } = require("./helpers/e2eEnv");

/**
 * Tier-4 E2E core: real bot booted against the fauxcord mock Discord
 * (real gateway handshake, real router, real SQLite). Regression mirror of
 * scripts/e2e/fauxcord-spike.js plus cooldown behavior over the live
 * MESSAGE_CREATE pipeline. Namespace 1.
 */
describe("e2e: core boot + slash + message pipeline", { concurrency: 1 }, () => {
  /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
  let env;

  before(async () => {
    env = await createE2eEnv({ ns: 1 });
  });

  after(async () => {
    await env?.cleanup();
  });

  it("hydrates guild AND channels from GUILD_CREATE (router prerequisites)", () => {
    const client = env.supervisor.discord;
    const guild = client.guilds.cache.get(env.ids.guild);
    assert.ok(guild, "guild cached from GUILD_CREATE");
    assert.ok(
      client.channels.cache.get(env.ids.general),
      "text channel cached from GUILD_CREATE channels",
    );
  });

  it("/xp self → ephemeral reply via router (interaction flags 64)", async () => {
    const inter = await env.mock.slash({ command: "xp" });
    const reply = await env.mock.awaitReply(inter);
    assert.match(String(reply.content), /E2EOperator/);
    assert.match(String(reply.content), /\*\*0 XP\*\*/);
    assert.equal(Number(reply.flags) & 64, 64, "reply is ephemeral");
  });

  it("/xp user=@target → USER-typed option resolves via data.resolved", async () => {
    const inter = await env.mock.slash({
      command: "xp",
      options: [{ name: "user", type: 6, value: env.ids.target }],
    });
    const reply = await env.mock.awaitReply(inter);
    assert.match(String(reply.content), /E2ETarget/);
  });

  it("/leaderboard with no data → empty-state reply (defer/edit surface)", async () => {
    const inter = await env.mock.slash({ command: "leaderboard" });
    const reply = await env.mock.awaitReply(inter);
    assert.match(String(reply.content), /no leaderboard data/i);
  });

  it("injected MESSAGE_CREATE → XP pipeline awards XP, cooldown gates the next message", async () => {
    const xpOf = (userId) =>
      env.dbmod.db
        .prepare(
          "SELECT xp FROM users WHERE community_id = ? AND user_id = ?",
        )
        .get(env.communityId, userId)?.xp ?? 0;

    assert.equal(xpOf(env.ids.human), 0, "starts at 0 XP");
    await env.mock.inject("e2e xp message 1", env.ids.human);

    const { poll } = require("./helpers/mockenv");
    await poll(
      () => (xpOf(env.ids.human) > 0 ? xpOf(env.ids.human) : null),
      { timeoutMs: 8000, label: "first XP award" },
    );
    const first = xpOf(env.ids.human);

    // Immediate second message: default 20s message cooldown must swallow it.
    await env.mock.inject("e2e xp message 2 (inside cooldown)", env.ids.human);
    await new Promise((r) => setTimeout(r, 750));
    assert.equal(xpOf(env.ids.human), first, "cooldown suppressed the second award");
  });

  it("unknown command name is rejected by the mock (404, never dispatched)", async () => {
    await assert.rejects(
      () => env.mock.slash({ command: "definitely-not-registered" }),
      (err) => err.status === 404,
    );
  });
});
