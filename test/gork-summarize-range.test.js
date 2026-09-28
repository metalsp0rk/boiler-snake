/**
 * `/gork summarize` range-reader unit tests (roadmap/gork.md §7.21.2,
 * proposed decision 54; subtask gork-summarize-02).
 *
 * Pure duck-typed fakes mirroring test/gork-read-discord.test.js — no
 * Discord client, no network, no DB (ticket blackout runs against the
 * injected repo stub). Covers: the three discrete modes with exact fetch
 * math, the from/to swap rule, invalid mode combinations, bare-id channel
 * defaults, guild isolation (rejected WITHOUT any fetch), same-channel
 * rule, ViewChannel parity + open-ticket blackout, bot/webhook `[bot]`
 * labeling, system-message skipping, attachment collapse, the 1,000-message
 * clamp, the 12,000-char clamp with the disclosed window, zero-readable
 * errors, mid-range fetch-failure partial reporting, and the never-throws
 * `{ ok:false, error }` boundary.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const {
  readSummarizeRange,
  validateSummarizeMode,
  MODE_CLOSED,
  MODE_FROM_NOW,
  MODE_LAST,
} = require("../src/features/gork/summarizeRange");
const { formatReadLine } = require("../src/features/gork/tools/readDiscord");
const C = require("../src/features/gork/constants");

const GUILD = "1000000000000000001";
const CHANNEL = "2000000000000000002";
const ASKER = "3000000000000000003";
const BOT = "4000000000000000004";

const cmp = (a, b) => {
  const l = String(a);
  const r = String(b);
  return l === r ? 0 : l < r ? -1 : 1;
};

/* ------------------------------- fakes ----------------------------------- */

function makeMessage(id, author, content, extra = {}) {
  return {
    id: String(id),
    author: { id: `u-${author}`, username: author },
    content,
    createdTimestamp: Date.parse("2026-09-16T00:00:00.000Z") + Number(id) * 1000,
    attachments: new Map(),
    ...extra,
  };
}

/**
 * Duck-typed channel with the same REST contract as the read_discord test
 * fake: single id → message|null; {limit,before|after} → Map; `after`-only
 * selects NEAREST the cursor ascending, everything else descending.
 */
function makeChannel({ id = CHANNEL, messages = [], perms = null, seam = true }) {
  const fetchCalls = [];
  return {
    id,
    _fetchCalls: fetchCalls,
    messages: seam
      ? {
          fetch: async (arg) => {
            fetchCalls.push(arg);
            if (typeof arg === "string") {
              return messages.find((m) => String(m.id) === arg) || null;
            }
            const limit = Number(arg?.limit) || 100;
            const ascending = Boolean(arg?.after) && !arg?.before;
            let list = [...messages].sort((a, b) =>
              ascending ? cmp(a.id, b.id) : cmp(b.id, a.id),
            );
            if (arg?.before) list = list.filter((m) => cmp(m.id, arg.before) < 0);
            if (arg?.after) list = list.filter((m) => cmp(m.id, arg.after) > 0);
            return new Map(list.slice(0, limit).map((m) => [String(m.id), m]));
          },
        }
      : undefined,
    permissionsFor:
      perms === null
        ? () => ({ has: () => true })
        : (member) => ({
            has: (flag) => (typeof perms === "function" ? perms(member, flag) : perms),
          }),
  };
}

function makeGuild({ id = GUILD, channels = [], members = [{ id: ASKER }], me = { id: BOT } } = {}) {
  return {
    id,
    channels: {
      fetch: async (channelId) => channels.find((c) => c.id === String(channelId)) || null,
    },
    members: {
      me,
      fetch: async (userId) => {
        const m = members.find((x) => x.id === String(userId));
        if (!m) throw new Error(`Member ${userId} not found`);
        return m;
      },
    },
  };
}

const repoStub = (ticket = null) => ({
  calls: [],
  getTicketByChannel(channelId) {
    this.calls.push(channelId);
    return ticket;
  },
});

/** Service options riding on the fakes (default: read in the invocation channel). */
function opts({ guild, invokerId = ASKER, fallbackChannelId = CHANNEL, repo = repoStub(), ...rest }) {
  return { guildId: guild.id, guild, invokerId, fallbackChannelId, repo, ...rest };
}

const msgLink = (messageId, channelId = CHANNEL, guildId = GUILD) =>
  `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

/** ids `fromId..toId` as plain human messages. */
function range(fromId, toId, author = "alice", contentOf = (id) => `m${id}`) {
  const out = [];
  for (let id = fromId; id <= toId; id += 1) out.push(makeMessage(id, author, contentOf(id)));
  return out;
}

/* ------------------------------- mode gate -------------------------------- */

describe("validateSummarizeMode — exactly one mode (§7.21.1)", () => {
  it("resolves the three modes", () => {
    assert.deepEqual(validateSummarizeMode({ from: "1", to: "2" }), { ok: true, mode: MODE_CLOSED });
    assert.deepEqual(validateSummarizeMode({ from: "1" }), { ok: true, mode: MODE_FROM_NOW });
    assert.deepEqual(validateSummarizeMode({ last: 5 }), { ok: true, mode: MODE_LAST, last: 5 });
    assert.deepEqual(validateSummarizeMode({ last: "7" }), { ok: true, mode: MODE_LAST, last: 7 });
    assert.deepEqual([MODE_CLOSED, MODE_FROM_NOW, MODE_LAST], ["from-to", "from-now", "last"]);
  });

  it("from+last, to-without-from, and none are usage errors naming all three modes", () => {
    for (const bad of [{ from: "1", last: 5 }, { to: "2" }, {}, { to: "1", to2: undefined }]) {
      const r = validateSummarizeMode(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.code, "usage");
      assert.match(r.error, /from:\+to:/, r.error);
      assert.match(r.error, /from: alone/, r.error);
      assert.match(r.error, /last:<N>/, r.error);
    }
    assert.match(validateSummarizeMode({ from: "1", last: 5 }).error, /both from: and last:/);
    assert.match(validateSummarizeMode({ to: "2" }).error, /without a from:/);
  });

  it("last: must be an integer within the option bounds", () => {
    for (const bad of [0, -3, 2.5, "abc", C.GORK_SUMMARIZE_LAST_MAX + 1, "10.5"]) {
      const r = validateSummarizeMode({ last: bad });
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.match(r.error, /last: must be an integer between 1 and 1000/, r.error);
    }
    assert.equal(validateSummarizeMode({ last: C.GORK_SUMMARIZE_LAST_MAX }).ok, true);
  });
});

/* ----------------------------- closed range -------------------------------- */

describe("readSummarizeRange — from+to closed range", () => {
  const many = range(1001, 1100);

  const setup = () => {
    const channel = makeChannel({ messages: many });
    const guild = makeGuild({ channels: [channel] });
    return { channel, guild };
  };

  it("inclusive of both anchors, oldest→newest, one `after:` page from the anchor", async () => {
    const { channel, guild } = setup();
    const res = await readSummarizeRange(
      { from: msgLink(1010), to: msgLink(1019) },
      opts({ guild }),
    );
    assert.equal(res.ok, true, res.error);
    assert.equal(res.mode, MODE_CLOSED);
    assert.equal(res.firstId, "1010");
    assert.equal(res.lastId, "1019");
    assert.equal(res.count, 10);
    assert.equal(res.clamped, false);
    assert.equal(res.clampNote, null);
    const lines = res.transcript.split("\n");
    assert.equal(lines.length, 10);
    assert.match(lines[0], /^1010 \| 2026-09-16T/);
    assert.match(lines[9], /^1019 \| .* \| @alice: m1019$/);
    // exact fetch math: anchor, to-anchor, ONE after: page — nothing past `to`
    assert.deepEqual(channel._fetchCalls, [
      "1010",
      "1019",
      { limit: C.READ_DISCORD_CHANNEL_WINDOW, after: "1010" },
    ]);
  });

  it("swap rule: a newer from: than to: still reads oldest→newest inclusively", async () => {
    const { channel, guild } = setup();
    const res = await readSummarizeRange(
      { from: msgLink(1050), to: msgLink(1020) },
      opts({ guild }),
    );
    assert.equal(res.ok, true, res.error);
    assert.equal(res.firstId, "1020");
    assert.equal(res.lastId, "1050");
    assert.equal(res.count, 31);
    assert.deepEqual(channel._fetchCalls[2], {
      limit: C.READ_DISCORD_CHANNEL_WINDOW,
      after: "1020",
    });
  });

  it("deleted from: anchor → specific notfound error, no pagination", async () => {
    const { channel, guild } = setup();
    const res = await readSummarizeRange({ from: msgLink(9999) }, opts({ guild }));
    assert.equal(res.ok, false);
    assert.equal(res.code, "notfound");
    assert.match(res.error, /^The from: message 9999 in channel .* could not be read \(deleted or unknown id\)\.$/);
    assert.deepEqual(channel._fetchCalls, ["9999"], "no after: pages for a dead anchor");
  });

  it("deleted to: anchor → specific notfound naming to:, no pagination", async () => {
    const { channel, guild } = setup();
    const res = await readSummarizeRange(
      { from: msgLink(1010), to: msgLink(9999) },
      opts({ guild }),
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "notfound");
    assert.match(res.error, /^The to: message 9999 .* \(deleted or unknown id\)\.$/);
    assert.deepEqual(channel._fetchCalls, ["1010", "9999"]);
  });

  it("cross-channel anchors → specific usage error, nothing fetched", async () => {
    const chA = makeChannel({ id: CHANNEL, messages: many });
    const chB = makeChannel({ id: "2100000000000000009", messages: range(500, 510) });
    const guild = makeGuild({ channels: [chA, chB] });
    const res = await readSummarizeRange(
      { from: msgLink(1010), to: msgLink(505, "2100000000000000009") },
      opts({ guild }),
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "usage");
    assert.match(res.error, /different channels/, res.error);
    assert.match(res.error, /single channel/);
    assert.equal(chA._fetchCalls.length + chB._fetchCalls.length, 0);
  });
});

/* ------------------------------ from → now --------------------------------- */

describe("readSummarizeRange — from: alone through the newest message", () => {
  it("reads anchor→newest, ending on an empty after: page (natural end, not clamped)", async () => {
    const channel = makeChannel({ messages: range(1001, 1100) });
    const guild = makeGuild({ channels: [channel] });
    const res = await readSummarizeRange({ from: msgLink(1097) }, opts({ guild }));
    assert.equal(res.ok, true, res.error);
    assert.equal(res.mode, MODE_FROM_NOW);
    assert.deepEqual([res.firstId, res.lastId, res.count], ["1097", "1100", 4]);
    assert.equal(res.clamped, false);
    assert.deepEqual(channel._fetchCalls, [
      "1097",
      { limit: C.READ_DISCORD_CHANNEL_WINDOW, after: "1097" },
      { limit: C.READ_DISCORD_CHANNEL_WINDOW, after: "1100" },
    ]);
  });

  it("system messages inside the range are skipped and uncounted", async () => {
    const messages = [
      makeMessage(500, "alice", "start"),
      makeMessage(501, "system", "", { system: true }),
      makeMessage(502, "bob", "after join"),
    ];
    const channel = makeChannel({ messages });
    const guild = makeGuild({ channels: [channel] });
    const res = await readSummarizeRange({ from: msgLink(500) }, opts({ guild }));
    assert.equal(res.ok, true, res.error);
    assert.equal(res.count, 2);
    assert.ok(!res.transcript.includes("501 |"), res.transcript);
  });
});

/* --------------------------------- last:N ---------------------------------- */

describe("readSummarizeRange — last:N backward pagination", () => {
  const many = range(1001, 1100);

  const setup = () => {
    const channel = makeChannel({ messages: many });
    const guild = makeGuild({ channels: [channel] });
    return { channel, guild };
  };

  it("reads the newest N with before: pagination, returns oldest→newest", async () => {
    const { channel, guild } = setup();
    const res = await readSummarizeRange({ last: 3 }, opts({ guild }));
    assert.equal(res.ok, true, res.error);
    assert.equal(res.mode, MODE_LAST);
    assert.deepEqual([res.firstId, res.lastId, res.count], ["1098", "1100", 3]);
    assert.equal(res.requestedLast, 3);
    assert.equal(res.clamped, false);
    assert.match(res.transcript.split("\n")[0], /^1098 \|/);
    // single newest-first page fetch — no cursor on the first page
    assert.deepEqual(channel._fetchCalls, [{ limit: C.READ_DISCORD_CHANNEL_WINDOW }]);
  });

  it("crosses page boundaries with before: from the oldest seen id", async () => {
    const { channel, guild } = setup();
    const res = await readSummarizeRange({ last: 60 }, opts({ guild }));
    assert.equal(res.ok, true, res.error);
    assert.deepEqual([res.firstId, res.lastId, res.count], ["1041", "1100", 60]);
    assert.deepEqual(channel._fetchCalls, [
      { limit: 50 },
      { limit: 50, before: "1051" },
    ]);
  });

  it("N beyond the channel history is a natural end, not a clamp", async () => {
    const { channel, guild } = setup();
    const res = await readSummarizeRange({ last: 200 }, opts({ guild }));
    assert.equal(res.ok, true, res.error);
    assert.equal(res.count, 100);
    assert.equal(res.firstId, "1001");
    assert.equal(res.clamped, false);
    assert.deepEqual(channel._fetchCalls[2], { limit: 50, before: "1001" });
  });

  it("reads the channel: option when given, else the invocation channel", async () => {
    const chA = makeChannel({ id: CHANNEL, messages: range(1001, 1010) });
    const chB = makeChannel({ id: "2100000000000000009", messages: range(7001, 7005) });
    const guild = makeGuild({ channels: [chA, chB] });
    const viaOption = await readSummarizeRange(
      { last: 5, channel: "<#2100000000000000009>" },
      opts({ guild }),
    );
    assert.equal(viaOption.ok, true, viaOption.error);
    assert.deepEqual([viaOption.firstId, viaOption.lastId], ["7001", "7005"]);
    const viaFallback = await readSummarizeRange({ last: 5 }, opts({ guild }));
    assert.deepEqual([viaFallback.firstId, viaFallback.lastId], ["1006", "1010"]);
  });
});

/* -------------------------- anchor grammar & channel ------------------------ */

describe("readSummarizeRange — anchor grammar + channel defaults", () => {
  const many = range(1001, 1100);

  const setup = () => {
    const channel = makeChannel({ messages: many });
    const guild = makeGuild({ channels: [channel] });
    return { channel, guild };
  };

  it("bare message id anchors resolve against channel: / the invocation channel", async () => {
    // Real snowflakes are 17-20 digits; the reused §7.19 grammar accepts
    // bare ids of 5+ digits, so these fake ids are 5 wide.
    const channel = makeChannel({ messages: range(20001, 20010) });
    const guild = makeGuild({ channels: [channel] });
    const viaFallback = await readSummarizeRange({ from: "20008" }, opts({ guild }));
    assert.equal(viaFallback.ok, true, viaFallback.error);
    assert.deepEqual([viaFallback.firstId, viaFallback.lastId], ["20008", "20010"]);

    const chOther = makeChannel({ id: "2100000000000000009", messages: range(80001, 80002) });
    const guild2 = makeGuild({ channels: [channel, chOther] });
    const viaOption = await readSummarizeRange(
      { from: "80001", channel: "2100000000000000009" },
      opts({ guild: guild2, fallbackChannelId: null }),
    );
    assert.equal(viaOption.ok, true, viaOption.error);
    assert.deepEqual([viaOption.firstId, viaOption.lastId], ["80001", "80002"]);
  });

  it("a bare id with no channel anywhere is a usage error (bare ids need a channel)", async () => {
    const { guild } = setup();
    const res = await readSummarizeRange({ from: "10098" }, opts({ guild, fallbackChannelId: null }));
    assert.equal(res.ok, false);
    assert.equal(res.code, "usage");
    assert.match(res.error, /bare message id.*channel/i, res.error);
  });

  it("channel links and <#mentions> are not message anchors", async () => {
    const { guild } = setup();
    for (const raw of [`https://discord.com/channels/${GUILD}/${CHANNEL}`, `<#${CHANNEL}>`]) {
      const res = await readSummarizeRange({ from: raw }, opts({ guild }));
      assert.equal(res.ok, false, raw);
      assert.match(res.error, /points at a channel, not a message/, raw);
    }
  });

  it("garbage anchors and garbage channel options give specific usage errors", async () => {
    const { guild } = setup();
    const badFrom = await readSummarizeRange({ from: "hello world!!" }, opts({ guild }));
    assert.match(badFrom.error, /is not a Discord message link or message id/);
    const badCh = await readSummarizeRange({ last: 5, channel: "not-a-channel" }, opts({ guild }));
    assert.match(badCh.error, /^channel: "not-a-channel" is not a channel mention, channel link, or channel id\.$/);
  });

  it("last: with no channel at all is a usage error", async () => {
    const { guild } = setup();
    const res = await readSummarizeRange({ last: 5 }, opts({ guild, fallbackChannelId: null }));
    assert.equal(res.ok, false);
    assert.match(res.error, /last: needs a channel/);
  });
});

/* ------------------------------ guild isolation ----------------------------- */

describe("readSummarizeRange — guild isolation (decision 46)", () => {
  it("cross-guild from: link rejected BEFORE any channel lookup or fetch", async () => {
    let lookedUp = 0;
    const guild = makeGuild({ channels: [makeChannel({ messages: range(1001, 1010) })] });
    const res = await readSummarizeRange(
      { from: msgLink(1005, CHANNEL, "9999999999999999999") },
      {
        ...opts({ guild }),
        channelResolver: async () => {
          lookedUp += 1;
          return makeChannel({ messages: [] });
        },
      },
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "security");
    assert.match(res.error, /^The from: link points to another server/, res.error);
    assert.equal(lookedUp, 0, "the other server's data is off-limits");
  });

  it("cross-guild to: and channel: links rejected too", async () => {
    const guild = makeGuild({ channels: [makeChannel({ messages: range(1001, 1010) })] });
    const toOther = await readSummarizeRange(
      { from: msgLink(1002), to: msgLink(1005, CHANNEL, "9999999999999999999") },
      opts({ guild }),
    );
    assert.equal(toOther.ok, false);
    assert.match(toOther.error, /^The to: link points to another server/, toOther.error);
    const chOther = await readSummarizeRange(
      { last: 5, channel: `https://discord.com/channels/9999999999999999999/${CHANNEL}` },
      opts({ guild }),
    );
    assert.equal(chOther.ok, false);
    assert.match(chOther.error, /^The channel: link points to another server/, chOther.error);
  });

  it("same-guild links pass isolation", async () => {
    const channel = makeChannel({ messages: range(1001, 1010) });
    const guild = makeGuild({ channels: [channel] });
    const res = await readSummarizeRange({ from: msgLink(1009) }, opts({ guild }));
    assert.equal(res.ok, true, res.error);
  });
});

/* ----------------------- channel gates + parity + blackout ----------------------- */

describe("readSummarizeRange — channel gates and decision-46 checks", () => {
  const setup = (perms = null, ticket = null) => {
    const channel = makeChannel({ messages: range(1001, 1010), perms });
    const guild = makeGuild({ channels: [channel] });
    return { channel, guild, repo: repoStub(ticket) };
  };

  it("unknown channel → specific notfound error", async () => {
    const { guild } = setup();
    const res = await readSummarizeRange({ last: 3 }, { ...opts({ guild }), fallbackChannelId: "999000999000999000" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "notfound");
    assert.match(res.error, /^No channel 999000999000999000 in this server\.$/);
  });

  it("forum channels (no messages seam) are refused exactly as read_discord refuses them", async () => {
    const channel = makeChannel({ seam: false });
    const guild = makeGuild({ channels: [channel] });
    const res = await readSummarizeRange({ last: 3 }, opts({ guild }));
    assert.equal(res.ok, false);
    assert.match(res.error, /does not expose readable messages/, res.error);
  });

  it("channel lookup rejection → fetch-coded failure string, no crash", async () => {
    const { guild } = setup();
    const res = await readSummarizeRange({ last: 3 }, {
      ...opts({ guild }),
      channelResolver: async () => {
        throw new Error("500: Internal Server Error");
      },
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "fetch");
    assert.match(res.error, /Channel lookup for .* failed: 500/, res.error);
  });

  it("invoker without ViewChannel → refused before any message fetch, no leak", async () => {
    const { channel, guild, repo } = setup((member, flag) => {
      if (member.id === ASKER && flag === PermissionFlagsBits.ViewChannel) return false;
      return true;
    });
    const res = await readSummarizeRange({ last: 3 }, opts({ guild, repo }));
    assert.equal(res.ok, false);
    assert.equal(res.code, "security");
    assert.match(res.error, /The invoking user cannot view channel/, res.error);
    assert.ok(!res.error.includes("m1008"), "no content leak");
    assert.equal(channel._fetchCalls.length, 0);
  });

  it("member fetch failure fails closed; unknown invoker refused; missing invoker id refused", async () => {
    const { guild } = setup(null, null);
    const memberless = makeGuild({ channels: [makeChannel({ messages: range(1001, 1010) })], members: [] });
    const thrower = await readSummarizeRange({ last: 3 }, opts({ guild: memberless }));
    assert.match(thrower.error, /^Could not check the invoking user's access:/, thrower.error);
    const nuller = await readSummarizeRange({ last: 3 }, {
      ...opts({ guild }),
      memberFetcher: async () => null,
    });
    assert.match(nuller.error, /not a member of this server/);
    const noInvoker = await readSummarizeRange({ last: 3 }, opts({ guild, invokerId: null }));
    assert.equal(noInvoker.ok, false);
    assert.match(noInvoker.error, /Cannot identify the invoking user/);
  });

  it("bot missing ViewChannel / ReadMessageHistory → specific refusals", async () => {
    const noView = setup((member, flag) =>
      member.id === BOT && flag === PermissionFlagsBits.ViewChannel ? false : true);
    const resA = await readSummarizeRange({ last: 3 }, opts(noView));
    assert.match(resA.error, /The bot cannot view channel/, resA.error);
    const noHistory = setup((member, flag) =>
      member.id === BOT && flag === PermissionFlagsBits.ReadMessageHistory ? false : true);
    const resB = await readSummarizeRange({ last: 3 }, opts(noHistory));
    assert.match(resB.error, /The bot cannot read message history/, resB.error);
  });

  it("open-ticket blackout (decision 46): unarchived row refuses BEFORE any fetch", async () => {
    const { channel, guild, repo } = setup(null, { channel_id: CHANNEL, archived: 0 });
    const res = await readSummarizeRange({ last: 3 }, opts({ guild, repo }));
    assert.equal(res.ok, false);
    assert.equal(res.code, "security");
    assert.match(res.error, /is an open help ticket/, res.error);
    assert.deepEqual(repo.calls, [CHANNEL]);
    assert.equal(channel._fetchCalls.length, 0);
  });

  it("archived ticket rows stay readable", async () => {
    const { guild, repo } = setup(null, { channel_id: CHANNEL, archived: 1 });
    const res = await readSummarizeRange({ last: 3 }, opts({ guild, repo }));
    assert.equal(res.ok, true, res.error);
    assert.equal(res.count, 3);
  });
});

/* ----------------------------- transcript format ----------------------------- */

describe("readSummarizeRange — transcript line format (§7.19 + [bot] labels)", () => {
  it("bots ride along labeled [bot]; webhooks too; human lines equal formatReadLine exactly", async () => {
    const human = makeMessage(1001, "alice", "plain human line");
    const bot = makeMessage(1002, "gork", "hello from gork", {
      author: { id: "u-gork", username: "gork", bot: true },
    });
    const webhook = makeMessage(1003, "news", "release shipped", { webhookId: "4242424242" });
    const channel = makeChannel({ messages: [human, bot, webhook] });
    const guild = makeGuild({ channels: [channel] });
    const res = await readSummarizeRange({ last: 10 }, opts({ guild }));
    assert.equal(res.ok, true, res.error);
    const lines = res.transcript.split("\n");
    assert.equal(lines.length, 3, res.transcript);
    assert.equal(lines[0], formatReadLine(human), "human line is byte-identical to §7.19 formatReadLine");
    assert.match(lines[1], /^1002 \| 2026-09-16T\d{2}:\d{2}:\d{2}\.\d{3}Z \| @gork \[bot\]: hello from gork$/);
    assert.match(lines[2], /^1003 \| .* \| @news \[bot\]: release shipped$/);
  });

  it("attachments collapse to [N attachment(s)]; empty messages degrade to (no text)", async () => {
    const attach = new Map([["a", {}], ["b", {}]]);
    const messages = [
      makeMessage(1001, "alice", "look", { attachments: attach }),
      makeMessage(1002, "bob", "", { attachments: attach }),
      makeMessage(1003, "carol", ""),
    ];
    const channel = makeChannel({ messages });
    const guild = makeGuild({ channels: [channel] });
    const res = await readSummarizeRange({ last: 10 }, opts({ guild }));
    const lines = res.transcript.split("\n");
    assert.ok(lines[0].endsWith("look [2 attachment(s)]"), lines[0]);
    assert.ok(lines[1].endsWith("[2 attachment(s)]"), lines[1]);
    assert.ok(lines[2].endsWith("(no text)"), lines[2]);
  });

  it("per-message content is capped at 500 chars, code-point-safe", async () => {
    const emoji = "💯".repeat(400); // astral: 800 code units, 400 code points
    const channel = makeChannel({ messages: [makeMessage(3001, "alice", emoji)] });
    const guild = makeGuild({ channels: [channel] });
    const res = await readSummarizeRange({ last: 5 }, opts({ guild }));
    const body = res.transcript.slice(res.transcript.indexOf(": ") + 2);
    assert.ok(body.length > 0 && body.length <= C.READ_DISCORD_MESSAGE_CHAR_CAP, `body capped: ${body.length}`);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(res.transcript), "no split surrogate pair");
  });
});

/* ------------------------------- caps & clamps ------------------------------- */

describe("readSummarizeRange — caps with clamp-and-disclose (§7.21.2)", () => {
  const fatRange = (from, to) => range(from, to, "alice", () => "💯".repeat(250));

  it("12k char clamp (from-modes): keeps the oldest-first window, discloses it", async () => {
    const channel = makeChannel({ messages: fatRange(4001, 4040) });
    const guild = makeGuild({ channels: [channel] });
    const res = await readSummarizeRange({ from: msgLink(4001), to: msgLink(4040) }, opts({ guild }));
    assert.equal(res.ok, true, res.error);
    assert.equal(res.scannedCount, 40, "the full range was READ from Discord");
    assert.ok(res.count < 40 && res.count > 10, `budget kept some tail: kept ${res.count}`);
    assert.equal(res.firstId, "4001", "from-modes keep the OLDEST-first window");
    assert.equal(res.lastId, String(4000 + res.count));
    assert.equal(res.clamped, true);
    assert.deepEqual(res.clampReasons, ["chars"]);
    assert.ok(res.transcript.length <= C.READ_DISCORD_TOTAL_CHAR_CAP);
    assert.ok(res.transcript.length > 11000, `budget is actually used: ${res.transcript.length}`);
    assert.equal(res.transcript.split("\n").length, res.count);
    assert.match(res.clampNote, /12000-character transcript budget kept \d+ of 40/);
    assert.match(res.clampNote, new RegExp(`Disclosed window 4001 → ${res.lastId}`));
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(res.transcript), "code-point-safe");
  });

  it("12k char clamp (last:): keeps the NEWEST window that fits — the largest window", async () => {
    const channel = makeChannel({ messages: fatRange(4001, 4040) });
    const guild = makeGuild({ channels: [channel] });
    const res = await readSummarizeRange({ last: 40 }, opts({ guild }));
    assert.equal(res.ok, true, res.error);
    assert.equal(res.scannedCount, 40);
    assert.ok(res.count < 40, `kept ${res.count}`);
    assert.equal(res.lastId, "4040", "last: keeps the newest end");
    assert.equal(res.firstId, String(4040 - res.count + 1), "contiguous newest window");
    assert.equal(res.clamped, true);
    assert.deepEqual(res.clampReasons, ["chars"]);
    assert.ok(res.transcript.length <= C.READ_DISCORD_TOTAL_CHAR_CAP);
    assert.match(res.clampNote, /Disclosed window .* → 4040/);
  });

  it("1,000-message read cap bites on huge ranges and is disclosed", async () => {
    const many = range(2001, 3200); // 1,200 readable messages
    const channel = makeChannel({ messages: many });
    const guild = makeGuild({ channels: [channel] });
    const res = await readSummarizeRange({ from: msgLink(2001) }, opts({ guild }));
    assert.equal(res.ok, true, res.error);
    assert.equal(res.scannedCount, C.GORK_SUMMARIZE_RANGE_MAX_MESSAGES, "hard 1,000-message read cap");
    assert.equal(res.clamped, true);
    assert.ok(res.clampReasons.includes("messages"), res.clampReasons.join(","));
    assert.ok(res.clampReasons.includes("chars"), "the char budget also trimmed the transcript");
    assert.equal(res.firstId, "2001");
    assert.ok(res.count < res.scannedCount);
    assert.match(res.clampNote, /1000-message read cap was hit/);
    assert.ok(
      many[1000].id > res.transcript.split("\n").pop().split(" | ")[0],
      "never read past the cap into the unread rest",
    );
  });

  it("a range of EXACTLY 1,000 readable messages ends naturally — no messages clamp (peek honesty)", async () => {
    const channel = makeChannel({ messages: range(2001, 3000) });
    const guild = makeGuild({ channels: [channel] });
    const res = await readSummarizeRange({ from: msgLink(2001) }, opts({ guild }));
    assert.equal(res.ok, true, res.error);
    assert.equal(res.scannedCount, 1000, "scan covered the whole natural range");
    assert.ok(!res.clampReasons.includes("messages"), res.clampReasons.join(","));
    assert.ok(res.clampReasons.includes("chars"), "12k budget still trims the transcript");
  });

  it("last:N stays inside the hard cap via the option bounds", () => {
    assert.equal(C.GORK_SUMMARIZE_LAST_MAX, C.GORK_SUMMARIZE_RANGE_MAX_MESSAGES);
  });
});

/* -------------------------------- empty ranges -------------------------------- */

describe("readSummarizeRange — zero readable messages", () => {
  it("range with only system messages → specific empty error", async () => {
    const messages = [
      makeMessage(501, "sys", "", { system: true }),
      makeMessage(502, "sys", "", { system: true, type: "GUILD_MEMBER_JOIN" }),
    ];
    const channel = makeChannel({ messages });
    const guild = makeGuild({ channels: [channel] });
    const res = await readSummarizeRange({ from: msgLink(501) }, opts({ guild }));
    assert.equal(res.ok, false);
    assert.equal(res.code, "empty");
    assert.match(res.error, /No readable messages in that range/, res.error);
    assert.match(res.error, /system messages/);
  });

  it("empty channel with last: → specific empty error", async () => {
    const channel = makeChannel({ id: CHANNEL, messages: [] });
    const guild = makeGuild({ channels: [channel] });
    const res = await readSummarizeRange({ last: 10 }, opts({ guild }));
    assert.equal(res.ok, false);
    assert.equal(res.code, "empty");
    assert.match(res.error, /empty or holds only system messages/);
  });
});

/* --------------------- mid-range failures (partial results) --------------------- */

describe("readSummarizeRange — fetch failures report the partial range (never throw)", () => {
  it("forward read dies on page 2: the error discloses what WAS read", async () => {
    const channel = makeChannel({ messages: range(1001, 1100) });
    const guild = makeGuild({ channels: [channel] });
    const realFetch = channel.messages.fetch;
    let calls = 0;
    channel.messages.fetch = async (arg) => {
      calls += 1;
      if (typeof arg === "object" && calls > 2) throw new Error("500: Internal Server Error");
      return realFetch(arg);
    };
    const res = await readSummarizeRange({ from: msgLink(1001) }, opts({ guild }));
    assert.equal(res.ok, false);
    assert.equal(res.code, "fetch");
    // 1 anchor + 1 page (50 messages: 1002..1051) read = 51 before the failure
    assert.match(res.error, /^Message fetch failed in channel 2000000000000000002 after reading 51 message\(s\) \(1001 → 1051\): 500: Internal Server Error/, res.error);
    assert.match(res.error, /no rundown was produced/);
    assert.deepEqual(res.partial, { count: 51, firstId: "1001", lastId: "1051" });
  });

  it("last: read dies on the second page: newest-side partial is disclosed", async () => {
    const channel = makeChannel({ messages: range(1001, 1100) });
    const guild = makeGuild({ channels: [channel] });
    const realFetch = channel.messages.fetch;
    let pages = 0;
    channel.messages.fetch = async (arg) => {
      if (typeof arg === "object") {
        pages += 1;
        if (pages > 1) throw new Error("boom");
      }
      return realFetch(arg);
    };
    const res = await readSummarizeRange({ last: 75 }, opts({ guild }));
    assert.equal(res.ok, false);
    assert.deepEqual(res.partial, { count: 50, firstId: "1051", lastId: "1100" });
    assert.match(res.error, /after reading 50 message\(s\) \(1051 → 1100\): boom/);
  });

  it("anchor fetch rejection → specific fetch error, no partial (nothing was read)", async () => {
    const channel = makeChannel({ messages: range(1001, 1100) });
    channel.messages.fetch = async () => {
      throw new Error("429: rate limited");
    };
    const guild = makeGuild({ channels: [channel] });
    const res = await readSummarizeRange({ from: msgLink(1050) }, opts({ guild }));
    assert.equal(res.ok, false);
    assert.equal(res.code, "fetch");
    assert.match(res.error, /^The from: message 1050 in channel .* could not be read: 429: rate limited/, res.error);
    assert.equal(res.partial, undefined);
  });
});

/* ------------------------------ never-throws gate ------------------------------ */

describe("readSummarizeRange — never throws at the service boundary", () => {
  it("garbage args resolve to specific usage failures instead of throwing", async () => {
    const guild = makeGuild({ channels: [makeChannel({ messages: range(1, 3) })] });
    for (const bad of [null, undefined, "string", 42, {}, { from: 1, to: 2 }]) {
      const res = await readSummarizeRange(bad, opts({ guild }));
      assert.equal(typeof res, "object", JSON.stringify(bad));
      assert.equal(res.ok, false, JSON.stringify(bad));
      assert.equal(typeof res.error, "string");
      assert.ok(res.error.length > 0);
    }
  });

  it("missing guild context → internal failure, not a crash", async () => {
    const res = await readSummarizeRange({ last: 5 }, {});
    assert.equal(res.ok, false);
    assert.equal(res.code, "internal");
    assert.match(res.error, /No guild context/);
  });

  it("repo (ticket lookup) throwing → specific internal failure", async () => {
    const guild = makeGuild({ channels: [makeChannel({ messages: range(1001, 1005) })] });
    const res = await readSummarizeRange({ last: 3 }, {
      ...opts({ guild }),
      repo: {
        getTicketByChannel() {
          throw new Error("SQLITE_BUSY");
        },
      },
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "internal");
    assert.match(res.error, /Could not check the ticket status of channel .*: SQLITE_BUSY/, res.error);
  });

  it("invoker permissionsFor throwing → fails closed with a specific reason", async () => {
    const channel = makeChannel({ messages: range(1001, 1005) });
    channel.permissionsFor = () => {
      throw new Error("perm surface exploded");
    };
    const guild = makeGuild({ channels: [channel] });
    const res = await readSummarizeRange({ last: 3 }, opts({ guild }));
    assert.equal(res.ok, false);
    assert.equal(res.code, "security");
    assert.match(res.error, /^Could not check the invoking user's access: perm surface exploded/, res.error);
  });

  it("service-level mode exclusivity: from+last via the service is a usage error naming the modes", async () => {
    const guild = makeGuild({ channels: [makeChannel({ messages: range(1001, 1005) })] });
    const res = await readSummarizeRange({ from: "1001", last: 5 }, opts({ guild }));
    assert.equal(res.ok, false);
    assert.equal(res.code, "usage");
    assert.match(res.error, /both from: and last:/);
    assert.match(res.error, /last:<N>/);
  });
});
