/**
 * Gork `read_discord` tool unit tests (locked spec: roadmap/gork.md
 * §7.19, decisions 44–48).
 *
 * Pure duck-typed fakes — no Discord client, no network, no DB (the
 * ticket blackout check runs against an injected repo stub). Covers:
 * link parsing (every accepted form + garbage), guild isolation
 * (rejected WITHOUT any fetch), asker parity + open-ticket blackout
 * denials, window math with injected fetchers (missing edges, deleted
 * anchor), formatting/truncation, and the never-throws contract.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const rd = require("../src/features/gork/tools/readDiscord");
const {
  READ_DISCORD_TOOL,
  executeReadDiscord,
  parseDiscordLink,
  formatReadLine,
  formatReadOutput,
  ANCHOR_MARKER,
} = rd;
const C = require("../src/features/gork/constants");

const GUILD = "1000000000000000001";
const ASKER = "3000000000000000003";
const BOT = "4000000000000000004";

const cmp = (a, b) => {
  const l = String(a);
  const r = String(b);
  return l === r ? 0 : l < r ? -1 : 1;
};

/* ------------------------------- fakes ---------------------------------- */

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
 * Duck-typed channel. `messages.fetch` implements the Discord REST
 * contract: single id → message|null; {limit,before|after} → Map
 * NEWEST→oldest. `fetchCalls` records every window fetch (to prove
 * short-circuits never fetched).
 */
function makeChannel({ id = "2000000000000000002", messages = [], perms = null, seam = true }) {
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
            // after-only: the limit messages NEAREST the cursor, oldest
            // first (the real API's ascending mode); everything else:
            // newest first (descending mode).
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

function makeGuild({ id = GUILD, channels = [], members = [], me = { id: BOT } } = {}) {
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

/** Executor options riding on the fakes (defaults exercise the real seams). */
function opts({ guild, askerId = ASKER, repo = repoStub(), ...rest }) {
  return { guildId: guild.id, guild, askerId, repo, ...rest };
}

/* ------------------------------- schema ---------------------------------- */

describe("read_discord tool schema + locked constants", () => {
  it("schema: function read_discord with one required string param `link`", () => {
    assert.equal(READ_DISCORD_TOOL.type, "function");
    const fn = READ_DISCORD_TOOL.function;
    assert.equal(fn.name, "read_discord");
    assert.deepEqual(fn.parameters.required, ["link"]);
    assert.equal(fn.parameters.properties.link.type, "string");
    // Routing guidance lives in the schema description (decision-21 pattern).
    assert.match(fn.description, /read_page/i);
    assert.match(fn.description, /discord\.com/i);
    assert.equal(Object.keys(READ_DISCORD_TOOL.function.parameters.properties).length, 1);
  });

  it("windows + caps match the locked numbers (decision 45)", () => {
    assert.equal(C.READ_DISCORD_CHANNEL_WINDOW, 50);
    assert.equal(C.READ_DISCORD_BEFORE_WINDOW, 40);
    assert.equal(C.READ_DISCORD_AFTER_WINDOW, 10);
    assert.equal(C.READ_DISCORD_MESSAGE_CHAR_CAP, 500);
    assert.equal(C.READ_DISCORD_TOTAL_CHAR_CAP, 12000);
  });
});

/* ---------------------------- link parsing ------------------------------- */

describe("parseDiscordLink — accepted forms", () => {
  it("message URL (protocol, www., discordapp.com, no protocol, trailing slash)", () => {
    const forms = [
      "https://discord.com/channels/1/2/3",
      "http://discord.com/channels/1/2/3",
      "https://www.discord.com/channels/1/2/3",
      "https://discordapp.com/channels/1/2/3",
      "discord.com/channels/1/2/3",
      "https://discord.com/channels/1/2/3/",
      " https://discord.com/channels/1/2/3 ",
    ];
    for (const form of forms) {
      const p = parseDiscordLink(form);
      assert.equal(p.ok, true, form);
      assert.equal(p.kind, "message", form);
      assert.deepEqual([p.guildId, p.channelId, p.messageId], ["1", "2", "3"], form);
    }
  });

  it("channel URL (two segments) → channel target carrying its guild id", () => {
    const p = parseDiscordLink("https://discord.com/channels/42/43");
    assert.equal(p.ok, true);
    assert.equal(p.kind, "channel");
    assert.equal(p.guildId, "42");
    assert.equal(p.channelId, "43");
  });

  it("<#id> mention and bare numeric id → in-guild channel target (no guild id)", () => {
    for (const form of ["<#2000000000000000002>", "123456789012345678"]) {
      const p = parseDiscordLink(form);
      assert.equal(p.ok, true, form);
      assert.equal(p.kind, "channel", form);
      assert.equal(p.guildId, null, form);
    }
    assert.equal(parseDiscordLink("<#2000000000000000002>").channelId, "2000000000000000002");
    assert.equal(parseDiscordLink("123456789012345678").channelId, "123456789012345678");
  });
});

describe("parseDiscordLink — garbage", () => {
  const garbage = [
    "",
    "   ",
    null,
    undefined,
    42,
    {},
    "hello", // not a snowflake
    "1234", // too short for a bare id
    "1".repeat(26), // too long
    "<@123456789012345678>", // user mention, not channel
    "<#>", // empty mention
    "https://example.com/channels/1/2/3", // wrong host
    "https://discord.com/users/123", // wrong path
    "https://discord.com/channels/1", // missing channel segment
    "https://discord.com/channels/1/2 extra", // trailing junk
    "two words",
  ];
  for (const raw of garbage) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      const p = parseDiscordLink(raw);
      assert.equal(p.ok, false);
      assert.match(p.reason, /not a Discord|no link/i);
    });
  }
});

/* ---------------------------- channel reads ------------------------------ */

describe("executeReadDiscord — channel window (decision 45)", () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    makeMessage(1000 + i, `user${i % 3}`, `message ${1000 + i}`),
  );
  const channel = makeChannel({ messages: many });
  const guild = makeGuild({ channels: [channel], members: [{ id: ASKER }] });

  it("reads the 50 most recent messages, oldest→newest, one line each", async () => {
    const out = await executeReadDiscord(`<#${channel.id}>`, opts({ guild }));
    const lines = out.split("\n");
    assert.equal(lines.length, 50, "window cap 50");
    assert.match(lines[0], /^1010 \| 2026-09-16T00:16:50\.000Z \| @user1: message 1010$/);
    assert.match(lines[49], /^1059 \| .* \| @user2: message 1059$/);
    // window was fetched with the locked limit
    assert.deepEqual(channel._fetchCalls, [{ limit: 50 }]);
  });

  it("accepts bare id and channel URL forms too (same guild)", async () => {
    const viaBare = await executeReadDiscord(channel.id, opts({ guild }));
    const viaUrl = await executeReadDiscord(
      `https://discord.com/channels/${GUILD}/${channel.id}`,
      opts({ guild }),
    );
    assert.equal(viaBare.split("\n").length, 50);
    assert.equal(viaUrl, viaBare);
  });

  it("attachments collapse to [N attachment(s)]; empties degrade", async () => {
    const attach = new Map([["a", {}], ["b", {}]]);
    const ch = makeChannel({
      id: "2100000000000000009",
      messages: [
        makeMessage(2001, "alice", "look", { attachments: attach }),
        makeMessage(2002, "bob", "", { attachments: attach }),
        makeMessage(2003, "carol", ""),
      ],
    });
    const g = makeGuild({ channels: [ch], members: [{ id: ASKER }] });
    const out = await executeReadDiscord(`<#${ch.id}>`, opts({ guild: g }));
    const lines = out.split("\n");
    assert.ok(lines[0].endsWith("look [2 attachment(s)]"), lines[0]);
    assert.ok(lines[1].endsWith("[2 attachment(s)]"), lines[1]);
    assert.ok(lines[2].endsWith("(no text)"), lines[2]);
  });

  it("caps content at 500 chars per message (code-point-safe)", async () => {
    const emoji = "💯".repeat(400); // astral: 800 code units, 400 code points
    const ch = makeChannel({
      id: "2200000000000000008",
      messages: [makeMessage(3001, "alice", emoji)],
    });
    const g = makeGuild({ channels: [ch], members: [{ id: ASKER }] });
    const out = await executeReadDiscord(`<#${ch.id}>`, opts({ guild: g }));
    const body = out.slice(out.indexOf(": ") + 2);
    assert.ok(body.length > 0 && body.length <= 500, `body capped: ${body.length}`);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), "no split surrogate pair");
  });

  it("caps the whole read at 12,000 chars (code-point-safe)", async () => {
    const fat = Array.from({ length: 50 }, (_, i) =>
      makeMessage(4000 + i, "alice", "💯".repeat(250)),
    );
    const ch = makeChannel({ id: "2300000000000000007", messages: fat });
    const g = makeGuild({ channels: [ch], members: [{ id: ASKER }] });
    const out = await executeReadDiscord(`<#${ch.id}>`, opts({ guild: g }));
    assert.ok(out.length <= 12000 && out.length > 11000, `total capped: ${out.length}`);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), "no split surrogate pair");
  });
});

/* ---------------------------- message link ------------------------------- */

describe("executeReadDiscord — message link window (decision 45)", () => {
  const many = Array.from({ length: 100 }, (_, i) =>
    makeMessage(1001 + i, "alice", `m${1001 + i}`),
  ); // ids 1001..1100

  const setup = () => {
    const channel = makeChannel({ id: "2000000000000000002", messages: many });
    const guild = makeGuild({ channels: [channel], members: [{ id: ASKER }] });
    return { channel, guild };
  };

  it("anchor + up to 40 before + up to 10 after, merged oldest→newest, anchor marked", async () => {
    const { channel, guild } = setup();
    const out = await executeReadDiscord(
      `https://discord.com/channels/${GUILD}/${channel.id}/1050`,
      opts({ guild }),
    );
    const lines = out.split("\n");
    assert.equal(lines.length, 51, "40 + anchor + 10");
    assert.ok(lines[0].startsWith("1010 |"), `oldest = 40 before the anchor: ${lines[0]}`);
    assert.ok(lines[40].startsWith("1050 |"), "anchor sits at position 41");
    assert.ok(lines[40].endsWith(ANCHOR_MARKER), "anchor marked");
    assert.ok(lines[50].startsWith("1060 |"), "nearest 10 newer messages");
    assert.equal(lines.filter((l) => l.includes(ANCHOR_MARKER)).length, 1, "exactly one anchor");
    // three exact fetches: single anchor, before-40, after-10
    assert.deepEqual(channel._fetchCalls, [
      "1050",
      { limit: 40, before: "1050" },
      { limit: 10, after: "1050" },
    ]);
  });

  it("missing edges simply return fewer messages (anchor near the start)", async () => {
    const { channel, guild } = setup();
    const out = await executeReadDiscord(
      `https://discord.com/channels/${GUILD}/${channel.id}/1002`,
      opts({ guild }),
    );
    const lines = out.split("\n");
    assert.ok(lines[0].startsWith("1001 |"), "only one older message exists");
    assert.ok(lines[1].includes(ANCHOR_MARKER), "anchor marked");
    assert.ok(lines[1].startsWith("1002 |"));
    assert.ok(lines[lines.length - 1].startsWith("1012 |"), "10 newer still fetched");
    assert.equal(lines.length, 12, "1 + anchor + 10");
  });

  it("deleted/unknown anchor → failure string, no partial-window fallback", async () => {
    const { channel, guild } = setup();
    const out = await executeReadDiscord(
      `https://discord.com/channels/${GUILD}/${channel.id}/9999`,
      opts({ guild }),
    );
    assert.match(
      out,
      /^Could not read message 9999: the linked message could not be read/,
    );
    assert.deepEqual(channel._fetchCalls, ["9999"], "before/after never fetched");
  });

  it("anchor fetch rejection → graceful failure string", async () => {
    const channel = makeChannel({ id: "2000000000000000002", messages: many });
    channel.messages.fetch = async () => {
      throw new Error("500: Internal Server Error");
    };
    const guild = makeGuild({ channels: [channel], members: [{ id: ASKER }] });
    const out = await executeReadDiscord(
      `https://discord.com/channels/${GUILD}/${channel.id}/1050`,
      opts({ guild }),
    );
    assert.match(out, /^Could not read message 1050: message fetch failed: 500/);
  });
});

/* ------------------------------- security -------------------------------- */

describe("executeReadDiscord — guild isolation (decision 46)", () => {
  it("cross-guild MESSAGE link rejected without any channel lookup", async () => {
    let lookedUp = 0;
    const guild = makeGuild({ members: [{ id: ASKER }] });
    const out = await executeReadDiscord(
      "https://discord.com/channels/9999999999999999999/2/3",
      {
        ...opts({ guild }),
        channelResolver: async () => {
          lookedUp += 1;
          return makeChannel({});
        },
      },
    );
    assert.match(out, /^Could not read message 3: that link points to another server/);
    assert.equal(lookedUp, 0, "no fetch — the other server's data is off-limits");
  });

  it("cross-guild CHANNEL URL rejected too", async () => {
    const guild = makeGuild({ members: [{ id: ASKER }] });
    const out = await executeReadDiscord(
      "https://discord.com/channels/9999999999999999999/2",
      opts({ guild }),
    );
    assert.match(out, /points to another server/);
  });

  it("bare ids / mentions resolve in-guild only (via guild.channels.fetch)", async () => {
    const channel = makeChannel({ messages: [makeMessage(7, "a", "hi")] });
    const guild = makeGuild({ channels: [channel], members: [{ id: ASKER }] });
    const out = await executeReadDiscord(channel.id, opts({ guild }));
    assert.match(out, /@a: hi/);
    const other = await executeReadDiscord("999000999000999000", opts({ guild }));
    assert.match(other, /^Could not read channel 999000999000999000: no channel with that id/);
  });

  it("channels without a messages seam (forums/categories) → failure string", async () => {
    const forum = makeChannel({ id: "2000000000000000002", seam: false });
    const guild = makeGuild({ channels: [forum], members: [{ id: ASKER }] });
    const out = await executeReadDiscord("<#2000000000000000002>", opts({ guild }));
    assert.match(out, /does not expose readable messages/);
  });
});

describe("executeReadDiscord — asker parity (decision 46)", () => {
  const channelWith = (perms) =>
    makeChannel({
      id: "2000000000000000002",
      messages: [makeMessage(500, "alice", "SECRET PLANNING")],
      perms,
    });

  it("asker without ViewChannel → refused, content never leaks", async () => {
    const channel = channelWith((member, flag) => {
      if (member.id === ASKER && flag === PermissionFlagsBits.ViewChannel) return false;
      return true;
    });
    const guild = makeGuild({ channels: [channel], members: [{ id: ASKER }] });
    const out = await executeReadDiscord("<#2000000000000000002>", opts({ guild }));
    assert.match(out, /the asking user cannot view that channel/);
    assert.ok(!out.includes("SECRET PLANNING"), "no leak");
    assert.equal(channel._fetchCalls.length, 0, "refused before any message fetch");
  });

  it("member fetch failure fails closed", async () => {
    const channel = channelWith(null);
    const guild = makeGuild({ channels: [channel], members: [] }); // asker not fetchable
    const out = await executeReadDiscord("<#2000000000000000002>", opts({ guild }));
    assert.match(out, /could not check the asking user's access/);
  });

  it("unknown asker id → refused", async () => {
    const channel = channelWith(null);
    const guild = makeGuild({ channels: [channel], members: [] });
    const out = await executeReadDiscord("<#2000000000000000002>", {
      ...opts({ guild }),
      memberFetcher: async () => null,
    });
    assert.match(out, /not a member of this server/);
  });

  it("bot missing ViewChannel on a channel the asker CAN see → graceful failure", async () => {
    const channel = channelWith((member, flag) => {
      if (member.id === BOT && flag === PermissionFlagsBits.ViewChannel) return false;
      return true;
    });
    const guild = makeGuild({ channels: [channel], members: [{ id: ASKER }] });
    const out = await executeReadDiscord("<#2000000000000000002>", opts({ guild }));
    assert.match(out, /the bot cannot view that channel/);
  });
});

describe("executeReadDiscord — open-ticket blackout (decision 46)", () => {
  const channel = () =>
    makeChannel({
      id: "2000000000000000002",
      messages: [makeMessage(9, "alice", "ticket whisper")],
    });

  it("unarchived ticket row → always refused, even for a viewer who can see it", async () => {
    const ch = channel();
    const guild = makeGuild({ channels: [ch], members: [{ id: ASKER }] });
    const repo = repoStub({ channel_id: ch.id, archived: 0 });
    const out = await executeReadDiscord("<#2000000000000000002>", opts({ guild, repo }));
    assert.match(out, /that channel is an open help ticket/);
    assert.ok(!out.includes("ticket whisper"), "no leak");
    assert.deepEqual(repo.calls, [ch.id]);
    assert.equal(ch._fetchCalls.length, 0, "refused before any message fetch");
  });

  it("archived ticket rows stay readable (blackout covers OPEN tickets only)", async () => {
    const ch = channel();
    const guild = makeGuild({ channels: [ch], members: [{ id: ASKER }] });
    const out = await executeReadDiscord("<#2000000000000000002>", {
      ...opts({ guild }),
      repo: repoStub({ channel_id: ch.id, archived: 1 }),
    });
    assert.match(out, /@alice: ticket whisper/);
  });
});

/* --------------------------- never-throws contract ------------------------ */

describe("executeReadDiscord — never throws (decision 47)", () => {
  it("every garbage arg resolves to a failure string", async () => {
    const guild = makeGuild({ members: [{ id: ASKER }] });
    for (const raw of [undefined, null, 42, {}, [], "hello", "", "https://x.example/1"]) {
      const out = await executeReadDiscord(raw, opts({ guild }));
      assert.equal(typeof out, "string", JSON.stringify(raw));
      assert.match(out, /^Could not read .+: /, JSON.stringify(raw));
    }
  });

  it("missing guild context → failure string, not a crash", async () => {
    const out = await executeReadDiscord("<#1234567890123456789>", {});
    assert.match(out, /^Could not read channel 1234567890123456789: /);
  });

  it("window fetch rejection mid-read → graceful failure string", async () => {
    const channel = makeChannel({
      id: "2000000000000000002",
      messages: Array.from({ length: 10 }, (_, i) => makeMessage(i + 1, "a", "x")),
    });
    const guild = makeGuild({ channels: [channel], members: [{ id: ASKER }] });
    channel.messages.fetch = async () => {
      throw new Error("boom");
    };
    const out = await executeReadDiscord("<#2000000000000000002>", opts({ guild }));
    assert.match(out, /^Could not read channel 2000000000000000002: message fetch failed: boom/);
  });

  it("repo (ticket lookup) throwing → graceful failure string", async () => {
    const channel = makeChannel({ id: "2000000000000000002", messages: [makeMessage(1, "a", "x")] });
    const guild = makeGuild({ channels: [channel], members: [{ id: ASKER }] });
    const out = await executeReadDiscord("<#2000000000000000002>", {
      ...opts({ guild }),
      repo: {
        getTicketByChannel() {
          throw new Error("SQLITE_BUSY");
        },
      },
    });
    assert.match(out, /^Could not read .+: message fetch failed: SQLITE_BUSY/);
  });
});

/* ------------------------------- formatters ------------------------------- */

describe("formatReadLine / formatReadOutput are pure duck-typed renders", () => {
  it("line shape id | timestamp | @author: content, anchor suffix only on the anchor", () => {
    const m = makeMessage(77, "alice", "hi", {
      createdTimestamp: Date.parse("2026-09-16T12:34:56.000Z"),
    });
    assert.equal(formatReadLine(m), "77 | 2026-09-16T12:34:56.000Z | @alice: hi");
    assert.ok(formatReadLine(m, true).endsWith(ANCHOR_MARKER));
    assert.equal(formatReadLine({}), "? |  | @unknown: (no text)");
  });

  it("formatReadOutput marks the anchor by id and caps the total", () => {
    const msgs = [makeMessage(1, "a", "x"), makeMessage(2, "b", "y")];
    const out = formatReadOutput(msgs, 2);
    assert.ok(out.split("\n")[1].endsWith(ANCHOR_MARKER));
    assert.ok(!out.split("\n")[0].includes(ANCHOR_MARKER));
    const huge = Array.from({ length: 50 }, (_, i) => makeMessage(i + 1, "a", "z".repeat(400)));
    assert.ok(formatReadOutput(huge).length <= 12000);
  });
});
