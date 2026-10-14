/**
 * Unit + boundary tests for the three issue-#279 normalized-shape contracts
 * in src/platform/normalizedMessageContract.js:
 *
 *   - NormalizedReaction  (assertNormalizedReaction)  — entries:
 *     pipelines.onFluxerReactionAdd / onFluxerReactionRemove
 *   - MESSAGE_DELETE identity partial (assertNormalizedDelete) — entry:
 *     pipelines.onFluxerMessageDelete (dual source shape: raw wire
 *     snake_case / SDK PartialMessage camelCase; NEVER full-message rules)
 *   - NormalizedDmMessage (assertNormalizedDm) — entry: the DM fan-out in
 *     client.js createDmDispatcher.emit
 *
 * Mirrors the issue #201 idiom (test/normalizedMessageContract.test.js):
 * one test per required field (delete → throws naming THAT field + the
 * platform), nullability-table tests, wrong-type tests, the exact
 * required-field drift lock, plus the #279-critical cross-shape guards
 * (a legitimate partial delete / DM must pass ITS contract and be rejected
 * by the message validator — proving the shapes are separate contracts).
 * Boundary sections prove a half-shaped hand-built payload is logged
 * DISTINCTLY and SKIPPED at the shipped entry (no downstream execution,
 * no generic pipeline-error line, no crash).
 *
 * loadDb() before any src/ require: the boundary tests pull the pipeline +
 * client chain (features → db); the validator itself is a dependency-free
 * leaf module.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { api: dbApi, cleanup } = loadDb();

const {
  assertNormalizedMessage,
  assertNormalizedReaction,
  assertNormalizedDelete,
  assertNormalizedDm,
  NormalizedMessageContractError,
  REQUIRED_REACTION_FIELDS,
  REQUIRED_DELETE_FIELDS,
  REQUIRED_DM_FIELDS,
} = require("../src/platform/normalizedMessageContract");
const {
  normalizeFluxerReaction,
  normalizeFluxerMessageDelete,
  normalizeFluxerDmMessage,
} = require("../src/platform/fluxer/normalize");
const pipelines = require("../src/bot/pipelines");
const { createDmDispatcher } = require("../src/platform/fluxer/client");
const { ensureCommunity } = require("../src/platform/community");
const { makeFakeRest, makeFakeHandle, gatewayMessage } = require("./helpers/fluxer");

after(cleanup);

const INSTANCE = "https://fluxer.test";
const GUILD = "99";
const TS_ISO = "2026-10-13T09:00:00.000Z";

/**
 * A complete, contract-valid fluxer-flavored NormalizedReaction — exactly
 * the 9 keys normalizeFluxerReaction's single return object emits.
 */
function validReaction(overrides = {}) {
  return {
    platform: "fluxer",
    instanceKey: INSTANCE,
    communityId: null,
    externalGuildId: GUILD,
    messageId: "500",
    channelId: "7",
    userId: "5",
    userBot: false,
    emojiKey: "👍",
    ...overrides,
  };
}

/** The exact six-key delete identity partial (normalizeFluxerMessageDelete). */
function validDeletePartial(overrides = {}) {
  return {
    platform: "fluxer",
    instanceKey: INSTANCE,
    communityId: null,
    externalGuildId: GUILD,
    id: "500",
    channelId: "7",
    ...overrides,
  };
}

/** A complete NormalizedDmMessage — exactly the §10.3 typedef key set. */
function validDm(overrides = {}) {
  return {
    platform: "fluxer",
    instanceKey: INSTANCE,
    channelId: "7",
    id: "50",
    authorId: "5",
    content: "hello",
    mentions: { users: [], roles: [], channels: [] },
    attachments: [],
    createdAt: new Date(TS_ISO),
    ...overrides,
  };
}

/** DM `d` payload: the guild fixture with NO guild id (module scope so the
 *  acceptance AND drift-lock blocks both normalize through it). */
function dmD(overrides = {}) {
  return gatewayMessage({
    guild_id: undefined,
    id: "1554600000000005001",
    channel_id: "1554600000000005002",
    author: { id: "1554600000000005003", username: "staffy", bot: false },
    content: "!bridge connect B_7K2M9QXP 42",
    timestamp: TS_ISO,
    ...overrides,
  });
}

/** Capture console.error for the duration of fn (AGENTS.md log pins). */
async function captureConsoleError(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => lines.push(args.map((a) => String(a)).join(" "));
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

/** Shared one-test-per-required-field generator (the #201 loop idiom). */
function perFieldDeletionTests(buildValid, requiredFields, assertFn) {
  for (const field of requiredFields) {
    it(`deleting "${field}" throws a contract error naming the field and the platform`, () => {
      const payload = buildValid();
      delete payload[field];
      // Deleting the platform tag itself → the label falls back to "unknown".
      const expectedPlatform = field === "platform" ? "unknown" : "fluxer";
      assert.throws(
        () => assertFn(payload, { boundary: "unitTestBoundary" }),
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
          assert.match(err.message, /unitTestBoundary/);
          return true;
        },
      );
    });
  }
}

/** Shared null-acceptance generator, driven by each shape's nullability set. */
function nullabilityTests(buildValid, requiredFields, nullableFields, assertFn) {
  for (const field of requiredFields) {
    const nullable = nullableFields.includes(field);
    it(`"${field}" null is ${nullable ? "accepted" : "rejected"}`, () => {
      const payload = buildValid({ [field]: null });
      if (nullable) {
        assertFn(payload);
      } else {
        assert.throws(
          () => assertFn(payload),
          (err) =>
            err instanceof NormalizedMessageContractError && err.field === field,
        );
      }
    });
  }
}

/** Shared whole-payload (non-object) generator. */
function wholePayloadTests(label, wholeField, assertFn) {
  it(`a non-object payload throws naming ${wholeField}, not a TypeError`, () => {
    for (const bad of [null, undefined, "payload", 42, ["array"]]) {
      assert.throws(
        () => assertFn(bad),
        (err) => {
          assert.ok(err instanceof NormalizedMessageContractError);
          assert.equal(err.field, wholeField);
          assert.equal(err.platform, "unknown");
          return true;
        },
        `${label} payload ${String(bad)} must yield a contract error`,
      );
    }
  });
}

/** Shared wrong-type generator: [field, value] pairs must throw naming field. */
function wrongTypeTests(label, cases, buildValid, assertFn) {
  for (const [field, value] of cases) {
    it(`"${field}" = ${value === "" ? '""' : JSON.stringify(value) ?? String(value)} throws naming the field`, () => {
      assert.throws(
        () => assertFn(buildValid({ [field]: value })),
        (err) =>
          err instanceof NormalizedMessageContractError && err.field === field,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// NormalizedReaction
// ---------------------------------------------------------------------------

describe("normalizedShapeContract:reaction — shape acceptance", () => {
  it("accepts a complete reaction (returns the SAME object)", () => {
    const r = validReaction();
    assert.equal(assertNormalizedReaction(r), r, "identity pass-through");
  });

  it("accepts the REAL wire-shape normalizer output (snake_case payload)", () => {
    const out = normalizeFluxerReaction(
      {
        t: "MESSAGE_REACTION_ADD",
        d: {
          user_id: "5",
          channel_id: "7",
          message_id: "50",
          guild_id: GUILD,
          emoji: { name: "👍" },
        },
      },
      { instanceKey: INSTANCE },
    );
    assert.ok(out, "fixture sanity: the wire payload normalizes");
    assert.equal(assertNormalizedReaction(out), out);
  });

  it("accepts the REAL SDK camelCase emit shape (flat ids + reaction.emoji/guildId)", () => {
    const out = normalizeFluxerReaction(
      {
        userId: "5",
        channelId: "7",
        messageId: "50",
        user: { id: "5", bot: false },
        reaction: { emoji: { id: "123", name: "party", animated: false }, guildId: GUILD },
      },
      { instanceKey: INSTANCE },
    );
    assert.ok(out, "fixture sanity: the SDK emit normalizes");
    assert.equal(out.emojiKey, "123", "custom emoji id is the key");
    assert.equal(assertNormalizedReaction(out), out);
  });

  it('accepts guild-less payloads (externalGuildId: null is the MODELED shape — the pipeline logs "no guild" itself)', () => {
    const out = normalizeFluxerReaction(
      { user_id: "5", channel_id: "7", message_id: "50", emoji: { name: "🎉" } },
      { instanceKey: INSTANCE },
    );
    assert.equal(out.externalGuildId, null, "fixture sanity: guild-less");
    assertNormalizedReaction(out);
  });

  it("accepts resolved communityId and unknown extras (the contract stays shallow)", () => {
    assertNormalizedReaction(
      validReaction({
        communityId: 7,
        // Extras real consumers add (pipeline write-back / defensive fields)
        memberRoleIds: ["r1"],
        emoji: { name: "👍" },
      }),
    );
  });

  perFieldDeletionTests(validReaction, REQUIRED_REACTION_FIELDS, assertNormalizedReaction);
  nullabilityTests(
    validReaction,
    REQUIRED_REACTION_FIELDS,
    ["communityId", "externalGuildId"],
    assertNormalizedReaction,
  );

  wrongTypeTests(
    "reaction",
    [
      ["platform", "telegram"],
      ["instanceKey", ""],
      ["communityId", "7"],
      ["communityId", 7.5],
      ["externalGuildId", ""],
      ["externalGuildId", 99],
      ["messageId", 500],
      ["messageId", ""],
      ["channelId", {}],
      ["userId", 5],
      ["userBot", "false"],
      ["userBot", 1],
      ["emojiKey", ""],
      ["emojiKey", 123],
    ],
    validReaction,
    assertNormalizedReaction,
  );

  wholePayloadTests("reaction", "(whole reaction)", assertNormalizedReaction);

  it("reports the FIRST violated field in contract order (platform first when both break)", () => {
    assert.throws(
      () => assertNormalizedReaction(validReaction({ platform: 7, messageId: null })),
      (err) => err.field === "platform",
    );
  });

  it("error text names the MESSAGE id so the failure is reproducible from logs", () => {
    assert.throws(
      () => assertNormalizedReaction(validReaction({ userBot: null })),
      (err) => {
        assert.match(err.message, /message 500/);
        assert.match(err.message, /expected/);
        assert.match(err.message, /got null/);
        return true;
      },
    );
  });
});

describe("normalizedShapeContract:reaction — required-field list (drift lock)", () => {
  it("pins the exact required fields in check order", () => {
    assert.deepEqual([...REQUIRED_REACTION_FIELDS], [
      "platform",
      "instanceKey",
      "communityId",
      "externalGuildId",
      "messageId",
      "channelId",
      "userId",
      "userBot",
      "emojiKey",
    ]);
  });

  it("does NOT require message-shape fields or raw payload extras", () => {
    for (const absent of [
      "id",
      "authorId",
      "content",
      "mentions",
      "attachments",
      "createdAt",
      "authorBot",
      "embeds",
      "emoji",
      "memberRoleIds",
    ]) {
      assert.ok(
        !REQUIRED_REACTION_FIELDS.includes(absent),
        `${absent} must stay out of the REQUIRED reaction list (a normalized reaction does not carry it)`,
      );
    }
  });

  it("a normalized reaction is NOT a normalized message (separate contracts, cross-guard)", () => {
    const r = normalizeFluxerReaction(
      { user_id: "5", channel_id: "7", message_id: "50", guild_id: GUILD, emoji: { name: "👍" } },
      { instanceKey: INSTANCE },
    );
    assertNormalizedReaction(r);
    // The message contract rejects it — the reaction table is not a message
    // table in disguise.
    assert.throws(
      () => assertNormalizedMessage(r),
      (err) => err instanceof NormalizedMessageContractError,
    );
  });
});

// ---------------------------------------------------------------------------
// MESSAGE_DELETE identity partial
// ---------------------------------------------------------------------------

describe("normalizedShapeContract:delete — shape acceptance", () => {
  it("accepts the exact six-key identity partial (returns the SAME object)", () => {
    const d = validDeletePartial();
    assert.equal(assertNormalizedDelete(d), d, "identity pass-through");
  });

  it("accepts the REAL normalizer output from the RAW WIRE shape (snake_case)", () => {
    const out = normalizeFluxerMessageDelete(
      { id: "500", channel_id: "7", guild_id: GUILD },
      { instanceKey: INSTANCE },
    );
    assert.ok(out, "fixture sanity: the wire delete normalizes");
    assert.deepEqual(Object.keys(out).sort(), [
      "channelId",
      "communityId",
      "externalGuildId",
      "id",
      "instanceKey",
      "platform",
    ]);
    assert.equal(assertNormalizedDelete(out), out);
  });

  it("accepts the REAL normalizer output from the SDK PartialMessage shape (camelCase)", () => {
    const out = normalizeFluxerMessageDelete(
      { id: "500", channelId: "7", guildId: GUILD },
      { instanceKey: INSTANCE },
    );
    assert.ok(out, "fixture sanity: the SDK partial normalizes");
    assert.equal(assertNormalizedDelete(out), out);
  });

  it("a LEGITIMATE partial delete is never full-message validated (issue #279 core semantic)", () => {
    const partial = normalizeFluxerMessageDelete(
      { id: "500", channel_id: "7", guild_id: GUILD },
      { instanceKey: INSTANCE },
    );
    // Its own contract: passes…
    assertNormalizedDelete(partial);
    // …while the MESSAGE validator would reject the SAME payload for fields a
    // real MESSAGE_DELETE never carries (author, content, …). Validating
    // deletes with the message rules would drop every legitimate delete.
    assert.throws(
      () => assertNormalizedMessage(partial),
      (err) =>
        err instanceof NormalizedMessageContractError && err.field === "authorId",
    );
  });

  it("accepts a full normalized message too (extras are allowed — shallow rules)", () => {
    assertNormalizedDelete(
      validDeletePartial({
        authorId: "5",
        content: "deleted text",
        mentions: { users: [], roles: [], channels: [] },
      }),
    );
  });

  perFieldDeletionTests(validDeletePartial, REQUIRED_DELETE_FIELDS, assertNormalizedDelete);

  // communityId is the ONLY nullable field: the pipeline fills it AFTER
  // validation (resolveFluxerCommunity). externalGuildId is deliberately
  // non-null here — the guild gate makes it structurally present on every
  // partial that survives normalization, and it is what makes the partial
  // community-RESOLVABLE (the issue's {id, channelId, community-resolvable}
  // presence requirement).
  nullabilityTests(validDeletePartial, REQUIRED_DELETE_FIELDS, ["communityId"], assertNormalizedDelete);

  it("externalGuildId null is REJECTED (the community-resolvable presence requirement)", () => {
    // The MESSAGE table accepts id-or-null here (null = guild-less Discord DM;
    // pinned by test/normalizedMessageContract.test.js). The delete table
    // deliberately diverges: the normalizer's guild gate means a surviving
    // partial ALWAYS carries the anchor, and a null could never resolve a
    // community — the bridge intake would dead-end silently (forbidden by
    // AGENTS.md rule 1), so the contract names it at the boundary instead.
    assert.throws(
      () => assertNormalizedDelete(validDeletePartial({ externalGuildId: null })),
      (err) => {
        assert.ok(err instanceof NormalizedMessageContractError);
        assert.equal(err.field, "externalGuildId");
        // The expectation text names WHY: community-resolvable anchor.
        assert.match(err.message, /community-resolvable/);
        return true;
      },
    );
  });

  wrongTypeTests(
    "delete",
    [
      ["platform", "telegram"],
      ["instanceKey", ""],
      ["communityId", "3"],
      ["externalGuildId", ""],
      ["externalGuildId", 99],
      ["id", 500],
      ["id", ""],
      ["channelId", {}],
      ["channelId", null],
    ],
    validDeletePartial,
    assertNormalizedDelete,
  );

  wholePayloadTests("delete", "(whole delete)", assertNormalizedDelete);

  it("error text names the message id and the delete label", () => {
    assert.throws(
      () => assertNormalizedDelete(validDeletePartial({ channelId: null })),
      (err) => {
        assert.match(err.message, /normalized delete partial fails required field "channelId"/);
        assert.match(err.message, /message 500/);
        return true;
      },
    );
  });
});

describe("normalizedShapeContract:delete — required-field list (drift lock)", () => {
  it("pins the exact required fields in check order", () => {
    assert.deepEqual([...REQUIRED_DELETE_FIELDS], [
      "platform",
      "instanceKey",
      "communityId",
      "externalGuildId",
      "id",
      "channelId",
    ]);
  });

  it("does NOT require ANY full-message field (partials must keep flowing)", () => {
    for (const absent of [
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
      "messageId",
      "userId",
      "userBot",
      "emojiKey",
    ]) {
      assert.ok(
        !REQUIRED_DELETE_FIELDS.includes(absent),
        `${absent} must stay out of the REQUIRED delete list (a partial delete does not carry it — requiring it would reject every legitimate delete)`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// NormalizedDmMessage
// ---------------------------------------------------------------------------

describe("normalizedShapeContract:dm — shape acceptance", () => {
  it("accepts a complete DM (returns the SAME object)", () => {
    const dm = validDm();
    assert.equal(assertNormalizedDm(dm), dm, "identity pass-through");
  });

  it("accepts the REAL normalizer output (exactly the §10.3 typedef key set)", () => {
    const dm = normalizeFluxerDmMessage(
      { t: "MESSAGE_CREATE", d: dmD() },
      { instanceKey: INSTANCE },
    );
    assert.ok(dm, "fixture sanity: the guild-less payload normalizes to a DM");
    assert.equal(assertNormalizedDm(dm), dm);
  });

  it("accepts the modeled nulls: createdAt null (unparseable timestamp)", () => {
    const dm = normalizeFluxerDmMessage(
      { t: "MESSAGE_CREATE", d: dmD({ timestamp: "not-a-date" }) },
      { instanceKey: INSTANCE },
    );
    assert.equal(dm.createdAt, null, "fixture sanity: timestamp defaulted to null");
    assertNormalizedDm(dm);
  });

  it("accepts empty-but-typed values (content '' from a missing content field)", () => {
    const dm = normalizeFluxerDmMessage(
      { t: "MESSAGE_CREATE", d: dmD({ content: undefined }) },
      { instanceKey: INSTANCE },
    );
    assert.equal(dm.content, "");
    assertNormalizedDm(dm);
  });

  perFieldDeletionTests(validDm, REQUIRED_DM_FIELDS, assertNormalizedDm);
  nullabilityTests(validDm, REQUIRED_DM_FIELDS, ["createdAt"], assertNormalizedDm);

  wrongTypeTests(
    "dm",
    [
      ["platform", "telegram"],
      ["instanceKey", ""],
      ["channelId", ""],
      ["channelId", 7],
      ["id", 50],
      ["id", ""],
      ["authorId", null],
      ["content", null],
      ["content", 0],
      ["mentions", { users: [], roles: [] }],
      ["mentions", []],
      ["attachments", new Map()],
      ["createdAt", TS_ISO],
      ["createdAt", new Date("nope")],
    ],
    validDm,
    assertNormalizedDm,
  );

  wholePayloadTests("dm", "(whole DM)", assertNormalizedDm);

  it("error text names the DM message id", () => {
    assert.throws(
      () => assertNormalizedDm(validDm({ authorId: null })),
      (err) => {
        assert.match(err.message, /normalized DM fails required field "authorId"/);
        assert.match(err.message, /message 50/);
        return true;
      },
    );
  });
});

describe("normalizedShapeContract:dm — required-field list (drift lock)", () => {
  it("pins the exact required fields in check order", () => {
    assert.deepEqual([...REQUIRED_DM_FIELDS], [
      "platform",
      "instanceKey",
      "channelId",
      "id",
      "authorId",
      "content",
      "mentions",
      "attachments",
      "createdAt",
    ]);
  });

  it("does NOT require the guild/community fields (a DM has no community — §10.3 typedef)", () => {
    for (const absent of [
      "communityId",
      "externalGuildId",
      "authorBot",
      "webhookId",
      "authorDisplayName",
      "messageId",
      "userId",
      "userBot",
      "emojiKey",
    ]) {
      assert.ok(
        !REQUIRED_DM_FIELDS.includes(absent),
        `${absent} must stay out of the REQUIRED DM list (the NormalizedDmMessage typedef never carries it)`,
      );
    }
  });

  it("a real DM shape is REJECTED by the message validator (separate contracts, cross-guard)", () => {
    const dm = normalizeFluxerDmMessage(
      { t: "MESSAGE_CREATE", d: dmD() },
      { instanceKey: INSTANCE },
    );
    assertNormalizedDm(dm);
    assert.throws(
      () => assertNormalizedMessage(dm),
      (err) =>
        err instanceof NormalizedMessageContractError && err.field === "communityId",
    );
  });
});

// ---------------------------------------------------------------------------
// Boundary integration: half-shaped hand-built payloads are logged + skipped
// ---------------------------------------------------------------------------

describe("boundary: fluxer reaction pipelines (issue #279 contract gate)", () => {
  function fakeOutbound() {
    const rest = makeFakeRest({ routes: {} });
    const { outbound } = makeFakeHandle({ rest });
    return { rest, outbound };
  }

  it("onFluxerReactionAdd: a half-shaped reaction logs the contract line ONLY and touches no wire", async () => {
    const { rest, outbound } = fakeOutbound();
    const half = validReaction({ messageId: "770001" });
    delete half.emojiKey;

    const logs = await captureConsoleError(() =>
      pipelines.onFluxerReactionAdd(outbound, half),
    );

    assert.equal(
      logs.filter(
        (l) =>
          l.includes("normalized-reaction contract violation") &&
          l.includes('"emojiKey"') &&
          l.includes('platform "fluxer"') &&
          l.includes("onFluxerReactionAdd"),
      ).length,
      1,
      `expected one contract log naming emojiKey+fluxer, got: ${JSON.stringify(logs)}`,
    );
    assert.equal(
      logs.filter((l) => l.startsWith("[fluxer] ReactionAdd error:")).length,
      0,
      "contract failures stay distinguishable from downstream errors",
    );
    assert.equal(rest.calls.length, 0, "the skipped reaction never reached the outbound wire");
  });

  it("onFluxerReactionRemove: a half-shaped reaction logs the contract line ONLY and touches no wire", async () => {
    const { rest, outbound } = fakeOutbound();
    const half = validReaction({ messageId: "770002" });
    delete half.userId;

    const logs = await captureConsoleError(() =>
      pipelines.onFluxerReactionRemove(outbound, half),
    );

    assert.equal(
      logs.filter(
        (l) =>
          l.includes("normalized-reaction contract violation") &&
          l.includes('"userId"') &&
          l.includes("onFluxerReactionRemove"),
      ).length,
      1,
      `expected one contract log naming userId, got: ${JSON.stringify(logs)}`,
    );
    assert.equal(
      logs.filter((l) => l.startsWith("[fluxer] ReactionRemove error:")).length,
      0,
      "the contract line replaces the generic pipeline error line",
    );
    assert.equal(rest.calls.length, 0, "the skipped reaction never reached the outbound wire");
  });

  it("a full-shape reaction passes the gate untouched (bot reaction: silent early return, zero logs)", async () => {
    const { rest, outbound } = fakeOutbound();
    const communityId = ensureCommunity({
      platform: "fluxer",
      instanceKey: INSTANCE,
      externalGuildId: GUILD,
    });
    const r = validReaction({ messageId: "770003", communityId, userBot: true });

    const logs = await captureConsoleError(() =>
      pipelines.onFluxerReactionAdd(outbound, r),
    );

    assert.deepEqual(
      logs.filter((l) => l.includes("contract violation") || l.includes("error")),
      [],
      `a contract-valid reaction must not log at the boundary, got: ${JSON.stringify(logs)}`,
    );
    assert.equal(rest.calls.length, 0, "bot reactions never hit the wire (existing gate preserved)");
  });

  it("a null reaction stays the quiet normalizer-drop signal (no NEW violation log)", async () => {
    const { outbound } = fakeOutbound();
    const logs = await captureConsoleError(() =>
      pipelines.onFluxerReactionAdd(outbound, null),
    );
    assert.deepEqual(logs, []);
  });
});

describe("boundary: onFluxerMessageDelete (issue #279 contract gate)", () => {
  it("a half-shaped delete partial logs the contract line ONLY and enqueues nothing", async () => {
    const half = validDeletePartial({ id: "770010" });
    delete half.channelId;

    const logs = await captureConsoleError(() =>
      pipelines.onFluxerMessageDelete({}, half),
    );

    assert.equal(
      logs.filter(
        (l) =>
          l.includes("normalized-delete contract violation") &&
          l.includes('"channelId"') &&
          l.includes('platform "fluxer"') &&
          l.includes("onFluxerMessageDelete"),
      ).length,
      1,
      `expected one contract log naming channelId+fluxer, got: ${JSON.stringify(logs)}`,
    );
    assert.equal(
      logs.filter((l) => l.startsWith("[fluxer MessageDelete] error:")).length,
      0,
      "the contract line replaces the generic pipeline error line",
    );
    assert.equal(
      dbApi.db
        .prepare("SELECT COUNT(*) AS c FROM bridge_outbox WHERE src_message_id = ?")
        .get("770010").c,
      0,
      "the skipped delete never reached the bridge intake",
    );
  });

  it("a legitimate six-key partial (real normalizer, guild-gated output) flows silently through the gate", async () => {
    const partial = normalizeFluxerMessageDelete(
      { id: "770011", channel_id: "7", guild_id: GUILD },
      { instanceKey: INSTANCE },
    );

    const logs = await captureConsoleError(() =>
      pipelines.onFluxerMessageDelete({}, partial),
    );

    assert.deepEqual(
      logs.filter((l) => l.includes("contract violation") || l.includes("error")),
      [],
      `a legitimate partial delete must pass the gate, got: ${JSON.stringify(logs)}`,
    );
    assert.equal(
      Number.isSafeInteger(partial.communityId),
      true,
      "resolveFluxerCommunity still fills the community AFTER validation",
    );
    assert.equal(
      dbApi.db
        .prepare("SELECT COUNT(*) AS c FROM bridge_outbox WHERE src_message_id = ?")
        .get("770011").c,
      0,
      "no bridge link exists, so the platform-neutral intake enqueues nothing (no-op)",
    );
  });

  it("a null delete stays the quiet normalizer-drop signal (no NEW violation log)", async () => {
    const logs = await captureConsoleError(() =>
      pipelines.onFluxerMessageDelete({}, null),
    );
    assert.deepEqual(logs, []);
  });
});

describe("boundary: DM dispatcher emit (issue #279 contract gate)", () => {
  it("a half-shaped hand-built DM is logged distinctly and NEVER delivered to consumers", async () => {
    const dispatcher = createDmDispatcher("inst-279");
    const delivered = [];
    dispatcher.register((dm) => delivered.push(dm));

    const half = validDm({ id: "770020" });
    delete half.createdAt; // present-null is modeled; key ABSENT is the violation

    const logs = await captureConsoleError(() => dispatcher.emit(half));

    assert.equal(
      logs.filter(
        (l) =>
          l.includes("normalized-dm contract violation") &&
          l.includes('"createdAt"') &&
          l.includes('platform "fluxer"') &&
          l.includes("onDmMessage") &&
          l.includes("inst-279"),
      ).length,
      1,
      `expected one contract log naming createdAt (with the instance key), got: ${JSON.stringify(logs)}`,
    );
    assert.equal(
      logs.filter((l) => l.includes("dm consumer failed")).length,
      0,
      "the contract line stays distinct from the consumer-failure line",
    );
    assert.deepEqual(delivered, [], "a half-shaped DM never reaches shared consumers");
  });

  it("a non-object DM is logged + skipped — emit never rejects (the gateway handler stays alive)", async () => {
    const dispatcher = createDmDispatcher("inst-279b");
    const logs = await captureConsoleError(() => dispatcher.emit(null));
    assert.equal(
      logs.filter(
        (l) =>
          l.includes("normalized-dm contract violation") &&
          l.includes("DM is not an object"),
      ).length,
      1,
      `expected the whole-DM contract log, got: ${JSON.stringify(logs)}`,
    );
  });

  it("a contract-valid DM is delivered to every consumer, identity-preserved, zero logs", async () => {
    const dispatcher = createDmDispatcher("inst-279c");
    const dm = validDm({ id: "770021" });
    const got = [];
    dispatcher.register((m) => got.push(m));
    dispatcher.register((m) => got.push(m));

    const logs = await captureConsoleError(() => dispatcher.emit(dm));

    assert.deepEqual(got, [dm, dm], "both consumers received the exact object");
    assert.deepEqual(logs, [], "delivery of a valid DM logs nothing");
  });
});
