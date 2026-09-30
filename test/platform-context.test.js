/**
 * Unit tests for the platform-neutral CommandContext seam
 * (src/platform/context.js). The module under test is pure — no DB, no
 * gateway — so this file needs neither. discord.js builders appear ONLY to
 * pin the legacy EmbedBuilder/AttachmentBuilder passthrough shapes the
 * adapters rely on.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder, AttachmentBuilder } = require("discord.js");

const {
  missingOptionError,
  normalizeResolvedUser,
  normalizeEmbed,
  normalizeReplyPayload,
  assertCommandContext,
} = require("../src/platform/context");

describe("platform/context — missingOptionError", () => {
  it("returns the pinned message string (not an Error)", () => {
    assert.equal(missingOptionError("user"), "Missing required option: user");
    assert.equal(typeof missingOptionError("x"), "string");
  });
});

describe("platform/context — normalizeResolvedUser", () => {
  it("maps null/undefined to null", () => {
    assert.equal(normalizeResolvedUser(null), null);
    assert.equal(normalizeResolvedUser(undefined), null);
  });

  it("stringifies ids and booleans on a full user", () => {
    assert.deepEqual(normalizeResolvedUser({ id: 42, username: "gork", bot: 1 }), {
      id: "42",
      username: "gork",
      bot: true,
    });
  });

  it("fills defaults for a partial user", () => {
    assert.deepEqual(normalizeResolvedUser({ id: "7" }), {
      id: "7",
      username: "",
      bot: false,
    });
  });
});

describe("platform/context — normalizeEmbed", () => {
  it("maps null to null", () => {
    assert.equal(normalizeEmbed(null), null);
    assert.equal(normalizeEmbed(undefined), null);
  });

  it("passes legacy toJSON objects through untouched", () => {
    const builder = new EmbedBuilder()
      .setTitle("Legacy")
      .setColor(0x9b59b6)
      .setFooter({ text: "Staff only" });
    // The adapter owns EmbedBuilder construction; the seam only unwraps.
    assert.deepEqual(normalizeEmbed(builder), builder.toJSON());
  });

  it("shallow-normalizes plain-object fields, footer, and author", () => {
    const out = normalizeEmbed({
      title: "Updated XP settings",
      color: 0x9b59b6,
      fields: [{ name: "Factor", value: 5, inline: true }, {}],
      footer: { text: "Staff only", icon_url: "https://ignored.example" },
      author: { name: "Actor", url: "https://ignored.example" },
    });
    assert.deepEqual(out, {
      title: "Updated XP settings",
      description: null,
      url: null,
      color: 0x9b59b6,
      fields: [
        { name: "Factor", value: "5", inline: true },
        { name: "", value: "", inline: false },
      ],
      footer: { text: "Staff only" },
      timestamp: null,
      author: { name: "Actor" },
    });
  });

  it("drops empty footer/author blocks and non-array fields", () => {
    const out = normalizeEmbed({ footer: {}, author: {}, fields: "nope" });
    assert.equal(out.footer, null);
    assert.equal(out.author, null);
    assert.deepEqual(out.fields, []);
    assert.equal(out.title, null);
    assert.equal(out.color, null);
  });
});

describe("platform/context — normalizeReplyPayload", () => {
  it("converts strings to { content }", () => {
    assert.deepEqual(normalizeReplyPayload("hi"), { content: "hi" });
  });

  it("maps null/undefined to an empty payload", () => {
    assert.deepEqual(normalizeReplyPayload(null), {});
    assert.deepEqual(normalizeReplyPayload(undefined), {});
  });

  it("shallow-copies objects and preserves sensitive + allowedMentions", () => {
    const payload = {
      content: "secret",
      sensitive: true,
      allowedMentions: { parse: [] },
    };
    const out = normalizeReplyPayload(payload);
    assert.notEqual(out, payload, "must return a fresh object");
    assert.equal(out.content, "secret");
    assert.equal(out.sensitive, true, "sensitive is preserved for the adapter");
    assert.deepEqual(out.allowedMentions, { parse: [] });
  });

  it("passes AttachmentBuilder-shaped file entries through by reference", () => {
    const attachment = new AttachmentBuilder(Buffer.from("png"), {
      name: "board.png",
    });
    const out = normalizeReplyPayload({ files: [attachment] });
    assert.equal(out.files[0], attachment);
  });

  it("keeps valid plain file descriptors", () => {
    const data = Buffer.from("png");
    const out = normalizeReplyPayload({
      files: [{ name: "board.png", data, contentType: "image/png" }],
    });
    assert.deepEqual(out.files, [
      { name: "board.png", data, contentType: "image/png" },
    ]);
  });

  it("throws a specific error for invalid file entries", () => {
    const pin = (index) => (err) =>
      err instanceof Error &&
      new RegExp(`file at index ${index} needs \\{ name, data \\}`).test(
        err.message,
      );
    assert.throws(() => normalizeReplyPayload({ files: [{ name: "a.png" }] }), pin(0));
    assert.throws(() => normalizeReplyPayload({ files: [{ data: "x" }] }), pin(0));
    assert.throws(
      () => normalizeReplyPayload({ files: [{ name: "", data: "x" }] }),
      pin(0),
    );
    assert.throws(
      () => normalizeReplyPayload({ files: [{ name: "a", data: 42 }] }),
      pin(0),
    );
    assert.throws(
      () => normalizeReplyPayload({ files: [{ name: "ok", data: "x" }, null] }),
      pin(1),
    );
    assert.throws(
      () => normalizeReplyPayload({ files: "board.png" }),
      /files must be an array/,
    );
  });
});

describe("platform/context — assertCommandContext", () => {
  function fullContext(overrides = {}) {
    return {
      platform: "discord",
      instanceKey: "discord",
      communityId: 7,
      externalGuildId: "1554590611015729152",
      channelId: "10",
      userId: "9",
      user: { id: "9", username: "user_9", bot: false },
      commandName: "xp",
      subcommand: null,
      subcommandGroup: null,
      options: { getString: () => null, getInteger: () => null },
      channelPermissions: 0n,
      memberRoleIds: [],
      guildOwner: false,
      deferred: false,
      replied: false,
      reply: async () => {},
      editReply: async () => {},
      followUp: async () => {},
      defer: async () => {},
      outbound: {},
      ...overrides,
    };
  }

  it("accepts a full spec-shaped literal", () => {
    assert.doesNotThrow(() => assertCommandContext(fullContext()));
  });

  const rejections = [
    ["undefined", undefined, /CommandContext: ctx required/],
    ["null", null, /CommandContext: ctx required/],
    ["missing platform", fullContext({ platform: undefined }), /CommandContext: platform required/],
    ["non-string platform", fullContext({ platform: 1 }), /CommandContext: platform required/],
    ["string communityId (snowflake)", fullContext({ communityId: "1554590611015729152" }), /CommandContext: communityId required/],
    ["non-integer communityId", fullContext({ communityId: 1.5 }), /CommandContext: communityId required/],
    ["missing communityId", fullContext({ communityId: undefined }), /CommandContext: communityId required/],
    ["empty userId", fullContext({ userId: "" }), /CommandContext: userId required/],
    ["numeric userId", fullContext({ userId: 42 }), /CommandContext: userId required/],
    ["empty commandName", fullContext({ commandName: "" }), /CommandContext: commandName required/],
    ["missing reply", fullContext({ reply: undefined }), /CommandContext: reply required/],
    ["null options", fullContext({ options: null }), /CommandContext: options/],
    ["options without getString", fullContext({ options: {} }), /CommandContext: options/],
  ];

  for (const [label, value, pattern] of rejections) {
    it(`throws CommandContext: … required for ${label}`, () => {
      assert.throws(
        () => assertCommandContext(value),
        (err) => err instanceof Error && pattern.test(err.message),
      );
    });
  }
});
