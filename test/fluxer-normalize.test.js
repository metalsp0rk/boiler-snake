/**
 * Unit tests for src/platform/fluxer/normalize.js (PR 6).
 *
 * Payload shapes are the Phase 0 record (roadmap/fluxer.md § Phase 0, recorded
 * 2026-09-29): MESSAGE_CREATE `d` carries `mentions` (USER OBJECTS),
 * `mention_roles` (id strings), `mention_channels` ({id, name, type, ...}),
 * `mention_everyone` (bool), `member` (author's member, `roles` = id array) —
 * there is NO `mention_users` field. Reaction events are ONE object:
 * {user_id, channel_id, message_id, emoji{name, id?}, guild_id?, member?}.
 *
 * The normalizer is pure (no DB, no SDK) — no loadDb() needed.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeFluxerMessage,
  normalizeFluxerReaction,
} = require("../src/platform/fluxer/normalize");

const TS_ISO = "2026-09-29T12:34:56.000Z";

/** Full Phase 0 MESSAGE_CREATE `d` payload. */
function phase0D(overrides = {}) {
  return {
    id: "1554600000000000001",
    channel_id: "1554600000000000002",
    guild_id: "1554590611015729152",
    author: {
      id: "1554600000000000003",
      username: "sparky",
      discriminator: "0001",
      bot: false,
    },
    content: "!xp",
    timestamp: TS_ISO,
    attachments: [
      { id: "att-1", filename: "shot.png", url: "https://cdn.test/shot.png" },
    ],
    mentions: [{ id: "1554600000000000009", username: "targetbot", bot: true }],
    mention_roles: ["1554600000000000010"],
    mention_channels: [
      {
        id: "1554600000000000011",
        name: "general",
        type: 0,
        mention_string: "<#1554600000000000011>",
      },
    ],
    mention_everyone: false,
    member: { roles: ["1554600000000000010", "1554600000000000012"], nick: null },
    ...overrides,
  };
}

describe("platform/fluxer/normalize — normalizeFluxerMessage", () => {
  it("maps a Phase 0 MESSAGE_CREATE payload field by field", () => {
    const out = normalizeFluxerMessage(
      { t: "MESSAGE_CREATE", d: phase0D() },
      { instanceKey: "https://fluxer.test" },
    );

    assert.ok(out, "expected a normalized message");
    assert.equal(out.platform, "fluxer");
    assert.equal(out.instanceKey, "https://fluxer.test");
    assert.equal(out.communityId, null, "community resolution is the pipeline's job");
    assert.equal(out.externalGuildId, "1554590611015729152");
    assert.equal(out.id, "1554600000000000001");
    assert.equal(out.channelId, "1554600000000000002");
    assert.equal(out.authorId, "1554600000000000003");
    assert.equal(out.authorBot, false);
    assert.equal(out.content, "!xp");
    assert.deepEqual(out.mentions, {
      users: ["1554600000000000009"],
      roles: ["1554600000000000010"],
      channels: ["1554600000000000011"],
    });
    assert.deepEqual(out.attachments, [
      { name: "shot.png", url: "https://cdn.test/shot.png" },
    ]);
    assert.ok(out.createdAt instanceof Date);
    assert.equal(out.createdAt.getTime(), Date.parse(TS_ISO));
    // Pipeline-added fields (contract 1)
    assert.deepEqual(out.memberRoleIds, ["1554600000000000010", "1554600000000000012"]);
    assert.equal(out.channelTypes.get("1554600000000000011"), 0);
    assert.deepEqual(out.memberRaw.roles, ["1554600000000000010", "1554600000000000012"]);
    assert.equal(out.authorRaw.username, "sparky");
    assert.equal(out.mentionBots.get("1554600000000000009"), true);
    assert.equal(out.mentionUsersRaw.length, 1);
    assert.equal(out.mentionUsersRaw[0].username, "targetbot");
    assert.equal(out.parsePrefix, null);
  });

  it("maps attachments to {name: filename, url} and defaults missing ones to []", () => {
    const withFiles = normalizeFluxerMessage(
      {
        t: "MESSAGE_CREATE",
        d: phase0D({
          attachments: [
            { id: "a", filename: "a.png", url: "https://cdn.test/a.png" },
            { id: "b", filename: "b.bin" },
          ],
        }),
      },
      { instanceKey: "fluxer-1" },
    );
    assert.deepEqual(withFiles.attachments, [
      { name: "a.png", url: "https://cdn.test/a.png" },
      { name: "b.bin", url: "" },
    ]);

    const noFiles = normalizeFluxerMessage(
      { t: "MESSAGE_CREATE", d: phase0D({ attachments: undefined }) },
      { instanceKey: "fluxer-1" },
    );
    assert.deepEqual(noFiles.attachments, []);
  });

  it('missing content becomes ""', () => {
    const out = normalizeFluxerMessage(
      { t: "MESSAGE_CREATE", d: phase0D({ content: undefined }) },
      { instanceKey: "fluxer-1" },
    );
    assert.equal(out.content, "");
  });

  it("drops DMs: no guild_id → null", () => {
    const out = normalizeFluxerMessage(
      { t: "MESSAGE_CREATE", d: phase0D({ guild_id: undefined }) },
      { instanceKey: "fluxer-1" },
    );
    assert.equal(out, null);
  });

  it("drops payloads missing id, channel_id, or author (logged, no throw)", () => {
    const orig = console.error;
    const lines = [];
    console.error = (...args) => lines.push(args.join(" "));
    try {
      // Missing fields on a gateway payload are silently tolerated by the
      // normalizer's guards: the message is dropped (returns null).
      assert.equal(normalizeFluxerMessage({ t: "MESSAGE_CREATE", d: phase0D({ id: undefined }) }, { instanceKey: "f" }), null);
      assert.equal(normalizeFluxerMessage({ t: "MESSAGE_CREATE", d: phase0D({ channel_id: null }) }, { instanceKey: "f" }), null);
      assert.equal(normalizeFluxerMessage({ t: "MESSAGE_CREATE", d: phase0D({ author: null }) }, { instanceKey: "f" }), null);
      assert.equal(normalizeFluxerMessage(null), null);
      assert.equal(normalizeFluxerMessage("nope"), null);
    } finally {
      console.error = orig;
    }
  });

  it("tolerates plain-string mentions arrays and invalid timestamps", () => {
    const out = normalizeFluxerMessage(
      {
        t: "MESSAGE_CREATE",
        d: phase0D({
          mentions: ["1234567890123", 42],
          timestamp: "definitely-not-a-date",
        }),
      },
      { instanceKey: "fluxer-1" },
    );
    assert.deepEqual(out.mentions.users, ["1234567890123", "42"]);
    assert.equal(out.mentionBots.size, 0);
    assert.equal(out.createdAt, null, "invalid timestamp → null, not Invalid Date");
  });

  it("defaults member/mention fields to empty when absent", () => {
    const d = phase0D();
    delete d.member;
    delete d.mention_roles;
    delete d.mention_channels;
    const out = normalizeFluxerMessage({ t: "MESSAGE_CREATE", d }, { instanceKey: "fluxer-1" });
    assert.deepEqual(out.memberRoleIds, []);
    assert.deepEqual(out.mentions.roles, []);
    assert.deepEqual(out.mentions.channels, []);
    assert.equal(out.channelTypes.size, 0);
    assert.equal(out.memberRaw, null);
  });
});

describe("platform/fluxer/normalize — normalizeFluxerReaction", () => {
  it("normalizes a unicode reaction (Phase 0 single-object payload)", () => {
    const out = normalizeFluxerReaction(
      {
        t: "MESSAGE_REACTION_ADD",
        d: {
          user_id: "1554600000000000003",
          channel_id: "1554600000000000002",
          message_id: "1554600000000000001",
          emoji: { name: "👍", id: null, animated: false },
          guild_id: "1554590611015729152",
          member: { user: { id: "1554600000000000003", bot: false } },
        },
      },
      { instanceKey: "https://fluxer.test" },
    );

    assert.ok(out);
    assert.equal(out.platform, "fluxer");
    assert.equal(out.instanceKey, "https://fluxer.test");
    assert.equal(out.communityId, null);
    assert.equal(out.externalGuildId, "1554590611015729152");
    assert.equal(out.messageId, "1554600000000000001");
    assert.equal(out.channelId, "1554600000000000002");
    assert.equal(out.userId, "1554600000000000003");
    assert.equal(out.userBot, false);
    assert.equal(out.emojiKey, "👍", "unicode emoji key is the emoji name");
  });

  it("normalizes a custom emoji by id (emojiKey = custom id)", () => {
    const out = normalizeFluxerReaction({
      t: "MESSAGE_REACTION_ADD",
      d: {
        user_id: "u1",
        channel_id: "c1",
        message_id: "m1",
        emoji: { name: "gork", id: "1554600000000000099", animated: true },
        guild_id: "g1",
        member: { user: { id: "u1", bot: true } },
      },
    });
    assert.equal(out.emojiKey, "1554600000000000099");
    assert.equal(out.userBot, true, "bot flag comes from member.user.bot");
    assert.equal(out.instanceKey, "fluxer", "default instanceKey");
  });

  it("logs and returns null when a required field is missing", () => {
    const orig = console.error;
    const lines = [];
    console.error = (...args) => lines.push(args.join(" "));
    try {
      assert.equal(
        normalizeFluxerReaction({
          t: "MESSAGE_REACTION_ADD",
          d: { user_id: "u1", channel_id: "c1", emoji: { name: "👍" }, guild_id: "g1" },
        }),
        null,
      );
      assert.equal(
        normalizeFluxerReaction({
          t: "MESSAGE_REACTION_ADD",
          d: { user_id: "u1", channel_id: "c1", message_id: "m1", guild_id: "g1" },
        }),
        null,
      );
      assert.equal(
        lines.filter((l) => l.includes('missing required field "message_id"')).length,
        1,
      );
      assert.equal(
        lines.filter((l) => l.includes('missing required field "emoji"')).length,
        1,
      );
      assert.equal(normalizeFluxerReaction(null), null);
    } finally {
      console.error = orig;
    }
  });
});
