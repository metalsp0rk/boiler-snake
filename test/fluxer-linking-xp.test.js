/**
 * XP mirror fan-out integration (roadmap/account-linking.md T4).
 *
 * Full-stack offline (real SQLite via loadDb, fake Fluxer transport via
 * test/helpers/fluxer): a bridge-paired Discord↔Fluxer community pair with a
 * linked user pair, then real awardXp calls through the pipeline seam.
 * Pinned contracts (subtask account-linking-04):
 *  - award on Discord mirrors to the linked Fluxer row at the configured pct
 *  - pct 0 → no mirror row (no-op, not an error)
 *  - NO recursion: a Fluxer-side award mirrors to Discord exactly ONCE; the
 *    mirror-issued award (fanOut:false loop guard) never re-fans back
 *  - negative deltas mirror negative (sign-preserving rounding: 50% of 5 = 3,
 *    50% of -5 = -3)
 *  - missing target client → specific warning surfaces via linkMirror,
 *    the primary award is unaffected and nothing throws
 *  - fanOut:false short-circuits the fan-out leg entirely
 *  - mirror role math runs on the TARGET community through the TARGET's
 *    OutboundClient, gated by the target community's K8 elevated_permissions
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");
const { api, cleanup } = loadDb();

const { awardXp } = require("../src/services/awardXp");
const service = require("../src/features/linking/service");
const users = require("../src/db/repositories/users");
const { makeFakeRest, makeFakeHandle } = require("./helpers/fluxer");

after(cleanup);

const FX_INSTANCE = "https://fluxer-linking.test";
const DC_GUILD = "1700000000000000001";
const FX_GUILD = "990000000000000001";
const DISC_USER = "disc-xp-1";
const FX_USER = "sub-xp-1";
const LEVEL_ROLE = "role-lvl-1";

/** @type {number} */ let dcId;
/** @type {number} */ let fxId;
let fxRest;
let fxOutbound;
let dcOutbound;
let supervisor;

/**
 * Minimal Discord OutboundClient double: awardXp only needs platform +
 * fetchMember, and addRole/removeRole calls are recorded so the tests can
 * prove the MIRROR never runs role ops on the SOURCE outbound.
 */
function makeFakeDiscordOutbound() {
  const roleCalls = [];
  return {
    platform: "discord",
    roleCalls,
    async fetchMember(communityId, userId) {
      return { id: String(userId), username: "disc-xp-1", bot: false, roleIds: [] };
    },
    async addRole(communityId, userId, roleId) {
      roleCalls.push({ communityId, userId, roleId });
      return { ok: true };
    },
    async removeRole(communityId, userId, roleId) {
      roleCalls.push({ communityId, userId, roleId });
      return { ok: true };
    },
  };
}

describe("linking XP fan-out (account-linking T4)", () => {
  before(async () => {
    dcId = communityKey(DC_GUILD);
    fxId = communityKey(FX_GUILD, "fluxer", FX_INSTANCE);

    // Links live between BRIDGE-PAIRED communities only (locked decision 3):
    // activate a bridge the way the repo state machine records it.
    const bridge = api.createBridge({
      publicId: api.generateBridgeHandle(),
      createdByUserId: "u-mint",
      endACommunityId: dcId,
      endAChannelId: "chan-a",
    });
    api.addBridgeEnd({ bridgeId: bridge.id, position: "b", communityId: fxId, channelId: "chan-b" });
    api.db.prepare(`UPDATE bridges SET state = 'active' WHERE id = ?`).run(bridge.id);

    // The link: Discord side is `a`, Fluxer side is `b` (canonical orientation).
    const minted = await service.createLinkCode(dcId, DISC_USER);
    assert.equal(minted.ok, true, minted.error || "");
    const made = await service.redeemLinkCode(fxId, FX_USER, minted.code);
    assert.equal(made.ok, true, made.error || "");
    assert.equal(made.link.mirror_a_to_b_pct, 100, "default mirror rate is 100%");

    // Level math + role mapping on the TARGET (Fluxer) community.
    api.updateGuildSettings(fxId, { level_xp_factor: 100 });
    api.upsertLevelRole(fxId, LEVEL_ROLE, 1, 0);

    // Target transport: member fetch + role PUT routes for the mirror leg.
    fxRest = makeFakeRest({
      routes: {
        [`GET /v1/guilds/${FX_GUILD}/members/${FX_USER}`]: {
          id: "77",
          user: { id: FX_USER, username: "fx-user", bot: false },
          roles: [],
        },
        [`PUT /v1/guilds/${FX_GUILD}/members/${FX_USER}/roles/${LEVEL_ROLE}`]: {},
      },
    });
    const fxHandle = makeFakeHandle({ instanceKey: FX_INSTANCE, rest: fxRest });
    fxOutbound = fxHandle.outbound;

    dcOutbound = makeFakeDiscordOutbound();

    // Boot-equivalent: features/linking/index.js start() does exactly this.
    supervisor = {
      clientForCommunity: (id) => (id === dcId ? dcOutbound : id === fxId ? fxOutbound : null),
    };
    service.attachSupervisor(supervisor);
  });

  it("award on Discord mirrors to the linked Fluxer row at 100% by default", async () => {
    const fxBefore = users.getXp(fxId, FX_USER);
    const result = await awardXp(dcOutbound, {
      communityId: dcId,
      externalGuildId: DC_GUILD,
      userId: DISC_USER,
      delta: 20,
      activityKind: "message",
    });

    assert.equal(result.newXp, 20, "primary award lands on the Discord row");
    assert.deepEqual(
      result.linkMirror,
      { awarded: 20, warnings: [] },
      "additive linkMirror field reports the mirror",
    );
    assert.equal(users.getXp(fxId, FX_USER), fxBefore + 20, "Fluxer row mirrors the award");
  });

  it("pct 0 is a no-op mirror: primary award lands, no mirror row", async () => {
    assert.equal(api.setUserLinkMirrorPct(dcId, DISC_USER, "a_to_b", 0).ok, true);

    const fxBefore = users.getXp(fxId, FX_USER);
    const dcBefore = users.getXp(dcId, DISC_USER);
    const result = await awardXp(dcOutbound, {
      communityId: dcId,
      externalGuildId: DC_GUILD,
      userId: DISC_USER,
      delta: 30,
      activityKind: "message",
    });

    assert.equal(result.newXp, dcBefore + 30, "primary award unaffected by the off direction");
    assert.equal(result.linkMirror.awarded, null, "0% direction mirrors nothing");
    assert.deepEqual(result.linkMirror.warnings, [], "a configured 0% is not a failure");
    assert.equal(users.getXp(fxId, FX_USER), fxBefore, "no mirror row written");

    // Next tests run the a→b direction at 50%.
    assert.equal(api.setUserLinkMirrorPct(dcId, DISC_USER, "a_to_b", 50).ok, true);
  });

  it("mirrors sign-preserving rounding: 50% of 5 is 3, 50% of -5 is -3", async () => {
    // Seed the target row so a negative mirror cannot clamp at zero.
    users.addXp(fxId, FX_USER, 50);
    const fxSeeded = users.getXp(fxId, FX_USER);
    const dcBefore = users.getXp(dcId, DISC_USER);

    const up = await awardXp(dcOutbound, {
      communityId: dcId,
      externalGuildId: DC_GUILD,
      userId: DISC_USER,
      delta: 5,
      activityKind: "message",
    });
    assert.equal(up.linkMirror.awarded, 3, "Math.round(5*50/100) = 3");
    assert.equal(users.getXp(fxId, FX_USER), fxSeeded + 3);

    const down = await awardXp(dcOutbound, {
      communityId: dcId,
      externalGuildId: DC_GUILD,
      userId: DISC_USER,
      delta: -5,
      activityKind: "admin_grant",
    });
    assert.equal(down.newXp, dcBefore, "primary -5 lands on the Discord row");
    assert.equal(down.linkMirror.awarded, -3, "sign preserved: -round(5*50/100) = -3");
    assert.equal(
      users.getXp(fxId, FX_USER),
      fxSeeded,
      "negative delta mirrors NEGATIVE on the target row (decay-safe)",
    );
  });

  it("loop guard: a Fluxer-side award mirrors to Discord ONCE and never re-fans", async () => {
    // b→a at 50%, a→b back at 100%: a recursive mirror-of-a-mirror would
    // add a second +5 to the FLUXER row. fanOut:false on the mirror call
    // (the loop guard) must make that impossible.
    assert.equal(api.setUserLinkMirrorPct(dcId, DISC_USER, "b_to_a", 50).ok, true);
    assert.equal(api.setUserLinkMirrorPct(dcId, DISC_USER, "a_to_b", 100).ok, true);

    const dcBefore = users.getXp(dcId, DISC_USER);
    const fxBefore = users.getXp(fxId, FX_USER);

    const result = await awardXp(fxOutbound, {
      communityId: fxId,
      externalGuildId: FX_GUILD,
      userId: FX_USER,
      delta: 10,
      activityKind: "message",
    });

    assert.equal(result.newXp, fxBefore + 10, "primary award lands on the Fluxer row");
    assert.equal(result.linkMirror.awarded, 5, "b→a mirrors 10 at 50%");
    assert.equal(users.getXp(dcId, DISC_USER), dcBefore + 5, "Discord row moved exactly once");
    assert.equal(
      users.getXp(fxId, FX_USER),
      fxBefore + 10,
      "NO mirror-of-mirror: the a→b 100% direction never fires on the mirror award",
    );
  });

  it("missing target client surfaces a specific warning; primary award unaffected", async () => {
    // Simulate a dead handle for the target community.
    service.attachSupervisor({
      clientForCommunity: (id) => (id === dcId ? dcOutbound : null),
    });
    try {
      const fxBefore = users.getXp(fxId, FX_USER);
      const dcBefore = users.getXp(dcId, DISC_USER);

      const result = await awardXp(dcOutbound, {
        communityId: dcId,
        externalGuildId: DC_GUILD,
        userId: DISC_USER,
        delta: 12,
        activityKind: "message",
      });

      assert.equal(result.newXp, dcBefore + 12, "primary award never depends on the mirror");
      assert.equal(result.linkMirror.awarded, null, "nothing mirrored without a client");
      assert.equal(result.linkMirror.warnings.length, 1, "the warning surfaces in the result");
      assert.match(
        result.linkMirror.warnings[0],
        new RegExp(`no client for target community ${fxId}`),
        "warning names the missing target community",
      );
      assert.equal(users.getXp(fxId, FX_USER), fxBefore, "target row untouched");
    } finally {
      service.attachSupervisor(supervisor);
    }
  });

  it("fanOut:false short-circuits the fan-out leg entirely", async () => {
    const fxBefore = users.getXp(fxId, FX_USER);
    const dcBefore = users.getXp(dcId, DISC_USER);

    const result = await awardXp(
      dcOutbound,
      {
        communityId: dcId,
        externalGuildId: DC_GUILD,
        userId: DISC_USER,
        delta: 40,
        activityKind: "message",
        fanOut: false,
      },
    );

    assert.equal(result.newXp, dcBefore + 40, "primary award unaffected");
    assert.equal(result.linkMirror, undefined, "non-fanning calls carry no linkMirror field");
    assert.equal(users.getXp(fxId, FX_USER), fxBefore, "no mirror award attempted");
  });

  it("mirror role math runs on the TARGET community through the target outbound (K8 gate)", async () => {
    // K8 flag 0 (Phase 0 default for Fluxer rows): awardXp's Fluxer branch
    // skips role sync — the mirror must touch NOTHING on the target transport.
    const dcBefore = users.getXp(dcId, DISC_USER);
    const fxBefore = users.getXp(fxId, FX_USER);
    assert.equal(
      Number(api.db.prepare("SELECT elevated_permissions FROM communities WHERE id = ?").get(fxId).elevated_permissions),
      0,
      "Fluxer communities default to elevated_permissions=0",
    );

    await awardXp(dcOutbound, {
      communityId: dcId,
      externalGuildId: DC_GUILD,
      userId: DISC_USER,
      delta: 200,
      activityKind: "message",
    });
    assert.equal(users.getXp(fxId, FX_USER), fxBefore + 200, "mirror XP lands at K8 flag 0");
    assert.equal(
      fxRest.calls.filter((c) => c.path.includes(`/members/${FX_USER}`)).length,
      0,
      "K8 flag 0 skips member fetch on the target transport",
    );

    // K8 flag 1: the level leg runs — THROUGH THE TARGET (Fluxer) OUTBOUND.
    api.db.prepare("UPDATE communities SET elevated_permissions = 1 WHERE id = ?").run(fxId);
    const fxMid = users.getXp(fxId, FX_USER);

    const result = await awardXp(dcOutbound, {
      communityId: dcId,
      externalGuildId: DC_GUILD,
      userId: DISC_USER,
      delta: 200,
      activityKind: "message",
    });

    assert.equal(result.newXp, dcBefore + 200 + 200, "primary awards unaffected by the mirror leg");
    assert.equal(result.linkMirror.awarded, 200);
    assert.deepEqual(result.linkMirror.warnings, [], "clean mirror reports no warnings");
    assert.equal(users.getXp(fxId, FX_USER), fxMid + 200, "target XP total includes both mirrors");

    const memberGet = fxRest.calls.find(
      (c) => c.method === "GET" && c.path === `/v1/guilds/${FX_GUILD}/members/${FX_USER}`,
    );
    assert.ok(memberGet, "mirror fetched the member via the TARGET outbound (member:null)");

    const rolePut = fxRest.calls.find(
      (c) => c.method === "PUT" && c.path === `/v1/guilds/${FX_GUILD}/members/${FX_USER}/roles/${LEVEL_ROLE}`,
    );
    assert.ok(rolePut, "level role granted on the TARGET community via the TARGET outbound");
    assert.equal(dcOutbound.roleCalls.length, 0, "role ops never ride the source outbound");
  });

  it("a throwing target award degrades to a warning, never into the caller", async () => {
    // Hostile/broken target OutboundClient: fetchMember rejects. awardXp
    // (the mirror leg) lets a rejecting transport throw; fanOutLinkedXp
    // must catch it and report a specific warning — the award pipeline
    // (pipelines.js / command handlers) can never receive the throw.
    service.attachSupervisor({
      clientForCommunity: (id) =>
        id === dcId
          ? dcOutbound
          : {
              platform: "fluxer",
              async fetchMember() {
                throw new Error("target transport down");
              },
            },
    });
    try {
      const fxBefore = users.getXp(fxId, FX_USER);
      const dcBefore = users.getXp(dcId, DISC_USER);

      const result = await awardXp(dcOutbound, {
        communityId: dcId,
        externalGuildId: DC_GUILD,
        userId: DISC_USER,
        delta: 14,
        activityKind: "message",
      });

      assert.equal(result.newXp, dcBefore + 14, "primary award lands despite the broken mirror");
      // awardXp semantics (see integration "still stores XP when member fetch
      // fails"): the XP row is written BEFORE the member/role leg, so the
      // mirror's XP lands and the transport failure surfaces as a warning
      // with awarded: null — a partial failure, never a throw.
      assert.equal(users.getXp(fxId, FX_USER), fxBefore + 14, "mirror XP lands before the role leg");
      assert.equal(result.linkMirror.awarded, null, "failed mirror leg reports no award");
      assert.equal(result.linkMirror.warnings.length, 1, "one specific warning surfaced");
      assert.match(
        result.linkMirror.warnings[0],
        new RegExp(
          `mirror award of 14 XP to community ${fxId} user ${FX_USER} failed: target transport down`,
        ),
        "warning names target ids and the specific cause",
      );
    } finally {
      service.attachSupervisor(supervisor);
    }
  });
});

// ---------------------------------------------------------------------------
// Leaderboard/levels spot-check (subtask account-linking-06): a linked user
// with mirrored XP must surface in BOTH communities' topUsers with the
// configured pct applied to the mirror side's total (acceptance criterion 3:
// "leaderboard shows linked user in both communities").
// ---------------------------------------------------------------------------
describe("linked accounts land on BOTH communities' leaderboards (account-linking-06)", () => {
  const DISC_USER2 = "disc-xp-2";
  const FX_USER2 = "sub-xp-2";
  const FX_GHOST = "sub-xp-ghost"; // unlinked local: proves the mirror ranks on the board

  before(async () => {
    // State inherited from the describe above: the dcId↔fxId bridge is ACTIVE,
    // dcOutbound/fxOutbound exist, and service.attachSupervisor(supervisor) is
    // restored. Second linked pair, minted/redeemed through the service seam.
    const minted = await service.createLinkCode(dcId, DISC_USER2);
    assert.equal(minted.ok, true, minted.error || "mint must succeed");
    const made = await service.redeemLinkCode(fxId, FX_USER2, minted.code);
    assert.equal(made.ok, true, made.error || "redeem must succeed");
    // Configured direction: Discord → Fluxer at 40% (a visible pct difference).
    assert.equal(api.setUserLinkMirrorPct(dcId, DISC_USER2, "a_to_b", 40).ok, true);
  });

  it("awardXp on the Discord side lands in topUsers of both communities at the configured pct", async () => {
    // Seed totals so ranking is meaningful: the mirror side starts at 20 XP.
    users.addXp(dcId, DISC_USER2, 250);
    users.addXp(fxId, FX_USER2, 20);
    users.addXp(fxId, FX_GHOST, 20);

    const result = await awardXp(dcOutbound, {
      communityId: dcId,
      externalGuildId: DC_GUILD,
      userId: DISC_USER2,
      delta: 100,
      activityKind: "message",
    });

    assert.equal(result.newXp, 350, "primary award lands on the Discord row (250 + 100)");
    assert.deepEqual(
      result.linkMirror,
      { awarded: 40, warnings: [] },
      "a_to_b=40% mirrors 100 XP as 40 XP",
    );

    const dcBoard = users.topUsers(dcId, 20);
    const fxBoard = users.topUsers(fxId, 20);
    const dcRow = dcBoard.find((r) => r.user_id === DISC_USER2);
    const fxRow = fxBoard.find((r) => r.user_id === FX_USER2);
    assert.ok(dcRow, "the linked user appears in the Discord leaderboard");
    assert.ok(fxRow, "the mirrored row ranks on the Fluxer leaderboard too");

    // /xp-style reads: each board entry equals the users-repo total exactly.
    assert.equal(dcRow.xp, users.getXp(dcId, DISC_USER2), "board entry matches the /xp source");
    assert.equal(fxRow.xp, users.getXp(fxId, FX_USER2), "board entry matches the /xp source");
    assert.equal(dcRow.xp, 350, "Discord total: 250 seed + 100 award");
    assert.equal(
      fxRow.xp,
      20 + Math.round((100 * 40) / 100),
      "mirror-side total is pct-adjusted: 20 seed + 40 mirrored (not 20 + 100)",
    );

    // Ranking: the 40% mirror (total 60) outscores the unlinked 20-XP local.
    const ghostRow = fxBoard.find((r) => r.user_id === FX_GHOST);
    assert.ok(ghostRow, "fixture rival row exists on the Fluxer board");
    assert.ok(
      fxBoard.indexOf(fxRow) < fxBoard.indexOf(ghostRow),
      "mirrored XP moves the linked user up the target leaderboard",
    );
    for (const board of [dcBoard, fxBoard]) {
      const xps = board.map((r) => r.xp);
      assert.deepEqual(
        xps,
        [...xps].sort((a, b) => b - a),
        "topUsers stays ordered by xp desc",
      );
    }
  });
});
