/**
 * #466 (C1-11): the Fluxer access list intersects with BOT liveness.
 *
 * Pre-fix, `getFluxerAccessGuilds` was user-list ∩ LOGIN-TIME SNAPSHOT and
 * nothing else (its own comment argued instance-scoping made a live check
 * unnecessary — instance-scoped ≠ bot-still-present). After the bot LEFT a
 * community, staff viewers degraded to deny (their member fetch fails) but
 * a snapshot `owner:true` viewer kept `tier:"admin"` — the switcher listed
 * a community whose every action endpoint 404s, until the token died.
 *
 * Now every access-list rebuild prunes entries whose bot-presence probe is
 * REFUSED (403/404 on the guild GET, answered by the bot's own outbound —
 * the credential the mutations would use), while a probe that could not be
 * answered ("unknown") keeps the community (bounded by the next TTL), and
 * an unwired client seam keeps the pre-fix shape exactly.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");

process.env.SESSION_SECRET = "test-c111-fake-secret";

const { api, cleanup } = loadDb(); // CONTRACT: temp DB before any src/ require

const { createGuildAccessResolver } = require("../src/web/auth/guildAccess");
const sessionPolicy = require("../src/web/auth/sessions");
const tokens = require("../src/web/auth/tokens");
const { makeFakeRest, makeFakeHandle, FluxerRestError } = require("./helpers/fluxer");

after(cleanup);

const FX = "c111-instance";
const GUILD_A = "910000000000000001"; // bot still present
const GUILD_B = "910000000000000002"; // bot has LEFT (probe refuses)
const GUILD_C = "910000000000000003"; // snapshot noise with NO communities row

let CID_A;
let CID_B;

describe("#466 (C1-11): probeGuildPresence — present / absent / unknown, honestly", () => {
  before(() => {
    CID_A = communityKey(GUILD_A, "fluxer", FX);
    CID_B = communityKey(GUILD_B, "fluxer", FX);
  });

  const build = (routes) => {
    const rest = makeFakeRest({ routes });
    // The fake handle IS the handle shape; handle.outbound is the real
    // OutboundClient built over it (same construction as every adapter test).
    return makeFakeHandle({ rest }).outbound;
  };

  it("a guild the bot can GET is present", async () => {
    const o = build({ [`GET /v1/guilds/${GUILD_A}`]: { id: GUILD_A } });
    assert.equal(await o.probeGuildPresence(CID_A), "present");
  });

  it("404 AND 403 are ABSENT (the bot no longer sees the guild)", async () => {
    const o404 = build({}); // fake transport answers 404 FAKE_NO_ROUTE
    assert.equal(await o404.probeGuildPresence(CID_A), "absent");
    const o403 = build({
      [`GET /v1/guilds/${GUILD_A}`]: () => {
        throw new FluxerRestError("403 FORBIDDEN", { status: 403 });
      },
    });
    assert.equal(await o403.probeGuildPresence(CID_A), "absent");
  });

  it("a transport hiccup is UNKNOWN — never a verdict", async () => {
    const o = build({
      [`GET /v1/guilds/${GUILD_A}`]: () => {
        throw new FluxerRestError("500 boom", { status: 500 });
      },
    });
    assert.equal(await o.probeGuildPresence(CID_A), "unknown");
  });

  it("a community without a row is absent", async () => {
    const o = build({});
    assert.equal(await o.probeGuildPresence(999999), "absent");
  });
});

describe("#466 (C1-11): the access list + tier deny bot-absent communities", () => {
  let sessionId;
  let session;

  before(() => {
    CID_A = communityKey(GUILD_A, "fluxer", FX);
    CID_B = communityKey(GUILD_B, "fluxer", FX);
    const s = sessionPolicy.createSession({ userId: "920000000000000001", discordTag: "c111#0001" });
    sessionId = s.id;
    api.setWebSessionAuth(sessionId, {
      accessTokenEnc: tokens.encryptAccessToken("tok-c111"),
      tokenExpiresAt: Date.now() + 2 * 3_600_000,
      scopes: "identify guilds",
      guildSnapshot: JSON.stringify([
        { id: GUILD_A, name: "Still Here", icon: null, owner: true, permissions: "0" },
        { id: GUILD_B, name: "Bot Left", icon: null, owner: true, permissions: "0" },
        { id: GUILD_C, name: "No Community Row", icon: null, owner: true, permissions: "0" },
      ]),
    });
    session = { id: sessionId, userId: "920000000000000001", platform: "fluxer", instanceKey: FX };
  });

  /** Verdicts per community id; a client without the method = "unwired". */
  function boot(verdicts) {
    return createGuildAccessResolver({
      // No instance entries ⇒ the USER guild-list has no api base ⇒ the
      // stored-snapshot path runs — where the prune MUST still apply (the
      // user token happily lists guilds the bot left).
      getFluxerWebInstances: () => [],
      getCommunityClient: (cid) =>
        typeof verdicts[cid] === "string"
          ? { probeGuildPresence: async () => verdicts[cid] }
          : null,
      ttlMs: 60_000,
    });
  }

  it("a bot-absent community is dropped from the list and DENIED — snapshot-admin or not", async () => {
    const resolver = boot({ [CID_A]: "present", [CID_B]: "absent" });

    const listed = await resolver.listGuilds(session);
    const ids = listed.guilds.map((g) => g.id);
    assert.ok(ids.includes(GUILD_A), "present stays");
    assert.ok(
      !ids.includes(GUILD_B),
      "the bot-left community leaves the switcher (pre-fix: listed, every action 404s)",
    );
    assert.ok(!ids.includes(GUILD_C), "a snapshot entry with no communities row is gone too");

    const okA = await resolver.resolve(session, CID_A);
    assert.equal(okA.status, "ok");
    assert.equal(okA.tier, "admin", "present + snapshot owner still tiers (no regression)");

    const denied = await resolver.resolve(session, CID_B);
    assert.equal(denied.status, "deny", "the admin-from-snapshot-alone hole is closed");
    assert.equal(denied.reason, "not_in_access_list");
  });

  it("an unanswerable probe keeps the community (bounded by the next TTL)", async () => {
    const resolver = boot({ [CID_A]: "present", [CID_B]: "unknown" });
    const denied = await resolver.resolve(session, CID_B);
    assert.equal(denied.status, "ok", "a transient probe failure must not evict a healthy community");
    assert.equal(denied.tier, "admin");
  });

  it("an unwired client seam keeps the pre-fix listing exactly", async () => {
    const resolver = boot({});
    const listed = await resolver.listGuilds(session);
    const ids = listed.guilds.map((g) => g.id);
    assert.ok(ids.includes(GUILD_A) && ids.includes(GUILD_B), "no seam ⇒ no verdicts ⇒ no pruning");
    assert.ok(!ids.includes(GUILD_C), "…but a vanished communities row is still a fact");
  });
});
