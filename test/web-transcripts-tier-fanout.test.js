/**
 * #898 (audit r4 F6): the /t archive index must fan its tier resolves out
 * CAPPED and CONCURRENT — the #466 C2-8 doctrine already proved on "/" but
 * /t kept the sequential, uncapped loop: a cold tier-cache (60 s TTL) made
 * the page pay one networked member-read after another per shared guild,
 * on the cheapest page for the plainest staff user.
 *
 * The stub resolver counts CONCURRENCY directly (peak overlapping calls)
 * rather than timing — deterministic: a sequential loop can never exceed 1.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");
const { cleanup } = loadDb(); // CONTRACT: temp DB before any src/ require
after(cleanup);

const {
  listStaffedGuilds,
  MAX_SCOPED_GUILDS,
} = require("../src/web/routes/transcripts");

const session = { id: "sess-fanout", userId: "42" };

function guildSet(n, { nullEvery = 0 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `9${String(1000 + i)}`.padEnd(19, "0"),
    communityId: nullEvery && (i + 1) % nullEvery === 0 ? null : 100 + i,
    name: `Guild ${i + 1}`,
    icon: null,
  }));
}

/** Stub guildAccess measuring peak concurrent resolve() calls. */
function stubAccess(guilds, decide) {
  const fan = { active: 0, peak: 0, calls: 0, resolved: [] };
  return {
    fan,
    async listGuilds() {
      return { reauth: false, guilds, degraded: false };
    },
    async resolve(_sess, communityId) {
      fan.calls += 1;
      fan.resolved.push(communityId);
      fan.active += 1;
      fan.peak = Math.max(fan.peak, fan.active);
      await new Promise((r) => setImmediate(r)); // the overlap window
      fan.active -= 1;
      return decide ? decide(communityId) : { status: "ok", tier: "admin" };
    },
  };
}

describe("#898: /t tier fan-out is concurrent and capped", () => {
  it("resolves independent guilds CONCURRENTLY (a sequential loop peaks at 1)", async () => {
    const access = stubAccess(guildSet(12));
    const out = await listStaffedGuilds(access, session);
    assert.equal(out.reauth, false);
    assert.equal(out.guilds.length, 12, "all staffed rows kept");
    assert.ok(
      access.fan.peak >= 2,
      `peak concurrent resolves was ${access.fan.peak} — the fan-out is sequential again`,
    );
    assert.equal(access.fan.peak, 12, "12 independent rows overlap fully");
  });

  it("caps the fan-out at MAX_SCOPED_GUILDS and keeps display ORDER", async () => {
    const many = guildSet(MAX_SCOPED_GUILDS + 20);
    const access = stubAccess(many);
    const out = await listStaffedGuilds(access, session);
    assert.equal(access.fan.calls, MAX_SCOPED_GUILDS, "at most the cap is resolved");
    assert.equal(out.guilds.length, MAX_SCOPED_GUILDS);
    assert.deepEqual(
      out.guilds.map((g) => g.communityId),
      many.slice(0, MAX_SCOPED_GUILDS).map((g) => g.communityId),
      "the scoped set is the LIST ORDER prefix, order preserved",
    );
  });

  it("rows without a communities id deny WITHOUT a resolve call; non-staff drop out", async () => {
    // 9 rows, every 3rd has communityId null → 6 resolves; of those, only
    // even ids answer ok.
    const access = stubAccess(guildSet(9, { nullEvery: 3 }), (cid) =>
      cid % 2 === 0 ? { status: "ok", tier: "mod" } : { status: "deny" },
    );
    const out = await listStaffedGuilds(access, session);
    assert.equal(access.fan.calls, 6, "the 3 community-less rows never touched the resolver");
    assert.deepEqual(out.communityIds, [100, 104, 106], "staffed-only, list order kept");
  });

  it("ANY re-auth answer aborts the whole scope to re-auth", async () => {
    const access = stubAccess(guildSet(6), (cid) =>
      cid === 103 ? { status: "reauth" } : { status: "ok", tier: "admin" },
    );
    const out = await listStaffedGuilds(access, session);
    assert.equal(out.reauth, true, "a revoked token mid-list still fails the whole page to login");
    assert.deepEqual(out.guilds, []);
  });

  it("resolver failures keep failing CLOSED to an empty scope", async () => {
    const access = {
      async listGuilds() {
        return { reauth: false, guilds: guildSet(3), degraded: false };
      },
      async resolve() {
        throw new Error("token expired hard");
      },
    };
    const out = await listStaffedGuilds(access, session);
    assert.equal(out.reauth, false);
    assert.deepEqual(out.guilds, [], "a thrown resolver never widens the scope");
  });
});
