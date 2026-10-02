const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { loadDb } = require("./helpers/env");
const {
  createClient,
  createGuild,
  createMember,
  createUser,
  createTextChannel,
} = require("./helpers/discord");
const { IDS } = require("./helpers/fixtures");

const SNOWFLAKE = "1554590611015729152";
const TS = Date.UTC(2023, 10, 14, 22, 13, 20);

describe("platform/discord/outbound", () => {
  let cleanup;
  let community;
  let client;
  let guild;
  let textChannel;
  let member;
  let memberUser;
  let communityId;
  let outbound;

  before(async () => {
    // Contract: loadDb() before any other `src/` require (temp SQLite).
    const env = loadDb();
    cleanup = env.cleanup;
    community = require("../src/platform/community");
    const { createDiscordOutbound } = require("../src/platform/discord/outbound");

    client = createClient();
    guild = createGuild({ id: IDS.guild, name: "Test Guild", afkChannelId: IDS.channelAfk });
    guild.ownerId = IDS.admin; // mock helper omits the field; real Guild has it
    client.addGuild(guild);

    memberUser = createUser({ id: IDS.member, username: "member" });
    member = createMember({ guild, user: memberUser });
    guild.addMember(member);

    textChannel = createTextChannel({ id: IDS.channelGeneral, guild, name: "general" });
    guild.addChannel(textChannel);

    const usersById = new Map([[IDS.member, memberUser]]);
    client.users = {
      fetch: async (id) => {
        const user = usersById.get(id);
        if (!user) throw new Error(`User ${id} not found`);
        return user;
      },
    };

    // Real users open DMs through createDM(); exercise that shape here.
    const dmSends = [];
    const dmUser = createUser({ id: IDS.member2, username: "member2" });
    dmUser.createDM = async () => ({
      id: "dm-channel-1",
      send: async (payload) => {
        dmSends.push(payload);
        return { id: "dm-msg-1", content: typeof payload === "string" ? payload : payload?.content };
      },
    });
    usersById.set(IDS.member2, dmUser);

    communityId = community.ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId: IDS.guild,
    });
    outbound = createDiscordOutbound(client);
    outbound._dmSends = dmSends;
  });

  after(() => cleanup?.());

  it("exposes the spec OutboundClient surface", () => {
    assert.equal(outbound.platform, "discord");
    assert.equal(outbound.instanceKey, "discord");
    // botUserId is the Ready snapshot — the id tickets/honeypot compare to.
    assert.equal(outbound.botUserId, IDS.bot);
    for (const name of [
      "fetchGuild",
      "fetchChannel",
      "fetchUser",
      "fetchMember",
      "fetchRoles",
      "sendChannel",
      "sendDm",
      "editMessage",
      "addRole",
      "removeRole",
      "addReaction",
      "removeUserReaction",
      "removeEmojiReaction",
      "createChannel",
      "setOverwrites",
      "banMember",
      "fetchMessages",
      "fetchMessage",
    ]) {
      assert.equal(typeof outbound[name], "function", `missing ${name}`);
    }
  });

  describe("fetches", () => {
    it("fetchGuild resolves the normalized shape from the communities row", async () => {
      const result = await outbound.fetchGuild(communityId);
      assert.deepEqual(result, {
        id: IDS.guild,
        name: "Test Guild",
        ownerId: IDS.admin,
        afkChannelId: IDS.channelAfk,
      });
    });

    it("fetchGuild resolves null for an unknown community id", async () => {
      assert.equal(await outbound.fetchGuild(987_654), null);
    });

    it("fetchChannel returns the channel handle (id, numeric type, permissionOverwrites)", async () => {
      const channel = await outbound.fetchChannel(communityId, IDS.channelGeneral);
      assert.equal(channel.id, IDS.channelGeneral);
      assert.equal(typeof channel.type, "number");
      assert.ok(channel.permissionOverwrites);
    });

    it("fetchUser includes bot", async () => {
      assert.deepEqual(await outbound.fetchUser(communityId, IDS.member), {
        id: IDS.member,
        username: "member",
        bot: false,
      });
      assert.equal(await outbound.fetchUser(communityId, "user-missing"), null);
    });

    it("fetchMember returns the MemberHandle shape", async () => {
      const handle = await outbound.fetchMember(communityId, IDS.member);
      assert.equal(handle.id, IDS.member);
      assert.equal(handle.username, "member");
      assert.equal(handle.bot, false);
      // createMember always includes the @everyone role (the guild id).
      assert.deepEqual(handle.roleIds, [IDS.guild]);
    });

    it("fetchRoles returns RoleHandles with decimal-string permissions", async () => {
      guild.roles.cache.set(IDS.roleLevel5, {
        id: IDS.roleLevel5,
        name: "Level 5",
        position: 3,
        permissions: 1024n,
      });
      const roles = await outbound.fetchRoles(communityId);
      const role = roles.find((r) => r.id === IDS.roleLevel5);
      assert.deepEqual(role, {
        id: IDS.roleLevel5,
        name: "Level 5",
        position: 3,
        permissions: "1024",
      });
      for (const r of roles) {
        assert.equal(typeof r.permissions, "string");
      }
    });

    it("fetchMessages normalizes history (id, authorId, authorBot, content, createdAt)", async () => {
      textChannel.addMessage({ id: "aaa", content: "first", createdTimestamp: TS });
      textChannel.addMessage({ id: "bbb", content: "second", createdTimestamp: TS + 1 });
      const res = await outbound.fetchMessages(IDS.channelGeneral, {
        limit: 100,
        before: "bbb",
      });
      assert.equal(res.ok, true);
      assert.deepEqual(res.messages, [
        {
          id: "aaa",
          authorId: IDS.member,
          authorBot: false,
          content: "first",
          createdAt: new Date(TS).toISOString(),
        },
      ]);
    });

    it("fetchMessage REST-reads one message by id into the §10.3 fetch shape", async () => {
      const msg = textChannel.addMessage({ id: "fm-1", content: "hello", createdTimestamp: TS });
      msg.editedTimestamp = TS + 5000;
      msg.type = 0;
      msg.webhookId = "wh-9";
      msg.attachments = new Map([
        [
          "att-1",
          {
            id: "att-1",
            name: "shot.png",
            size: 10,
            contentType: "image/png",
            flags: 1n,
            url: "https://cdn.test/s.png",
            proxyURL: "https://proxy.test/s.png",
          },
        ],
      ]);
      msg.stickers = new Map([["st-1", { id: "st-1", name: "gork" }]]);

      const res = await outbound.fetchMessage(communityId, IDS.channelGeneral, "fm-1");

      assert.equal(res.ok, true);
      const m = res.message;
      assert.equal(m.platform, "discord");
      assert.equal(m.instanceKey, "discord");
      assert.equal(m.communityId, communityId, "the fetch shape is guild-scoped: community id rides along");
      assert.equal(m.externalGuildId, IDS.guild);
      assert.equal(m.id, "fm-1");
      assert.equal(m.channelId, IDS.channelGeneral);
      assert.equal(m.authorId, IDS.member);
      assert.equal(m.authorBot, false);
      assert.deepEqual(m.author, {
        id: IDS.member,
        username: "member",
        displayName: "member",
        bot: false,
      });
      assert.equal(m.content, "hello");
      assert.equal(m.type, 0);
      assert.equal(m.webhookId, "wh-9");
      assert.equal(m.editedTimestamp, TS + 5000);
      assert.equal(m.createdAt, new Date(TS).toISOString());
      assert.equal(m.deleted, false);
      assert.deepEqual(m.attachments, [
        {
          id: "att-1",
          filename: "shot.png",
          size: 10,
          contentType: "image/png",
          flags: 1, // bigint BitField → number at the boundary
          url: "https://cdn.test/s.png",
          proxyUrl: "https://proxy.test/s.png",
        },
      ]);
      assert.deepEqual(m.stickers, [{ id: "st-1", name: "gork" }]);
      assert.deepEqual(m.messageSnapshots, []);
    });

    it("fetchMessage reports missing messages and channels with specific, actionable errors", async () => {
      const missingMsg = await outbound.fetchMessage(communityId, IDS.channelGeneral, "nope");
      assert.equal(missingMsg.ok, false);
      assert.match(missingMsg.error, /fetchMessage: message nope in channel .* not found/);

      const missingChannel = await outbound.fetchMessage(communityId, "channel-missing", "m1");
      assert.equal(missingChannel.ok, false);
      assert.match(missingChannel.error, /channel channel-missing not found in community/);

      const noId = await outbound.fetchMessage(communityId, IDS.channelGeneral, "");
      assert.equal(noId.ok, false);
      assert.match(noId.error, /a messageId is required/);
    });
  });

  describe("sends return { ok:false, error } for expected failures", () => {
    it("sendChannel happy path", async () => {
      const res = await outbound.sendChannel(IDS.channelGeneral, { content: "hello" });
      assert.equal(res.ok, true);
      assert.equal(typeof res.id, "string");
      assert.equal(textChannel.sent.length, 1);
      assert.deepEqual(textChannel.sent[0], { content: "hello" });
    });

    it("sendChannel on a missing channel reports the cause", async () => {
      const res = await outbound.sendChannel("channel-missing", { content: "hi" });
      assert.equal(res.ok, false);
      assert.match(res.error, /channel channel-missing not found/);
    });

    it("sendDm opens the DM through createDM", async () => {
      const res = await outbound.sendDm(IDS.member2, { content: "ticket update" });
      assert.deepEqual(res, { ok: true, id: "dm-msg-1" });
      assert.deepEqual(outbound._dmSends, [{ content: "ticket update" }]);
    });

    it("sendDm on an unresolvable user returns { ok:false, error }", async () => {
      const res = await outbound.sendDm("user-missing", { content: "x" });
      assert.equal(res.ok, false);
      assert.match(res.error, /sendDm: DM to user user-missing failed: User user-missing not found/);
    });

    it("editMessage mutates the target message", async () => {
      const msg = textChannel.addMessage({ id: "msg-edit-1", content: "before" });
      const edits = [];
      msg.edit = async (payload) => {
        edits.push(payload);
        return msg;
      };
      const res = await outbound.editMessage(
        { communityId, channelId: IDS.channelGeneral, messageId: "msg-edit-1" },
        { content: "after" },
      );
      assert.deepEqual(res, { ok: true });
      assert.deepEqual(edits, [{ content: "after" }]);
    });

    it("editMessage on a missing message returns a specific error", async () => {
      const res = await outbound.editMessage(
        { communityId, channelId: IDS.channelGeneral, messageId: "msg-nope" },
        { content: "x" },
      );
      assert.equal(res.ok, false);
      assert.match(res.error, /message msg-nope in channel .* not found/);
    });

    it("addRole / removeRole happy paths mutate the member", async () => {
      assert.deepEqual(await outbound.addRole(communityId, IDS.member, IDS.roleLevel5), {
        ok: true,
      });
      assert.deepEqual(await outbound.removeRole(communityId, IDS.member, IDS.roleLevel5), {
        ok: true,
      });
      assert.deepEqual(member._addedRoles, [IDS.roleLevel5]);
      assert.deepEqual(member._removedRoles, [IDS.roleLevel5]);
    });

    it("addRole on an unknown member returns { ok:false, error }", async () => {
      const res = await outbound.addRole(communityId, "user-missing", IDS.roleLevel5);
      assert.equal(res.ok, false);
      assert.match(res.error, /member user-missing in community .* fetch failed: Member user-missing not found/);
    });

    it("addRole surfaces the Discord API code as a string", async () => {
      const original = guild.members.fetch;
      guild.members.fetch = async () => {
        const err = new Error("Missing Permissions");
        err.code = 50013; // DiscordAPIError-style numeric code
        throw err;
      };
      try {
        const res = await outbound.addRole(communityId, IDS.member, IDS.roleExempt);
        assert.equal(res.ok, false);
        assert.match(res.error, /Missing Permissions/);
        assert.equal(res.code, "50013");
      } finally {
        guild.members.fetch = original;
      }
    });

    it("reactions: add, remove-user, remove-emoji", async () => {
      const msg = textChannel.addMessage({ id: "msg-react-1" });
      const reacted = [];
      const usersRemoved = [];
      let emojiRemoved = 0;
      msg.react = async (emojiKey) => {
        reacted.push(emojiKey);
        const reaction = {
          emojiKey,
          users: { remove: async (userId) => usersRemoved.push(userId) },
          remove: async () => {
            emojiRemoved += 1;
          },
        };
        msg.reactions = {
          ...msg.reactions,
          cache: new Map([[emojiKey, reaction]]),
          resolve: (key) => msg.reactions.cache.get(key) ?? null,
        };
        return reaction;
      };

      assert.deepEqual(await outbound.addReaction(IDS.channelGeneral, "msg-react-1", "👍"), {
        ok: true,
      });
      assert.deepEqual(
        await outbound.removeUserReaction(IDS.channelGeneral, "msg-react-1", "👍", IDS.bot),
        { ok: true },
      );
      assert.deepEqual(
        await outbound.removeEmojiReaction(IDS.channelGeneral, "msg-react-1", "👍"),
        { ok: true },
      );
      assert.deepEqual(reacted, ["👍", "👍"]);
      assert.deepEqual(usersRemoved, [IDS.bot]);
      assert.equal(emojiRemoved, 1);
    });

    it("removeEmojiReaction on a message without that emoji is a no-op success", async () => {
      const msg = textChannel.addMessage({ id: "msg-react-2" });
      const res = await outbound.removeEmojiReaction(IDS.channelGeneral, "msg-react-2", "🎉");
      assert.deepEqual(res, { ok: true });
    });

    it("createChannel maps CreateChannelArgs to discord.js data", async () => {
      const res = await outbound.createChannel({
        communityId,
        name: "ticket-1",
        parentId: IDS.channelLog,
        type: 0,
        overwrites: [
          { id: IDS.member, kind: "member", allow: "1024", deny: "8192" },
          { id: IDS.roleExempt, kind: "role", allow: "1024", deny: "0" },
        ],
      });
      assert.equal(res.ok, true);
      assert.equal(typeof res.id, "string");

      const created = guild.channels.cache.get(res.id);
      assert.equal(created.name, "ticket-1");
      assert.equal(created.type, 0);
      assert.equal(created.parentId, IDS.channelLog);
      // Spec wire shape: type 0 = role, 1 = member; allow/deny decimal strings.
      assert.deepEqual(
        created._overwrites.map((ow) => [ow.id, ow.type, String(ow.allow), String(ow.deny)]),
        [
          [IDS.member, 1, "1024", "8192"],
          [IDS.roleExempt, 0, "1024", "0"],
        ],
      );
    });

    it("createChannel rejects an overwrite kind outside role/member", async () => {
      const res = await outbound.createChannel({
        communityId,
        name: "bad-ow",
        parentId: null,
        type: 0,
        overwrites: [{ id: "x", kind: "channel", allow: "1", deny: "0" }],
      });
      assert.equal(res.ok, false);
      assert.match(res.error, /createChannel: overwrite for x has kind "channel"; expected "role" or "member"/);
    });

    it("setOverwrites applies the mapped list", async () => {
      const res = await outbound.setOverwrites(IDS.channelGeneral, [
        { id: IDS.member, kind: "member", allow: "1024", deny: "0" },
      ]);
      assert.deepEqual(res, { ok: true });
      assert.deepEqual(
        textChannel._overwrites.map((ow) => [ow.id, ow.type]),
        [[IDS.member, 1]],
      );
    });

    it("setOverwrites partial failure reports per-overwrite skips", async () => {
      const broken = createTextChannel({ id: "ch-ow-broken", guild });
      guild.addChannel(broken);
      broken.permissionOverwrites.set = async () => {
        const err = new Error("Missing Permissions");
        err.code = 50013;
        throw err;
      };
      const res = await outbound.setOverwrites("ch-ow-broken", [
        { id: "role-a", kind: "role", allow: "1024", deny: "0" },
        { id: "user-a", kind: "member", allow: "1024", deny: "0" },
      ]);
      assert.equal(res.ok, false);
      assert.match(res.error, /setOverwrites: applying 2 overwrite\(s\) to channel ch-ow-broken failed: Missing Permissions/);
      assert.deepEqual(res.skipped, [
        { id: "role-a", reason: "Missing Permissions" },
        { id: "user-a", reason: "Missing Permissions" },
      ]);
    });

    it("banMember records the ban with reason", async () => {
      const res = await outbound.banMember(communityId, IDS.member, "honeypot");
      assert.deepEqual(res, { ok: true });
      assert.deepEqual(guild._bans, [{ userId: IDS.member, reason: "honeypot" }]);
    });

    it("a missing guild surfaces a specific not-available error", async () => {
      // Second client shares the DB (same community id) but has no guild
      // cached, and its REST fetch 404s — the bot cannot see the guild.
      const blindClient = createClient();
      const blind = require("../src/platform/discord/outbound").createDiscordOutbound(blindClient);
      const res = await blind.addRole(communityId, IDS.member, IDS.roleLevel5);
      assert.equal(res.ok, false);
      assert.match(res.error, /not available to the bot/);
    });

    it("an unknown community id is an actionable error, not a crash", async () => {
      const res = await outbound.banMember(987_654, IDS.member, "x");
      assert.equal(res.ok, false);
      assert.match(res.error, /no communities row for id 987654/);
    });
  });

  describe("community id discipline", () => {
    it("snowflake strings throw the assertCommunityId programmer error", async () => {
      const message = "community id required, got string";
      await assert.rejects(() => outbound.fetchGuild(SNOWFLAKE), { message });
      await assert.rejects(() => outbound.fetchChannel(SNOWFLAKE, "c1"), { message });
      await assert.rejects(() => outbound.fetchUser(SNOWFLAKE, "u1"), { message });
      await assert.rejects(() => outbound.fetchMember(SNOWFLAKE, "u1"), { message });
      await assert.rejects(() => outbound.fetchRoles(SNOWFLAKE), { message });
      await assert.rejects(() => outbound.fetchMessage(SNOWFLAKE, "c1", "m1"), { message });
      await assert.rejects(() => outbound.addRole(SNOWFLAKE, "u1", "r1"), { message });
      await assert.rejects(() => outbound.removeRole(SNOWFLAKE, "u1", "r1"), { message });
      await assert.rejects(() => outbound.banMember(SNOWFLAKE, "u1", "x"), { message });
      await assert.rejects(
        () => outbound.editMessage({ communityId: SNOWFLAKE, channelId: "c1", messageId: "m1" }, {}),
        { message },
      );
      await assert.rejects(
        () => outbound.createChannel({ communityId: SNOWFLAKE, name: "n", parentId: null, type: 0, overwrites: [] }),
        { message },
      );
    });
  });

  describe("never throws uncaught for expected platform failures", () => {
    it("every ok-shaped method returns { ok:false, error: string } against a dead client", async () => {
      const boom = createClient();
      boom.users = {
        fetch: async () => {
          throw new Error("users down");
        },
      };
      boom.guilds = {
        cache: { get: () => null },
        fetch: async () => {
          throw new Error("guilds down");
        },
      };
      boom.channels = {
        fetch: async () => {
          throw new Error("channels down");
        },
      };
      const dead = require("../src/platform/discord/outbound").createDiscordOutbound(boom);

      const sendCalls = [
        ["sendChannel", () => dead.sendChannel("c1", "hi")],
        ["sendDm", () => dead.sendDm("u1", "hi")],
        ["editMessage", () => dead.editMessage({ communityId, channelId: "c1", messageId: "m1" }, {})],
        ["addRole", () => dead.addRole(communityId, "u1", "r1")],
        ["removeRole", () => dead.removeRole(communityId, "u1", "r1")],
        ["addReaction", () => dead.addReaction("c1", "m1", "👍")],
        ["removeUserReaction", () => dead.removeUserReaction("c1", "m1", "👍", "u1")],
        ["removeEmojiReaction", () => dead.removeEmojiReaction("c1", "m1", "👍")],
        [
          "createChannel",
          () => dead.createChannel({ communityId, name: "n", parentId: null, type: 0, overwrites: [] }),
        ],
        [
          "setOverwrites",
          () => dead.setOverwrites("c1", [{ id: "r1", kind: "role", allow: "1", deny: "0" }]),
        ],
        ["banMember", () => dead.banMember(communityId, "u1", "spam")],
        ["fetchMessages", () => dead.fetchMessages("c1", { limit: 100 })],
        ["fetchMessage", () => dead.fetchMessage(communityId, "c1", "m1")],
      ];

      for (const [name, call] of sendCalls) {
        const res = await call();
        assert.equal(res.ok, false, `expected ok:false from ${name}`);
        assert.equal(typeof res.error, "string", `${name} must report a string cause`);
        assert.ok(res.error.length > 0, `${name} must not report an empty error`);
      }

      // Fetch-shaped methods resolve their typedef null/[] values.
      assert.equal(await dead.fetchGuild(communityId), null);
      assert.equal(await dead.fetchChannel(communityId, "c1"), null);
      assert.equal(await dead.fetchUser(communityId, "u1"), null);
      assert.equal(await dead.fetchMember(communityId, "u1"), null);
      assert.deepEqual(await dead.fetchRoles(communityId), []);
    });
  });

  it("source never references the Fluxer capability flag columns", () => {
    // Spec line 425: the Discord path must never read elevated_permissions /
    // voice_states_complete — enforced the same way AGENTS.md verifies it.
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "platform", "discord", "outbound.js"),
      "utf8",
    );
    assert.ok(!src.includes("elevated_permissions"), "outbound must not read elevated_permissions");
    assert.ok(!src.includes("voice_states_complete"), "outbound must not read voice_states_complete");
  });
});
