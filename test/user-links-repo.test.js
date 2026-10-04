/**
 * userLinks repository unit tests (roadmap/account-linking.md T1 — repo half).
 *
 * Everything runs against a fresh temp SQLite via loadDb() (real migrations).
 * No Discord, no Fluxer, no sockets. The identity firewall, the UNIQUE
 * conflict shape, atomic code consumption, and the bridge-pair gate are the
 * contracts pinned here.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { loadDb, communityKey } = require("./helpers/env");

/** Deterministic 32-byte digest for a label (mimics hashing a canonical code). */
const digestFor = (label) => crypto.createHash("sha256").update(label, "utf8").digest();

describe("userLinks repo (account-linking T1)", () => {
  /** @type {{ [k: string]: Function }} */
  let api;
  let cleanup;

  let dcGuild; // discord community
  let fxRoom; // fluxer community
  let dcGuild2; // second discord community (for scoping tests)

  before(() => {
    // Contract: loadDb() before any other src/ require in this file.
    ({ api, cleanup } = loadDb());
    dcGuild = communityKey("111000000000000001");
    fxRoom = communityKey("sub-fluxer-room-1", "fluxer", "fluxer.example:8443");
    dcGuild2 = communityKey("111000000000000002");
  });

  after(() => cleanup?.());

  /** Mint a bridge between two communities in `pending` state (repo never flips state). */
  const mintBridge = (cidA, cidB) => {
    const bridge = api.createBridge({
      publicId: api.generateBridgeHandle(),
      createdByUserId: "u-minter",
      endACommunityId: cidA,
      endAChannelId: "chan-a",
    });
    api.addBridgeEnd({ bridgeId: bridge.id, position: "b", communityId: cidB, channelId: "chan-b" });
    return bridge; // state stays 'pending'; tests drive the state machine flips
  };

  describe("facade surface", () => {
    it("src/db exposes the linking helpers", () => {
      for (const name of [
        "createUserLink",
        "getUserLinkFor",
        "getUserLinkById",
        "listUserLinksForCommunity",
        "removeUserLink",
        "createLinkCode",
        "getLinkCodeByHash",
        "consumeLinkCode",
        "purgeExpiredLinkCodes",
        "hasActiveBridgeBetween",
        "setUserLinkMirrorPct",
        "setUserLinkMirrorMemory",
      ]) {
        assert.equal(typeof api[name], "function", `facade must expose ${name}`);
      }
      assert.deepEqual(api.LINK_MIRROR_DIRECTIONS, ["a_to_b", "b_to_a"]);
      assert.equal(api.USER_LINK_CODE_LIFETIME_MS, 15 * 60 * 1000, "codes live 15 minutes");
    });
  });

  describe("identity firewall", () => {
    it("rejects snowflake strings and every non-integer community id before touching SQL", () => {
      const snowflake = "123456789012345678901"; // string-typed Discord id
      const calls = [
        () => api.createUserLink({ communityIdA: snowflake, userIdA: "u", communityIdB: 1, userIdB: "v" }),
        () => api.createUserLink({ communityIdA: 1, userIdA: "u", communityIdB: "1", userIdB: "v" }),
        () => api.getUserLinkFor(snowflake, "u"),
        () => api.getUserLinkById(snowflake, 1),
        () => api.listUserLinksForCommunity(snowflake),
        () => api.removeUserLink(snowflake, "u"),
        () => api.createLinkCode({ communityId: snowflake, userId: "u", codeHash: digestFor("x") }),
        () => api.setUserLinkMirrorPct(snowflake, "u", "a_to_b", 50),
        () => api.setUserLinkMirrorMemory(snowflake, "u", true),
        () => api.hasActiveBridgeBetween(snowflake, 1),
        () => api.hasActiveBridgeBetween(1, snowflake),
        () => api.listUserLinksForCommunity(1.5),
        () => api.listUserLinksForCommunity(0),
        () => api.listUserLinksForCommunity(2_147_483_648),
      ];
      for (const call of calls) {
        assert.throws(call, /^Error: community id required, got /, `${call.name} must throw`);
      }
    });

    it("rejects non-string user ids and garbage code digests as programmer errors", () => {
      assert.throws(() => api.getUserLinkFor(dcGuild, 12345), /userId must be a non-empty string/);
      assert.throws(() => api.getUserLinkFor(dcGuild, "  "), /userId must be a non-empty string/);
      assert.throws(() => api.createLinkCode({ communityId: dcGuild, userId: "u", codeHash: "deadbeef" }),
        /32-byte sha256 digest/);
      assert.throws(() => api.consumeLinkCode(new Uint8Array(16)), /32-byte sha256 digest/);
    });
  });

  describe("link CRUD", () => {
    it("createLink stores the pair with default mirror settings and reads back from BOTH sides", () => {
      const beforeMs = Date.now();
      const res = api.createUserLink({
        communityIdA: dcGuild,
        userIdA: "disc-u-1",
        communityIdB: fxRoom,
        userIdB: "flux-s-1",
      });
      assert.equal(res.ok, true, res.error || "create must succeed");
      const link = res.link;
      assert.ok(Number.isInteger(link.id) && link.id >= 1);
      assert.equal(link.community_id_a, dcGuild);
      assert.equal(link.user_id_a, "disc-u-1");
      assert.equal(link.community_id_b, fxRoom);
      assert.equal(link.user_id_b, "flux-s-1");
      assert.equal(link.mirror_a_to_b_pct, 100);
      assert.equal(link.mirror_b_to_a_pct, 100);
      assert.equal(link.mirror_memory, 1);
      assert.ok(link.created_at >= beforeMs && link.created_at <= Date.now());

      // getLinkFor resolves from either side (the firewall key is the pair).
      assert.deepEqual(api.getUserLinkFor(dcGuild, "disc-u-1"), link);
      assert.deepEqual(api.getUserLinkFor(fxRoom, "flux-s-1"), link);
      assert.equal(api.getUserLinkFor(dcGuild, "nobody"), null);
      assert.equal(api.getUserLinkFor(dcGuild2, "disc-u-1"), null, "same user id in another community is not the same identity");
    });

    it("getLinkById is party-scoped to the caller's community", () => {
      const link = api.getUserLinkFor(dcGuild, "disc-u-1");
      assert.equal(api.getUserLinkById(dcGuild, link.id).id, link.id);
      assert.equal(api.getUserLinkById(fxRoom, link.id).id, link.id);
      assert.equal(api.getUserLinkById(dcGuild2, link.id), null, "non-parties cannot resolve the link");
      assert.throws(() => api.getUserLinkById(dcGuild, 0), /link id must be a positive integer/);
      assert.throws(() => api.getUserLinkById(dcGuild, "7"), /link id must be a positive integer/);
    });

    it("createLink refuses a same-community pair (links are cross-platform)", () => {
      assert.throws(
        () => api.createUserLink({ communityIdA: dcGuild, userIdA: "a", communityIdB: dcGuild, userIdB: "b" }),
        /two distinct communities/,
      );
    });

    it("UNIQUE conflicts come back as {ok:false, error} naming the taken side and the existing link date", () => {
      const existing = api.getUserLinkFor(dcGuild, "disc-u-1");
      const iso = new Date(existing.created_at).toISOString();

      const sideA = api.createUserLink({
        communityIdA: dcGuild,
        userIdA: "disc-u-1", // already linked
        communityIdB: communityKey("sub-fluxer-room-2", "fluxer", "fluxer.example:8443"),
        userIdB: "flux-new",
      });
      assert.equal(sideA.ok, false);
      assert.match(sideA.error, /first side .* is already linked to user flux-s-1/);
      assert.ok(sideA.error.includes(iso), `error must name the existing link date (${iso})`);
      assert.match(sideA.error, /remove that link first/);
      assert.equal(sideA.existingLink.id, existing.id);

      const sideB = api.createUserLink({
        communityIdA: dcGuild2,
        userIdA: "disc-fresh",
        communityIdB: fxRoom,
        userIdB: "flux-s-1", // already linked on the b side
      });
      assert.equal(sideB.ok, false);
      assert.match(sideB.error, /second side .* is already linked to user disc-u-1/);
      assert.ok(sideB.error.includes(iso));

      // No half-written rows from the rejected attempts.
      assert.equal(api.getUserLinkFor(dcGuild2, "disc-fresh"), null);
      assert.equal(api.listUserLinksForCommunity(dcGuild).length, 1);
    });

    it("listLinksForCommunity returns every link the community is a party to, oldest first", () => {
      const a = api.getUserLinkFor(dcGuild, "disc-u-1");
      const made = api.createUserLink({
        communityIdA: dcGuild2,
        userIdA: "disc-u-2",
        communityIdB: fxRoom,
        userIdB: "flux-s-2",
      });
      assert.equal(made.ok, true);
      const fxLinks = api.listUserLinksForCommunity(fxRoom);
      assert.equal(fxLinks.length, 2, "both links on the fluxer side are visible");
      const ids = fxLinks.map((r) => r.id);
      assert.ok(ids.includes(a.id) && ids.includes(made.link.id));
      assert.deepEqual(ids, [...ids].sort((x, y) => x - y), "oldest first");
      assert.deepEqual(api.listUserLinksForCommunity(communityKey("g-no-links")), []);
    });

    it("removeLink requires a party and deletes the row; repeat removal is a specific no-op", () => {
      const made = api.createUserLink({
        communityIdA: dcGuild2,
        userIdA: "disc-u-3",
        communityIdB: fxRoom,
        userIdB: "flux-s-3",
      });
      assert.equal(made.ok, true);

      // Caller is not a party → specific refusal, row untouched.
      const stranger = api.removeUserLink(communityKey("g-stranger"), "disc-u-3");
      assert.equal(stranger.ok, false);
      assert.match(stranger.error, /has no account link to remove/);
      assert.ok(api.getUserLinkById(dcGuild2, made.link.id), "stranger must not delete it");

      // Party on the b side removes it.
      const removed = api.removeUserLink(fxRoom, "flux-s-3");
      assert.equal(removed.ok, true);
      assert.equal(removed.link.id, made.link.id);
      assert.equal(api.getUserLinkFor(dcGuild2, "disc-u-3"), null);
      assert.equal(api.getUserLinkFor(fxRoom, "flux-s-3"), null);

      const again = api.removeUserLink(dcGuild2, "disc-u-3");
      assert.equal(again.ok, false, "second removal is a specific no-op");
      assert.match(again.error, /has no account link to remove/);
    });
  });

  describe("mirror configuration", () => {
    before(() => {
      const made = api.createUserLink({
        communityIdA: dcGuild,
        userIdA: "disc-cfg",
        communityIdB: fxRoom,
        userIdB: "flux-cfg",
      });
      assert.equal(made.ok, true, made.error || "");
    });

    it("setMirrorPct writes the named direction from either side", () => {
      const one = api.setUserLinkMirrorPct(dcGuild, "disc-cfg", "a_to_b", 0);
      assert.equal(one.ok, true);
      assert.equal(one.link.mirror_a_to_b_pct, 0, "0 is a legal (off) rate");

      const two = api.setUserLinkMirrorPct(fxRoom, "flux-cfg", "b_to_a", 50);
      assert.equal(two.ok, true);
      assert.equal(two.link.mirror_b_to_a_pct, 50);
      assert.equal(two.link.mirror_a_to_b_pct, 0, "the other direction is untouched");
      assert.equal(two.link.mirror_memory, 1, "memory flag untouched");
    });

    it("setMirrorPct rejects out-of-range and fractional percentages with a specific error", () => {
      for (const bad of [101, -1, 55.5, "50", NaN, Infinity, null, undefined]) {
        const res = api.setUserLinkMirrorPct(dcGuild, "disc-cfg", "a_to_b", bad);
        assert.equal(res.ok, false, `${String(bad)} must be rejected`);
        assert.match(res.error, /must be a whole number between 0 and 100/);
      }
      assert.throws(
        () => api.setUserLinkMirrorPct(dcGuild, "disc-cfg", "sideways", 50),
        /mirror direction must be one of a_to_b, b_to_a/,
      );
    });

    it("setMirrorPct on a user with no link names the missing step", () => {
      const res = api.setUserLinkMirrorPct(dcGuild2, "disc-unlinked", "a_to_b", 50);
      assert.equal(res.ok, false);
      assert.match(res.error, /has no account link to configure/);
      assert.match(res.error, /link create mints a code and link connect creates the link/);
    });

    it("setMirrorMemory accepts on/off from either side, rejects everything else", () => {
      const off = api.setUserLinkMirrorMemory(dcGuild, "disc-cfg", false);
      assert.equal(off.ok, true);
      assert.equal(off.link.mirror_memory, 0);

      const on = api.setUserLinkMirrorMemory(fxRoom, "flux-cfg", 1);
      assert.equal(on.ok, true);
      assert.equal(on.link.mirror_memory, 1);

      const truthy = api.setUserLinkMirrorMemory(dcGuild, "disc-cfg", "yes");
      assert.equal(truthy.ok, false);
      assert.match(truthy.error, /mirror_memory must be on \(true\/1\) or off \(false\/0\)/);

      const noLink = api.setUserLinkMirrorMemory(dcGuild2, "disc-unlinked", true);
      assert.equal(noLink.ok, false);
      assert.match(noLink.error, /has no account link to configure/);
    });
  });

  describe("link codes", () => {
    it("createLinkCode stores the digest with a 15-minute expiry and no used_at", () => {
      const beforeMs = Date.now();
      const hash = digestFor("code-mint-1");
      const minted = api.createLinkCode({ communityId: dcGuild, userId: "disc-u-1", codeHash: hash });
      assert.equal(minted.ok, true);
      const row = minted.linkCode;
      assert.equal(row.community_id, dcGuild);
      assert.equal(row.user_id, "disc-u-1");
      assert.equal(row.used_at, null, "fresh code is unconsumed");
      assert.ok(row.created_at >= beforeMs);
      assert.ok(
        row.expires_at >= beforeMs + api.USER_LINK_CODE_LIFETIME_MS &&
          row.expires_at <= Date.now() + api.USER_LINK_CODE_LIFETIME_MS,
        "expiry is exactly the 15-minute lifetime",
      );
      // getLinkCodeByHash round-trips from a fresh Buffer of the same digest.
      assert.deepEqual(api.getLinkCodeByHash(digestFor("code-mint-1")), row);
      assert.equal(api.getLinkCodeByHash(digestFor("never-minted")), null);
    });

    it("duplicate digests surface {ok:false} naming the mint-a-fresh-code fix", () => {
      const hash = digestFor("code-dupe");
      assert.equal(api.createLinkCode({ communityId: dcGuild, userId: "u", codeHash: hash }).ok, true);
      const dupe = api.createLinkCode({ communityId: dcGuild, userId: "u", codeHash: hash });
      assert.equal(dupe.ok, false);
      assert.match(dupe.error, /link code with this exact code hash already exists/);
      assert.match(dupe.error, /mint a fresh code and retry/);
    });

    it("consumeLinkCode is single-use: the first caller wins, every race gets null", () => {
      const hash = digestFor("code-consume");
      const minted = api.createLinkCode({ communityId: dcGuild, userId: "u", codeHash: hash });
      const consumed = api.consumeLinkCode(hash);
      assert.ok(consumed, "first consume returns the row");
      assert.equal(consumed.id, minted.linkCode.id);
      assert.ok(Number.isInteger(consumed.used_at) && consumed.used_at >= minted.linkCode.created_at);

      // Replay + a concurrent race that lost the CAS both resolve to null.
      assert.equal(api.consumeLinkCode(hash), null, "a used code can never be redeemed twice");
      assert.equal(api.consumeLinkCode(digestFor("code-never-minted")), null, "unknown digest is null, not a throw");

      // The used row remains readable (used_at set) so connect can report
      // "already used" on replays, like bridges keep code_hash on active rows.
      assert.equal(api.getLinkCodeByHash(hash).used_at, consumed.used_at);
    });

    it("consume honors the expiry clock: expired codes never redeem", () => {
      const hash = digestFor("code-expiring");
      const t0 = 1_700_000_000_000;
      const minted = api.createLinkCode({
        communityId: dcGuild,
        userId: "u",
        codeHash: hash,
        expiresAt: t0 + 60_000,
      });
      assert.equal(minted.ok, true);
      // Redeem after expiry with the injectable clock → no row flips.
      assert.equal(api.consumeLinkCode(hash, t0 + 60_000), null, "at == expiry is expired");
      assert.equal(api.consumeLinkCode(hash, t0 + 59_000).id, minted.linkCode.id);
      assert.equal(api.consumeLinkCode(hash, t0 + 61_000), null, "used stays used");
    });

    it("purgeExpiredLinkCodes sweeps only codes at/before the cutoff", () => {
      api.db.prepare(`DELETE FROM user_link_codes`).run(); // hermetic slice
      const t = 2_000_000_000_000;
      assert.equal(
        api.createLinkCode({ communityId: dcGuild, userId: "u", codeHash: digestFor("p1"), expiresAt: t - 5_000 }).ok,
        true,
      );
      assert.equal(
        api.createLinkCode({ communityId: dcGuild, userId: "u", codeHash: digestFor("p2"), expiresAt: t }).ok,
        true,
      ); // boundary: <=
      assert.equal(
        api.createLinkCode({ communityId: fxRoom, userId: "v", codeHash: digestFor("p3"), expiresAt: t + 60_000 }).ok,
        true,
      );
      assert.equal(api.purgeExpiredLinkCodes(t), 2, "expired + boundary rows sweep");
      assert.equal(api.getLinkCodeByHash(digestFor("p1")), null);
      assert.equal(api.getLinkCodeByHash(digestFor("p2")), null);
      assert.ok(api.getLinkCodeByHash(digestFor("p3")), "live code survives");
      assert.equal(api.purgeExpiredLinkCodes(t), 0, "purge on a clean slice is a no-op");
      api.purgeExpiredLinkCodes(t + 60_000); // tidy p3
      assert.throws(() => api.purgeExpiredLinkCodes("now"), /integer ms epoch/);
    });
  });

  describe("bridge-pair gate", () => {
    it("hasActiveBridgeBetween follows the bridges state machine, both orientations", () => {
      const pairA = communityKey("111000000000000091");
      const pairB = communityKey("sub-fluxer-pair-b", "fluxer", "fluxer.example:8443");
      const unpaired = communityKey("111000000000000099");

      assert.equal(api.hasActiveBridgeBetween(pairA, pairB), false, "no rows → false");
      assert.equal(api.hasActiveBridgeBetween(pairA, pairA), false, "self-pair is never active");

      const bridge = mintBridge(pairA, pairB);
      // Pending codes pair channels, not links: pending is NOT active yet.
      assert.equal(api.hasActiveBridgeBetween(pairA, pairB), false);
      api.db.prepare(`UPDATE bridges SET state = 'active' WHERE id = ?`).run(bridge.id);
      assert.equal(api.hasActiveBridgeBetween(pairA, pairB), true);
      assert.equal(api.hasActiveBridgeBetween(pairB, pairA), true, "orientation-agnostic");
      assert.equal(api.hasActiveBridgeBetween(pairA, unpaired), false, "unrelated communities stay unpaired");

      api.markBridgeBroken(bridge.id, "test: destination channel gone");
      assert.equal(api.hasActiveBridgeBetween(pairA, pairB), false, "broken bridges gate links off");
    });
  });
});
