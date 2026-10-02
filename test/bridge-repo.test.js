/**
 * Bridge schema / repository / codes / expiry unit tests (roadmap/bridge.md
 * § Tests — "Pairing", "Disconnect", repo/codes/expiry rows).
 *
 * Everything runs against a fresh temp SQLite via loadDb() (real migrations,
 * FKs on at the driver level). No Discord, no Fluxer, no sockets.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { loadDb, communityKey, createTempDbPath } = require("./helpers/env");

const BRIDGE_TABLES = [
  "bridges",
  "bridge_ends",
  "bridge_outbox",
  "bridge_message_links",
  "bridge_src_snapshots",
  "bridge_connect_attempts",
];

const T0 = 1_700_000_000_000; // fixed epoch ms for clock-injected tests

describe("bridge repo (PR 2)", () => {
  /** @type {{ [k: string]: Function }} */
  let api;
  /** @type {{ sweepExpiredPendingBridges: Function, createSweepJobSpec: Function }} */
  let expire;
  /** @type {Record<string, Function>} */
  let codes;
  let cleanup;

  let guildA; // discord community
  let guildB; // fluxer community

  before(() => {
    // Contract: loadDb() before any other src/ require in this file.
    ({ api, cleanup } = loadDb());
    // codes/expire require the repository chain — load AFTER loadDb so they
    // bind to the temp DB (same contract as every src/ require in tests).
    codes = require("../src/features/bridge/codes");
    expire = require("../src/features/bridge/expire");
    guildA = communityKey("900000000000000001");
    guildB = communityKey("900000000000000002", "fluxer", "fluxer.example:8443");
  });

  after(() => cleanup?.());

  const tablePresent = (name) =>
    !!api.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(name);

  /** Tables keyed by bridge_id — the cascade's child set (bridges itself keys on id). */
  const CHILD_TABLES = [
    "bridge_ends",
    "bridge_outbox",
    "bridge_message_links",
    "bridge_src_snapshots",
  ];

  const countRows = (table, bridgeId) =>
    api.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE bridge_id = ?`).get(bridgeId).n;

  /** Create a pending bridge with the required minimum arguments. */
  const makeBridge = (overrides = {}) =>
    api.createBridge({
      publicId: codes.generatePublicId(),
      createdByUserId: "100000000000000001",
      endACommunityId: guildA,
      endAChannelId: "200000000000000001",
      ...overrides,
    });

  describe("migration 035", () => {
    it("is registered in migrate.js and creates all six tables", () => {
      const { migrations } = require("../src/db/migrate");
      assert.ok(
        migrations.some((m) => m.id === "035_bridges"),
        "035_bridges must be registered in migrate.js",
      );
      for (const table of BRIDGE_TABLES) {
        assert.ok(tablePresent(table), `missing table: ${table}`);
      }
    });

    it("re-running all migrations (incl. 035) is idempotent", () => {
      const { runMigrations } = require("../src/db/migrate");
      assert.doesNotThrow(() => runMigrations());
      assert.doesNotThrow(() => runMigrations());
    });

    it("up() refuses to run without the communities table (034 dependency)", () => {
      const Database = require("better-sqlite3");
      const migration = require("../src/db/migrations/035_bridges");
      const { dbPath, dbs, cleanup: bareCleanup } = createTempDbPath();
      const bare = new Database(dbPath);
      dbs.push(bare);
      const tableExists = (name) =>
        !!bare.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);

      assert.throws(
        () => migration.up(bare, { tableExists }),
        /communities.*must run first|communities.*missing/i,
      );

      bare.exec(`
        CREATE TABLE communities (
          id INTEGER PRIMARY KEY,
          platform TEXT, instance_key TEXT, external_guild_id TEXT, created_at INTEGER
        );
      `);
      assert.doesNotThrow(() => migration.up(bare, { tableExists }));
      assert.doesNotThrow(() => migration.up(bare, { tableExists }), "up() must be idempotent");
      for (const table of BRIDGE_TABLES) {
        assert.ok(
          !!bare.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table),
          `fresh DB missing table: ${table}`,
        );
      }
      bareCleanup();
    });

    it("CHECK constraints reject invalid state/direction/position/kind", () => {
      const bridge = makeBridge({ endAChannelId: "200000000000000090" });
      const insert = (sql, ...args) => () => api.db.prepare(sql).run(...args);

      assert.throws(
        insert(
          `INSERT INTO bridges (public_id, state, created_at, created_by_user_id) VALUES ('b_zzzzzzzz', 'draft', ?, 'u')`,
          T0,
        ),
        (err) => err.code === "SQLITE_CONSTRAINT_CHECK",
        "state CHECK rejects unknown states",
      );
      assert.throws(
        insert(
          `INSERT INTO bridges (public_id, state, direction, created_at, created_by_user_id) VALUES ('b_zzzzzzzy', 'pending', 'a_to_a', ?, 'u')`,
          T0,
        ),
        (err) => err.code === "SQLITE_CONSTRAINT_CHECK",
        "direction CHECK rejects non-KD19 values",
      );
      assert.throws(
        insert(
          `INSERT INTO bridge_ends (bridge_id, position, community_id, channel_id) VALUES (?, 'c', ?, '999')`,
          bridge.id,
          guildA,
        ),
        (err) => err.code === "SQLITE_CONSTRAINT_CHECK",
        "position CHECK allows only a/b",
      );
      assert.throws(
        insert(
          `INSERT INTO bridge_outbox (bridge_id, direction, src_message_id, enqueued_at, state, payload_json)
           VALUES (?, 'both', '1', ?, 'pending', '{}')`,
          bridge.id,
          T0,
        ),
        (err) => err.code === "SQLITE_CONSTRAINT_CHECK",
      );
      // kind CHECK: note the explicit kind column — state has no CHECK by spec.
      assert.throws(
        insert(
          `INSERT INTO bridge_outbox (bridge_id, direction, kind, src_message_id, enqueued_at, state, payload_json)
           VALUES (?, 'a_to_b', 'forward', '1', ?, 'pending', '{}')`,
          bridge.id,
          T0,
        ),
        (err) => err.code === "SQLITE_CONSTRAINT_CHECK",
      );
    });

    it("UNIQUE (community_id, channel_id) is enforced at the schema level", () => {
      const bridge = makeBridge({ endAChannelId: "200000000000000091" });
      assert.throws(
        () =>
          api.db
            .prepare(
              `INSERT INTO bridge_ends (bridge_id, position, community_id, channel_id) VALUES (?, 'b', ?, '200000000000000091')`,
            )
            .run(bridge.id, guildA),
        /UNIQUE constraint failed: bridge_ends.community_id, bridge_ends.channel_id/,
      );
    });
  });

  describe("codes (§10.1, pure — no DB needed beyond module load order)", () => {
    const CODE_SHAPE = /^BRG-[0-9A-HJ-KM-NP-TV-Z]{4}(-[0-9A-HJ-KM-NP-TV-Z]{4}){4}-[0-9A-HJ-KM-NP-TV-Z]{2}$/;

    it("generateConnectCode mints a 22-char canonical code from 128 random bits", () => {
      const minted = codes.generateConnectCode();
      assert.match(minted.displayCode, CODE_SHAPE);
      assert.equal(minted.canonical.length, 22);
      assert.equal(Buffer.isBuffer(minted.digest), true);
      assert.equal(minted.digest.length, 32, "sha256 digest is 32 bytes");
      // Canonical form is the display code stripped of BRG and dashes.
      assert.equal(
        codes.canonicalizeConnectCode(minted.displayCode),
        minted.canonical,
        "display → canonical round-trip",
      );
    });

    it("hashing is case/space/dash/BRG-insensitive and matches the minted digest", () => {
      const minted = codes.generateConnectCode();
      const variants = [
        minted.canonical,
        minted.canonical.toLowerCase(),
        codes.formatDisplayCode(minted.canonical),
        minted.canonical.toLowerCase().split("").join(" "),
        ` brg-${minted.canonical.toLowerCase().replace(/(.{4})(?=.)/g, "$1-")}  `,
      ];
      for (const variant of variants) {
        assert.equal(
          codes.digestsEqual(minted.digest, codes.hashConnectCode(variant)),
          true,
          `variant must hash to the minted digest: ${JSON.stringify(variant)}`,
        );
      }
    });

    it("formatDisplayCode groups 4-4-4-4-4-2 (canonical 22 chars)", () => {
      const canonical = "A".repeat(8) + "BBBB" + "CCCC" + "DDDD" + "EF"; // 22 chars
      assert.equal(canonical.length, 22);
      assert.equal(codes.formatDisplayCode(canonical), "AAAA-AAAA-BBBB-CCCC-DDDD-EF");
      // Non-22 canonical strings pass through untouched (formatting never validates).
      assert.equal(codes.formatDisplayCode("ABCD"), "ABCD");
    });

    it("generatePublicId returns canonical handles and retries collisions", () => {
      for (let i = 0; i < 200; i++) {
        const id = codes.generatePublicId();
        assert.match(id, /^b_[0-9a-hjkmnp-tv-z]{8}$/);
      }
      // Collision retry: first three candidates are "taken".
      let probes = 0;
      const id = codes.generatePublicId({ isTaken: () => ++probes <= 3 });
      assert.match(id, /^b_[0-9a-hjkmnp-tv-z]{8}$/);
      assert.equal(probes, 4, "the accepted handle must be the 4th candidate");
      // Endless collision is a loud failure, never an infinite loop.
      assert.throws(() => codes.generatePublicId({ isTaken: () => true }), /collisions/);
    });

    it("handle inputs are trimmed + lowercased and never reach the hasher", () => {
      assert.equal(codes.normalizeHandle("  B_7K2M9QXP "), "b_7k2m9qxp");
      assert.equal(codes.isBridgeHandle("B_7K2M9QXP"), true);
      assert.equal(codes.isBridgeHandle(" b_7k2m9qxp "), true, "validation runs on the normalized form");
      assert.equal(codes.isBridgeHandle("b_7k2m9"), false, "7 chars is not a handle");
      assert.equal(codes.isBridgeHandle("b_7k2m9qxo"), false, "O is not a Crockford char");
      assert.throws(
        () => codes.hashConnectCode("B_7K2M9QXP"),
        (err) => err instanceof TypeError && /never run through the code hasher/.test(err.message),
      );
    });

    it("classifyConnectInput splits handle / alphabet garbage / well-formed code / empty", () => {
      assert.deepEqual(codes.classifyConnectInput("B_7K2M9QXP"), { kind: "handle", publicId: "b_7k2m9qxp" });
      assert.deepEqual(codes.classifyConnectInput("   "), { kind: "empty" });
      assert.deepEqual(codes.classifyConnectInput(null), { kind: "empty" });
      // Alphabet garbage: O and U (and underscores) are not Crockford characters.
      const garbage = codes.classifyConnectInput("BRG-" + "AAAA".repeat(5) + "-OO");
      assert.equal(garbage.kind, "garbage");
      assert.equal(garbage.canonical, "A".repeat(20) + "OO");
      assert.equal(
        codes.classifyConnectInput("B_7K2M9QX").kind,
        "garbage",
        "a handle-shaped string of the wrong length is alphabet garbage (underscore)",
      );
      // Well-formed: every Crockford char, any length (a lookup miss, counted).
      assert.deepEqual(codes.classifyConnectInput("brg-" + "aaaa".repeat(5) + "-aa"), {
        kind: "code",
        canonical: "A".repeat(22),
      });
    });

    it("digestsEqual is false for non-digests, true for equal digests", () => {
      const minted = codes.generateConnectCode();
      assert.equal(codes.digestsEqual(minted.digest, minted.digest), true);
      assert.equal(codes.digestsEqual(minted.digest, crypto.randomBytes(32)), false);
      assert.equal(codes.digestsEqual(minted.digest, Buffer.alloc(16)), false, "length mismatch is false, never a throw");
      assert.equal(codes.digestsEqual(null, minted.digest), false);
      assert.equal(codes.digestsEqual("a".repeat(32), minted.digest), false);
    });

    it("codes carry enough entropy to never repeat in practice", () => {
      const seen = new Set();
      for (let i = 0; i < 500; i++) seen.add(codes.generateConnectCode().canonical);
      assert.equal(seen.size, 500);
    });
  });

  describe("bridges + ends CRUD", () => {
    it("createBridge stores a pending row + end A with digest and 30-minute default expiry", () => {
      const minted = codes.generateConnectCode();
      const bridge = api.createBridge({
        publicId: codes.generatePublicId(),
        createdByUserId: "100000000000000002",
        endACommunityId: guildA,
        endAChannelId: "200000000000000010",
        direction: "a_to_b",
        codeHash: minted.digest,
        nsfw: true,
        everyoneDeniedView: 1,
      });
      assert.equal(bridge.state, "pending", "repo never writes active");
      assert.equal(bridge.direction, "a_to_b");
      assert.equal(bridge.expires_at - bridge.created_at, api.BRIDGE_CODE_LIFETIME_MS);
      assert.equal(bridge.created_by_user_id, "100000000000000002");
      assert.equal(codes.digestsEqual(Buffer.from(bridge.code_hash), minted.digest), true);

      const fetched = api.getBridgeById(bridge.id);
      assert.equal(fetched.public_id, bridge.public_id);
      assert.equal(api.getBridgeByPublicId(bridge.public_id).id, bridge.id);
      assert.equal(api.getBridgeByCodeHash(minted.digest).id, bridge.id, "digest lookup round-trips");
      assert.equal(api.getBridgeByCodeHash(crypto.randomBytes(32)), null);

      const ends = api.listBridgeEnds(bridge.id);
      assert.equal(ends.length, 1, "pending bridges have only end A");
      assert.equal(ends[0].position, "a");
      assert.equal(ends[0].community_id, guildA);
      assert.equal(ends[0].channel_id, "200000000000000010");
      assert.equal(ends[0].nsfw, 1);
      assert.equal(ends[0].everyone_denied_view, 1);

      const byChannel = api.getBridgeForChannel(guildA, "200000000000000010");
      assert.equal(byChannel.bridge.id, bridge.id);
      assert.equal(byChannel.end.position, "a");
    });

    it("createBridge rejects garbage arguments (programmer errors throw)", () => {
      assert.throws(() => api.createBridge({ publicId: "BRG-AAAA-AAAA", createdByUserId: "u", endACommunityId: guildA, endAChannelId: "c" }), /publicId must match/);
      assert.throws(() => api.createBridge({ publicId: "b_7k2m9qxp", createdByUserId: " ", endACommunityId: guildA, endAChannelId: "c" }), /createdByUserId/);
      assert.throws(
        () => api.createBridge({ publicId: "b_7k2m9qxp", createdByUserId: "u", endACommunityId: "900000000000000001", endAChannelId: "c" }),
        /community id required/,
      );
      assert.throws(
        () => api.createBridge({ publicId: "b_7k2m9qxp", createdByUserId: "u", endACommunityId: guildA, endAChannelId: "c", direction: "to-fluxer" }),
        /direction must be one of/,
      );
      assert.throws(
        () => api.createBridge({ publicId: "b_7k2m9qxp", createdByUserId: "u", endACommunityId: guildA, endAChannelId: "c", codeHash: Buffer.alloc(16) }),
        /32-byte/,
      );
    });

    it("a second create on a taken channel throws bridge_channel_taken and leaks no parent row", () => {
      const bridge = makeBridge({ endAChannelId: "200000000000000020" });
      const bridgesBefore = api.db.prepare(`SELECT COUNT(*) AS n FROM bridges`).get().n;
      assert.throws(
        () =>
          api.createBridge({
            publicId: codes.generatePublicId(),
            createdByUserId: "u",
            endACommunityId: guildA,
            endAChannelId: "200000000000000020",
          }),
        (err) => err.code === "bridge_channel_taken" && /already a bridge end/.test(err.message),
      );
      assert.equal(
        api.db.prepare(`SELECT COUNT(*) AS n FROM bridges`).get().n,
        bridgesBefore,
        "the rolled-back create must not leave a bridges row",
      );
      assert.equal(api.listBridgeEnds(bridge.id).length, 1);
    });

    it("the same channel on the other platform is a valid end (no cross-platform aliasing)", () => {
      const bridge = makeBridge({ endAChannelId: "200000000000000030" });
      const endB = api.addBridgeEnd({
        bridgeId: bridge.id,
        position: "b",
        communityId: guildB,
        channelId: "200000000000000030",
      });
      assert.equal(endB.position, "b");
      assert.equal(endB.community_id, guildB, "the same channel id on the other community is a distinct pair");
      assert.throws(
        () => api.addBridgeEnd({ bridgeId: bridge.id, position: "a", communityId: guildB, channelId: "999" }),
        /PRIMARY KEY|UNIQUE/,
      );
      assert.throws(() => api.addBridgeEnd({ bridgeId: bridge.id, position: "c", communityId: guildB, channelId: "999" }), /position/);
      assert.equal(api.getBridgeEndForChannel(guildB, "200000000000000030").bridge_id, bridge.id);
    });

    it("webhook + flag setters round-trip on an end", () => {
      const bridge = makeBridge({ endAChannelId: "200000000000000031" });
      assert.equal(
        api.setBridgeEndWebhook(bridge.id, "a", {
          webhookId: "500000000000000001",
          tokenEnc: "v1.iv.tag.ciphertext",
          uploadLimitBytes: 52_428_800,
        }),
        true,
      );
      const end = api.getBridgeEndForChannel(guildA, "200000000000000031");
      assert.equal(end.webhook_id, "500000000000000001");
      assert.equal(end.webhook_token_enc, "v1.iv.tag.ciphertext");
      assert.equal(end.upload_limit_bytes, 52_428_800);
      assert.equal(api.setBridgeEndWebhook(999999, "a", { webhookId: "1" }), false);
      assert.throws(() => api.setBridgeEndWebhook(bridge.id, "a", { tokenEnc: 42 }), /envelope/);

      assert.equal(api.setBridgeEndFlags(bridge.id, "a", { nsfw: true }), true);
      assert.equal(api.getBridgeEndForChannel(guildA, "200000000000000031").nsfw, 1);
      assert.equal(api.setBridgeEndFlags(bridge.id, "b", { nsfw: true }), false, "missing end is a no-op");
    });

    it("listBridgesForCommunity returns bridge+end pairs oldest first", () => {
      const first = api.createBridge({
        publicId: codes.generatePublicId(),
        createdByUserId: "u",
        endACommunityId: guildB,
        endAChannelId: "300000000000000001",
      });
      const second = api.createBridge({
        publicId: codes.generatePublicId(),
        createdByUserId: "u",
        endACommunityId: guildB,
        endAChannelId: "300000000000000002",
        direction: "b_to_a",
      });
      const listed = api.listBridgesForCommunity(guildB);
      // The shared DB carries an end-B from the earlier cross-platform test,
      // so assert the CONTRACT (membership, stable oldest-first order), not
      // an exact row set.
      for (const row of listed) {
        assert.equal(row.end.community_id, guildB, "list is scoped to the requested community");
      }
      const ids = listed.map((row) => row.bridge.id);
      assert.ok(ids.includes(first.id), "first created bridge is listed");
      assert.ok(ids.includes(second.id), "second created bridge is listed");
      assert.ok(
        ids.indexOf(first.id) < ids.indexOf(second.id),
        "oldest-first: earlier create precedes later create",
      );
      const created = listed.map((row) => row.bridge.created_at);
      assert.deepEqual(
        [...created].sort((a, b) => a - b),
        created,
        "created_at is non-decreasing across the listing",
      );
      assert.deepEqual(
        listed
          .filter((row) => row.bridge.id === first.id || row.bridge.id === second.id)
          .map((row) => [row.bridge.id, row.end.channel_id]),
        [
          [first.id, "300000000000000001"],
          [second.id, "300000000000000002"],
        ],
      );
    });
  });

  describe("outbox (FIFO per direction, coalescing, poison ladder)", () => {
    it("enqueue → claim is FIFO by (direction, enqueued_at); one-pending-edit replaces in place", () => {
      const bridge = makeBridge({ endAChannelId: "400000000000000001" });
      const bId = bridge.id;

      const createA = api.enqueueBridgeOutbox(bId, { direction: "a_to_b", srcMessageId: "m-1", enqueuedAt: T0 + 300 });
      assert.equal(createA.state, "pending");
      assert.equal(createA.kind, "create");
      assert.throws(
        () => api.enqueueBridgeOutbox(bId, { direction: "a_to_b", srcMessageId: "m-1", enqueuedAt: T0 + 400 }),
        (err) => err.code === "bridge_outbox_duplicate",
        "UNIQUE (bridge, direction, src, kind) is the one-per-message rule",
      );

      api.enqueueBridgeOutbox(bId, { direction: "b_to_a", srcMessageId: "m-0", enqueuedAt: T0 + 900 });
      api.enqueueBridgeOutbox(bId, { direction: "a_to_b", srcMessageId: "m-2", enqueuedAt: T0 + 100 });
      api.enqueueBridgeOutbox(bId, { direction: "a_to_b", srcMessageId: "m-3", enqueuedAt: T0 + 200 });

      const claimed = [];
      for (let i = 0; i < 4; i++) claimed.push(api.claimNextOutboxRow(bId, "a_to_b"));
      assert.deepEqual(
        claimed.map((row) => row?.src_message_id ?? null),
        ["m-2", "m-3", "m-1", null],
        "FIFO by enqueued_at; a_to_b is drained after 3 rows",
      );
      assert.equal(claimed[0].state, "sending");
      assert.equal(api.claimNextOutboxRow(bId, "a_to_b"), null);
      // The other direction is an independent queue.
      const firstB2A = api.claimNextOutboxRow(bId, "b_to_a");
      assert.equal(firstB2A.src_message_id, "m-0");
      // Drain: worker ACKs every claimed row so no 'sending' rows leak into
      // the restart test below.
      for (const row of [...claimed, firstB2A]) {
        if (row) assert.equal(api.markOutboxDone(row.id), true);
      }

      // One-pending-edit rule: the second edit replaces the pending row's
      // payload and keeps its queue slot (same id, same enqueued_at).
      const b2 = makeBridge({ endAChannelId: "400000000000000002" });
      const edit1 = api.enqueueBridgeOutbox(b2.id, { direction: "a_to_b", kind: "edit", srcMessageId: "m-9", payload: { text: "v1" }, enqueuedAt: T0 });
      const edit2 = api.enqueueBridgeOutbox(b2.id, { direction: "a_to_b", kind: "edit", srcMessageId: "m-9", payload: { text: "v2" }, enqueuedAt: T0 + 50 });
      assert.equal(edit2.id, edit1.id, "coalesced edit keeps one row");
      assert.equal(edit2.payload_json, JSON.stringify({ text: "v2" }));
      assert.equal(edit2.enqueued_at, T0, "coalesced edit keeps its FIFO slot");
      assert.equal(
        api.db.prepare(`SELECT COUNT(*) AS n FROM bridge_outbox WHERE bridge_id=? AND kind='edit'`).get(b2.id).n,
        1,
      );

      // Delete supersession: pending create/edit rows for the source go away.
      const del = api.enqueueBridgeOutbox(b2.id, { direction: "a_to_b", kind: "delete", srcMessageId: "m-9" });
      assert.equal(del.kind, "delete");
      assert.equal(
        api.db
          .prepare(`SELECT COUNT(*) AS n FROM bridge_outbox WHERE bridge_id=? AND kind IN ('create','edit')`)
          .get(b2.id).n,
        0,
        "a takedown supersedes copies in flight",
      );

      assert.throws(() => api.enqueueBridgeOutbox(999999, { direction: "a_to_b", srcMessageId: "m" }), /does not exist/);
      assert.throws(() => api.enqueueBridgeOutbox(bId, { direction: "both", srcMessageId: "m" }), /relay direction must be/);
      assert.throws(() => api.enqueueBridgeOutbox(bId, { direction: "a_to_b", kind: "forward", srcMessageId: "m" }), /kind must be/);
      assert.throws(() => api.enqueueBridgeOutbox(bId, { direction: "a_to_b", srcMessageId: " " }), /srcMessageId/);
    });

    it("failure ladder parks at 5 attempts; restart requeues sending rows; depth counts queued rows", () => {
      const bridge = makeBridge({ endAChannelId: "400000000000000003" });
      const row = api.enqueueBridgeOutbox(bridge.id, { direction: "a_to_b", srcMessageId: "m-x" });

      for (let attempt = 1; attempt <= 4; attempt++) {
        const failed = api.recordOutboxFailure(row.id, `boom ${attempt}`);
        assert.equal(failed.attempts, attempt);
        assert.equal(failed.state, "pending", "under the poison limit the row retries");
        assert.equal(failed.last_error, `boom ${attempt}`);
      }
      const parked = api.recordOutboxFailure(row.id, "boom 5");
      assert.equal(parked.attempts, 5);
      assert.equal(parked.state, "failed", "the 5th failure parks the row (spec §10.10)");
      assert.equal(api.recordOutboxFailure(999999, "nope"), null);

      const queued = api.enqueueBridgeOutbox(bridge.id, { direction: "b_to_a", srcMessageId: "m-y" });
      api.claimNextOutboxRow(bridge.id, "b_to_a");
      assert.deepEqual(api.countOutboxDepth(bridge.id), { a_to_b: 0, b_to_a: 1 }, "parked rows do not count as depth");
      assert.equal(api.requeueStaleOutbox(), 1, "sending rows return to pending on restart");
      assert.equal(api.getBridgeOutboxById(queued.id).state, "pending");

      assert.equal(api.markOutboxDone(queued.id), true);
      assert.equal(api.getBridgeOutboxById(queued.id).state, "done");
      assert.equal(api.markOutboxDone(queued.id), false, "done rows are final");
      assert.deepEqual(api.countOutboxDepth(bridge.id), { a_to_b: 0, b_to_a: 0 });
    });
  });

  describe("links, snapshots, state flags", () => {
    it("links round-trip ordered by part_index; destination lookup resolves the echo gate", () => {
      const bridge = makeBridge({ endAChannelId: "400000000000000004" });
      const link1 = api.addBridgeMessageLink({
        bridgeId: bridge.id,
        srcCommunityId: guildA,
        srcMessageId: "m-100",
        partIndex: 1,
        dstMessageId: "d-2",
      });
      const link0 = api.addBridgeMessageLink({
        bridgeId: bridge.id,
        srcCommunityId: guildA,
        srcMessageId: "m-100",
        partIndex: 0,
        dstMessageId: "d-1",
      });
      assert.deepEqual(
        api.listBridgeMessageLinks(bridge.id, "m-100").map((l) => l.dst_message_id),
        ["d-1", "d-2"],
        "PARTS go in order (§10.7 chunking)",
      );
      assert.equal(Number.isInteger(link0.created_at), true);
      assert.equal(Number(link1.created_at) > 0, true);
      assert.equal(api.getBridgeLinkByDestination(bridge.id, "d-2").src_message_id, "m-100");
      assert.equal(api.getBridgeLinkByDestination(bridge.id, "d-9"), null);
      assert.throws(() => api.addBridgeMessageLink({ bridgeId: bridge.id, srcCommunityId: guildA, srcMessageId: "m", partIndex: -1, dstMessageId: "d" }), /part_index/);
      assert.throws(() => api.addBridgeMessageLink({ bridgeId: bridge.id, srcCommunityId: "900000000000000001", srcMessageId: "m", partIndex: 0, dstMessageId: "d" }), /community id required/);
    });

    it("src snapshots upsert (edit coalescing hash store)", () => {
      const bridge = makeBridge({ endAChannelId: "400000000000000005" });
      const first = api.upsertBridgeSrcSnapshot(bridge.id, "m-200", "hash-one");
      assert.equal(first.content_hash, "hash-one");
      const second = api.upsertBridgeSrcSnapshot(bridge.id, "m-200", "hash-two");
      assert.equal(second.content_hash, "hash-two");
      assert.equal(second.updated_at >= first.updated_at, true);
      assert.equal(api.getBridgeSrcSnapshot(bridge.id, "m-200").content_hash, "hash-two");
      assert.equal(api.getBridgeSrcSnapshot(bridge.id, "m-none"), null);
      assert.throws(() => api.upsertBridgeSrcSnapshot(bridge.id, "m", ""), /contentHash/);
    });

    it("markBridgeBroken only fires on active rows; last_error round-trips", () => {
      const bridge = makeBridge({ endAChannelId: "400000000000000006" });
      assert.equal(api.markBridgeBroken(bridge.id, "channel gone"), false, "pending never becomes broken");
      api.db.prepare(`UPDATE bridges SET state='active', connected_at=? WHERE id=?`).run(T0, bridge.id);
      assert.equal(api.markBridgeBroken(bridge.id, "destination channel is gone"), true);
      const broken = api.getBridgeById(bridge.id);
      assert.equal(broken.state, "broken");
      assert.equal(broken.broken_reason, "destination channel is gone");
      assert.equal(api.markBridgeBroken(bridge.id, "again"), false, "broken is terminal until disconnect");

      assert.equal(api.setBridgeLastError(bridge.id, "429 storm"), true);
      assert.equal(api.getBridgeById(bridge.id).last_error, "429 storm");
      assert.equal(api.setBridgeLastError(bridge.id, null), true);
      assert.equal(api.getBridgeById(bridge.id).last_error, null);
      assert.equal(api.setBridgeLastError(999999, "x"), false);
    });
  });

  describe("deleteBridgeCascade + expiry sweeper", () => {
    /** Populate every child table for a bridge. */
    const populate = (bridgeId) => {
      api.addBridgeEnd({ bridgeId, position: "b", communityId: guildB, channelId: `x${bridgeId}` });
      api.enqueueBridgeOutbox(bridgeId, { direction: "a_to_b", srcMessageId: "m-1" });
      api.enqueueBridgeOutbox(bridgeId, { direction: "b_to_a", srcMessageId: "m-1", kind: "edit", payload: { e: 1 } });
      api.addBridgeMessageLink({ bridgeId, srcCommunityId: guildA, srcMessageId: "m-1", partIndex: 0, dstMessageId: "d-1" });
      api.addBridgeMessageLink({ bridgeId, srcCommunityId: guildA, srcMessageId: "m-1", partIndex: 1, dstMessageId: "d-2" });
      api.upsertBridgeSrcSnapshot(bridgeId, "m-1", "sha-1");
    };

    it("child-then-parent delete leaves zero rows in all six tables", () => {
      const bridge = makeBridge({ endAChannelId: "500000000000000001" });
      populate(bridge.id);
      for (const table of ["bridge_ends", "bridge_outbox", "bridge_message_links", "bridge_src_snapshots"]) {
        assert.ok(countRows(table, bridge.id) > 0, `${table} should have child rows first`);
      }

      const counts = api.deleteBridgeCascade(bridge.id);
      assert.deepEqual(counts, {
        bridge_src_snapshots: 1,
        bridge_message_links: 2,
        bridge_outbox: 2,
        bridge_ends: 2,
        bridges: 1,
      });
      for (const table of CHILD_TABLES) {
        assert.equal(countRows(table, bridge.id), 0, `${table} must be empty after cascade`);
      }
      assert.equal(api.getBridgeById(bridge.id), null);
      assert.equal(api.getBridgeEndForChannel(guildB, `x${bridge.id}`), null, "end B is gone, so the channel is bridgeable again");
      assert.deepEqual(api.deleteBridgeCascade(bridge.id).bridges, 0, "second delete is a no-op");
    });

    it("sweeper deletes only expired PENDING rows — never active, never the future", () => {
      const expired = makeBridge({ endAChannelId: "600000000000000001", expiresAt: T0 + 60_000 });
      populate(expired.id);
      const future = makeBridge({ endAChannelId: "600000000000000002", expiresAt: T0 + 10 * 60_000 });
      const immortal = makeBridge({ endAChannelId: "600000000000000003", expiresAt: null });
      const active = makeBridge({
        endAChannelId: "600000000000000004",
        expiresAt: T0 - 1,
        codeHash: codes.generateConnectCode().digest,
      });
      api.db.prepare(`UPDATE bridges SET state='active', connected_at=? WHERE id=?`).run(T0, active.id);

      const result = expire.sweepExpiredPendingBridges(T0 + 120_000);
      assert.deepEqual(result, { checked: 1, deleted: 1, publicIds: [expired.public_id] });

      assert.equal(api.getBridgeById(expired.id), null, "expired pending row is gone");
      for (const table of CHILD_TABLES) {
        assert.equal(countRows(table, expired.id), 0, `${table} must not outlive its bridge`);
      }
      assert.equal(api.getBridgeById(future.id) !== null, true, "future expiry is untouched");
      assert.equal(api.getBridgeById(immortal.id) !== null, true, "expires_at NULL never expires");
      const activeRow = api.getBridgeById(active.id);
      assert.equal(activeRow.state, "active", "the sweeper never touches active rows (§10.10)");
      assert.ok(activeRow.code_hash, "code_hash is never nulled on an active row (replay reports already-used)");

      const second = expire.sweepExpiredPendingBridges(T0 + 120_000);
      assert.deepEqual(second, { checked: 0, deleted: 0, publicIds: [] }, "the queue is drained");
    });

    it("createSweepJobSpec describes the 60s registerJob wiring (no boot hookup here)", () => {
      const spec = expire.createSweepJobSpec();
      assert.equal(spec.name, "bridge-expiry");
      assert.equal(spec.intervalMs, 60_000);
      assert.equal(typeof spec.run, "function");
    });
  });

  describe("connect attempts counter (§10.1)", () => {
    it("5 well-formed misses in a 10-minute window lock the community; the window resets", () => {
      const community = communityKey("900000000000000099");
      const window = api.BRIDGE_CONNECT_WINDOW_MS;

      let state = api.getBridgeConnectState(community, { nowMs: T0 });
      assert.deepEqual(state, { failures: 0, locked: false, windowStartedAt: null });

      for (let miss = 1; miss <= 4; miss++) {
        const recorded = api.recordBridgeConnectMiss(community, { nowMs: T0 + miss * 1000 });
        assert.equal(recorded.failures, miss);
        assert.equal(recorded.locked, false, `miss ${miss} is under the limit`);
      }
      const fifth = api.recordBridgeConnectMiss(community, { nowMs: T0 + 5000 });
      assert.equal(fifth.failures, 5);
      assert.equal(fifth.locked, true, "the 5th well-formed miss trips the limit (spec §10.1)");

      const sixth = api.recordBridgeConnectMiss(community, { nowMs: T0 + 6000 });
      assert.equal(sixth.locked, true, "a 6th miss inside the window stays locked");
      assert.equal(sixth.failures, 6);
      assert.equal(api.getBridgeConnectState(community, { nowMs: T0 + 6000 }).locked, true);

      // A full window after the FIRST miss (T0+1000) is the reset boundary.
      const windowEnd = T0 + 1000 + window;
      assert.deepEqual(api.getBridgeConnectState(community, { nowMs: windowEnd }), {
        failures: 0,
        locked: false,
        windowStartedAt: T0 + 1000,
      });
      const afterReset = api.recordBridgeConnectMiss(community, { nowMs: windowEnd });
      assert.equal(afterReset.failures, 1, "window reset starts a new window");
      assert.equal(afterReset.windowStartedAt, windowEnd);

      assert.equal(api.clearBridgeConnectAttempts(community), true);
      assert.equal(api.clearBridgeConnectAttempts(community), false);
      assert.equal(api.getBridgeConnectState(community, { nowMs: T0 + window }).failures, 0);
      assert.throws(() => api.getBridgeConnectState("900000000000000099"), /community id required/);
    });
  });
});
