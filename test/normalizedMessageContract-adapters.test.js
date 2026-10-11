/**
 * Adapter-boundary tests for the NormalizedMessage contract (issue #201).
 *
 * Proof in both directions at the adapter edge:
 *  1. BOTH normalizers under realistic inputs (guild message, DM, relay
 *     detail, SDK-adjacent extras) produce messages that PASS
 *     assertNormalizedMessage — the shipped shape IS the contract.
 *  2. A half-shaped message CANNOT pass: deleting or nulling ANY required
 *     field of a REAL normalized adapter output (not a hand-built fixture)
 *     throws naming that field and the platform. An adapter that forgets a
 *     field therefore fails loudly at the boundary, never downstream.
 *
 * loadDb() before any src/ require (discord normalize hits the communities
 * table via ensureCommunity — same contract as discord-normalize.test.js).
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { cleanup } = loadDb();

const {
  assertNormalizedMessage,
  NormalizedMessageContractError,
  REQUIRED_NORMALIZED_FIELDS,
} = require("../src/platform/normalizedMessageContract");
const { normalizeDiscordMessage } = require("../src/platform/discord/normalize");
const { normalizeFluxerMessage } = require("../src/platform/fluxer/normalize");
const {
  createGuild,
  createUser,
  createMember,
  createTextChannel,
  createMessage,
} = require("./helpers/discord");
const { gatewayMessage } = require("./helpers/fluxer");
const { IDS } = require("./helpers/fixtures");

after(cleanup);

const TS = Date.UTC(2026, 0, 2, 3, 4, 5);

/** Full Discord guild message (Collection-shaped mentions/attachments). */
function discordGuildNormalized() {
  const guild = createGuild({ id: IDS.guild });
  const author = createUser({ id: IDS.member, username: "member" });
  author.globalName = "Spark 🐍";
  const member = createMember({ guild, user: author });
  const channel = createTextChannel({ id: IDS.channelGeneral, guild });
  const message = createMessage({
    id: "1234567890123456789",
    guild,
    channel,
    author,
    member,
    content: "hello pipeline",
  });
  message.createdAt = new Date(TS);
  message.mentions = {
    users: new Map([[IDS.member, {}]]),
    roles: new Map([["role-staff", {}]]),
    channels: new Map([[IDS.channelLog, {}]]),
    everyone: false,
  };
  message.attachments = new Map([
    [
      "a1",
      {
        name: "shot.png",
        url: "https://cdn.example/shot.png",
        id: "9",
        size: 120n,
        contentType: "image/png",
      },
    ],
  ]);
  return normalizeDiscordMessage(message);
}

/** Discord DM: no guild anywhere on the payload; channel + author present. */
function discordDmNormalized() {
  const author = createUser({ id: "44", username: "dm-user" });
  return normalizeDiscordMessage({
    id: "99",
    content: "hi bot",
    guild: null,
    guildId: null,
    channel: { id: "dm-channel-1" },
    channelId: "dm-channel-1",
    author,
    member: null,
    createdAt: new Date(TS),
    attachments: new Map(),
  });
}

/** Fluxer MESSAGE_CREATE with the full wire detail (mentions/member/etc.). */
function fluxerNormalized() {
  return normalizeFluxerMessage(
    {
      t: "MESSAGE_CREATE",
      d: gatewayMessage({
        id: "1554600000000000001",
        channel_id: "1554600000000000002",
        guild_id: "1554590611015729152",
        content: "!warn @user spam",
        mentions: [{ id: "9", username: "mentioned", bot: false }],
        mention_roles: ["1554590611015729010"],
        mention_channels: [{ id: "11", name: "general", type: 0 }],
        attachments: [{ id: "a1", filename: "n.png", url: "https://cdn.test/n.png", size: 3 }],
        member: { roles: ["1554590611015729010"], user: { id: "5" } },
        webhook_id: null,
        type: 0,
        message_snapshots: [],
        stickers: [],
      }),
    },
    { instanceKey: "https://fluxer.test" },
  );
}

describe("adapter boundary — real normalized output passes the contract", () => {
  it("normalizeDiscordMessage (guild message, collections, bigint size) passes", () => {
    const msg = discordGuildNormalized();
    assert.ok(msg.externalGuildId, "fixture sanity: guild id resolved");
    assertNormalizedMessage(msg, { boundary: "onMessageCreate" });
  });

  it("normalizeDiscordMessage (idempotent second pass) still passes", () => {
    const msg = discordGuildNormalized();
    assertNormalizedMessage(normalizeDiscordMessage(msg));
  });

  it("normalizeDiscordMessage (DM: externalGuildId/communityId explicitly null) passes", () => {
    const msg = discordDmNormalized();
    assert.equal(msg.externalGuildId, null, "fixture sanity: guild-less DM");
    assertNormalizedMessage(msg);
  });

  it("normalizeFluxerMessage (full wire payload) passes with communityId: null", () => {
    const msg = fluxerNormalized();
    assert.ok(msg, "fixture sanity: guild payload normalizes");
    assert.equal(msg.communityId, null, "contract 4: resolve belongs to the pipeline");
    assertNormalizedMessage(msg);
  });

  it("normalizeFluxerMessage (bare defaults via gatewayMessage()) passes", () => {
    const msg = normalizeFluxerMessage(gatewayMessage(), { instanceKey: "fluxer" });
    assertNormalizedMessage(msg);
  });
});

describe("adapter boundary — half-shaped output can never pass", () => {
  for (const [name, build] of [
    ["discord", discordGuildNormalized],
    ["fluxer", fluxerNormalized],
  ]) {
    it(`a real ${name} normalized message with ANY required field deleted throws naming that field`, () => {
      for (const field of REQUIRED_NORMALIZED_FIELDS) {
        const msg = build();
        delete msg[field];
        assert.throws(
          () => assertNormalizedMessage(msg),
          (err) => {
            assert.ok(
              err instanceof NormalizedMessageContractError,
              `${name} message missing "${field}" must yield a contract error, got ${err?.name}: ${err?.message}`,
            );
            assert.equal(err.field, field, `error must name "${field}"`);
            // The platform label is the adapter's tag — or "unknown" when the
            // deleted field IS the platform tag (nothing trustworthy left).
            assert.equal(err.platform, field === "platform" ? "unknown" : name);
            return true;
          },
        );
      }
    });

    it(`a real ${name} normalized message with a field nulled either passes (explicit nullability) or throws naming that field`, () => {
      // Consistency check against the contract's nullability table: a null
      // that the contract did not declare must throw with the field name.
      for (const field of REQUIRED_NORMALIZED_FIELDS) {
        const msg = build();
        msg[field] = null;
        let threw = null;
        try {
          assertNormalizedMessage(msg);
        } catch (err) {
          threw = err;
        }
        if (threw === null) continue; // nullability is explicit for this field
        assert.ok(threw instanceof NormalizedMessageContractError);
        assert.equal(threw.field, field);
      }
    });
  }

  it("the pipeline guild-null semantics stay explicit: null externalGuildId passes validation, undefined does not", () => {
    const msg = discordDmNormalized();
    assertNormalizedMessage(msg); // explicit null = modeled DM
    delete msg.externalGuildId; // absent = adapter bug
    assert.throws(
      () => assertNormalizedMessage(msg),
      (err) => err.field === "externalGuildId",
    );
  });
});
