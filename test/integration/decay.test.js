const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const { assertXp } = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

/**
 * PR 7 fake supervisor: ticker entry points take a supervisor and resolve the
 * OutboundClient per community via clientForCommunity (roadmap/fluxer.md §
 * Scheduler jobs). Discord-only in tests — fluxer rows resolve to null.
 */
function fakeSupervisor(client) {
  const { getDiscordOutbound } = require("../../src/platform/discord/outbound");
  return {
    discord: client,
    fluxer: new Map(),
    clientForCommunity: () => getDiscordOutbound(client),
  };
}

describe("integration: decay", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let runDecayForGuild;

  after(() => {
    // Close SQLite handles and remove the temp dir created for this env.
    env?.cleanup();
  });

  before(async () => {
    env = await createIntegrationEnv();
    runDecayForGuild = require("../../src/features/decay").runDecayForGuild;
  });

  it("no-ops when decay disabled", async () => {
    env.db.updateGuildSettings(env.communityId, {
      decay_enabled: 0,
      decay_percent: 0.5,
      decay_min_messages: 10,
      decay_window_days: 7,
    });
    env.db.setXp(env.communityId, IDS.member, 1000);
    await runDecayForGuild(fakeSupervisor(env.client), env.communityId);
    assertXp(env.db, env.communityId, IDS.member, 1000);
  });

  it("reduces XP for inactive users", async () => {
    env.db.updateGuildSettings(env.communityId, {
      decay_enabled: 1,
      decay_percent: 0.1,
      decay_min_messages: 5,
      decay_window_days: 7,
    });
    env.db.setXp(env.communityId, IDS.member, 1000);
    // no activity rows → count 0 < 5
    await runDecayForGuild(fakeSupervisor(env.client), env.communityId);
    assertXp(env.db, env.communityId, IDS.member, 900);
  });

  it("skips users who meet message threshold", async () => {
    env.db.updateGuildSettings(env.communityId, {
      decay_enabled: 1,
      decay_percent: 0.5,
      decay_min_messages: 3,
      decay_window_days: 7,
    });
    env.db.setXp(env.communityId, IDS.member2, 800);
    for (let i = 0; i < 3; i++) {
      env.db.logActivity(env.communityId, IDS.member2, "message", 1);
    }
    await runDecayForGuild(fakeSupervisor(env.client), env.communityId);
    assertXp(env.db, env.communityId, IDS.member2, 800);
  });

  /** All decay.xp_decay audit rows recorded for this community. */
  function decayAuditRows() {
    return env.db.db
      .prepare(
        `SELECT target_id, details_json FROM admin_audit
         WHERE community_id=? AND action='decay.xp_decay'`,
      )
      .all(env.communityId);
  }

  it("XP awarded mid-loop survives the decay tick (#191 / audit H10)", async () => {
    env.db.updateGuildSettings(env.communityId, {
      decay_enabled: 1,
      decay_percent: 0.1,
      decay_min_messages: 5,
      decay_window_days: 7,
    });
    env.db.setXp(env.communityId, IDS.member, 1000);
    env.db.setXp(env.communityId, IDS.member2, 1000);

    // Real unified award path; required AFTER loadDb (harness contract).
    const { awardXp } = require("../../src/services/awardXp");
    const { getDiscordOutbound } = require("../../src/platform/discord/outbound");

    let awarded = false;
    let awardedTo = null;
    const auditBefore = decayAuditRows().length;

    await runDecayForGuild(fakeSupervisor(env.client), env.communityId, {
      // Test seam: fires after the user enumeration, before the decayed
      // user's write — the exact window where the stale snapshot used to
      // clobber live XP.
      onBeforeDecay: async (u) => {
        if (awarded) return;
        awarded = true;
        awardedTo = u.user_id === IDS.member ? IDS.member2 : IDS.member;
        await awardXp(getDiscordOutbound(env.client), {
          communityId: env.communityId,
          userId: awardedTo,
          delta: 500,
          activityKind: "message",
        });
      },
    });

    // Awarded user: floor((1000 + 500) * 0.9) = 1350. The snapshot code
    // wrote floor(1000 * 0.9) = 900 and silently destroyed the award.
    assert.ok(awardedTo, "mid-loop award never ran");
    assertXp(env.db, env.communityId, awardedTo, 1350);
    assertXp(
      env.db,
      env.communityId,
      awardedTo === IDS.member ? IDS.member2 : IDS.member,
      900,
    );

    // Audit trail still records every decay delta — now from the LIVE value.
    const rows = decayAuditRows();
    assert.equal(rows.length, auditBefore + 2);
    const awardedRow = rows.find((r) => r.target_id === awardedTo);
    assert.ok(awardedRow, "no decay.xp_decay audit row for the awarded user");
    const details = JSON.parse(awardedRow.details_json);
    assert.equal(details.before_xp, 1500);
    assert.equal(details.after_xp, 1350);
  });

  it("one user's role-sync throw does not abort the tick (#198 decay leg)", async () => {
    env.db.updateGuildSettings(env.communityId, {
      decay_enabled: 1,
      decay_percent: 0.1,
      decay_min_messages: 5,
      decay_window_days: 7,
    });
    env.db.setXp(env.communityId, IDS.member, 1000);
    env.db.setXp(env.communityId, IDS.member2, 1000);

    // Poison the FIRST member fetch: a member object without `.guild`
    // passes the (caught) fetch, tolerates syncMemberRoles, then throws
    // inside the unguarded syncMemberReactionRoles call — the throw shape
    // that used to abort the whole community loop.
    const members = env.guild.members;
    const origFetch = members.fetch;
    let poisonedId = null;
    members.fetch = async (arg) => {
      if (!poisonedId && typeof arg === "string") {
        poisonedId = arg;
        return { id: arg };
      }
      return origFetch.call(members, arg);
    };

    const errors = [];
    const origErr = console.error;
    const origWarn = console.warn;
    console.error = (...args) => errors.push(args.map(String).join(" "));
    console.warn = () => {}; // [roles] role-sync warn — not under test here
    try {
      await runDecayForGuild(fakeSupervisor(env.client), env.communityId);
    } finally {
      console.error = origErr;
      console.warn = origWarn;
      members.fetch = origFetch;
    }

    // The throw happened mid-loop for the first-processed user…
    assert.ok(poisonedId, "member fetch never ran — poison path not exercised");
    // …was logged with BOTH ids and the specific cause…
    const lines = errors.filter((l) => l.includes("[decay]"));
    assert.equal(lines.length, 1, `expected one [decay] error, got: ${errors.join(" | ")}`);
    assert.ok(lines[0].includes(env.guildId), `guild id missing in: ${lines[0]}`);
    assert.ok(lines[0].includes(poisonedId), `user id missing in: ${lines[0]}`);
    assert.ok(
      lines[0].includes("Cannot read properties of undefined"),
      `cause missing in: ${lines[0]}`,
    );
    // …and BOTH users were still decayed: the failed user keeps its own
    // write, and the loop continued to the next user.
    assertXp(env.db, env.communityId, IDS.member, 900);
    assertXp(env.db, env.communityId, IDS.member2, 900);
  });

  it("zero XP and pct 0 are no-ops with no audit rows", async () => {
    env.db.updateGuildSettings(env.communityId, {
      decay_enabled: 1,
      decay_percent: 0.5,
      decay_min_messages: 5,
      decay_window_days: 7,
    });
    env.db.setXp(env.communityId, IDS.member, 0);
    env.db.setXp(env.communityId, IDS.member2, 0);

    const auditBefore = decayAuditRows().length;
    await runDecayForGuild(fakeSupervisor(env.client), env.communityId);
    assertXp(env.db, env.communityId, IDS.member, 0);
    assertXp(env.db, env.communityId, IDS.member2, 0);
    assert.equal(decayAuditRows().length, auditBefore);

    // pct 0 (e.g. season paused): rows untouched even with XP on them.
    env.db.updateGuildSettings(env.communityId, { decay_percent: 0 });
    env.db.setXp(env.communityId, IDS.member, 1000);
    await runDecayForGuild(fakeSupervisor(env.client), env.communityId);
    assertXp(env.db, env.communityId, IDS.member, 1000);
    assert.equal(decayAuditRows().length, auditBefore);
  });
});
