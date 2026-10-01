/**
 * Unit tests for the Fluxer honeypot enforcement path (PR 9, roadmap/fluxer.md
 * PR 9: "honeypot bans run" when the community's elevated_permissions flag is 1).
 *
 * Ban wire (SHIPPED banMember, src/platform/fluxer/outbound.js):
 *   PUT /v1/guilds/{g}/bans/{u}  body { reason: "Honeypot: <shortReason>" }
 * K8 self-gate: at flag 0 banMember returns {ok:false, code:"elevated_disabled"}
 * with the specific reason and NEVER touches the network — the message stays
 * consumed as a honeypot hit (true), and the gate's own text is logged.
 *
 * The warning-notice reaction strip (handleHoneypotFluxerWarningReaction) is
 * the PR 9 fluxer branch of the PR 6 pipeline seam: the store is the
 * honeypot_channels.warning_message_id column, so the lookup works from the
 * normalized ids alone — the strip itself rides removeEmojiReaction (reactions
 * are not elevated).
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { api: dbApi, cleanup } = loadDb();

const honeypot = require("../src/features/honeypot");
const pipelines = require("../src/bot/pipelines");
const { ensureCommunity } = require("../src/platform/community");
const { makeFakeRest, makeFakeHandle } = require("./helpers/fluxer");

after(cleanup);

const INSTANCE = "https://fluxer.test";
const GUILD = "99";
const HONEYPOT_CHANNEL = "77";

const COMMUNITY_ID = ensureCommunity({
  platform: "fluxer",
  instanceKey: INSTANCE,
  externalGuildId: GUILD,
});

function setElevatedFlag(value) {
  dbApi.db
    .prepare("UPDATE communities SET elevated_permissions=? WHERE id=?")
    .run(value, COMMUNITY_ID);
}

function normalizedMessage(overrides = {}) {
  return {
    platform: "fluxer",
    instanceKey: INSTANCE,
    communityId: COMMUNITY_ID,
    externalGuildId: GUILD,
    id: "m-1",
    channelId: HONEYPOT_CHANNEL,
    authorId: "spammer-1",
    authorBot: false,
    memberRoleIds: [],
    ...overrides,
  };
}

function memberRoute(authorId, roles = []) {
  return {
    [`GET /v1/guilds/${GUILD}/members/${authorId}`]: {
      user: { id: authorId, username: "u", bot: false },
      roles,
    },
  };
}

/** Capture console.log/.error/.warn for the duration of fn. */
async function withConsole(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const cap = (...args) => lines.push(args.map((a) => String(a)).join(" "));
  console.log = cap;
  console.error = cap;
  console.warn = cap;
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
  }
}

function banHits(rest, authorId) {
  return rest.calls.filter(
    (c) => c.method === "PUT" && c.path === `/v1/guilds/${GUILD}/bans/${authorId}`,
  );
}

describe("fluxer honeypot ban — K8 flag 0", () => {
  it("banMember is CALLED, self-gates to elevated_disabled with zero ban traffic, and the specific reason is logged", async () => {
    dbApi.addHoneypotChannel(COMMUNITY_ID, HONEYPOT_CHANNEL);
    setElevatedFlag(0);
    const rest = makeFakeRest({ routes: memberRoute("spammer-1") });
    const { outbound } = makeFakeHandle({ rest });

    const { result, lines } = await withConsole(() =>
      honeypot.handleHoneypotFluxerMessage(outbound, normalizedMessage({ authorId: "spammer-1" })),
    );

    assert.equal(result, true, "the message stays consumed as a honeypot hit");
    assert.equal(
      rest.calls.filter((c) => c.method === "PUT").length,
      0,
      "flag 0: the elevated ban leg NEVER touches the network (only the staff-check member GET ran)",
    );
    assert.equal(
      rest.calls.filter((c) => c.path.startsWith(`/v1/guilds/${GUILD}/bans/`)).length,
      0,
    );
    assert.ok(
      lines.some(
        (l) =>
          l.includes("honeypot ban suppressed") &&
          l.includes("elevated_permissions=0") &&
          l.includes(`community ${COMMUNITY_ID}`),
      ),
      "the K8 gate's OWN specific reason (names elevated_permissions + community) is logged — not a generic string",
    );
    assert.ok(
      lines.some((l) => l.includes("message delete suppressed") && l.includes("no OutboundClient.deleteMessage")),
      "the message-delete suppression line remains (out of scope in PR 9)",
    );
  });
});

describe("fluxer honeypot ban — K8 flag 1", () => {
  it("issues PUT /v1/guilds/{g}/bans/{u} with the honeypot reason", async () => {
    dbApi.addHoneypotChannel(COMMUNITY_ID, HONEYPOT_CHANNEL);
    setElevatedFlag(1);
    const rest = makeFakeRest({
      routes: { ...memberRoute("spammer-2"), [`PUT /v1/guilds/${GUILD}/bans/spammer-2`]: null },
    });
    const { outbound } = makeFakeHandle({ rest });

    const { result, lines } = await withConsole(() =>
      honeypot.handleHoneypotFluxerMessage(outbound, normalizedMessage({ authorId: "spammer-2" })),
    );

    assert.equal(result, true);
    const ban = banHits(rest, "spammer-2");
    assert.equal(ban.length, 1, "exactly one ban PUT");
    assert.equal(
      ban[0].body.reason,
      "Honeypot: Posted in a honeypot channel",
      "reason mirrors the Discord ban reason shape (Honeypot: <shortReason>)",
    );
    assert.ok(
      lines.some((l) => l.includes("Banned user spammer-2") && l.includes(`community ${COMMUNITY_ID}`)),
      "success log mirrors the Discord ban log",
    );
  });

  it("ban failures on the wire are logged with the specific cause", async () => {
    dbApi.addHoneypotChannel(COMMUNITY_ID, HONEYPOT_CHANNEL);
    setElevatedFlag(1);
    const rest = makeFakeRest({ routes: memberRoute("spammer-3") }); // no ban route → 404
    const { outbound } = makeFakeHandle({ rest });

    const { result, lines } = await withConsole(() =>
      honeypot.handleHoneypotFluxerMessage(outbound, normalizedMessage({ authorId: "spammer-3" })),
    );

    assert.equal(result, true, "a failed ban still consumes the message as a hit");
    assert.equal(banHits(rest, "spammer-3").length, 1, "the ban attempt hit the wire (404 from the fake)");
    assert.ok(
      lines.some((l) => l.includes("honeypot ban failed") && l.includes("404")),
      "failure log carries the specific API cause, never a generic string",
    );
  });

  it("rapid messages from one author ban exactly once (in-flight dedupe parity)", async () => {
    dbApi.addHoneypotChannel(COMMUNITY_ID, HONEYPOT_CHANNEL);
    setElevatedFlag(1);
    const rest = makeFakeRest({
      routes: { ...memberRoute("dupe-1"), [`PUT /v1/guilds/${GUILD}/bans/dupe-1`]: null },
    });
    const { outbound } = makeFakeHandle({ rest });

    const first = await honeypot.handleHoneypotFluxerMessage(
      outbound,
      normalizedMessage({ authorId: "dupe-1", id: "m-a" }),
    );
    const second = await honeypot.handleHoneypotFluxerMessage(
      outbound,
      normalizedMessage({ authorId: "dupe-1", id: "m-b" }),
    );

    assert.equal(first, true);
    assert.equal(second, true, "the second message is still consumed as a hit");
    assert.equal(banHits(rest, "dupe-1").length, 1, "the 10s in-flight window dedupes the ban");
  });
});

describe("fluxer honeypot — gates unchanged", () => {
  it("staff-exempt author: consumed, no ban, message stands", async () => {
    dbApi.addHoneypotChannel(COMMUNITY_ID, HONEYPOT_CHANNEL);
    dbApi.addStaffRole(COMMUNITY_ID, "role-staff");
    setElevatedFlag(1);
    const rest = makeFakeRest({ routes: memberRoute("staff-1", ["role-staff"]) });
    const { outbound } = makeFakeHandle({ rest });

    const { result, lines } = await withConsole(() =>
      honeypot.handleHoneypotFluxerMessage(outbound, normalizedMessage({ authorId: "staff-1" })),
    );

    assert.equal(result, true);
    assert.equal(banHits(rest, "staff-1").length, 0, "exempt staff are never banned");
    assert.ok(
      lines.some((l) => l.includes("exempt member") && l.includes("no ban")),
      "the exemption decision is logged (no silent drop)",
    );
  });

  it("non-honeypot channel: not handled, zero network", async () => {
    setElevatedFlag(1);
    const rest = makeFakeRest({ routes: {} });
    const { outbound } = makeFakeHandle({ rest });

    const { result } = await withConsole(() =>
      honeypot.handleHoneypotFluxerMessage(
        outbound,
        normalizedMessage({ authorId: "citizen-1", channelId: "9999" }),
      ),
    );

    assert.equal(result, false);
    assert.equal(rest.calls.length, 0, "a non-honeypot channel is a zero-call no-op");
  });
});

describe("fluxer pipelines — honeypot warning-reaction strip (PR 9 fluxer branch)", () => {
  it("a reaction on a warning notice is wiped via removeEmojiReaction — for bots too", async () => {
    dbApi.addHoneypotChannel(COMMUNITY_ID, HONEYPOT_CHANNEL);
    dbApi.setHoneypotWarningMessage(COMMUNITY_ID, HONEYPOT_CHANNEL, "600");
    setElevatedFlag(0); // reactions are NOT elevated — the strip works at flag 0
    const emoji = "👍";
    const wipePath = `/v1/channels/${HONEYPOT_CHANNEL}/messages/600/reactions/${encodeURIComponent(emoji)}`;
    const rest = makeFakeRest({ routes: { [`DELETE ${wipePath}`]: {} } });
    const { outbound } = makeFakeHandle({ rest });

    await withConsole(() =>
      pipelines.onFluxerReactionAdd(
        outbound,
        {
          platform: "fluxer",
          instanceKey: INSTANCE,
          communityId: COMMUNITY_ID,
          externalGuildId: GUILD,
          messageId: "600",
          channelId: HONEYPOT_CHANNEL,
          userId: "bot-1",
          userBot: true, // Discord parity: the strip runs for bots so the notice stays clean
          emojiKey: emoji,
        },
      ),
    );

    assert.equal(
      rest.calls.filter((c) => c.method === "DELETE" && c.path === wipePath).length,
      1,
      "full-emoji wipe issued (the OutboundClient twin of reaction.remove())",
    );
  });
});
