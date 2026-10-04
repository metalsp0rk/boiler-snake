/**
 * Linking service unit tests (roadmap/account-linking.md T2).
 *
 * Runs against a fresh temp SQLite via loadDb() (real migrations, real
 * repository). No Discord, no Fluxer, no sockets: the service is pure data,
 * so every branch is reachable here. Pinned contracts:
 *  - code minting mirrors the bridge format (Crockford base32, LNK- display,
 *    SHA-256 digest at rest, plaintext returned once)
 *  - redemption validation: unknown / expired / used (atomic, single use) /
 *    alphabet garbage / same-platform / unpaired-community / both
 *    already-linked conflicts — each with its OWN specific sentence
 *  - canonical orientation: Discord side stored as `a`, Fluxer as `b`, from
 *    either creation direction
 *  - configureMirror validation and resolveMirrorTarget direction selection
 *  - expandLinkedIds carries the mirror_memory flag (gork fan-out seam)
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { loadDb, communityKey } = require("./helpers/env");

/** A 22-char code-shaped string (Crockford alphabet, never minted). */
const CODE_SHAPED_UNKNOWN = "ABCDEFGHJKMNPQRSTVWXYZ";

/** Fifteen minutes, as pinned by the repository constant. */
const LIFETIME_MS = 15 * 60 * 1000;

describe("linking service (account-linking T2)", () => {
  /** @type {{ [k: string]: Function }} */
  let api;
  let cleanup;
  let service;
  let codes;
  let linking;

  // Community pairs (each bridge pair hosts its own scenarios, so tests
  // never collide on the one-link-per-identity UNIQUE constraints).
  let dcMain;
  let fxMain;
  let dcFlip;
  let fxFlip;
  let dcSolo;
  let fxSolo;
  let dcAlpha;
  let dcBeta; // second DISCORD community — same-platform rejection fixture
  const MISSING_COMMUNITY = 900_042; // never registered in this DB

  before(() => {
    // Contract: loadDb() before any other src/ require in this file.
    ({ api, cleanup } = loadDb());
    service = require("../src/features/linking/service");
    codes = require("../src/features/linking/codes");
    linking = require("../src/features/linking");

    dcMain = communityKey("220000000000000001");
    fxMain = communityKey("sub-linking-fx-1", "fluxer", "fluxer.example:8443");
    dcFlip = communityKey("220000000000000002");
    fxFlip = communityKey("sub-linking-fx-2", "fluxer", "fluxer.example:8443");
    dcSolo = communityKey("220000000000000003");
    fxSolo = communityKey("sub-linking-fx-3", "fluxer", "fluxer.example:8443");
    dcAlpha = communityKey("220000000000000004");
    dcBeta = communityKey("220000000000000005");

    // Active bridges for the two linking pairs. The repository never flips
    // bridges to 'active' (the connect service owns that CAS), so tests drive
    // the state machine directly, exactly like test/user-links-repo.test.js.
    const activateBridge = (cidA, cidB) => {
      const bridge = api.createBridge({
        publicId: api.generateBridgeHandle(),
        createdByUserId: "u-minter",
        endACommunityId: cidA,
        endAChannelId: "chan-a",
      });
      api.addBridgeEnd({ bridgeId: bridge.id, position: "b", communityId: cidB, channelId: "chan-b" });
      api.db.prepare(`UPDATE bridges SET state = 'active' WHERE id = ?`).run(bridge.id);
      return bridge;
    };
    activateBridge(dcMain, fxMain);
    activateBridge(dcFlip, fxFlip);
    // dcSolo / fxSolo / dcAlpha / dcBeta stay UNPAIRED on purpose.
  });

  after(() => cleanup?.());

  /** Read the stored code row behind a minted plaintext code. */
  const codeRowFor = (plainCode) => api.getLinkCodeByHash(codes.hashLinkCode(plainCode));

  // -------------------------------------------------------------------------
  // codes.js — mint/verify helpers mirroring bridge code conventions
  // -------------------------------------------------------------------------

  describe("codes", () => {
    it("mints a bridge-style Crockford code with a LNK- display form and a 32-byte digest", () => {
      const minted = codes.generateLinkCode();
      assert.equal(typeof minted.canonical, "string");
      assert.match(minted.canonical, /^[0-9A-HJ-KM-NP-TV-Z]{22}$/, "22 Crockford characters");
      assert.ok(minted.displayCode.startsWith("LNK-"), "display carries the prefix");
      assert.equal(
        minted.displayCode,
        `LNK-${codes.formatDisplayCode(minted.canonical)}`,
        "display is the grouped canonical",
      );
      assert.match(
        minted.displayCode,
        /^LNK-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/,
      );
      assert.ok(Buffer.isBuffer(minted.digest) && minted.digest.length === 32, "sha256 digest");
      // The minted body never starts with the display prefix (that form is
      // unredeemable: canonicalize strips a leading LNK).
      assert.ok(!minted.canonical.startsWith(codes.CODE_PREFIX));
    });

    it("canonicalizes every typed form of a minted code back to its storage form", () => {
      const minted = codes.generateLinkCode();
      assert.equal(codes.canonicalizeLinkCode(minted.displayCode), minted.canonical);
      assert.equal(codes.canonicalizeLinkCode(minted.canonical), minted.canonical);
      assert.equal(codes.canonicalizeLinkCode(minted.canonical.toLowerCase()), minted.canonical);
      assert.equal(
        codes.canonicalizeLinkCode(`  ${minted.canonical}  `.toLowerCase().replace(/(.{4})(?=.)/g, "$1-")),
        minted.canonical,
        "lowercase + dashed + padded input canonicalizes identically",
      );
      assert.equal(minted.digest.toString("hex"), codes.hashLinkCode(minted.displayCode).toString("hex"));
    });

    it("classifies input before hashing: empty, alphabet garbage, code-shaped", () => {
      assert.deepEqual(codes.classifyLinkInput(""), { kind: "empty" });
      assert.deepEqual(codes.classifyLinkInput("   "), { kind: "empty" });
      assert.deepEqual(codes.classifyLinkInput(null), { kind: "empty" });
      assert.deepEqual(codes.classifyLinkInput(42), { kind: "empty" });
      // "I", "O", "U", "L" are excluded from Crockford base32 → garbage.
      const bad = codes.classifyLinkInput("not a code!!");
      assert.equal(bad.kind, "garbage");
      assert.equal(bad.canonical, "NOTACODE!!", "non-alphanumerics survive canonicalization");
      const code = codes.classifyLinkInput(`lnk-${CODE_SHAPED_UNKNOWN.toLowerCase()}`);
      assert.equal(code.kind, "code");
      assert.equal(code.canonical, CODE_SHAPED_UNKNOWN);
    });

    it("re-mints on collisions and refuses to mint forever against a full table", () => {
      assert.throws(
        () => codes.generateLinkCode({ isTaken: () => true }),
        /refusing to mint/,
      );

      const taken = new Set();
      const first = codes.generateLinkCode({ isTaken: (d) => taken.has(d.toString("hex")) });
      taken.add(first.digest.toString("hex"));
      const second = codes.generateLinkCode({ isTaken: (d) => taken.has(d.toString("hex")) });
      assert.notEqual(second.digest.toString("hex"), first.digest.toString("hex"), "probe is consulted");
    });

    it("digestsEqual is type-tolerant and length-safe", () => {
      const minted = codes.generateLinkCode();
      assert.equal(codes.digestsEqual(minted.digest, minted.digest.toString("hex")), true);
      assert.equal(codes.digestsEqual(minted.digest.toString("hex"), minted.digest), true);
      assert.equal(codes.digestsEqual(minted.digest, codes.hashLinkCode("AAAAAAAAAAAAAAAAAAAAAA")), false);
      assert.equal(codes.digestsEqual(minted.digest, "not-hex"), false, "never throws");
      assert.equal(codes.digestsEqual(minted.digest, null), false);
      assert.equal(codes.digestsEqual(Buffer.alloc(16), Buffer.alloc(16)), false, "length guard");
    });
  });

  // -------------------------------------------------------------------------
  // createLinkCode
  // -------------------------------------------------------------------------

  describe("createLinkCode", () => {
    it("mints a 15-minute single-use code and stores only the SHA-256 digest", async () => {
      const beforeMs = Date.now();
      const res = await service.createLinkCode(dcMain, "disc-mint-1");
      assert.equal(res.ok, true, res.error || "mint must succeed");
      assert.match(res.code, /^LNK-/);
      assert.equal(res.canonical.length, 22);
      assert.equal(res.platform, "discord");
      assert.equal(res.lifetimeMs, LIFETIME_MS, "codes live 15 minutes");
      assert.ok(
        res.expiresAt >= beforeMs + LIFETIME_MS && res.expiresAt <= Date.now() + LIFETIME_MS,
        "expiry is now + 15 minutes",
      );

      const row = codeRowFor(res.code);
      assert.ok(row, "row resolvable by digest");
      assert.equal(row.community_id, dcMain);
      assert.equal(row.user_id, "disc-mint-1");
      assert.equal(row.used_at, null, "fresh code is unconsumed");
      assert.equal(row.expires_at, res.expiresAt);

      // At rest the column holds the lowercase-hex SHA-256 of the canonical
      // form — the plaintext never reaches the database (AGENTS.md secrets).
      assert.match(row.code_hash, /^[0-9a-f]{64}$/);
      assert.equal(row.code_hash, crypto.createHash("sha256").update(res.canonical, "utf8").digest("hex"));
      assert.ok(!row.code_hash.includes(res.canonical.slice(0, 8)), "plaintext is not stored");

      // ...and the minted code is redeemable from the OTHER platform.
      const redeemed = await service.redeemLinkCode(fxMain, "flux-mint-1", res.code);
      assert.equal(redeemed.ok, true, redeemed.error || "");
      assert.equal(codeRowFor(res.code).used_at !== null, true, "redemption stamps used_at");
    });

    it("honors an injected clock for the expiry", async () => {
      const fixed = 1_700_000_000_000;
      const res = await service.createLinkCode(dcMain, "disc-mint-clock", { clock: () => fixed });
      assert.equal(res.ok, true);
      assert.equal(res.expiresAt, fixed + LIFETIME_MS);
      assert.equal(codeRowFor(res.code).expires_at, fixed + LIFETIME_MS);
    });

    it("answers an unregistered community with a specific, actionable sentence", async () => {
      const res = await service.createLinkCode(MISSING_COMMUNITY, "disc-none");
      assert.equal(res.ok, false);
      assert.match(res.error, new RegExp(`Community ${MISSING_COMMUNITY} is not registered with this bot`));
      assert.match(res.error, /Run any bot command in that community first/);
    });

    it("turns a snowflake passed as community id into a specific failure, not a crash", async () => {
      const res = await service.createLinkCode("123456789012345678", "disc-1");
      assert.equal(res.ok, false);
      assert.match(res.error, /community id required, got string/);
    });

    it("turns a missing user id into a specific failure", async () => {
      const res = await service.createLinkCode(dcMain, "   ");
      assert.equal(res.ok, false);
      assert.match(res.error, /userId must be a non-empty string, got empty string/);
    });
  });

  // -------------------------------------------------------------------------
  // redeemLinkCode
  // -------------------------------------------------------------------------

  describe("redeemLinkCode", () => {
    it("links a Discord account to a Fluxer account (code created on Discord)", async () => {
      const minted = await service.createLinkCode(dcMain, "disc-a1");
      assert.equal(minted.ok, true, minted.error || "");

      const res = await service.redeemLinkCode(fxMain, "flux-b1", minted.code);
      assert.equal(res.ok, true, res.error || "redeem must succeed");
      assert.equal(res.codeBurned, true);
      const link = res.link;
      // Canonical orientation: the Discord side is `a`, the Fluxer side is `b`.
      assert.equal(link.community_id_a, dcMain);
      assert.equal(link.user_id_a, "disc-a1");
      assert.equal(link.community_id_b, fxMain);
      assert.equal(link.user_id_b, "flux-b1");
      assert.equal(link.mirror_a_to_b_pct, 100);
      assert.equal(link.mirror_b_to_a_pct, 100);
      assert.equal(link.mirror_memory, 1);
      // The caller's peer is the code's owner.
      assert.equal(res.peer.platform, "discord");
      assert.equal(res.peer.userId, "disc-a1");
      assert.equal(res.peer.communityId, dcMain);

      // Both sides resolve the same row.
      assert.equal(api.getUserLinkFor(dcMain, "disc-a1").id, link.id);
      assert.equal(api.getUserLinkFor(fxMain, "flux-b1").id, link.id);
    });

    it("stores Discord as side a even when the code was created on Fluxer", async () => {
      const minted = await service.createLinkCode(fxFlip, "flux-c1");
      assert.equal(minted.ok, true, minted.error || "");
      assert.equal(minted.platform, "fluxer");

      // Redeem accepts the dashed display form, lowercase, with padding.
      const res = await service.redeemLinkCode(dcFlip, "disc-d1", `  ${minted.code.toLowerCase()}  `);
      assert.equal(res.ok, true, res.error || "");
      assert.equal(res.link.community_id_a, dcFlip, "Discord side is always a");
      assert.equal(res.link.user_id_a, "disc-d1");
      assert.equal(res.link.community_id_b, fxFlip, "Fluxer side is always b");
      assert.equal(res.link.user_id_b, "flux-c1");
      assert.equal(res.peer.platform, "fluxer");
      assert.equal(res.peer.userId, "flux-c1");
    });

    it("rejects an expired code and leaves it unconsumed", async () => {
      const past = Date.now() - 20 * 60 * 1000; // minted 20 min ago
      const minted = await service.createLinkCode(dcMain, "disc-exp", { clock: () => past });
      assert.equal(minted.ok, true, minted.error || "");
      assert.equal(minted.expiresAt, past + LIFETIME_MS);

      const res = await service.redeemLinkCode(fxMain, "flux-exp", minted.code);
      assert.equal(res.ok, false, "expired codes never redeem");
      assert.match(res.error, /^That link code expired at \d{4}-\d{2}-\d{2}T.*Z UTC/);
      assert.match(res.error, /Create a new one with \/link create/);
      assert.equal(codeRowFor(minted.code).used_at, null, "a rejected redeem must not burn the code");
      assert.equal(api.getUserLinkFor(dcMain, "disc-exp"), null);
    });

    it("redeems a code exactly once: the second attempt names the spend", async () => {
      const minted = await service.createLinkCode(dcMain, "disc-twice");
      const first = await service.redeemLinkCode(fxMain, "flux-twice", minted.code);
      assert.equal(first.ok, true, first.error || "");

      const second = await service.redeemLinkCode(fxMain, "flux-other", minted.code);
      assert.equal(second.ok, false);
      assert.match(second.error, /already redeemed on \d{4}-\d{2}-\d{2}T.*Z UTC/);
      assert.match(second.error, /cannot be used twice/);
      // Only one link exists, and it belongs to the first redeemer.
      assert.equal(api.getUserLinkFor(dcMain, "disc-twice").id, first.link.id);
      assert.equal(api.getUserLinkFor(fxMain, "flux-other"), null);
    });

    it("loses a concurrent race gracefully: the pre-checked code is reported as spent", async () => {
      const minted = await service.createLinkCode(fxFlip, "flux-race");
      assert.equal(minted.ok, true, minted.error || "");
      // A parallel connect consumes the row after our checks, before our CAS.
      const burned = api.consumeLinkCode(codes.hashLinkCode(minted.code));
      assert.ok(burned, "the race winner consumed it");

      const res = await service.redeemLinkCode(dcFlip, "disc-race", minted.code);
      assert.equal(res.ok, false);
      assert.match(res.error, /already redeemed on/);
      assert.equal(api.getUserLinkFor(dcFlip, "disc-race"), null, "the loser creates no link");
    });

    it("rejects missing and malformed codes with their own sentences", async () => {
      const missing = await service.redeemLinkCode(fxMain, "flux-fmt", "");
      assert.equal(missing.ok, false);
      assert.match(missing.error, /A link code is required/);
      assert.match(missing.error, /link create/);

      const garbage = await service.redeemLinkCode(fxMain, "flux-fmt", "not-a-code!!");
      assert.equal(garbage.ok, false);
      assert.match(garbage.error, /characters a code can't contain/);

      const unknown = await service.redeemLinkCode(fxMain, "flux-fmt", `LNK-${CODE_SHAPED_UNKNOWN}`);
      assert.equal(unknown.ok, false);
      assert.match(unknown.error, /never created, was purged, or was typed wrong/);
    });

    it("rejects same-platform redemption and leaves the code intact", async () => {
      // dcAlpha and dcBeta are BOTH Discord communities.
      const minted = await service.createLinkCode(dcAlpha, "disc-e1");
      assert.equal(minted.ok, true, minted.error || "");

      const res = await service.redeemLinkCode(dcBeta, "disc-e2", minted.code);
      assert.equal(res.ok, false);
      assert.match(res.error, /one Discord account and one Fluxer account/);
      assert.match(res.error, /created on Discord/);
      assert.match(res.error, /run \/link connect on the OTHER platform/);
      assert.equal(codeRowFor(minted.code).used_at, null, "same-platform must not burn the code");
    });

    it("rejects a community pair with no active bridge", async () => {
      // dcSolo / fxSolo have no bridges row at all.
      const minted = await service.createLinkCode(dcSolo, "disc-f1");
      assert.equal(minted.ok, true, minted.error || "");

      const res = await service.redeemLinkCode(fxSolo, "flux-g1", minted.code);
      assert.equal(res.ok, false);
      assert.match(res.error, new RegExp(`No active bridge connects communities ${dcSolo} and ${fxSolo}`));
      assert.match(res.error, /bridge create \+ bridge connect first/);
      assert.equal(codeRowFor(minted.code).used_at, null, "an unpaired pair must not burn the code");
    });

    it("rejects when the caller is already linked, naming the existing link", async () => {
      // disc-a1 ↔ flux-b1 are linked by the happy-path test above.
      const minted = await service.createLinkCode(fxMain, "flux-b1");
      assert.equal(minted.ok, true, minted.error || "");

      const res = await service.redeemLinkCode(dcMain, "disc-a1", minted.code);
      assert.equal(res.ok, false);
      assert.match(res.error, /You \(user disc-a1 in community \d+\) are already linked/);
      assert.match(res.error, /already linked to user flux-b1 in community \d+/);
      assert.match(res.error, /linked since \d{4}-\d{2}-\d{2}T/);
      assert.match(res.error, /link remove to unlink first/);
      assert.equal(codeRowFor(minted.code).used_at, null, "a fixable conflict must not burn the code");
    });

    it("rejects when the code's owner is already linked to someone else", async () => {
      // disc-a1 already holds a link; a fresh Fluxer account cannot claim it.
      const minted = await service.createLinkCode(dcMain, "disc-a1");
      assert.equal(minted.ok, true, minted.error || "");

      const res = await service.redeemLinkCode(fxMain, "flux-fresh-target", minted.code);
      assert.equal(res.ok, false);
      assert.match(res.error, /The account behind that code \(user disc-a1 in community \d+\)/);
      assert.match(res.error, /is already linked to user flux-b1 in community \d+/);
      assert.match(res.error, /must run \/link remove before it can be linked again/);
      assert.equal(api.getUserLinkFor(fxMain, "flux-fresh-target"), null);
      assert.equal(codeRowFor(minted.code).used_at, null);
    });

    it("refuses a code whose creating community no longer exists", async () => {
      const minted = await service.createLinkCode(dcMain, "disc-orphan");
      assert.equal(minted.ok, true, minted.error || "");
      const digest = codes.hashLinkCode(minted.code).toString("hex");
      const row = api.getLinkCodeByHash(codes.hashLinkCode(minted.code));
      // Simulate a community row removed under the code.
      api.db.prepare(`UPDATE user_link_codes SET community_id = ? WHERE id = ?`).run(MISSING_COMMUNITY, row.id);

      const res = await service.redeemLinkCode(fxMain, "flux-orphan", minted.code);
      assert.equal(res.ok, false);
      assert.match(res.error, new RegExp(`community that minted this code \\(id ${MISSING_COMMUNITY}\\) no longer exists`));
      assert.equal(api.getLinkCodeByHash(Buffer.from(digest, "hex")).used_at, null);
    });

    it("answers an unregistered redeeming community with the specific sentence", async () => {
      const minted = await service.createLinkCode(dcMain, "disc-nocomm");
      const res = await service.redeemLinkCode(MISSING_COMMUNITY, "flux-nocomm", minted.code);
      assert.equal(res.ok, false);
      assert.match(res.error, new RegExp(`Community ${MISSING_COMMUNITY} is not registered with this bot`));
      assert.equal(codeRowFor(minted.code).used_at, null, "no code burned by a bad caller community");
    });
  });

  // -------------------------------------------------------------------------
  // getLinkFor / removeLink
  // -------------------------------------------------------------------------

  describe("getLinkFor / removeLink", () => {
    it("getLinkFor reports the caller's link and peer from their own side", async () => {
      const made = await service.createLinkCode(dcMain, "disc-status");
      const link = await service.redeemLinkCode(fxMain, "flux-status", made.code);
      assert.equal(link.ok, true, link.error || "");

      const fromDiscord = service.getLinkFor(dcMain, "disc-status");
      assert.equal(fromDiscord.ok, true);
      assert.equal(fromDiscord.link.id, link.link.id);
      assert.equal(fromDiscord.side, "a");
      assert.equal(fromDiscord.peer.userId, "flux-status");
      assert.equal(fromDiscord.peer.platform, "fluxer");

      const fromFluxer = service.getLinkFor(fxMain, "flux-status");
      assert.equal(fromFluxer.ok, true);
      assert.equal(fromFluxer.side, "b");
      assert.equal(fromFluxer.peer.platform, "discord");
      assert.equal(fromFluxer.peer.userId, "disc-status");
    });

    it("getLinkFor for an unlinked user is a success with no link", () => {
      const res = service.getLinkFor(dcMain, "disc-not-linked");
      assert.equal(res.ok, true);
      assert.equal(res.link, null);
      assert.equal(res.peer, null);
      assert.equal(res.side, null);
    });

    it("removeLink requires a party, deletes the row, and states the non-retroactive rule", async () => {
      const made = await service.createLinkCode(dcMain, "disc-drop");
      const link = await service.redeemLinkCode(fxMain, "flux-drop", made.code);
      assert.equal(link.ok, true, link.error || "");

      const stranger = service.removeLink(dcMain, "disc-stranger");
      assert.equal(stranger.ok, false);
      assert.match(stranger.error, /has no account link to remove/);
      assert.ok(api.getUserLinkById(dcMain, link.link.id), "a non-party cannot delete it");

      const removed = service.removeLink(fxMain, "flux-drop");
      assert.equal(removed.ok, true, removed.error || "");
      assert.equal(removed.link.id, link.link.id);
      assert.match(removed.note, /XP and memories already mirrored .* stay in place/);
      assert.match(removed.note, /mirroring stops from now on/);

      assert.equal(api.getUserLinkFor(dcMain, "disc-drop"), null);
      assert.equal(api.getUserLinkFor(fxMain, "flux-drop"), null);

      const again = service.removeLink(dcMain, "disc-drop");
      assert.equal(again.ok, false, "second removal is a specific no-op");
      assert.match(again.error, /has no account link to remove/);
    });
  });

  // -------------------------------------------------------------------------
  // configureMirror
  // -------------------------------------------------------------------------

  describe("configureMirror", () => {
    let cfg; // { linkId }

    before(async () => {
      const minted = await service.createLinkCode(dcMain, "disc-cfg");
      const made = await service.redeemLinkCode(fxMain, "flux-cfg", minted.code);
      assert.equal(made.ok, true, made.error || "");
      cfg = { linkId: made.link.id };
    });

    it("stores per-direction percentages from either side", async () => {
      const one = await service.configureMirror(dcMain, "disc-cfg", { direction: "a_to_b", pct: 50 });
      assert.equal(one.ok, true, one.error || "");
      assert.equal(one.link.mirror_a_to_b_pct, 50);
      assert.deepEqual(one.applied, ["a_to_b=50"]);

      // From the Fluxer side, "to-discord" is b→a.
      const two = await service.configureMirror(fxMain, "flux-cfg", { direction: "to-discord", pct: 30 });
      assert.equal(two.ok, true, two.error || "");
      assert.equal(two.link.mirror_b_to_a_pct, 30);
      assert.equal(two.link.mirror_a_to_b_pct, 50, "the other direction is untouched");

      // From Discord, "to-fluxer" is a→b.
      const three = await service.configureMirror(dcMain, "disc-cfg", { direction: "to-fluxer", pct: 70 });
      assert.equal(three.ok, true);
      assert.equal(three.link.mirror_a_to_b_pct, 70);
      assert.equal(three.link.mirror_b_to_a_pct, 30);

      // "both" sets each direction to the same rate.
      const four = await service.configureMirror(dcMain, "disc-cfg", { direction: "both", pct: 25 });
      assert.equal(four.ok, true);
      assert.equal(four.link.mirror_a_to_b_pct, 25);
      assert.equal(four.link.mirror_b_to_a_pct, 25);
      assert.deepEqual(four.applied, ["a_to_b=25", "b_to_a=25"]);
      assert.deepEqual(four.mirror, { a_to_b_pct: 25, b_to_a_pct: 25, memory: true });
    });

    it("flips the gork memory switch", async () => {
      const off = await service.configureMirror(dcMain, "disc-cfg", { mirrorMemory: false });
      assert.equal(off.ok, true, off.error || "");
      assert.equal(off.link.mirror_memory, 0);
      assert.deepEqual(off.applied, ["mirror_memory=0"]);

      const on = await service.configureMirror(fxMain, "flux-cfg", { mirrorMemory: 1 });
      assert.equal(on.ok, true);
      assert.equal(on.link.mirror_memory, 1);

      const truthy = await service.configureMirror(dcMain, "disc-cfg", { mirrorMemory: "yes" });
      assert.equal(truthy.ok, false);
      assert.match(truthy.error, /mirror_memory must be on \(true\/1\) or off \(false\/0\)/);
    });

    it("rejects out-of-range, fractional, and non-number percentages with the range sentence", async () => {
      for (const bad of [101, -1, 55.5, "50", null, NaN, Infinity, 100.5]) {
        const res = await service.configureMirror(dcMain, "disc-cfg", { direction: "a_to_b", pct: bad });
        assert.equal(res.ok, false, `${String(bad)} must be rejected`);
        assert.match(res.error, /must be a whole number between 0 and 100/);
        assert.deepEqual(res.applied, [], "a rejected pct writes nothing");
      }
      const link = api.getUserLinkFor(dcMain, "disc-cfg");
      assert.equal(link.mirror_a_to_b_pct, 25, "rejects leave the row alone");
    });

    it("rejects unknown direction tokens with the legal choices", async () => {
      const res = await service.configureMirror(dcMain, "disc-cfg", { direction: "sideways", pct: 50 });
      assert.equal(res.ok, false);
      assert.match(res.error, /That is not a mirror direction/);
      assert.match(res.error, /to-fluxer, from-fluxer, both, a_to_b, b_to_a/);

      // A Fluxer caller gets Fluxer-relative choices.
      const fromFluxer = await service.configureMirror(fxMain, "flux-cfg", { direction: "sideways", pct: 50 });
      assert.equal(fromFluxer.ok, false);
      assert.match(fromFluxer.error, /to-discord, from-discord/);
    });

    it("requires a percentage with a direction and something to change", async () => {
      const noPct = await service.configureMirror(dcMain, "disc-cfg", { direction: "to-fluxer" });
      assert.equal(noPct.ok, false);
      assert.match(noPct.error, /needs a percentage with its direction/);

      const pctOnly = await service.configureMirror(dcMain, "disc-cfg", { pct: 50 });
      assert.equal(pctOnly.ok, false);
      assert.match(pctOnly.error, /needs a percentage with its direction/);

      const empty = await service.configureMirror(dcMain, "disc-cfg", {});
      assert.equal(empty.ok, false);
      assert.match(empty.error, /Nothing to change/);
    });

    it("applies pct before memory and stops at the first refusal", async () => {
      const res = await service.configureMirror(dcMain, "disc-cfg", {
        direction: "to-fluxer",
        pct: 150,
        mirrorMemory: false,
      });
      assert.equal(res.ok, false);
      assert.match(res.error, /must be a whole number between 0 and 100/);
      assert.deepEqual(res.applied, [], "nothing partial was applied");
      const link = api.getUserLinkFor(dcMain, "disc-cfg");
      assert.equal(link.mirror_a_to_b_pct, 25, "pct untouched");
      assert.equal(link.mirror_memory, 1, "memory untouched — the batch aborted");
    });

    it("applies pct and memory together when both are valid", async () => {
      const res = await service.configureMirror(dcMain, "disc-cfg", {
        direction: "from-fluxer",
        pct: 60,
        mirrorMemory: false,
      });
      assert.equal(res.ok, true, res.error || "");
      assert.equal(res.link.mirror_b_to_a_pct, 60);
      assert.equal(res.link.mirror_memory, 0);
      assert.deepEqual(res.applied, ["b_to_a=60", "mirror_memory=0"]);
    });

    it("refuses to configure a user with no link, naming the next step", async () => {
      const res = await service.configureMirror(dcMain, "disc-unlinked", { pct: 50, direction: "to-fluxer" });
      assert.equal(res.ok, false);
      assert.match(res.error, /has no account link to configure/);
      assert.match(res.error, /\/link create mints a code and \/link connect creates the link/);
    });

    it("refuses a stored link that pairs two communities on the same platform", async () => {
      // Forge a corrupt row: two Discord communities (service never makes one).
      const forged = api.createUserLink({
        communityIdA: dcAlpha,
        userIdA: "disc-bad-pair",
        communityIdB: dcBeta,
        userIdB: "flux-pretender",
      });
      assert.equal(forged.ok, true, forged.error || "");

      const res = await service.configureMirror(dcAlpha, "disc-bad-pair", { direction: "both", pct: 50 });
      assert.equal(res.ok, false);
      assert.match(
        res.error,
        new RegExp(
          `Stored link between communities ${dcAlpha} and ${dcBeta} joins two Discord communities`,
        ),
      );
      assert.match(res.error, /data problem the bot cannot mirror/);
      assert.match(res.error, /\/link remove/);
    });
  });

  // -------------------------------------------------------------------------
  // resolveMirrorTarget / expandLinkedIds (T4 / T5 seams)
  // -------------------------------------------------------------------------

  describe("resolveMirrorTarget", () => {
    let pair;

    before(async () => {
      const minted = await service.createLinkCode(dcMain, "disc-mirror");
      const made = await service.redeemLinkCode(fxMain, "flux-mirror", minted.code);
      assert.equal(made.ok, true, made.error || "");
      pair = made.link;
    });

    it("maps a side-a source to the Fluxer target with the a→b rate", () => {
      const res = service.resolveMirrorTarget(dcMain, "disc-mirror");
      assert.equal(res.ok, true);
      assert.equal(res.link.id, pair.id);
      assert.equal(res.mirror.sourceCommunityId, dcMain);
      assert.equal(res.mirror.sourceUserId, "disc-mirror");
      assert.equal(res.mirror.targetCommunityId, fxMain);
      assert.equal(res.mirror.targetUserId, "flux-mirror");
      assert.equal(res.mirror.direction, "a_to_b");
      assert.equal(res.mirror.pct, 100);
      assert.equal(res.mirror.mirrorMemory, true);
    });

    it("maps a side-b source to the Discord target with the b→a rate", () => {
      // Set the two directions to distinguishable rates.
      assert.equal(api.setUserLinkMirrorPct(dcMain, "disc-mirror", "a_to_b", 80).ok, true);
      assert.equal(api.setUserLinkMirrorPct(dcMain, "disc-mirror", "b_to_a", 60).ok, true);

      const fromFluxer = service.resolveMirrorTarget(fxMain, "flux-mirror");
      assert.equal(fromFluxer.ok, true);
      assert.equal(fromFluxer.mirror.targetCommunityId, dcMain);
      assert.equal(fromFluxer.mirror.targetUserId, "disc-mirror");
      assert.equal(fromFluxer.mirror.direction, "b_to_a");
      assert.equal(fromFluxer.mirror.pct, 60, "the source side's own column drives the rate");

      const fromDiscord = service.resolveMirrorTarget(dcMain, "disc-mirror");
      assert.equal(fromDiscord.mirror.pct, 80);
    });

    it("treats pct 0 as a no-op mirror, not an error", () => {
      assert.equal(api.setUserLinkMirrorPct(fxMain, "flux-mirror", "b_to_a", 0).ok, true);
      const off = service.resolveMirrorTarget(fxMain, "flux-mirror");
      assert.equal(off.ok, true);
      assert.equal(off.mirror, null, "0% mirrors nothing");
      assert.equal(off.pct, 0);
      assert.equal(off.link.id, pair.id, "the link itself is still reported");
      // The opposite direction is unaffected.
      assert.equal(service.resolveMirrorTarget(dcMain, "disc-mirror").mirror.pct, 80);
    });

    it("reports no mirror for an unlinked identity", () => {
      const res = service.resolveMirrorTarget(dcMain, "disc-never-linked");
      assert.equal(res.ok, true);
      assert.equal(res.link, null);
      assert.equal(res.mirror, null);
      assert.equal(res.pct, 0);
    });

    it("throws loudly on identity-firewall misuse (fan-out hot path)", () => {
      assert.throws(() => service.resolveMirrorTarget("123456789012345678", "u"), /community id required/);
      assert.throws(() => service.resolveMirrorTarget(1.5, "u"), /community id required/);
      assert.throws(() => service.resolveMirrorTarget(dcMain, 12345), /userId must be a non-empty string/);
    });
  });

  // -------------------------------------------------------------------------
  // mirror pct math + fanOutLinkedXp (T4 XP fan-out seam)
  // -------------------------------------------------------------------------

  describe("mirror pct math (T4 fan-out seam)", () => {
    /** Records every award the fan-out hands to the award machinery. */
    const awardCalls = [];
    const awardSpy = async (outbound, opts) => {
      awardCalls.push({ outbound, opts });
      return { newXp: 999, level: null, changes: null };
    };
    const stubOutbound = () => ({ platform: "stub", async fetchMember() { return null; } });

    before(async () => {
      const minted = await service.createLinkCode(dcMain, "disc-pct-math");
      assert.equal(minted.ok, true, minted.error || "");
      const made = await service.redeemLinkCode(fxMain, "flux-pct-math", minted.code);
      assert.equal(made.ok, true, made.error || "");
    });

    it("mirrorDelta rounds sign-preservingly at 0/50/100 and negative deltas", () => {
      assert.equal(service.mirrorDelta(10, 100), 10);
      assert.equal(service.mirrorDelta(-10, 100), -10);
      assert.equal(service.mirrorDelta(5, 50), 3, "50% of 5 = 3");
      assert.equal(service.mirrorDelta(-5, 50), -3, "50% of -5 = -3 (decay-safe)");
      assert.equal(service.mirrorDelta(0, 50), 0);
      assert.equal(service.mirrorDelta(10, 0), 0, "pct 0 mirrors nothing");
      assert.equal(service.mirrorDelta(-10, 0), 0);
      assert.equal(service.mirrorDelta(10, 33), 3);
      assert.equal(service.mirrorDelta(-10, 33), -3);
      assert.equal(service.mirrorDelta(1, 10), 0, "sub-rounding awards vanish");
      assert.equal(service.mirrorDelta(-1, 10), 0, "…without a sign artifact");
    });

    it("fans out at the a→b rate through the award machinery with loop-guard args", async () => {
      assert.equal(api.setUserLinkMirrorPct(dcMain, "disc-pct-math", "a_to_b", 50).ok, true);
      awardCalls.length = 0;

      const res = await service.fanOutLinkedXp(dcMain, "disc-pct-math", 10, "message", {
        getOutbound: stubOutbound,
        awardXp: awardSpy,
      });
      assert.deepEqual(res, { awarded: 5, warnings: [] }, "10 XP at 50% mirrors 5");
      assert.equal(awardCalls.length, 1, "exactly one target award");
      const opts = awardCalls[0].opts;
      assert.equal(opts.communityId, fxMain, "target is the peer community");
      assert.equal(opts.userId, "flux-pct-math", "target is the peer user");
      assert.equal(opts.delta, 5, "mirrored delta at the direction pct");
      assert.equal(opts.activityKind, "message", "activity kind forwarded unchanged");
      assert.equal(opts.member, null, "member fetched via the TARGET outbound");
      assert.equal(opts.source, "link_mirror", "audit source names the mirror");
      assert.equal(opts.fanOut, false, "LOOP GUARD: a mirror award never fans out again");
    });

    it("mirrors negative deltas negative (decay/admin subtraction symmetry)", async () => {
      awardCalls.length = 0;
      const res = await service.fanOutLinkedXp(dcMain, "disc-pct-math", -5, "message", {
        getOutbound: stubOutbound,
        awardXp: awardSpy,
      });
      assert.deepEqual(res, { awarded: -3, warnings: [] }, "50% of -5 mirrors -3, not +3");
      assert.equal(awardCalls.length, 1);
      assert.equal(awardCalls[0].opts.delta, -3);
    });

    it("pct 0 short-circuits: no target award, awarded null", async () => {
      assert.equal(api.setUserLinkMirrorPct(dcMain, "disc-pct-math", "a_to_b", 0).ok, true);
      awardCalls.length = 0;
      const res = await service.fanOutLinkedXp(dcMain, "disc-pct-math", 10, "message", {
        getOutbound: stubOutbound,
        awardXp: awardSpy,
      });
      assert.deepEqual(res, { awarded: null, warnings: [] });
      assert.equal(awardCalls.length, 0, "a 0% direction mirrors nothing");
    });

    it("a pct that rounds the award away reports awarded 0 without a target write", async () => {
      assert.equal(api.setUserLinkMirrorPct(dcMain, "disc-pct-math", "a_to_b", 10).ok, true);
      awardCalls.length = 0;
      const res = await service.fanOutLinkedXp(dcMain, "disc-pct-math", 1, "message", {
        getOutbound: stubOutbound,
        awardXp: awardSpy,
      });
      assert.deepEqual(res, { awarded: 0, warnings: [] });
      assert.equal(awardCalls.length, 0, "nothing written for a rounded-away award");
    });

    it("missing target client yields a specific warning and awards nothing", async () => {
      assert.equal(api.setUserLinkMirrorPct(dcMain, "disc-pct-math", "a_to_b", 100).ok, true);
      const res = await service.fanOutLinkedXp(dcMain, "disc-pct-math", 10, "message", {
        getOutbound: () => null,
      });
      assert.equal(res.awarded, null);
      assert.equal(res.warnings.length, 1);
      assert.match(res.warnings[0], new RegExp(`no client for target community ${fxMain}`));
    });

    it("a target award that throws degrades to a warning (fan-out never throws)", async () => {
      const boom = async () => {
        throw new Error("boom-target-award");
      };
      const res = await service.fanOutLinkedXp(dcMain, "disc-pct-math", 10, "message", {
        getOutbound: stubOutbound,
        awardXp: boom,
      });
      assert.equal(res.awarded, null);
      assert.equal(res.warnings.length, 1);
      assert.match(
        res.warnings[0],
        new RegExp(`mirror award of 10 XP to community ${fxMain} user flux-pct-math failed: boom-target-award`),
      );
    });

    it("unlinked identities fan out to nothing (no award, no warnings)", async () => {
      awardCalls.length = 0;
      const res = await service.fanOutLinkedXp(dcMain, "disc-never-linked-pct", 10, "message", {
        getOutbound: stubOutbound,
        awardXp: awardSpy,
      });
      assert.deepEqual(res, { awarded: null, warnings: [] });
      assert.equal(awardCalls.length, 0);
    });

    it("never throws on identity-firewall misuse (snowflake as community id)", async () => {
      const res = await service.fanOutLinkedXp("123456789012345678", "disc-pct-math", 10, "message");
      assert.equal(res.awarded, null, "programmer errors degrade to warnings in the award hot path");
      assert.equal(res.warnings.length, 1);
      assert.match(res.warnings[0], /xp mirror failed/);
    });
  });

  describe("expandLinkedIds", () => {
    before(async () => {
      const minted = await service.createLinkCode(dcMain, "disc-fanout");
      const made = await service.redeemLinkCode(fxMain, "flux-fanout", minted.code);
      assert.equal(made.ok, true, made.error || "");
    });

    it("expands linked ids, skips unlinked/blank/non-strings, and carries mirror_memory", () => {
      const res = service.expandLinkedIds(dcMain, [
        "disc-fanout",
        "disc-fanout", // duplicate collapses
        "disc-plain", // never linked
        "", // blank
        "   ", // blank
        12345, // non-string
      ]);
      assert.equal(res.ok, true);
      assert.equal(res.skipped, 3, "two blanks + one non-string");
      assert.equal(res.targets.length, 1);
      assert.deepEqual(res.targets[0], {
        sourceUserId: "disc-fanout",
        targetCommunityId: fxMain,
        targetUserId: "flux-fanout",
        mirrorMemory: true,
      });
    });

    it("expands from the Fluxer side and honours mirror_memory=0 (still expands)", () => {
      assert.equal(api.setUserLinkMirrorMemory(dcMain, "disc-fanout", false).ok, true);
      const res = service.expandLinkedIds(fxMain, ["flux-fanout"]);
      assert.equal(res.ok, true);
      assert.equal(res.targets.length, 1);
      assert.deepEqual(res.targets[0], {
        sourceUserId: "flux-fanout",
        targetCommunityId: dcMain,
        targetUserId: "disc-fanout",
        mirrorMemory: false,
      });
      assert.equal(api.setUserLinkMirrorMemory(dcMain, "disc-fanout", true).ok, true);
    });

    it("returns nothing for a community with no links", () => {
      const res = service.expandLinkedIds(dcSolo, ["nobody-a", "nobody-b"]);
      assert.deepEqual(res.targets, []);
      assert.equal(res.skipped, 0);
    });

    it("throws on a non-array input and on a snowflake community id", () => {
      assert.throws(() => service.expandLinkedIds(dcMain, "disc-fanout"), /needs an array of user ids/);
      assert.throws(() => service.expandLinkedIds(dcMain, null), /needs an array of user ids/);
      assert.throws(() => service.expandLinkedIds("123456789012345678", []), /community id required/);
    });
  });

  // -------------------------------------------------------------------------
  // maintenance + module surface
  // -------------------------------------------------------------------------

  describe("maintenance and module surface", () => {
    it("purgeExpiredLinkCodes sweeps only codes at/before the cutoff", async () => {
      api.db.prepare(`DELETE FROM user_link_codes`).run(); // hermetic slice
      const t = 3_000_000_000_000;
      const expiring = await service.createLinkCode(dcMain, "disc-p1", { clock: () => t - LIFETIME_MS - 1000 });
      const living = await service.createLinkCode(dcMain, "disc-p2", { clock: () => t - LIFETIME_MS + 60_000 });
      assert.equal(expiring.ok, true);
      assert.equal(living.ok, true);

      const deleted = service.purgeExpiredLinkCodes(t);
      assert.ok(deleted >= 1, `expected at least one sweep, got ${deleted}`);
      assert.equal(api.getLinkCodeByHash(codes.hashLinkCode(expiring.code)), null, "expired swept");
      assert.ok(api.getLinkCodeByHash(codes.hashLinkCode(living.code)), "live code survives");
    });

    it("exposes the feature surface load.js expects (T3 fills the commands in)", () => {
      assert.equal(linking.name, "linking");
      assert.equal(linking.commands.length, 1, "/link ships in T3 (registry count 29→30)");
      assert.equal(linking.commands[0].name, "link");
      assert.equal(typeof linking.handlers.link, "function");
      assert.equal(linking.handlerApi.link, "context");
      for (const key of [
        "createLinkCode",
        "redeemLinkCode",
        "getLinkFor",
        "removeLink",
        "configureMirror",
        "resolveMirrorTarget",
        "expandLinkedIds",
        "purgeExpiredLinkCodes",
      ]) {
        assert.equal(typeof linking[key], "function", `module must export ${key}`);
      }
    });

    it("arms the code sweeper once and never throws when re-started", () => {
      const scheduler = require("../src/core/scheduler");
      assert.equal(scheduler.getJob(linking.CODE_SWEEP_JOB), null, "not armed yet");
      assert.equal(linking.start(null, {}), undefined);
      const job = scheduler.getJob(linking.CODE_SWEEP_JOB);
      assert.ok(job, "job registered on the shared scheduler");
      assert.equal(job.intervalMs, linking.CODE_SWEEP_INTERVAL_MS);
      assert.equal(job.name, linking.CODE_SWEEP_JOB);
      // The sweep body must never throw into a scheduler tick (AGENTS.md rule 1).
      assert.doesNotThrow(() => job.run());
      // Idempotency: repeated boot hooks are no-ops (load.js may run once,
      // tests and integrations may call them again).
      linking.start(null, {});
      linking.registerEvents(null, {});
      linking.registerEvents(null, {});
      assert.equal(linking.CODE_SWEEP_INTERVAL_MS, 60 * 60 * 1000);
    });
  });
});
