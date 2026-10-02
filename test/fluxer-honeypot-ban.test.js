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

/**
 * Regression (live E2E 2026-10-02): `/honeypot channel add` crashed with
 * "Cannot read properties of undefined (reading 'channels')" — ensureHoneypotWarning
 * dereferenced raw?.guild unconditionally, and Fluxer contexts never carry a
 * rawInteraction (Contract 6). The honeypot row was ALREADY written before the
 * crash, so users saw "Something went wrong" on a config that had succeeded.
 */
describe("honeypot channel add — Fluxer arm (no raw guild, PR 7 shape)", () => {
  const ADD_CHANNEL = "78";

  function channelAddCtx(outbound, replies) {
    return {
      platform: "fluxer",
      communityId: COMMUNITY_ID,
      externalGuildId: GUILD,
      userId: "mod-1",
      user: { id: "mod-1", username: "mod" },
      commandName: "honeypot",
      subcommandGroup: "channel",
      subcommand: "add",
      options: {
        getString: () => null,
        getRole: () => null,
        getChannel: (name) =>
          name === "channel" ? { id: ADD_CHANNEL } : null,
      },
      // ManageGuild bit set → requireStaffFromContext passes.
      channelPermissions: BigInt(0x20),
      memberRoleIds: [],
      outbound,
      // Contract 6: no rawInteraction on Fluxer contexts — the exact shape
      // that used to crash the handler.
      reply: async (p) => {
        replies.push(p);
      },
    };
  }

  function cleanRow() {
    dbApi.db
      .prepare(
        "DELETE FROM honeypot_channels WHERE community_id=? AND channel_id=?",
      )
      .run(COMMUNITY_ID, ADD_CHANNEL);
  }

  function rowWarningMessageId() {
    const row = dbApi.db
      .prepare(
        "SELECT warning_message_id FROM honeypot_channels WHERE community_id=? AND channel_id=?",
      )
      .get(COMMUNITY_ID, ADD_CHANNEL);
    return row?.warning_message_id ?? null;
  }

  it("completes and posts the warning PNG via outbound (no raw guild)", async () => {
    cleanRow();
    const rest = makeFakeRest({
      routes: {
        [`GET /v1/channels/${ADD_CHANNEL}`]: {
          id: ADD_CHANNEL,
          guild_id: GUILD,
          name: "trap",
          type: 0,
        },
        [`POST /v1/channels/${ADD_CHANNEL}/messages`]: { id: "warn-1" },
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const replies = [];
    await honeypot.handlers.honeypot(channelAddCtx(outbound, replies), {});

    assert.equal(replies.length, 1, "handler must complete with one reply");
    assert.match(
      replies[0].content,
      /Marked <#78> as a \*\*honeypot\*\* channel/,
    );
    assert.match(
      replies[0].content,
      /Warning notice posted \(pinning is Discord-only\)/,
    );
    assert.equal(replies[0].sensitive, true);

    const post = rest.calls.find(
      (c) => c.method === "POST" && c.path === `/v1/channels/${ADD_CHANNEL}/messages`,
    );
    assert.ok(post, "warning PNG must be posted to the honeypot channel");
    assert.ok(
      post.body instanceof globalThis.FormData,
      "warning PNG posts multipart (AttachmentBuilder flow)",
    );
    assert.equal(rowWarningMessageId(), "warn-1");
    cleanRow();
  });

  it("a failed warning post degrades to a SPECIFIC message, not a crash", async () => {
    cleanRow();
    const rest = makeFakeRest({
      routes: {
        [`GET /v1/channels/${ADD_CHANNEL}`]: {
          id: ADD_CHANNEL,
          guild_id: GUILD,
          name: "trap",
          type: 0,
        },
        [`POST /v1/channels/${ADD_CHANNEL}/messages`]: () => {
          throw new Error("500 INTERNAL_SERVER_ERROR: boom");
        },
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const replies = [];
    await honeypot.handlers.honeypot(channelAddCtx(outbound, replies), {});

    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /Marked <#78> as a \*\*honeypot\*\* channel/);
    // Error-handling law: specific cause, never "check bot logs".
    assert.match(
      replies[0].content,
      /Could not post warning notice:.*500 INTERNAL_SERVER_ERROR/,
    );
    // The config itself still lands — the warning is best-effort.
    assert.equal(rowWarningMessageId(), null);
    cleanRow();
  });

  it("ensureHoneypotWarning without guild AND outbound skips cleanly", async () => {
    const status = await honeypot.ensureHoneypotWarning(
      null,
      ADD_CHANNEL,
      COMMUNITY_ID,
      undefined,
    );
    assert.equal(status, "Warning notice skipped (no channel access from this platform).");
  });
});
