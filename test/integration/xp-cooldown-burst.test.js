const { describe, it, after, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");

/**
 * #894 (audit r4 F2): the message/reaction XP paths gate on the cooldown,
 * await the award, and used to STAMP only after it resolved. The pipeline
 * runs one unit per event CONCURRENTLY (fire-and-forget per message), so
 * every message in a burst from one author cleared the gate while the first
 * award was still in flight — the configured cooldown did not bind under
 * rapid-fire spam (the live repro awarded +10 inside a 60 s window).
 *
 * The shipped suite drove emitMessage strictly sequentially (the harness
 * awaits the whole pipeline), which is why nothing caught it.
 */
describe("integration: burst messages respect the message cooldown (#894)", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  before(async () => {
    env = await createIntegrationEnv();
    env.db.updateGuildSettings(env.communityId, {
      msg_xp: 5,
      msg_cooldown_sec: 60, // one award per minute, per user
    });
  });

  after(() => env?.cleanup());

  it("sequential messages are gated (control)", async () => {
    const u = env.createUser({ id: "cd-seq", username: "seq" });
    env.createMember({ guild: env.guild, user: u });
    const beforeXp = env.db.getXp(env.communityId, u.id) ?? 0;
    await env.emitMessage({ author: u }); // awards +5, stamps
    await env.emitMessage({ author: u }); // inside the window → must skip
    const gained = (env.db.getXp(env.communityId, u.id) ?? 0) - beforeXp;
    assert.equal(gained, 5, "exactly one award inside the 60 s window");
  });

  it("two CONCURRENT messages award exactly once (the reserve closes the race)", async () => {
    const u = env.createUser({ id: "cd-concurrent", username: "cc" });
    env.createMember({ guild: env.guild, user: u });
    const beforeXp = env.db.getXp(env.communityId, u.id) ?? 0;

    // Exactly what two gateway MESSAGE_CREATE events in one tick do: two
    // independent pipelines, nobody awaits the other.
    await Promise.all([
      env.emitMessage({ author: u, content: "one", id: "m-cd-1" }),
      env.emitMessage({ author: u, content: "two", id: "m-cd-2" }),
    ]);

    const gained = (env.db.getXp(env.communityId, u.id) ?? 0) - beforeXp;
    assert.equal(
      gained,
      5,
      `one award inside the window (pre-fix behavior awarded +${gained})`,
    );
  });
});
