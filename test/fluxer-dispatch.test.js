/**
 * Unit tests for src/platform/fluxer/dispatch.js (PR 6). ParsedCommands are
 * built THROUGH the real parser (parsePrefix + buildDefaultRegistry().commands)
 * — the dispatch contract is the parser's output, not hand-rolled shapes.
 *
 * REST assertions run against Agent A's fake transport (test/helpers/fluxer.js,
 * pinned shape). Every reply the dispatcher sends is a recorded POST, so the
 * tests assert on rest.calls.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { api: dbApi, cleanup } = loadDb();

const { parsePrefix } = require("../src/platform/fluxer/commands");
const {
  dispatchPrefixCommand,
  NOT_ON_FLUXER,
} = require("../src/platform/fluxer/dispatch");
const { createRegistry, buildDefaultRegistry } = require("../src/commands/registry");
const { ensureCommunity } = require("../src/platform/community");
const { MSG_GENERIC_ERROR } = require("../src/core/theme");
const {
  makeFakeRest,
  makeFakeHandle,
  gatewayMessage,
} = require("./helpers/fluxer");
const { normalizeFluxerMessage } = require("../src/platform/fluxer/normalize");

after(cleanup);

const INSTANCE = "https://fluxer.test";
const GUILD = "1554590611015729152";
const CHANNEL = "555000111";

const registry = buildDefaultRegistry();
const P = { registryCommands: registry.commands, prefix: "!" };
const COMMUNITY_ID = ensureCommunity({
  platform: "fluxer",
  instanceKey: INSTANCE,
  externalGuildId: GUILD,
});

/**
 * A NormalizedMessage through the REAL normalizer (keeps the dispatch tests
 * honest about the field names the pipeline delivers).
 */
function fluxerMessage(overrides = {}) {
  const normalized = normalizeFluxerMessage(
    {
      t: "MESSAGE_CREATE",
      d: gatewayMessage({ content: "", channel_id: CHANNEL, guild_id: GUILD, ...overrides }),
    },
    { instanceKey: INSTANCE },
  );
  normalized.communityId = COMMUNITY_ID;
  return normalized;
}

function postCalls(rest) {
  return rest.calls.filter((c) => c.method === "POST" && c.path.includes("/messages"));
}

function lastPostBody(rest) {
  const posts = postCalls(rest);
  return posts[posts.length - 1]?.body;
}

describe("fluxer/dispatch — K2: /xp replies by DM, never in channel", () => {
  it("!xp sends POST /users/@me/channels, then posts to the DM channel", async () => {
    const rest = makeFakeRest({
      routes: {
        "POST /v1/users/@me/channels": { id: "dm-42", type: 1 },
        "POST /v1/channels/dm-42/messages": { id: "r-1" },
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const message = fluxerMessage({ content: "!xp" });
    const parsed = parsePrefix("!xp", P);
    assert.ok(parsed && !parsed.usageError);

    await dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor: null });

    const paths = rest.calls.map((c) => c.path);
    assert.equal(rest.calls[0].method, "POST");
    assert.equal(rest.calls[0].path, "/v1/users/@me/channels");
    // Target ids/usernames are read from the fixture payload itself so the
    // assertions survive fixture evolution (they must match what the bot
    // received, not hard-coded literals).
    assert.deepEqual(rest.calls[0].body, { recipient_id: message.authorId });
    assert.equal(rest.calls[1].path, "/v1/channels/dm-42/messages");

    const body = rest.calls[1].body;
    const username = message.authorRaw?.username ?? "sparky";
    assert.ok(body.content.includes(username), `expected "${username}" in: ${body.content}`);
    assert.match(body.content, /XP/);
    assert.match(body.content, /Level/);

    // NOT the channel: the guild channel never receives a POST.
    assert.ok(
      !paths.includes(`/v1/channels/${CHANNEL}/messages`),
      "K2: /xp output is private — no channel post",
    );
  });
});

describe("fluxer/dispatch — parse outcomes", () => {
  it("a null parse dispatches nothing (no REST calls)", async () => {
    const rest = makeFakeRest({ routes: {} });
    const { outbound } = makeFakeHandle({ rest });
    const message = fluxerMessage({ content: "!frobnicate" });
    assert.equal(parsePrefix("!frobnicate", P), null, "not a command at all");
    await dispatchPrefixCommand(outbound, message, null, { registry, supervisor: null });
    assert.equal(rest.calls.length, 0);
  });

  it("usage error → channel reply with the reason + the command's help block", async () => {
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/555000111/messages": { id: "u-1" } },
    });
    const { outbound } = makeFakeHandle({ rest });
    const message = fluxerMessage({ content: "!setxp 5" });
    const parsed = parsePrefix("!setxp 5", P);
    assert.ok(parsed.usageError, "5 is not an option name");

    await dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor: null });

    const posts = postCalls(rest);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, `/v1/channels/${CHANNEL}/messages`);
    assert.match(posts[0].body.content, /"5"/, "the reason line names the offending token");
    assert.match(posts[0].body.content, /setxp/, "the help block for the matched command rides along");
    assert.deepEqual(posts[0].body.allowed_mentions, { parse: [] }, "usage replies ping nobody");
  });

  it("a channel-type mismatch is a usage reply naming option + type", async () => {
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/555000111/messages": { id: "u-2" } },
    });
    const { outbound } = makeFakeHandle({ rest });
    const message = fluxerMessage({ content: "!setwarn log channel 12345" });
    // Gateway said channel 12345 is a VOICE channel (Fluxer type 2).
    message.channelTypes = new Map([["12345", 2]]);
    const parsed = parsePrefix("!setwarn log channel 12345", P);
    assert.equal(parsed.usageError, null, "the parser validates shape only");

    await dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor: null });

    const posts = postCalls(rest);
    assert.equal(posts.length, 1);
    assert.match(posts[0].body.content, /"channel"/, "names the option");
    assert.match(posts[0].body.content, /type 2/, "names the offending numeric type");
    assert.match(posts[0].body.content, /0, 5/, "lists the accepted types from the builder JSON");
  });

  it("unresolvable user id → 'Could not resolve user' and NO handler call", async () => {
    const rest = makeFakeRest({ routes: {} }); // GET /users → FAKE_NO_ROUTE → null
    const { outbound } = makeFakeHandle({ rest });
    const message = fluxerMessage({ content: "!grantxp user 999000111 amount 5" });
    const parsed = parsePrefix("!grantxp user 999000111 amount 5", P);
    assert.equal(parsed.usageError, null);

    await dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor: null });

    // One fetch attempt for the id, then the specific reply — grantxp never ran
    // (its admin-denial DM would be a POST /users/@me/channels, absent here).
    assert.ok(rest.calls.some((c) => c.method === "GET" && c.path === "/v1/users/999000111"));
    const posts = postCalls(rest);
    assert.equal(posts.length, 1);
    assert.match(posts[0].body.content, /Could not resolve user 999000111/);
  });

  it("a fetchable user id resolves through fetchUser once (spec step 7)", async () => {
    const rest = makeFakeRest({
      routes: {
        "GET /v1/users/999000111": { id: "999000111", username: "zoe", bot: false },
        // grantxp is context-API; the invoker is not staff (mask 0n) → the
        // handler's own sensitive denial reply proves it ran with a resolved user.
        "POST /v1/users/@me/channels": { id: "dm-7" },
        "POST /v1/channels/dm-7/messages": { id: "r-2" },
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const message = fluxerMessage({ content: "!grantxp user 999000111 amount 5" });
    const parsed = parsePrefix("!grantxp user 999000111 amount 5", P);

    await dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor: null });

    assert.equal(
      rest.calls.filter((c) => c.method === "GET" && c.path === "/v1/users/999000111").length,
      1,
      "the fetch happens exactly once",
    );
    const dmPost = rest.calls.find((c) => c.path === "/v1/channels/dm-7/messages");
    assert.ok(dmPost, "the handler ran and answered via DM (sensitive denial)");
    assert.match(dmPost.body.content, /permission/i, "requireAdminFromContext denial copy");
  });
});

describe("fluxer/dispatch — gates", () => {
  const allowedChannel = "999888777";
  const addGate = () => dbApi.addAllowedCommandChannel(COMMUNITY_ID, allowedChannel);
  const clearGate = () => dbApi.removeAllowedCommandChannel(COMMUNITY_ID, allowedChannel);

  it("a configured allow-list denies other channels with the exact copy", async () => {
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/555000111/messages": { id: "d-1" } },
    });
    const { outbound } = makeFakeHandle({ rest });
    const message = fluxerMessage({ content: "!xp" });
    const parsed = parsePrefix("!xp", P);

    addGate();
    try {
      await dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor: null });
      const posts = postCalls(rest);
      assert.equal(posts.length, 1);
      assert.equal(
        posts[0].body.content,
        "Commands aren't enabled in this channel.",
        "spec § Command-channel allow-list: reply in channel, not DM",
      );
    } finally {
      clearGate();
    }
  });

  it("no allow-list rows → the command runs (XP reply via DM)", async () => {
    const rest = makeFakeRest({
      routes: {
        "POST /v1/users/@me/channels": { id: "dm-5" },
        "POST /v1/channels/dm-5/messages": { id: "r-3" },
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const message = fluxerMessage({ content: "!xp" });
    const parsed = parsePrefix("!xp", P);

    await dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor: null });
    assert.ok(
      rest.calls.some((c) => c.path === "/v1/channels/dm-5/messages"),
      "no rows → allowed everywhere (spec § Command-channel allow-list)",
    );
  });

  it("interaction-API commands (music) get the NOT_ON_FLUXER line", async () => {
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/555000111/messages": { id: "n-1" } },
    });
    const { outbound } = makeFakeHandle({ rest });
    const message = fluxerMessage({ content: "!music skip" });
    const parsed = parsePrefix("!music skip", P);
    assert.equal(parsed.usageError, null);
    assert.equal(registry.getHandlerApi("music"), "interaction", "music is legacy in PR 6");

    await dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor: null });

    const posts = postCalls(rest);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.content, NOT_ON_FLUXER);
    assert.equal(NOT_ON_FLUXER, "That command is not available on Fluxer yet.");
  });
});

describe("fluxer/dispatch — handler failures", () => {
  it("a throwing handler is logged with the cause and answered with the generic copy", async () => {
    const rest = makeFakeRest({
      routes: {
        "POST /v1/users/@me/channels": { id: "dm-8" },
        "POST /v1/channels/dm-8/messages": { id: "r-4" },
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const stub = createRegistry();
    stub.registerHandler(
      "probe",
      async () => {
        throw new Error("boom");
      },
      { api: "context" },
    );

    const message = fluxerMessage({ content: "!probe" });
    const parsed = {
      commandName: "probe",
      subcommandGroup: null,
      subcommand: null,
      options: [],
      help: null,
      usageError: null,
    };

    const orig = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(" "));
    try {
      await dispatchPrefixCommand(outbound, message, parsed, { registry: stub, supervisor: null });
    } finally {
      console.error = orig;
    }

    assert.equal(
      logged.some((l) => l.includes("[fluxer] /probe failed: boom")),
      true,
      "log line carries the command and the cause (AGENTS.md rule 2)",
    );
    // Router-parity generic copy, DM-first (spec 652), on the recorded transport.
    const dmPost = rest.calls.find((c) => c.path === "/v1/channels/dm-8/messages");
    assert.ok(dmPost, "the generic reply goes out via DM (the handler's output kind)");
    assert.equal(dmPost.body.content, MSG_GENERIC_ERROR);
  });

  it("an unregistered handler name never reaches a handler and answers NOT_ON_FLUXER", async () => {
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/555000111/messages": { id: "n-2" } },
    });
    const { outbound } = makeFakeHandle({ rest });
    const stub = createRegistry(); // no handlers at all
    const message = fluxerMessage({ content: "!probe" });
    const parsed = {
      commandName: "probe",
      subcommandGroup: null,
      subcommand: null,
      options: [],
      help: null,
      usageError: null,
    };
    await dispatchPrefixCommand(outbound, message, parsed, { registry: stub, supervisor: null });
    assert.equal(postCalls(rest)[0].body.content, NOT_ON_FLUXER);
  });
});

describe("fluxer/dispatch — !help rendering", () => {
  it("!help lists commands and marks Discord-only ones", async () => {
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/555000111/messages": { id: "h-1" } },
    });
    const { outbound } = makeFakeHandle({ rest });
    const message = fluxerMessage({ content: "!help" });
    const parsed = parsePrefix("!help", P);

    await dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor: null });

    const content = lastPostBody(rest).content;
    assert.match(content, /Commands/);
    assert.match(content, /- xp — /, "public commands are listed with descriptions");
    assert.match(content, /- leaderboard — /);
    assert.match(content, /- music — Discord only/, "Discord-only line for music");
    assert.match(content, /- play — Discord only/);
    assert.match(content, /- eventreminder — Discord only/);
    assert.match(content, /ticket panel — Discord only/, "ticket panel note rides on ticket");
    assert.match(content, /- help — /, "the synthetic command is listed too");
  });

  it("!help warn shows the subcommand option line: user <user>, reason <string>, silent [boolean]", async () => {
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/555000111/messages": { id: "h-2" } },
    });
    const { outbound } = makeFakeHandle({ rest });
    const parsed = parsePrefix("!help warn", P);
    const message = fluxerMessage({ content: "!help warn" });

    await dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor: null });

    const content = lastPostBody(rest).content;
    assert.match(content, /warn add — /);
    assert.match(content, /user <user>/, "required option renders name <type>");
    assert.match(content, /reason <string>/);
    assert.match(content, /silent \[boolean\]/, "optional renders name [type]");
  });

  it("!help warn add shows the options with numeric bounds", async () => {
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/555000111/messages": { id: "h-3" } },
    });
    const { outbound } = makeFakeHandle({ rest });
    const parsed = parsePrefix("!help warn add", P);
    const message = fluxerMessage({ content: "!help warn add" });

    await dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor: null });

    const content = lastPostBody(rest).content;
    assert.match(content, /warn add — user <user>, reason <string>/);
    assert.match(content, /expires_days \[integer\]/);
  });

  it("!help leaderboard prints the integer bounds from the builder JSON", async () => {
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/555000111/messages": { id: "h-4" } },
    });
    const { outbound } = makeFakeHandle({ rest });
    const parsed = parsePrefix("!help leaderboard", P);
    const message = fluxerMessage({ content: "!help leaderboard" });

    await dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor: null });

    const content = lastPostBody(rest).content;
    assert.match(content, /limit \[integer\] \(1-20\)/, "min/max are rendered when set");
    assert.match(content, /page \[integer\] \(1-20\)/);
  });

  it("!help warnx → 'No command warnx.'", async () => {
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/555000111/messages": { id: "h-5" } },
    });
    const { outbound } = makeFakeHandle({ rest });
    const parsed = parsePrefix("!help warnx", P);
    const message = fluxerMessage({ content: "!help warnx" });

    await dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor: null });

    assert.equal(lastPostBody(rest).content, "No command warnx.");
  });

  it("!help honeypot channel shows the group and its subcommands", async () => {
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/555000111/messages": { id: "h-6" } },
    });
    const { outbound } = makeFakeHandle({ rest });
    const parsed = parsePrefix("!help honeypot channel", P);
    const message = fluxerMessage({ content: "!help honeypot channel" });

    await dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor: null });

    const content = lastPostBody(rest).content;
    assert.match(content, /honeypot channel — /, "the group header line");
    assert.match(content, /honeypot channel add — /, "group subcommands listed");
    assert.match(content, /channel <channel>/, "options render for the group's subcommands");
  });

  it("!help music is JUST the Discord-only line", async () => {
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/555000111/messages": { id: "h-7" } },
    });
    const { outbound } = makeFakeHandle({ rest });
    const parsed = parsePrefix("!help music", P);
    const message = fluxerMessage({ content: "!help music" });

    await dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor: null });

    assert.match(lastPostBody(rest).content, /^music — Discord only/);
  });
});
