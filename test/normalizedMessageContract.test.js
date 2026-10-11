/**
 * Unit tests for the NormalizedMessage required-field contract (issue #201,
 * audit §6 P2): src/platform/normalizedMessageContract.js.
 *
 * The validator is pure (no DB, no platform imports), so these tests need no
 * loadDb() env. Coverage per the issue's Verification section: one test per
 * required field (delete → throws naming THAT field + the platform), plus
 * null-type table tests (null rejected exactly where the contract says
 * non-null, accepted where nullability is explicit), wrong-type tests, and
 * the exact required-field list (drift lock).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  assertNormalizedMessage,
  NormalizedMessageContractError,
  REQUIRED_NORMALIZED_FIELDS,
} = require("../src/platform/normalizedMessageContract");

/**
 * A complete, contract-valid fluxer-flavored NormalizedMessage — exactly the
 * key set normalizeFluxerMessage emits (no `everyone`, no Discord duck
 * fields). Overridable for per-field mutations.
 */
function validMessage(overrides = {}) {
  return {
    platform: "fluxer",
    instanceKey: "https://fluxer.test",
    communityId: null,
    externalGuildId: "99",
    id: "50",
    channelId: "7",
    authorId: "5",
    authorBot: false,
    content: "hello",
    mentions: { users: [], roles: [], channels: [] },
    attachments: [],
    createdAt: new Date("2026-09-29T12:00:00.000Z"),
    webhookId: null,
    authorDisplayName: "tester",
    type: 0,
    messageSnapshots: [],
    stickers: [],
    parsePrefix: null,
    ...overrides,
  };
}

describe("normalizedMessageContract — shape acceptance", () => {
  it("accepts a complete fluxer-shaped normalized message (returns the SAME object)", () => {
    const msg = validMessage();
    assert.equal(assertNormalizedMessage(msg), msg, "identity pass-through");
  });

  it("accepts a discord-shaped message (communityId integer, everyone extra, duck fields)", () => {
    assertNormalizedMessage(
      validMessage({
        platform: "discord",
        instanceKey: "discord",
        communityId: 7,
        mentions: { users: [], roles: [], channels: [], everyone: false },
        // Discord duck pass-throughs are NOT contract fields — extras allowed.
        guild: { id: "99" },
        author: { id: "5", bot: false },
      }),
    );
  });

  it("accepts explicit guild-less nullability (Discord DM semantics)", () => {
    assertNormalizedMessage(
      validMessage({
        platform: "discord",
        instanceKey: "discord",
        communityId: null,
        externalGuildId: null,
      }),
    );
  });

  it("accepts every legal null: communityId, externalGuildId, createdAt, webhookId, type, parsePrefix", () => {
    assertNormalizedMessage(
      validMessage({
        communityId: null,
        externalGuildId: null,
        createdAt: null,
        webhookId: null,
        type: null,
        parsePrefix: null,
      }),
    );
  });

  it("accepts empty-but-typed values where the contract only pins the type (content '', displayName '')", () => {
    assertNormalizedMessage(validMessage({ content: "", authorDisplayName: "" }));
  });
});

describe("normalizedMessageContract — required-field list (drift lock)", () => {
  it("pins the exact required fields in check order", () => {
    assert.deepEqual([...REQUIRED_NORMALIZED_FIELDS], [
      "platform",
      "instanceKey",
      "communityId",
      "externalGuildId",
      "id",
      "channelId",
      "authorId",
      "authorBot",
      "content",
      "mentions",
      "attachments",
      "createdAt",
      "webhookId",
      "authorDisplayName",
      "type",
      "messageSnapshots",
      "stickers",
      "parsePrefix",
    ]);
  });

  it("does NOT require fluxer-only extras or Discord duck fields", () => {
    for (const absent of [
      "memberRoleIds",
      "channelTypes",
      "mentionBots",
      "authorRaw",
      "memberRaw",
      "mentionUsersRaw",
      "guild",
      "author",
      "channel",
      "member",
      "embeds",
    ]) {
      assert.ok(
        !REQUIRED_NORMALIZED_FIELDS.includes(absent),
        `${absent} must stay out of the REQUIRED list (produced by only one adapter; consumers type-guard it)`,
      );
    }
  });
});

describe("normalizedMessageContract — one violation test per required field", () => {
  for (const field of REQUIRED_NORMALIZED_FIELDS) {
    it(`deleting "${field}" throws a contract error naming the field and the platform`, () => {
      const msg = validMessage();
      delete msg[field];
      // Deleting the platform tag itself → the label falls back to "unknown".
      const expectedPlatform = field === "platform" ? "unknown" : "fluxer";
      assert.throws(
        () => assertNormalizedMessage(msg, { boundary: "onMessageCreate" }),
        (err) => {
          assert.ok(
            err instanceof NormalizedMessageContractError,
            `error must be a NormalizedMessageContractError (got ${err?.name}: ${err?.message})`,
          );
          assert.equal(err.field, field);
          assert.equal(err.code, "NORMALIZED_MESSAGE_CONTRACT");
          // Names the missing field AND the platform.
          assert.match(err.message, new RegExp(`"${field}"`));
          assert.equal(err.platform, expectedPlatform);
          assert.match(err.message, new RegExp(`platform "${expectedPlatform}"`));
          assert.match(err.message, /onMessageCreate/);
          return true;
        },
      );
    });
  }

  it('an invalid platform tag reports platform "unknown" and names "platform"', () => {
    const msg = validMessage({ platform: "telegram" });
    assert.throws(
      () => assertNormalizedMessage(msg),
      (err) => {
        assert.ok(err instanceof NormalizedMessageContractError);
        assert.equal(err.field, "platform");
        assert.equal(err.platform, "unknown");
        assert.match(err.message, /platform "unknown"/);
        assert.match(err.message, /"platform"/);
        return true;
      },
    );
  });

  it("reports the FIRST violated field in contract order (platform first when both break)", () => {
    const msg = validMessage({ platform: 7, id: null });
    assert.throws(
      () => assertNormalizedMessage(msg),
      (err) => err.field === "platform",
    );
  });

  it("a non-object payload throws naming (whole message), not a TypeError", () => {
    for (const bad of [null, undefined, "message", 42, ["array"]]) {
      assert.throws(
        () => assertNormalizedMessage(bad),
        (err) => {
          assert.ok(err instanceof NormalizedMessageContractError);
          assert.equal(err.field, "(whole message)");
          assert.equal(err.platform, "unknown");
          return true;
        },
        `payload ${String(bad)} must yield a contract error`,
      );
    }
  });
});

describe("normalizedMessageContract — null rejected exactly where the contract forbids it", () => {
  const NON_NULLABLE = [
    "platform",
    "instanceKey",
    "id",
    "channelId",
    "authorId",
    "authorBot",
    "content",
    "mentions",
    "attachments",
    "authorDisplayName",
    "messageSnapshots",
    "stickers",
  ];

  for (const field of REQUIRED_NORMALIZED_FIELDS) {
    const nullable = !NON_NULLABLE.includes(field);
    it(`"${field}" null is ${nullable ? "accepted" : "rejected"}`, () => {
      const msg = validMessage({ [field]: null });
      if (nullable) {
        assertNormalizedMessage(msg);
      } else {
        assert.throws(
          () => assertNormalizedMessage(msg),
          (err) =>
            err instanceof NormalizedMessageContractError && err.field === field,
        );
      }
    });
  }
});

describe("normalizedMessageContract — wrong types rejected (ids must be STRINGS, collections must be ARRAYS)", () => {
  const WRONG_TYPE = [
    ["platform", "telegram"],
    ["instanceKey", ""],
    ["communityId", "7"],
    ["communityId", 7.5],
    ["externalGuildId", ""],
    ["externalGuildId", 99],
    ["id", 50],
    ["id", ""],
    ["channelId", {}],
    ["authorId", ""],
    ["authorBot", "false"],
    ["content", null],
    ["content", 0],
    ["mentions", { users: [], roles: [] }],
    ["mentions", []],
    ["attachments", new Map()],
    ["attachments", {}],
    ["createdAt", "2026-09-29T12:00:00.000Z"],
    ["createdAt", new Date("nope")],
    ["webhookId", ""],
    ["webhookId", 12],
    ["type", Number.NaN],
    ["type", "0"],
    ["messageSnapshots", {}],
    ["stickers", null],
    ["parsePrefix", 0],
  ];

  for (const [field, value] of WRONG_TYPE) {
    it(`"${field}" = ${value === "" ? '""' : JSON.stringify(value) ?? String(value)} throws naming the field`, () => {
      assert.throws(
        () => assertNormalizedMessage(validMessage({ [field]: value })),
        (err) =>
          err instanceof NormalizedMessageContractError && err.field === field,
      );
    });
  }

  it("a number-carrying mentions object with non-array users throws", () => {
    assert.throws(
      () =>
        assertNormalizedMessage(
          validMessage({ mentions: { users: 3, roles: [], channels: [] } }),
        ),
      (err) => err.field === "mentions",
    );
  });
});

describe("normalizedMessageContract — error text quality", () => {
  it("names the message id so the failure is reproducible from logs", () => {
    assert.throws(
      () => assertNormalizedMessage(validMessage({ authorId: null })),
      (err) => {
        assert.match(err.message, /message 50/);
        assert.match(err.message, /expected/);
        assert.match(err.message, /got null/);
        return true;
      },
    );
  });

  it("is an Error subclass with name NormalizedMessageContractError", () => {
    try {
      assertNormalizedMessage(validMessage({ id: null }));
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.equal(err.name, "NormalizedMessageContractError");
    }
  });

  it("does not mutate or copy the message", () => {
    const msg = validMessage();
    const snapshot = { ...msg };
    assertNormalizedMessage(msg);
    assert.deepEqual(Object.keys(msg), Object.keys(snapshot));
    for (const key of Object.keys(snapshot)) {
      assert.equal(msg[key], snapshot[key]);
    }
  });
});
