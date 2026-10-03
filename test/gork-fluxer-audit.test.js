/**
 * Gork audit logging on Fluxer-only installs (roadmap/fluxer.md § Live E2E
 * verification, gap #4): the audit writers used getDiscordOutbound(client),
 * which throws without a Discord client — so every answered question on a
 * Fluxer-only deployment logged "Q&A audit log failed: createDiscordOutbound
 * requires a Discord client" and the audit row was lost. The helpers now
 * duck-type a Fluxer OutboundClient (platform: "fluxer") and key the
 * audit-channel settings lookup on the numeric communityId.
 *
 * No LLM involved: the audit helpers are called directly with the exact
 * opts the runGorkJob call sites pass.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { api: dbApi, cleanup } = loadDb();

const gorkAudit = require("../src/features/gork/audit");
const { ensureCommunity } = require("../src/platform/community");
const { updateGuildSettings } = require("../src/db");
const { makeFakeRest, makeFakeHandle } = require("./helpers/fluxer");

after(cleanup);

const INSTANCE = "https://fluxer.test";
const GUILD = "99";
const AUDIT_CHANNEL = "777";
const WEBAPP = "https://chat.test/";

const COMMUNITY_ID = ensureCommunity({
  platform: "fluxer",
  instanceKey: INSTANCE,
  externalGuildId: GUILD,
});

function fakeFluxerOutbound(rest) {
  const { outbound } = makeFakeHandle({ rest });
  // The real client.js stamps the discovered webapp base on the handle →
  // outbound (gap #4 wiring); fake handle has no discovery, so set it here.
  return Object.create(outbound, { webappBaseUrl: { value: WEBAPP } });
}

describe("gork audit — Fluxer OutboundClient (gap #4)", () => {
  it("Q&A embed lands in the community audit channel with fluxer jump links", async () => {
    updateGuildSettings(COMMUNITY_ID, { audit_log_channel_id: AUDIT_CHANNEL });
    const rest = makeFakeRest({
      routes: {
        [`GET /v1/channels/${AUDIT_CHANNEL}`]: { id: AUDIT_CHANNEL, type: 0 },
        [`POST /v1/channels/${AUDIT_CHANNEL}/messages`]: { id: "audit-1" },
      },
    });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(" "));
    try {
      await gorkAudit.logGorkQa(fakeFluxerOutbound(rest), GUILD, {
        communityId: COMMUNITY_ID,
        user: { id: "42", username: "asker" },
        question: "why is the sky blue",
        answer: "scattering",
        model: "test-model",
        durationMs: 1234,
        questionMessage: { id: "q-1", channelId: "55" },
        replyMessage: { id: "r-1", channelId: "55" },
      });
    } finally {
      console.warn = origWarn;
    }
    const post = rest.calls.find(
      (c) => c.method === "POST" && c.path === `/v1/channels/${AUDIT_CHANNEL}/messages`,
    );
    assert.ok(post, "audit embed must be POSTed to the audit channel (no Discord client present)");
    assert.deepEqual(warnings.filter((l) => l.includes("audit log failed")), [],
      "must not fall through the createDiscordOutbound failure");
    const embed = post.body.embeds[0];
    assert.equal(embed.title, "Gork Q&A");
    const jump = (embed.fields || []).find((f) => f.name === "Jump");
    assert.ok(jump, "embed carries the Jump field");
    assert.ok(
      jump.value.includes("https://chat.test/channels/99/55/q-1"),
      `question link uses the webapp base: ${jump.value}`,
    );
    assert.ok(jump.value.includes("https://chat.test/channels/99/55/r-1"), "reply link uses the webapp base");
  });

  it("no audit channel → console one-liner, never a crash, never a send", async () => {
    updateGuildSettings(COMMUNITY_ID, { audit_log_channel_id: null });
    const rest = makeFakeRest({ routes: {} });
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      await gorkAudit.logGorkQa(fakeFluxerOutbound(rest), GUILD, {
        communityId: COMMUNITY_ID,
        user: { id: "42", username: "asker" },
        question: "hello there",
        answer: "hi",
      });
    } finally {
      console.log = origLog;
    }
    assert.equal(rest.calls.length, 0, "no audit channel configured → no network calls");
    assert.ok(
      lines.some((l) => l.includes("[gork] Q&A (no audit channel)") && l.includes("hello there")),
      "degrades to the console one-liner",
    );
  });

  it("LLM-failure audit posts through the same Fluxer path", async () => {
    updateGuildSettings(COMMUNITY_ID, { audit_log_channel_id: AUDIT_CHANNEL });
    const rest = makeFakeRest({
      routes: {
        [`GET /v1/channels/${AUDIT_CHANNEL}`]: { id: AUDIT_CHANNEL, type: 0 },
        [`POST /v1/channels/${AUDIT_CHANNEL}/messages`]: { id: "audit-2" },
      },
    });
    await gorkAudit.logGorkFailure(fakeFluxerOutbound(rest), GUILD, {
      communityId: COMMUNITY_ID,
      user: { id: "42", username: "asker" },
      question: "why the timeout",
      reason: "LLM request timed out",
    });
    const post = rest.calls.find(
      (c) => c.method === "POST" && c.path === `/v1/channels/${AUDIT_CHANNEL}/messages`,
    );
    assert.ok(post, "failure embed must reach the audit channel");
    assert.match(JSON.stringify(post.body), /timed out/);
  });

  it("memory audit posts through the same Fluxer path", async () => {
    updateGuildSettings(COMMUNITY_ID, { audit_log_channel_id: AUDIT_CHANNEL });
    const rest = makeFakeRest({
      routes: {
        [`GET /v1/channels/${AUDIT_CHANNEL}`]: { id: AUDIT_CHANNEL, type: 0 },
        [`POST /v1/channels/${AUDIT_CHANNEL}/messages`]: { id: "audit-3" },
      },
    });
    await gorkAudit.logGorkMemory(fakeFluxerOutbound(rest), GUILD, {
      indexed: 3,
      stored: 1,
      skippedInvalid: 0,
      communityId: COMMUNITY_ID,
    });
    const post = rest.calls.find(
      (c) => c.method === "POST" && c.path === `/v1/channels/${AUDIT_CHANNEL}/messages`,
    );
    assert.ok(post, "memory entry must reach the audit channel");
    assert.match(JSON.stringify(post.body), /Stored: \+1/);
  });

  it("a Fluxer client with a non-numeric communityId degrades to console (no misrouted send)", async () => {
    const rest = makeFakeRest({ routes: {} });
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      await gorkAudit.logGorkQa(fakeFluxerOutbound(rest), GUILD, {
        communityId: "not-a-number",
        user: { id: "42" },
        question: "q",
        answer: "a",
      });
    } finally {
      console.log = origLog;
    }
    assert.equal(rest.calls.length, 0, "a bogus community id must never send");
    assert.ok(lines.some((l) => l.includes("no audit channel")));
  });
});
