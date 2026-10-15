const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { poll } = require("./helpers/mockenv");

const MSG_DENIED = "You don't have permission to use this.";

/**
 * Tier-4 XP & leaderboard coverage (issue #314). Namespace 5.
 *
 * Already covered elsewhere (not repeated here):
 *  - ns1 e2e-core: /xp self + USER option, /leaderboard empty state,
 *    MESSAGE_CREATE award + cooldown SUPPRESSION
 *  - ns3 e2e-gates: /grantxp denial (junior staff) + ManageGuild
 *    grant→revoke arc
 *  - ns23 e2e-mockgaps: reaction XP award + user cooldown via injected
 *    REACTION_ADD
 * This file: the /setxp settings surface, slash-origin audit rows,
 * non-member /xp rendering, and the cooldown-EXPIRY re-award (window
 * shortened through /setxp itself, so the slow test stays fast).
 */
describe("e2e: XP settings, audit & leaderboard", { concurrency: 1 }, () => {
  /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
  let env;

  const xpOf = (userId) =>
    env.dbmod.db
      .prepare("SELECT xp FROM users WHERE community_id = ? AND user_id = ?")
      .get(env.communityId, userId)?.xp ?? 0;

  before(async () => {
    env = await createE2eEnv({ ns: 5 });
    // human carries both tiers: staff_roles row (/setxp) and a role with
    // the ManageGuild bit (/grantxp) — aggregation per #311.
    const staffRole = await env.mock.createRole("E2E XP Staff");
    await env.mock.grantRole(env.ids.human, staffRole.id);
    env.dbmod.addStaffRole(env.communityId, String(staffRole.id), "junior");
    const adminRole = await env.mock.createRole("E2E XP Admin", {
      permissions: String(PermissionFlagsBits.ManageGuild),
    });
    await env.mock.grantRole(env.ids.human, adminRole.id);
  });

  after(async () => {
    await env?.cleanup();
  });

  it("/leaderboard clamps out-of-bounds limit/page into the empty state", async () => {
    const inter = await env.mock.slash({
      command: "leaderboard",
      options: [
        { name: "limit", type: 4, value: 999 },
        { name: "page", type: 4, value: 5 },
      ],
    });
    const reply = await env.mock.awaitReply(inter);
    assert.match(String(reply.content), /no leaderboard data/i);
  });

  it.todo("/leaderboard with seeded XP → PNG attachment reply + lb: prev/next buttons, click re-render + persisted edit — blocked on #312 (mock multipart interaction callbacks)");

  it.todo("Voice XP rules (AFK ignore, ≥2 eligible humans, muted/deafened) — blocked on #328 gap 6 (mock voice-state support)");

  it("/setxp persists each provided field and echoes the change (staff)", async () => {
    const inter = await env.mock.slash({
      command: "setxp",
      options: [
        { name: "message", type: 4, value: 25 },
        { name: "reaction", type: 4, value: 3 },
      ],
    });
    const reply = await env.mock.awaitReply(inter);
    assert.match(
      String(reply.embeds?.[0]?.title),
      /Updated XP settings/i,
      "echo embed returned",
    );
    const settings = env.dbmod.getGuildSettings(env.communityId);
    assert.equal(settings.msg_xp, 25);
    assert.equal(settings.reaction_xp, 3);
  });

  it("/setxp validation: over-cap and negative values reply specifically and change nothing", async () => {
    const tooBig = await env.mock.slash({
      command: "setxp",
      options: [{ name: "message", type: 4, value: 2_000_000_000 }],
    });
    assert.match(
      String((await env.mock.awaitReply(tooBig)).content),
      /XP value too large\. Maximum value per message is 1,000,000,000\./,
    );

    const negative = await env.mock.slash({
      command: "setxp",
      options: [{ name: "reaction", type: 4, value: -5 }],
    });
    assert.match(
      String((await env.mock.awaitReply(negative)).content),
      /Reaction XP must be a finite non-negative number\./,
    );

    const settings = env.dbmod.getGuildSettings(env.communityId);
    assert.equal(settings.msg_xp, 25, "rejected update changed nothing");
    assert.equal(settings.reaction_xp, 3, "rejected update changed nothing");
  });

  it("/setxp with no fields replies with guidance instead of a silent no-op", async () => {
    const inter = await env.mock.slash({ command: "setxp" });
    const reply = await env.mock.awaitReply(inter);
    assert.match(String(reply.content), /No XP settings provided/i);
  });

  it("/setxp denies a non-staff member", async () => {
    const inter = await env.mock.slash({
      command: "setxp",
      userId: env.ids.outsider,
      options: [{ name: "message", type: 4, value: 1 }],
    });
    assert.equal(String((await env.mock.awaitReply(inter)).content), MSG_DENIED);
  });

  it("/grantxp with a reason writes a slash-origin audit row with before/after details", async () => {
    const inter = await env.mock.slash({
      command: "grantxp",
      options: [
        { name: "user", type: 6, value: env.ids.target },
        { name: "amount", type: 4, value: 500 },
        { name: "reason", type: 3, value: "e2e audit proof" },
      ],
    });
    const reply = await env.mock.awaitReply(inter);
    assert.match(String(reply.content), /Granted \*\*500\*\* XP to \*\*E2ETarget\*\*/);
    assert.match(String(reply.content), /Reason: e2e audit proof/);
    assert.equal(xpOf(env.ids.target), 500, "DB total reflects the grant");

    const audit = env.dbmod.db
      .prepare(
        "SELECT * FROM admin_audit WHERE community_id = ? AND action = 'xp.grant' ORDER BY id DESC LIMIT 1",
      )
      .get(env.communityId);
    assert.ok(audit, "xp.grant audit row recorded");
    assert.equal(audit.origin, "slash", "slash-origin metadata on the audit row");
    assert.equal(audit.actor_user_id, env.ids.human);
    assert.equal(audit.target_id, env.ids.target);
    const details = JSON.parse(audit.details_json);
    assert.equal(details.amount, 500);
    assert.equal(details.before_xp, 0);
    assert.equal(details.after_xp, 500);
    assert.equal(details.reason, "e2e audit proof");
  });

  it("/xp renders a clean zero-state for a resolved user with no guild membership", async () => {
    // Ghost has a users row but never appeared in the guild (no member
    // row, no DB xp row) — resolution must not crash or leak an error.
    await env.mock.createUser("E2EGhost", env.ids.ghost);
    const inter = await env.mock.slash({
      command: "xp",
      options: [{ name: "user", type: 6, value: env.ids.ghost }],
    });
    const reply = await env.mock.awaitReply(inter);
    assert.match(String(reply.content), /\*\*E2EGhost\*\*: \*\*0 XP\*\* · Level \*\*0\*\*/);
  });

  it("message XP is awarded again once the cooldown window expires", async () => {
    // Shrink the window through the command surface itself (the same path
    // production uses), keeping this expiry proof fast.
    const set = await env.mock.slash({
      command: "setxp",
      options: [{ name: "msgcooldown", type: 4, value: 1 }],
    });
    await env.mock.awaitReply(set);

    await env.mock.inject("xp expiry msg 1", env.ids.human);
    await poll(() => (xpOf(env.ids.human) >= 25 ? xpOf(env.ids.human) : null), {
      label: "first message award (25 XP)",
    });
    assert.equal(xpOf(env.ids.human), 25);

    await env.mock.inject("xp expiry msg 2 (inside window)", env.ids.human);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(xpOf(env.ids.human), 25, "cooldown suppresses the second award");

    await new Promise((r) => setTimeout(r, 900));
    await env.mock.inject("xp expiry msg 3 (after window)", env.ids.human);
    await poll(() => (xpOf(env.ids.human) >= 50 ? xpOf(env.ids.human) : null), {
      label: "re-award after cooldown expiry",
    });
    assert.equal(xpOf(env.ids.human), 50, "one award per window, none lost");
  });
});
