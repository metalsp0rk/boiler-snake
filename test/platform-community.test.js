const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// Snowflake from the spec's Phase 0 record (test community on the live
// instance). String-typed exactly like handlers hold it.
const SNOWFLAKE = "1554590611015729152";

describe("platform/community", () => {
  let api;
  let cleanup;
  let assertCommunityId;
  let getCommunityByExternal;
  let getCommunityById;
  let ensureCommunity;

  before(() => {
    // Contract (see db-layer.test.js): loadDb() runs before any other
    // `src/` require so the platform module binds to the temp SQLite file.
    ({ api, cleanup } = loadDb());
    ({
      assertCommunityId,
      getCommunityByExternal,
      getCommunityById,
      ensureCommunity,
    } = require("../src/platform/community"));
  });

  after(() => cleanup?.());

  describe("assertCommunityId", () => {
    const rejections = [
      ["string snowflake", SNOWFLAKE, "community id required, got string"],
      ["numeric string", "1", "community id required, got string"],
      ["undefined", undefined, "community id required, got undefined"],
      ["null", null, "community id required, got object"],
      ["NaN", NaN, "community id required, got number"],
      ["fractional number", 1.5, "community id required, got number"],
      ["zero", 0, "community id required, got number"],
      ["negative", -7, "community id required, got number"],
      ["above 2^31-1", 2_147_483_648, "community id required, got number"],
      ["snowflake-sized number", Number.MAX_SAFE_INTEGER, "community id required, got number"],
      ["unsafe integer", Number.MAX_SAFE_INTEGER + 2, "community id required, got number"],
      ["bigint", 1n, "community id required, got bigint"],
      ["boolean", true, "community id required, got boolean"],
      ["plain object", {}, "community id required, got object"],
      ["array", [1], "community id required, got object"],
      ["function", () => {}, "community id required, got function"],
    ];

    for (const [label, value, message] of rejections) {
      it(`rejects ${label} with the exact spec message`, () => {
        assert.throws(
          () => assertCommunityId(value),
          (err) =>
            err instanceof Error &&
            !(err instanceof TypeError) &&
            err.message === message,
        );
      });
    }

    it("accepts the valid range", () => {
      assert.equal(assertCommunityId(1), 1);
      assert.equal(assertCommunityId(42), 42);
      assert.equal(assertCommunityId(2_147_483_647), 2_147_483_647);
    });
  });

  describe("getCommunityByExternal", () => {
    it("returns null for an unknown identity", () => {
      assert.equal(
        getCommunityByExternal("discord", "discord", "guild-never-seen"),
        null,
      );
    });

    it("rejects non-string identity parts with a specific message", () => {
      assert.throws(
        () => getCommunityByExternal(123, "discord", "g1"),
        /community platform must be a non-empty string, got number/,
      );
      assert.throws(
        () => getCommunityByExternal("discord", "", "g1"),
        /community instanceKey must be a non-empty string, got empty string/,
      );
      assert.throws(
        () => getCommunityByExternal("discord", "discord", null),
        /community externalGuildId must be a non-empty string, got null/,
      );
    });
  });

  describe("ensureCommunity", () => {
    it("inserts on first sight with spec defaults", () => {
      const id = ensureCommunity({
        platform: "discord",
        instanceKey: "discord",
        externalGuildId: "g-new-1",
      });
      assert.equal(typeof id, "number");
      assert.ok(Number.isSafeInteger(id) && id >= 1);

      const row = api.db
        .prepare("SELECT * FROM communities WHERE id = ?")
        .get(id);
      assert.equal(row.platform, "discord");
      assert.equal(row.instance_key, "discord");
      assert.equal(row.external_guild_id, "g-new-1");
      // Spec § Data Model Changes: both flags default to 0 for every row,
      // Discord included (K8: only a Fluxer adapter ever flips them).
      assert.equal(row.elevated_permissions, 0);
      assert.equal(row.voice_states_complete, 0);
      assert.ok(Number.isSafeInteger(row.created_at));
    });

    it("is idempotent: repeated calls return the same id and one row", () => {
      const args = {
        platform: "discord",
        instanceKey: "discord",
        externalGuildId: "g-idempotent-1",
      };
      const first = ensureCommunity(args);
      const second = ensureCommunity(args);
      const third = ensureCommunity(args);
      assert.equal(second, first);
      assert.equal(third, first);

      const { n } = api.db
        .prepare("SELECT COUNT(*) AS n FROM communities WHERE external_guild_id = ?")
        .get("g-idempotent-1");
      assert.equal(n, 1);
    });

    it("gives discord and fluxer rows with the SAME snowflake distinct ids", () => {
      const discordId = ensureCommunity({
        platform: "discord",
        instanceKey: "discord",
        externalGuildId: SNOWFLAKE,
      });
      const fluxerId = ensureCommunity({
        platform: "fluxer",
        instanceKey: "chat.metalspork.xyz",
        externalGuildId: SNOWFLAKE,
      });
      assert.notEqual(discordId, fluxerId);

      // Each identity resolves back to exactly its own row.
      assert.equal(
        getCommunityByExternal("discord", "discord", SNOWFLAKE),
        discordId,
      );
      assert.equal(
        getCommunityByExternal("fluxer", "chat.metalspork.xyz", SNOWFLAKE),
        fluxerId,
      );
    });

    it("concurrent calls race safely on the UNIQUE constraint", async () => {
      const args = {
        platform: "fluxer",
        instanceKey: "chat.example.org",
        externalGuildId: "900000000000000001",
      };
      const ids = await Promise.all(
        Array.from({ length: 8 }, () => Promise.resolve().then(() => ensureCommunity(args))),
      );
      for (const id of ids) {
        assert.equal(id, ids[0]);
      }
      const { n } = api.db
        .prepare(
          "SELECT COUNT(*) AS n FROM communities WHERE platform = 'fluxer' AND instance_key = ? AND external_guild_id = ?",
        )
        .get(args.instanceKey, args.externalGuildId);
      assert.equal(n, 1);
    });

    it("rejects unknown platforms and missing fields with specific messages", () => {
      assert.throws(
        () => ensureCommunity({ platform: "telegram", instanceKey: "x", externalGuildId: "g" }),
        /unsupported community platform "telegram", expected one of: discord, fluxer/,
      );
      assert.throws(
        () => ensureCommunity({}),
        /community platform must be a non-empty string, got undefined/,
      );
      assert.throws(
        () =>
          ensureCommunity({
            platform: "discord",
            instanceKey: "discord",
            externalGuildId: 12345,
          }),
        /community externalGuildId must be a non-empty string, got number/,
      );
    });
  });

  describe("getCommunityById", () => {
    it("returns the stored row", () => {
      const id = ensureCommunity({
        platform: "discord",
        instanceKey: "discord",
        externalGuildId: "g-lookup-1",
      });
      const row = getCommunityById(id);
      assert.equal(row.id, id);
      assert.equal(row.platform, "discord");
      assert.equal(row.instanceKey, "discord");
      assert.equal(row.externalGuildId, "g-lookup-1");
      assert.equal(typeof row.createdAt, "number");
    });

    it("returns null for an unknown id", () => {
      assert.equal(getCommunityById(999_999), null);
    });

    it("rejects a snowflake string (spec: 'snowflake is rejected')", () => {
      assert.throws(
        () => getCommunityById(SNOWFLAKE),
        { message: "community id required, got string" },
      );
    });
  });
});
