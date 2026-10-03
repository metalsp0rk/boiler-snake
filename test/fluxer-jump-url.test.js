/**
 * Unit tests for src/core/jumpUrl.js (roadmap/fluxer.md § Live E2E
 * verification, gap #2): platform-aware jump URLs. The codebase hardcoded
 * `https://discord.com/channels/…` at four sites — dead links on Fluxer,
 * auto-embedded there as a Discord marketing OpenGraph card.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMessageJumpUrl,
  normalizeWebappBase,
  DISCORD_WEBAPP_BASE,
} = require("../src/core/jumpUrl");

describe("normalizeWebappBase", () => {
  it("keeps http(s) URLs and strips trailing slashes", () => {
    assert.equal(normalizeWebappBase("https://chat.test"), "https://chat.test");
    assert.equal(normalizeWebappBase("https://chat.test/"), "https://chat.test");
    assert.equal(normalizeWebappBase("https://chat.test/app///"), "https://chat.test/app");
    assert.equal(normalizeWebappBase("  http://chat.test  "), "http://chat.test");
  });

  it("rejects non-URL, non-http(s), and empty values", () => {
    assert.equal(normalizeWebappBase("not a url"), null);
    assert.equal(normalizeWebappBase("javascript:alert(1)"), null);
    assert.equal(normalizeWebappBase("ftp://chat.test"), null);
    assert.equal(normalizeWebappBase(""), null);
    assert.equal(normalizeWebappBase("   "), null);
    assert.equal(normalizeWebappBase(null), null);
    assert.equal(normalizeWebappBase(42), null);
  });
});

describe("buildMessageJumpUrl", () => {
  it("keeps the Discord scheme for discord/undefined platform", () => {
    assert.equal(
      buildMessageJumpUrl({ platform: "discord", guildId: "1", channelId: "2", messageId: "3" }),
      `${DISCORD_WEBAPP_BASE}/channels/1/2/3`,
    );
    assert.equal(
      buildMessageJumpUrl({ guildId: 1, channelId: 2, messageId: 3 }),
      `${DISCORD_WEBAPP_BASE}/channels/1/2/3`,
    );
    // A Fluxer-looking webappBaseUrl must NOT leak into a discord reply.
    assert.equal(
      buildMessageJumpUrl({
        platform: "discord",
        guildId: "1",
        channelId: "2",
        messageId: "3",
        webappBaseUrl: "https://chat.test",
      }),
      `${DISCORD_WEBAPP_BASE}/channels/1/2/3`,
    );
  });

  it("builds the Fluxer scheme from the discovered webapp base", () => {
    assert.equal(
      buildMessageJumpUrl({
        platform: "fluxer",
        guildId: "1554590611015729152",
        channelId: "44",
        messageId: "55",
        webappBaseUrl: "https://chat.test/",
      }),
      "https://chat.test/channels/1554590611015729152/44/55",
    );
  });

  it("renders a channel-only link when messageId is absent", () => {
    assert.equal(
      buildMessageJumpUrl({
        platform: "fluxer",
        guildId: "9",
        channelId: "8",
        webappBaseUrl: "https://chat.test",
      }),
      "https://chat.test/channels/9/8",
    );
    assert.equal(
      buildMessageJumpUrl({ platform: "discord", guildId: "9", channelId: "8" }),
      "https://discord.com/channels/9/8",
    );
  });

  it("returns null (never a dead link) for missing ids or a Fluxer call with no usable base", () => {
    assert.equal(
      buildMessageJumpUrl({ platform: "fluxer", guildId: "1", channelId: "2", messageId: "3" }),
      null,
    );
    assert.equal(
      buildMessageJumpUrl({
        platform: "fluxer",
        guildId: "1",
        channelId: "2",
        messageId: "3",
        webappBaseUrl: "not a url",
      }),
      null,
    );
    assert.equal(
      buildMessageJumpUrl({ platform: "discord", channelId: "2", messageId: "3" }),
      null,
    );
    assert.equal(
      buildMessageJumpUrl({ platform: "discord", guildId: "1", messageId: "3" }),
      null,
    );
    assert.equal(
      buildMessageJumpUrl({ platform: "discord", guildId: "  ", channelId: "2" }),
      null,
    );
  });
});
