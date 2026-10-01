/**
 * Gork `read_history` tool unit tests (roadmap/fluxer.md § Gork mentions
 * and history, lines 636–644; PR 8).
 *
 * Drives the REAL Fluxer OutboundClient over the SDK-free fake REST
 * transport (test/helpers/fluxer.js) — window assertions are made on the
 * `GET /v1/channels/{c}/messages` QUERY params (before/after/limit), the
 * same contract Phase 0 recorded. No sockets, no SDK, no Discord client.
 * The ticket blackout runs against an injected repo stub (the readDiscord
 * options pattern), so no tickets rows are required.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");

const INSTANCE = "https://fluxer.test";
const GUILD = "99";
const GUILD_OTHER = "98";
// Bare ids must satisfy the snowflake grammar (5–25 digits, the readDiscord
// parity range). Realistic-length ids keep the routes readable.
const CHANNEL = "70001";
const CHANNEL_OTHER = "80001";
const CHANNEL_CATEGORY = "90001";
const ASKER = "5";

const TS = "2026-09-29T12:00:00.000Z";

let env;
let rh;
let makeFakeRest;
let makeFakeHandle;
let FluxerRestError;
let ANCHOR_MARKER;
let communityId;
let communityIdOther;

before(() => {
  env = loadDb();
  // Fresh requires so every module binds to THIS db (loadDb reset the cache).
  rh = require("../src/features/gork/tools/readHistory");
  const helpers = require("./helpers/fluxer");
  makeFakeRest = helpers.makeFakeRest;
  makeFakeHandle = helpers.makeFakeHandle;
  FluxerRestError = helpers.FluxerRestError;
  ANCHOR_MARKER = require("../src/features/gork/tools/readDiscord").ANCHOR_MARKER;
  communityId = communityKey(GUILD, "fluxer", INSTANCE);
  communityIdOther = communityKey(GUILD_OTHER, "fluxer", INSTANCE);
});

after(() => {
  env.cleanup();
});

/* ------------------------------- fakes ---------------------------------- */

/**
 * Scripted channel: `GET /v1/channels/70001` resolves to this guild's
 * channel. Extra channels: CHANNEL_OTHER belongs to the OTHER guild,
 * CHANNEL_CATEGORY is a category (type 4).
 */
const CHANNEL_ROUTES = {
  [`GET /v1/channels/${CHANNEL}`]: () => ({ id: CHANNEL, type: 0, community_id: GUILD }),
  [`GET /v1/channels/${CHANNEL_OTHER}`]: () => ({ id: CHANNEL_OTHER, type: 0, community_id: GUILD_OTHER }),
  [`GET /v1/channels/${CHANNEL_CATEGORY}`]: () => ({ id: CHANNEL_CATEGORY, type: 4, community_id: GUILD }),
};

/** Fixed-width ids so lexicographic order matches chronological order. */
function makeRows(n, start = 1) {
  return Array.from({ length: n }, (_, i) => ({
    id: String(1000000 + start + i),
    author: { id: (start + i) % 2 === 1 ? "5" : "6", bot: false },
    content: `msg ${start + i}`,
    timestamp: TS,
  }));
}

/**
 * Simulate the Phase 0 history endpoint: `before`/`after` cursors + limit,
 * newest-first for `before`-mode (readDiscord's makeChannel contract).
 */
function messagesRoute(rows) {
  const cmp = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
  return (body, req) => {
    const q = req.query || {};
    let list = rows.slice();
    if (q.before) list = list.filter((r) => cmp(r.id, q.before) < 0);
    if (q.after) list = list.filter((r) => cmp(r.id, q.after) > 0);
    const ascending = Boolean(q.after) && !q.before;
    list.sort((a, b) => (ascending ? cmp(a.id, b.id) : cmp(b.id, a.id)));
    return list.slice(0, Number(q.limit) || 100);
  };
}

function makeOutbound(routes) {
  const rest = makeFakeRest({ routes });
  const handle = makeFakeHandle({ instanceKey: INSTANCE, rest });
  return { outbound: handle.outbound, rest };
}

/** Repo stub with the community-keyed getTicketByChannel signature. */
function repoStub(ticket = null) {
  return {
    calls: [],
    getTicketByChannel(cid, channelId) {
      this.calls.push([cid, channelId]);
      return ticket;
    },
  };
}

function execRoutes(rows, extraRoutes = {}) {
  return {
    ...CHANNEL_ROUTES,
    "GET /v1/channels/70001/messages": messagesRoute(rows),
    "GET /v1/users/5": () => ({ id: "5", username: "alice", bot: false }),
    "GET /v1/users/6": () => ({ id: "6", username: "bob", bot: false }),
    ...extraRoutes,
  };
}

function execArgs(outbound, repo = repoStub()) {
  return {
    communityId,
    outbound,
    currentChannelId: CHANNEL,
    askerId: ASKER,
    repo,
  };
}

/* ------------------------------- tool JSON -------------------------------- */

describe("READ_HISTORY_TOOL (schema)", () => {
  it("is the read_history function tool with one string arg", () => {
    assert.equal(rh.READ_HISTORY_TOOL.type, "function");
    assert.equal(rh.READ_HISTORY_TOOL.function.name, "read_history");
    assert.deepEqual(rh.READ_HISTORY_TOOL.function.parameters.required, ["link"]);
    assert.equal(
      rh.READ_HISTORY_TOOL.function.parameters.properties.link.type,
      "string",
    );
  });
});

/* ------------------------------- parsing ---------------------------------- */

describe("parseHistoryTarget (bare ids only)", () => {
  it("accepts bare 5–25 digit ids (the readDiscord snowflake grammar)", () => {
    assert.deepEqual(rh.parseHistoryTarget("12345"), {
      ok: true,
      kind: "id",
      id: "12345",
    });
    assert.equal(rh.parseHistoryTarget(" 1000010 ").id, "1000010");
    assert.equal(rh.parseHistoryTarget("12345678901234567890").ok, true);
    // Upper bound matches readDiscord's /^\d{5,25}$/: 25 digits in, 26 out.
    assert.equal(rh.parseHistoryTarget("1".repeat(25)).ok, true);
    assert.equal(rh.parseHistoryTarget("1".repeat(26)).ok, false);
  });

  it("rejects short ids, non-ids, whitespace-joined text", () => {
    assert.equal(rh.parseHistoryTarget("1234").ok, false);
    assert.equal(rh.parseHistoryTarget("1".repeat(26)).ok, false);
    assert.equal(rh.parseHistoryTarget("abc123").ok, false);
    assert.equal(rh.parseHistoryTarget("12345 67890").ok, false);
    assert.equal(rh.parseHistoryTarget(null).ok, false);
  });

  it("flags Discord links as a dedicated rejection (before any lookup)", () => {
    for (const raw of [
      "https://discord.com/channels/99/7/1000010",
      "https://discordapp.com/channels/99/7",
      "www.discord.com/channels/99/7/1000010",
    ]) {
      const parsed = rh.parseHistoryTarget(raw);
      assert.equal(parsed.ok, false, raw);
      assert.equal(parsed.discordLink, true, raw);
    }
  });
});

/* --------------------------- locked rejection ----------------------------- */

describe("Discord link rejection (locked copy)", () => {
  it("is the exact spec sentence, no lookup attempted", async () => {
    const { outbound, rest } = makeOutbound(execRoutes([]));
    const out = await rh.executeReadHistory(
      "https://discord.com/channels/99/7/1000010",
      execArgs(outbound),
    );
    assert.equal(
      out,
      "Could not read target: that link is a Discord link and this community is not Discord.",
    );
    // The executor never touched the network for a Discord link.
    assert.deepEqual(rest.calls, []);
  });
});

/* ------------------------------ channel window ---------------------------- */

describe("channel window (50 newest via GET /v1/channels/{c}/messages)", () => {
  it("fetches limit 50 and renders id | timestamp | @author lines oldest→newest", async () => {
    const { outbound, rest } = makeOutbound(execRoutes(makeRows(60)));
    const out = await rh.executeReadHistory(CHANNEL, execArgs(outbound));
    const lines = out.split("\n");
    assert.equal(lines.length, 50, "exactly the 50 newest messages");
    assert.equal(lines[0], `1000011 | ${TS} | @alice: msg 11`, "oldest first");
    assert.equal(lines[49], `1000060 | ${TS} | @bob: msg 60`, "newest last");

    const historyCall = rest.calls.find(
      (c) => c.method === "GET" && c.path === `/v1/channels/${CHANNEL}/messages`,
    );
    assert.ok(historyCall, "channel history endpoint was called");
    assert.deepEqual(historyCall.query, { limit: 50 });
    // Channel resolution + ownership check used the recorded channel GET.
    const chanCall = rest.calls.find(
      (c) => c.method === "GET" && c.path === `/v1/channels/${CHANNEL}`,
    );
    assert.ok(chanCall);
  });

  it("resolves author ids to names via GET /v1/users/{id}", async () => {
    const { outbound, rest } = makeOutbound(execRoutes(makeRows(3)));
    const out = await rh.executeReadHistory(CHANNEL, execArgs(outbound));
    assert.ok(out.includes("@alice: msg 1"));
    assert.ok(out.includes("@bob: msg 2"));
    assert.ok(
      rest.calls.some((c) => c.method === "GET" && c.path === "/v1/users/5"),
      "author id 5 resolved through fetchUser",
    );
  });

  it("empty channel → the locked no-messages line", async () => {
    const { outbound } = makeOutbound(execRoutes([]));
    const out = await rh.executeReadHistory(CHANNEL, execArgs(outbound));
    assert.equal(out, "No messages to read in channel 70001.");
  });
});

/* ------------------------------ message window ---------------------------- */

describe("message window (anchor + 40 before + 10 after)", () => {
  const anchorRows = makeRows(20); // 1000001..1000020

  it("issues the exact three window fetches with before/after/limit query params", async () => {
    const { outbound, rest } = makeOutbound(execRoutes(anchorRows));
    const out = await rh.executeReadHistory("1000010", execArgs(outbound));

    const queries = rest.calls
      .filter((c) => c.path === `/v1/channels/${CHANNEL}/messages`)
      .map((c) => c.query);
    // Anchor = `after: anchorId−1, limit 1` (the row nearest the cursor,
    // ascending), then the spec windows on the raw anchor id.
    assert.deepEqual(queries, [
      { limit: 1, after: "1000009" },
      { limit: 40, before: "1000010" },
      { limit: 10, after: "1000010" },
    ]);

    const lines = out.split("\n");
    assert.equal(lines.length, 20, "9 before + anchor + 10 after");
    assert.equal(lines[0], `1000001 | ${TS} | @alice: msg 1`);
    assert.ok(
      lines[9].endsWith(ANCHOR_MARKER),
      "the anchor line carries the locked [LINKED MESSAGE] marker",
    );
    assert.ok(lines[9].startsWith("1000010 | "));
    assert.ok(!lines[8].includes(ANCHOR_MARKER));
  });

  it("degrades short windows to fewer rows (no anchor-pad fetches)", async () => {
    const { outbound, rest } = makeOutbound(execRoutes(makeRows(4, 18)));
    const out = await rh.executeReadHistory("1000020", execArgs(outbound));
    const lines = out.split("\n");
    assert.equal(lines.length, 4, "rows 18..21, anchor 1000020 included");
    assert.equal(lines[2], `1000020 | ${TS} | @bob: msg 20` + ANCHOR_MARKER);
    assert.ok(!lines[3].includes(ANCHOR_MARKER), "the anchor is not the last row");
    const afterCall = rest.calls.find(
      (c) => c.path === `/v1/channels/${CHANNEL}/messages` && c.query.after === "1000020",
    );
    assert.equal(afterCall.query.limit, 10, "the after window still asked for 10");
  });

  it("a bare message id the channel does not have → specific failure", async () => {
    const { outbound } = makeOutbound(execRoutes(anchorRows));
    const out = await rh.executeReadHistory("9999999", execArgs(outbound));
    assert.equal(
      out,
      "Could not read message 9999999: the linked message could not be read " +
        "(deleted, unknown id, or not in this channel)",
    );
  });

  it("surfaces a fetchMessages {ok:false} verbatim (status + API code)", async () => {
    const routes = execRoutes(anchorRows);
    routes[`GET /v1/channels/${CHANNEL}/messages`] = () => {
      throw new FluxerRestError("403 Missing Access", {
        status: 403,
        code: "Missing Access",
      });
    };
    const { outbound } = makeOutbound(routes);
    const out = await rh.executeReadHistory(CHANNEL, execArgs(outbound));
    assert.ok(
      out.startsWith("Could not read channel 70001: history fetch failed"),
      out,
    );
    assert.ok(out.includes("403 Missing Access"), "the API text is verbatim");
    assert.ok(out.includes("status 403"), "status included");
    assert.ok(out.includes("code Missing Access"), "API code included");
  });
});

/* ---------------------------- security gates ------------------------------ */

describe("open-ticket blackout (compared on communityId)", () => {
  it("refuses an unarchived ticket channel before fetching messages", async () => {
    const { outbound, rest } = makeOutbound(execRoutes(makeRows(3)));
    const repo = repoStub({ id: 1, channel_id: CHANNEL, archived: 0 });
    const out = await rh.executeReadHistory(CHANNEL, execArgs(outbound, repo));
    assert.equal(
      out,
      "Could not read channel 70001: that channel is an open help ticket",
    );
    assert.deepEqual(repo.calls, [[communityId, CHANNEL]], "blackout keyed by community id");
    assert.equal(
      rest.calls.filter((c) => c.path === `/v1/channels/${CHANNEL}/messages`).length,
      0,
      "no message fetch for a blacked-out channel",
    );
  });

  it("allows an ARCHIVED ticket channel (blackout is open-only)", async () => {
    const { outbound } = makeOutbound(execRoutes(makeRows(2)));
    const repo = repoStub({ id: 1, channel_id: CHANNEL, archived: 1 });
    const out = await rh.executeReadHistory(CHANNEL, execArgs(outbound, repo));
    assert.ok(out.startsWith("1000001 | "), out);
  });
});

describe("community isolation (compared on communityId)", () => {
  it("refuses a channel owned by a different community", async () => {
    const { outbound, rest } = makeOutbound(execRoutes(makeRows(3)));
    const out = await rh.executeReadHistory(CHANNEL_OTHER, execArgs(outbound));
    assert.equal(
      out,
      "Could not read channel 80001: that channel belongs to a different community",
    );
    assert.equal(
      rest.calls.filter((c) => c.path === "/v1/channels/8/messages").length,
      0,
      "isolation is checked BEFORE any message fetch",
    );
  });

  it("refuses non-text channels (category type 4)", async () => {
    const { outbound } = makeOutbound(execRoutes(makeRows(3)));
    const out = await rh.executeReadHistory(CHANNEL_CATEGORY, execArgs(outbound));
    assert.equal(
      out,
      "Could not read channel 90001: that channel does not expose readable messages",
    );
  });
});
