/**
 * Unit tests for src/platform/discord/webhooks.js (PR 3, §10.3 delta 3).
 *
 * No sockets: a stubbed discord.js client (test/helpers/discord doubles plus
 * hand-built webhook/channel doubles). Proves the §10.3 contract mirrored
 * from the Fluxer module — same signatures, same { ok, ... } shapes:
 *   createRelayWebhook resolves the channel THROUGH the community's guild;
 *   execute/patch/delete authenticate with the STORED token via
 *   client.webhooks.create(id, token);
 *   429/5xx/transport throws → retryable:true, 4xx → false;
 *   404-on-delete counts as ok;
 *   the webhook token never appears in an error string.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { cleanup } = loadDb();

const { createDiscordWebhooks } = require("../src/platform/discord/webhooks");
const community = require("../src/platform/community");
const {
  createClient,
  createGuild,
  createTextChannel,
} = require("./helpers/discord");
const { IDS } = require("./helpers/fixtures");

after(cleanup);

const WH = { id: "1554600000000000050", token: "discord-wh-SECRET-token" };

/** Error shaped like discord.js DiscordAPIError (status + numeric code). */
function apiError(message, { status, code } = {}) {
  const err = new Error(message);
  err.name = "DiscordAPIError[50013]";
  if (status != null) err.status = status;
  if (code != null) err.code = code;
  return err;
}

/** Webhook double for client.webhooks.create(id, token). */
function fakeWebhook(overrides = {}) {
  const calls = { send: [], editMessage: [], deleteMessage: [], delete: 0 };
  return {
    id: WH.id,
    calls,
    send: async (payload) => {
      calls.send.push(payload);
      if (overrides.sendError) throw overrides.sendError;
      // Explicit null means "send resolved with no message object"; only an
      // ABSENT override falls back to the default message.
      return overrides.sent === undefined ? { id: "msg-777" } : overrides.sent;
    },
    editMessage: async (messageId, payload) => {
      calls.editMessage.push({ messageId, payload });
      if (overrides.editError) throw overrides.editError;
    },
    deleteMessage: async (messageId) => {
      calls.deleteMessage.push(messageId);
      if (overrides.deleteError) throw overrides.deleteError;
    },
    delete: async () => {
      calls.delete += 1;
      if (overrides.deleteWebhookError) throw overrides.deleteWebhookError;
    },
  };
}

describe("platform/discord/webhooks", () => {
  let client;
  let guild;
  let textChannel;
  let communityId;
  let webhooks;
  let created; // channel.createWebhook call log

  before(() => {
    client = createClient();
    guild = createGuild({ id: IDS.guild, name: "Test Guild" });
    client.addGuild(guild);
    textChannel = createTextChannel({ id: IDS.channelGeneral, guild, name: "general" });
    created = [];
    textChannel.createWebhook = async (opts) => {
      created.push(opts);
      return { id: WH.id, token: WH.token, name: opts.name };
    };
    guild.addChannel(textChannel);

    communityId = community.ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId: IDS.guild,
    });
    webhooks = createDiscordWebhooks(client);
  });

  it("exposes the five lifecycle functions and requires a client", () => {
    for (const name of [
      "createRelayWebhook",
      "executeRelayWebhook",
      "patchRelayMessage",
      "deleteRelayMessage",
      "deleteRelayWebhook",
    ]) {
      assert.equal(typeof webhooks[name], "function", `missing ${name}`);
    }
    assert.throws(() => createDiscordWebhooks(null), /requires a Discord client/);
  });

  describe("createRelayWebhook", () => {
    it("creates on the community's guild channel and returns the webhook with its token", async () => {
      const res = await webhooks.createRelayWebhook(communityId, IDS.channelGeneral, {
        name: "Bridge Relay",
      });
      assert.deepEqual(res, { ok: true, webhook: { id: WH.id, token: WH.token } });
      assert.deepEqual(created, [{ name: "Bridge Relay" }]);
    });

    it("rejects a missing/blank name before touching the API", async () => {
      const res = await webhooks.createRelayWebhook(communityId, IDS.channelGeneral, {});
      assert.equal(res.ok, false);
      assert.match(res.error, /needs a non-empty string name/);
    });

    it("reports a missing communities row as a specific failure", async () => {
      const res = await webhooks.createRelayWebhook(999999, IDS.channelGeneral, { name: "R" });
      assert.equal(res.ok, false);
      assert.match(res.error, /no communities row for id 999999/);
    });

    it("reports a channel outside the community's guild as not found", async () => {
      const res = await webhooks.createRelayWebhook(communityId, "channel-from-elsewhere", {
        name: "R",
      });
      assert.equal(res.ok, false);
      assert.match(res.error, /channel channel-from-elsewhere not found in community/);
    });

    it("names channels that cannot host webhooks", async () => {
      const voice = createTextChannel({ id: "voice-1", guild, name: "Voice", type: 2 });
      voice.createWebhook = undefined; // voice channels have no createWebhook
      guild.addChannel(voice);
      const res = await webhooks.createRelayWebhook(communityId, "voice-1", { name: "R" });
      assert.equal(res.ok, false);
      assert.match(res.error, /does not support webhooks \(channel type 2\)/);
    });
  });

  describe("executeRelayWebhook (token transport)", () => {
    function wired(overrides = {}) {
      const wh = fakeWebhook(overrides);
      const seen = [];
      const local = createClient();
      local.webhooks = {
        create: async (id, token) => {
          seen.push({ id, token });
          return wh;
        },
      };
      return { api: createDiscordWebhooks(local), wh, seen };
    }

    it("resolves the webhook by stored token and passes every §10.3 field to send()", async () => {
      const { api, wh, seen } = wired({ sent: { id: "msg-42" } });

      const res = await api.executeRelayWebhook(WH, {
        content: "hello",
        username: "Relay (Bridge)",
        avatarUrl: "https://cdn.test/a.png",
        allowedMentions: {},
        flags: 1 << 12,
        nonce: "abc123",
        files: [{ name: "board.png", data: Buffer.from("PNG"), contentType: "image/png" }],
      });

      assert.deepEqual(res, { ok: true, messageId: "msg-42" });
      assert.deepEqual(seen, [{ id: WH.id, token: WH.token }], "authenticated by the stored token");
      const sent = wh.calls.send[0];
      assert.equal(sent.content, "hello");
      assert.equal(sent.username, "Relay (Bridge)");
      assert.equal(sent.avatarURL, "https://cdn.test/a.png", "avatarUrl maps to avatarURL");
      assert.deepEqual(sent.allowedMentions, {});
      assert.equal(sent.flags, 4096);
      assert.equal(sent.nonce, "abc123", "nonce passes through (forward-compat; §10.6)");
      assert.equal(sent.files.length, 1);
      assert.equal(sent.files[0].name, "board.png");
      assert.ok(Buffer.isBuffer(sent.files[0].attachment), "file bytes become Buffer attachments");
    });

    it("maps 429 to retryable:true and 403 to retryable:false with the numeric code stringified", async () => {
      const limited = wired({
        sendError: apiError("You are being rate limited.", { status: 429, code: 42900 }),
      });
      const res429 = await limited.api.executeRelayWebhook(WH, { content: "hi" });
      assert.equal(res429.ok, false);
      assert.equal(res429.retryable, true);
      assert.equal(res429.code, "42900");
      assert.ok(!res429.error.includes(WH.token), "no token in the failure text");

      const denied = wired({
        sendError: apiError("Missing Permissions", { status: 403, code: 50013 }),
      });
      const res403 = await denied.api.executeRelayWebhook(WH, { content: "hi" });
      assert.equal(res403.ok, false);
      assert.equal(res403.retryable, false, "4xx is terminal — the worker must not burn attempts");
      assert.equal(res403.code, "50013");
    });

    it("treats transport-level throws (no HTTP status) as retryable", async () => {
      const { api } = wired({ sendError: new TypeError("fetch failed") });
      const res = await api.executeRelayWebhook(WH, { content: "hi" });
      assert.equal(res.ok, false);
      assert.equal(res.retryable, true);
      assert.match(res.error, /fetch failed/);
    });

    it("returns messageId null when the send resolves without a message object", async () => {
      const { api } = wired({ sent: null });
      assert.deepEqual(await api.executeRelayWebhook(WH, { content: "hi" }), {
        ok: true,
        messageId: null,
      });
    });

    it("validates the RelayWebhook handle before any network", async () => {
      const local = createClient();
      local.webhooks = {
        create: async () => {
          throw new Error("must not be called");
        },
      };
      const api = createDiscordWebhooks(local);
      const res = await api.executeRelayWebhook({ id: "11", token: "" }, { content: "hi" });
      assert.equal(res.ok, false);
      assert.match(res.error, /webhook 11 has no token/);
      assert.equal(res.retryable, false);
    });

    it("reports token resolution failures with the specific cause", async () => {
      const local = createClient();
      local.webhooks = {
        create: async () => {
          throw apiError("Invalid Webhook Token", { status: 404, code: 10015 });
        },
      };
      const api = createDiscordWebhooks(local);
      const res = await api.executeRelayWebhook(WH, { content: "hi" });
      assert.equal(res.ok, false);
      assert.equal(res.retryable, false);
      assert.equal(res.code, "10015");
      assert.match(res.error, /Invalid Webhook Token/);
      assert.ok(!res.error.includes(WH.token));
    });

    it("rejects bad file descriptors before sending", async () => {
      const { api, wh } = wired();
      const res = await api.executeRelayWebhook(WH, { files: [{ data: "no name" }] });
      assert.equal(res.ok, false);
      assert.match(res.error, /files\[0\] needs a non-empty string name/);
      assert.equal(wh.calls.send.length, 0, "the send never fired with a bad descriptor");
    });
  });

  describe("patch / delete lifecycle", () => {
    function wired(overrides = {}) {
      const wh = fakeWebhook(overrides);
      const local = createClient();
      local.webhooks = { create: async () => wh };
      return { api: createDiscordWebhooks(local), wh };
    }

    it("patches the linked message through the token-scoped webhook", async () => {
      const { api, wh } = wired();
      const res = await api.patchRelayMessage(WH, "msg-42", {
        content: "edited",
        files: [{ name: "n.png", data: Buffer.from("x") }],
      });
      assert.deepEqual(res, { ok: true });
      assert.deepEqual(wh.calls.editMessage, [
        { messageId: "msg-42", payload: { content: "edited", files: [{ attachment: Buffer.from("x"), name: "n.png" }] } },
      ]);
    });

    it("reports edit refusals (spike B5) with the Discord code, no token", async () => {
      const { api } = wired({ editError: apiError("Invalid Form Body", { status: 400, code: 50035 }) });
      const res = await api.patchRelayMessage(WH, "msg-42", { content: "edited" });
      assert.equal(res.ok, false);
      assert.equal(res.code, "50035");
      assert.ok(!res.error.includes(WH.token));
    });

    it("counts 404-on-delete as ok and reports other failures with the code", async () => {
      const gone = wired({
        deleteError: apiError("Unknown Message", { status: 404, code: 10008 }),
      });
      assert.deepEqual(await gone.api.deleteRelayMessage(WH, "msg-42"), { ok: true });

      const broken = wired({
        deleteError: apiError("Server exploded", { status: 500, code: 50013 }),
      });
      const res = await broken.api.deleteRelayMessage(WH, "msg-42");
      assert.equal(res.ok, false);
      assert.equal(res.code, "50013");
      assert.ok(!res.error.includes(WH.token));
    });

    it("requires a messageId for patch/delete", async () => {
      const { api } = wired();
      assert.match((await api.patchRelayMessage(WH, null, { content: "x" })).error, /messageId is required/);
      assert.match((await api.deleteRelayMessage(WH, "")).error, /messageId is required/);
    });

    it("deletes the webhook itself (disconnect cleanup); 404 = ok, 500 = { ok:false, error }", async () => {
      const okCase = wired();
      assert.deepEqual(await okCase.api.deleteRelayWebhook(WH), { ok: true });
      assert.equal(okCase.wh.calls.delete, 1);

      const gone = wired({
        deleteWebhookError: apiError("Unknown Webhook", { status: 404, code: 10015 }),
      });
      assert.deepEqual(await gone.api.deleteRelayWebhook(WH), { ok: true });

      const broken = wired({
        deleteWebhookError: apiError("Server exploded", { status: 500, code: 50013 }),
      });
      const res = await broken.api.deleteRelayWebhook(WH);
      assert.equal(res.ok, false);
      assert.match(res.error, /Server exploded/);
      assert.equal(res.code, undefined, "deleteRelayWebhook failures carry no platform code (§10.3)");
      assert.ok(!res.error.includes(WH.token));
    });
  });
});
