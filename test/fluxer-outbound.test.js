/**
 * Unit tests for src/platform/fluxer/outbound.js (PR 6) over the SDK-free
 * fake transport from test/helpers/fluxer.js (Agent A's pinned shape:
 * makeFakeRest routes "METHOD /path" → object | async fn(body, req); every
 * request is recorded in rest.calls; makeFakeHandle wraps createFluxerOutbound).
 *
 * Wire facts are the Phase 0 record (law): JSON send accepts embeds, DM channel
 * create is POST /v1/users/@me/channels (200-idempotent), role permissions are
 * decimal strings, history accepts before/after/limit≤100, elevated actions
 * (K8) refuse with code "elevated_disabled" while the community flag is 0 and
 * NEVER touch the network.
 *
 * Token hygiene: OutboundClient is built from the handle {instanceKey, rest,
 * userId, …} — the handle carries no token (auth lives in client.js), so no
 * error string built here can contain one; tests additionally assert the
 * error shape carries status + API code, per spec line 404.
 */
const { describe, it, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { api: dbApi, cleanup } = loadDb();

const {
  createFluxerOutbound,
} = require("../src/platform/fluxer/outbound");
const { buildFluxerCommandContext } = require("../src/platform/fluxer/context");
const { ensureCommunity } = require("../src/platform/community");
const { makeFakeRest, makeFakeHandle } = require("./helpers/fluxer");

after(cleanup);

const INSTANCE = "https://fluxer.test";
const GUILD = "1554590611015729152";
const COMMUNITY_ID = ensureCommunity({
  platform: "fluxer",
  instanceKey: INSTANCE,
  externalGuildId: GUILD,
});

function setElevatedFlag(communityId, value) {
  dbApi.db
    .prepare("UPDATE communities SET elevated_permissions=? WHERE id=?")
    .run(value, communityId);
}

describe("fluxer/outbound — send shapes", () => {
  it("sendChannel posts JSON {content, embeds, allowed_mentions} and returns {ok, id}", async () => {
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/444/messages": { id: "m-1" } },
    });
    const { outbound } = makeFakeHandle({ rest });

    const res = await outbound.sendChannel("444", {
      content: "hello",
      embeds: [{ title: "T", description: "D" }],
      allowedMentions: { parse: [] },
    });

    assert.deepEqual(res, { ok: true, id: "m-1" });
    assert.equal(rest.calls.length, 1);
    const call = rest.calls[0];
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/v1/channels/444/messages");
    assert.equal(call.body.content, "hello");
    // Embeds are plain objects and pass through 1:1 (no builder classes on Fluxer).
    assert.deepEqual(call.body.embeds, [{ title: "T", description: "D" }]);
    assert.deepEqual(call.body.allowed_mentions, { parse: [] });
    assert.equal(call.body.sensitive, undefined, "K2 vocabulary never reaches the wire");
  });

  it("role pings map 1:1 to allowed_mentions.roles (Phase 0)", async () => {
    const rest = makeFakeRest({ routes: { "POST /v1/channels/7/messages": { id: "m" } } });
    const { outbound } = makeFakeHandle({ rest });
    await outbound.sendChannel("7", { content: "new video", allowedMentions: { roles: ["555"] } });
    assert.deepEqual(rest.calls[0].body.allowed_mentions, { roles: ["555"] });
  });

  it("files send as multipart: payload_json + files[i] parts (Phase 0 PASS shape)", async () => {
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/444/messages": { id: "m-1" } },
    });
    const { outbound } = makeFakeHandle({ rest });

    const res = await outbound.sendChannel("444", {
      content: "see attached",
      files: [{ name: "board.png", data: Buffer.from("PNGBYTES") }],
    });

    assert.deepEqual(res, { ok: true, id: "m-1" });
    assert.equal(rest.calls.length, 1);
    const body = rest.calls[0].body;
    assert.ok(body instanceof FormData, "the file path posts a FormData multipart body");
    const payload = JSON.parse(body.get("payload_json"));
    assert.equal(payload.content, "see attached", "payload_json carries the content part");
    const blob = body.get("files[0]");
    assert.ok(blob instanceof Blob, "file data travels as a Blob (Node 18+ global)");
    assert.equal(await blob.text(), "PNGBYTES", "the bytes ride the file part");
    assert.equal(blob.type, "application/octet-stream", "contentType defaults to octet-stream");
  });

  it("files entries accept contentType and string data (React-style { name, data, contentType? })", async () => {
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/444/messages": { id: "m-1" } },
    });
    const { outbound } = makeFakeHandle({ rest });

    const res = await outbound.sendChannel("444", {
      files: [{ name: "record.md", data: "# staff record", contentType: "text/markdown" }],
    });

    assert.equal(res.ok, true);
    const body = rest.calls[0].body;
    assert.deepEqual(JSON.parse(body.get("payload_json")), {}, "a files-only payload sends no empty content key");
    const blob = body.get("files[0]");
    assert.equal(await blob.text(), "# staff record", "string data is utf8-encoded");
    assert.equal(blob.type, "text/markdown", "contentType passes through to the part");
  });

  it("a bad files entry is refused by index BEFORE any network call", async () => {
    const rest = makeFakeRest({ routes: {} });
    const { outbound } = makeFakeHandle({ rest });

    const noName = await outbound.sendChannel("444", { content: "x", files: [{ name: "", data: Buffer.from("1") }] });
    assert.equal(noName.ok, false);
    assert.match(noName.error, /files\[0\] needs a non-empty string name/);

    const noData = await outbound.sendChannel("444", {
      files: [{ name: "a.bin", data: Buffer.from("ok") }, { name: "b.bin", data: 42 }],
    });
    assert.equal(noData.ok, false);
    assert.match(noData.error, /files\[1\] \("b\.bin"\) needs Buffer data, got number/);

    assert.equal(rest.calls.length, 0, "descriptor validation never reaches the wire");
  });

  it("sendDm delivers files to the DM channel (the /warn export path, matrix 687)", async () => {
    const rest = makeFakeRest({
      routes: {
        "POST /v1/users/@me/channels": { id: "dm-9", type: 1 },
        "POST /v1/channels/dm-9/messages": { id: "m-2" },
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const res = await outbound.sendDm("1234567890123", {
      content: "staff record attached",
      files: [{ name: "staff-record-123.md", data: Buffer.from("# record") }],
    });

    assert.deepEqual(res, { ok: true, id: "m-2" });
    assert.equal(rest.calls[0].path, "/v1/users/@me/channels");
    const dmPost = rest.calls[1];
    assert.equal(dmPost.path, "/v1/channels/dm-9/messages");
    assert.ok(dmPost.body instanceof FormData, "the DM file send is multipart too");
    assert.equal(JSON.parse(dmPost.body.get("payload_json")).content, "staff record attached");
    assert.equal(await dmPost.body.get("files[0]").text(), "# record");
  });

  it("edits refuse files with the named cause (files are a send-path concept)", async () => {
    const rest = makeFakeRest({ routes: {} });
    const { outbound } = makeFakeHandle({ rest });
    const res = await outbound.editMessage(
      { communityId: COMMUNITY_ID, channelId: "444", messageId: "m-1" },
      { content: "edited", files: [{ name: "sneaky.png", data: Buffer.from("x") }] },
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /not PATCH/);
    assert.equal(rest.calls.length, 0, "the refusal does not hit the network");
  });

  it("413 on the message POST surfaces the status and the API code (spec 630)", async () => {
    const rest = makeFakeRest({
      routes: {
        "POST /v1/channels/444/messages": async () => {
          const err = new Error("413 FILE_TOO_BIG: attachment exceeds the instance limit");
          err.status = 413;
          err.code = "FILE_TOO_BIG";
          throw err;
        },
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const res = await outbound.sendChannel("444", { files: [{ name: "big.png", data: Buffer.from("x") }] });

    assert.equal(res.ok, false);
    assert.match(res.error, /413/, "the response status rides in the message");
    assert.match(res.error, /FILE_TOO_BIG/, "the API error code rides in the message");
    assert.equal(res.code, "FILE_TOO_BIG", "the structured code is preserved");
  });

  it("presigned flow (feature flag): plan → PUT bytes with no auth → claim by upload_filename", async () => {
    const rest = makeFakeRest({
      routes: {
        "POST /v1/channels/7/attachments": {
          upload_mode: "singlepart",
          uploads: [{ upload_url: "https://media.test/u/1?grant=SIGNED", upload_filename: "f-1.png" }],
        },
        "POST /v1/channels/7/messages": { id: "m-9" },
      },
    });
    const uploads = [];
    const fetchStub = async (url, init) => {
      uploads.push({ url, init });
      return { ok: true };
    };
    const outbound = createFluxerOutbound(
      { instanceKey: INSTANCE, userId: "bot-1", rest, features: { presignedAttachmentUploads: true } },
      { fetch: fetchStub },
    );

    const res = await outbound.sendChannel("7", {
      content: "png",
      files: [{ name: "a.png", data: Buffer.from("AB"), contentType: "image/png" }],
    });

    assert.deepEqual(res, { ok: true, id: "m-9" });
    // 1. The plan request describes the file for the instance.
    assert.deepEqual(rest.calls[0].body, {
      files: [{ filename: "a.png", content_type: "image/png", file_size: 2 }],
    });
    // 2. PUT the bytes to the signed URL, NO auth header (Phase 0: no auth).
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].url, "https://media.test/u/1?grant=SIGNED");
    assert.equal(uploads[0].init.method, "PUT");
    assert.equal(uploads[0].init.headers["content-type"], "image/png");
    assert.equal(uploads[0].init.headers.authorization, undefined, "the PUT carries no auth header");
    assert.equal(Buffer.from(uploads[0].init.body).toString(), "AB", "raw bytes are PUT");
    // 3. Claim by position with the PLAN-provided filename.
    assert.deepEqual(rest.calls[1].body.attachments, [{ id: 0, upload_filename: "f-1.png" }]);
    assert.equal(rest.calls[1].body.content, "png");
  });

  it("presigned PUT failure (413) fails the send without claiming, naming status (no token in the text)", async () => {
    const rest = makeFakeRest({
      routes: {
        "POST /v1/channels/7/attachments": {
          upload_mode: "singlepart",
          uploads: [{ upload_url: "https://media.test/u/1?grant=SIGNED", upload_filename: "f-1.png" }],
        },
        "POST /v1/channels/7/messages": { id: "never" },
      },
    });
    const outbound = createFluxerOutbound(
      { instanceKey: INSTANCE, userId: "bot-1", rest, features: { presignedAttachmentUploads: true } },
      { fetch: async () => ({ ok: false, status: 413 }) },
    );

    const res = await outbound.sendChannel("7", { files: [{ name: "a.png", data: Buffer.from("x") }] });

    assert.equal(res.ok, false);
    assert.match(res.error, /presigned upload 0/);
    assert.match(res.error, /HTTP 413/);
    assert.ok(!res.error.includes("SIGNED"), "the signed grant never reaches the error text");
    assert.equal(
      rest.calls.some((c) => c.method === "POST" && c.path === "/v1/channels/7/messages"),
      false,
      "a failed upload never claims the attachment",
    );
  });

  it("a chunked presigned plan is refused by name (Phase 0 open item 5)", async () => {
    const rest = makeFakeRest({
      routes: {
        "POST /v1/channels/7/attachments": { upload_mode: "multipart", uploads: [] },
      },
    });
    const outbound = createFluxerOutbound(
      { instanceKey: INSTANCE, userId: "bot-1", rest, features: { presignedAttachmentUploads: true } },
      { fetch: async () => ({ ok: true }) },
    );

    const res = await outbound.sendChannel("7", { files: [{ name: "a.png", data: Buffer.from("x") }] });

    assert.equal(res.ok, false);
    assert.match(res.error, /upload_mode "multipart"/);
  });

  it("a plan whose upload count mismatches the files is refused (no partial claim)", async () => {
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/7/attachments": { upload_mode: "singlepart", uploads: [] } },
    });
    const outbound = createFluxerOutbound(
      { instanceKey: INSTANCE, userId: "bot-1", rest, features: { presignedAttachmentUploads: true } },
      { fetch: async () => ({ ok: true }) },
    );

    const res = await outbound.sendChannel("7", {
      files: [{ name: "a.png", data: Buffer.from("x") }, { name: "b.png", data: Buffer.from("y") }],
    });

    assert.equal(res.ok, false);
    assert.match(res.error, /refusing to claim a partial attachment set/);
  });

  it("sendDm opens the DM channel FIRST, then posts to it", async () => {
    const rest = makeFakeRest({
      routes: {
        "POST /v1/users/@me/channels": { id: "dm-9", type: 1 },
        "POST /v1/channels/dm-9/messages": { id: "m-2" },
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const res = await outbound.sendDm("1234567890123", { content: "psst" });

    assert.deepEqual(res, { ok: true, id: "m-2" });
    assert.equal(rest.calls.length, 2);
    assert.equal(rest.calls[0].method, "POST");
    assert.equal(rest.calls[0].path, "/v1/users/@me/channels");
    assert.deepEqual(rest.calls[0].body, { recipient_id: "1234567890123" });
    assert.equal(rest.calls[1].path, "/v1/channels/dm-9/messages");
    assert.equal(rest.calls[1].body.content, "psst");
  });

  it("sendDm with no channel id back is a specific failure", async () => {
    const rest = makeFakeRest({ routes: { "POST /v1/users/@me/channels": {} } });
    const { outbound } = makeFakeHandle({ rest });
    const res = await outbound.sendDm("u1", { content: "x" });
    assert.equal(res.ok, false);
    assert.match(res.error, /no channel id/);
  });

  it("K2: a failing DM falls back to the channel with the ERROR ONLY — never the sensitive body", async () => {
    const SECRET = "TOP SECRET NOTE BODY about user 1234567890123";
    const rest = makeFakeRest({
      routes: {
        "POST /v1/users/@me/channels": { id: "dm-99" },
        "POST /v1/channels/dm-99/messages": async () => {
          const err = new Error("400 CANNOT_SEND_TO_USER: cannot message user");
          err.status = 400;
          err.code = "CANNOT_SEND_TO_USER";
          throw err;
        },
        "POST /v1/channels/444555666/messages": { id: "m-77" },
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const ctx = buildFluxerCommandContext(
      {
        commandName: "xp",
        subcommandGroup: null,
        subcommand: null,
        options: [],
        help: null,
        usageError: null,
      },
      {
        platform: "fluxer",
        instanceKey: INSTANCE,
        communityId: COMMUNITY_ID,
        externalGuildId: GUILD,
        channelId: "444555666",
        authorId: "1234567890123",
        authorBot: false,
        authorRaw: { id: "1234567890123", username: "sparky", bot: false },
        memberRoleIds: [],
      },
      { outbound },
    );

    const orig = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(" "));
    try {
      await ctx.reply({ content: SECRET, sensitive: true });
    } finally {
      console.error = orig;
    }

    // 1. DM attempted first.
    assert.equal(rest.calls[0].path, "/v1/users/@me/channels");
    // 2. The channel fallback was sent.
    const fallback = rest.calls.find((c) => c.path === "/v1/channels/444555666/messages");
    assert.ok(fallback, "expected a channel fallback POST");
    assert.match(fallback.body.content, /I could not DM you the result:/);
    assert.match(fallback.body.content, /CANNOT_SEND_TO_USER/, "the fallback carries the SPECIFIC error");
    // 3. THE LEAK TEST: the sensitive body is absent from every channel payload.
    const channelPayloads = JSON.stringify(
      rest.calls.filter((c) => c.path === "/v1/channels/444555666/messages"),
    );
    assert.ok(
      !channelPayloads.includes("TOP SECRET NOTE BODY"),
      "K2: the channel payload must not contain the sensitive body",
    );
    // 4. The failure is logged with the cause.
    assert.equal(
      logged.some((l) => l.includes("[fluxer] DM to 1234567890123 failed:") && l.includes("CANNOT_SEND_TO_USER")),
      true,
    );
    assert.equal(ctx.replied, true, "every reply attempt marks the context replied");
  });
});

describe("fluxer/outbound — fetch mappers", () => {
  it("fetchRoles returns RoleHandle[] with permissions as DECIMAL STRINGS", async () => {
    const rest = makeFakeRest({
      routes: {
        "GET /v1/guilds/99887766/roles": [
          { id: "99887766", name: "@everyone", position: 0, permissions: "18014536052624961" },
          { id: "42", name: "Staff", position: 3, permissions: 8 },
        ],
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const cid = ensureCommunity({ platform: "fluxer", instanceKey: INSTANCE, externalGuildId: "99887766" });

    const roles = await outbound.fetchRoles(cid);
    assert.deepEqual(roles, [
      { id: "99887766", name: "@everyone", position: 0, permissions: "18014536052624961" },
      { id: "42", name: "Staff", position: 3, permissions: "8" },
    ]);
    for (const role of roles) {
      assert.equal(typeof role.permissions, "string");
    }
  });

  it("fetchMember maps the Phase 0 member fields (user nested, roles id array)", async () => {
    const rest = makeFakeRest({
      routes: {
        "GET /v1/guilds/G1/members/u-1": {
          user: { id: "u-1", username: "sparky", bot: false },
          roles: ["r1", "r2"],
          nick: "spork",
        },
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const cid = ensureCommunity({ platform: "fluxer", instanceKey: INSTANCE, externalGuildId: "G1" });

    const member = await outbound.fetchMember(cid, "u-1");
    assert.deepEqual(member, {
      id: "u-1",
      username: "sparky",
      bot: false,
      roleIds: ["r1", "r2"],
    });
  });

  it("fetchChannel exposes id, numeric type, and permissionOverwrites", async () => {
    const rest = makeFakeRest({
      routes: {
        "GET /v1/channels/c-9": {
          id: "c-9",
          type: 0,
          permission_overwrites: [{ id: "g1", type: 0, allow: "1024", deny: "0" }],
        },
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const ch = await outbound.fetchChannel(COMMUNITY_ID, "c-9");
    assert.equal(ch.id, "c-9");
    assert.equal(ch.type, 0);
    assert.deepEqual(ch.permissionOverwrites, [
      { id: "g1", type: 0, allow: "1024", deny: "0" },
    ]);
  });

  it("fetchUser → {id, username, bot}", async () => {
    const rest = makeFakeRest({
      routes: { "GET /v1/users/u-5": { id: "u-5", username: "bob", bot: true } },
    });
    const { outbound } = makeFakeHandle({ rest });
    const user = await outbound.fetchUser(COMMUNITY_ID, "u-5");
    assert.deepEqual(user, { id: "u-5", username: "bob", bot: true });
  });

  it("fetchMessages maps id/authorId/authorBot/content/createdAt and passes the query", async () => {
    const rest = makeFakeRest({
      routes: {
        "GET /v1/channels/444/messages": [
          { id: "3", author: { id: "u1", bot: true }, content: "a", timestamp: "2026-09-29T00:00:00.000Z" },
          { id: "2", author: { id: "u2" }, content: "b", timestamp: "2026-09-28T00:00:00.000Z" },
        ],
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const res = await outbound.fetchMessages("444", { limit: 100, before: "3", after: "1" });
    assert.equal(res.ok, true);
    assert.deepEqual(rest.calls[0].query, { limit: 100, before: "3", after: "1" });
    assert.deepEqual(res.messages, [
      { id: "3", authorId: "u1", authorBot: true, content: "a", createdAt: "2026-09-29T00:00:00.000Z" },
      { id: "2", authorId: "u2", authorBot: false, content: "b", createdAt: "2026-09-28T00:00:00.000Z" },
    ]);
  });

  it("a 429 transport error becomes {ok:false} naming status and API code", async () => {
    const rest = makeFakeRest({
      routes: {
        "GET /v1/channels/444/messages": async () => {
          const err = new Error("429 RATE_LIMITED: slow down");
          err.status = 429;
          err.code = "RATE_LIMITED";
          throw err;
        },
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const res = await outbound.fetchMessages("444", { limit: 100 });
    assert.equal(res.ok, false);
    assert.match(res.error, /429/);
    assert.match(res.error, /RATE_LIMITED/);
    assert.equal(res.code, "RATE_LIMITED");
    // Auth hygiene: the handle carries no token at all — the OutboundClient
    // physically cannot leak one (auth headers live inside the transport).
    assert.ok(!/Authorization|token/i.test(res.error.replace(/RATE_LIMITED/g, "")));
  });

  it("fetch failures resolve null/[] and log, never throw", async () => {
    const rest = makeFakeRest({ routes: {} }); // everything 404 FAKE_NO_ROUTE
    const { outbound } = makeFakeHandle({ rest });
    const orig = console.error;
    console.error = () => {};
    try {
      assert.equal(await outbound.fetchUser(COMMUNITY_ID, "ghost"), null);
      assert.deepEqual(await outbound.fetchRoles(COMMUNITY_ID), []);
      assert.equal(await outbound.fetchChannel(COMMUNITY_ID, "ghost"), null);
    } finally {
      console.error = orig;
    }
  });
});

describe("fluxer/outbound — elevated gate (K8)", () => {
  let cid;
  beforeEach(async () => {
    cid = ensureCommunity({
      platform: "fluxer",
      instanceKey: INSTANCE,
      externalGuildId: "elevated-guild-1",
    });
    setElevatedFlag(cid, 0);
  });

  it("with elevated_permissions=0 the five elevated methods refuse WITHOUT touching the network", async () => {
    const rest = makeFakeRest({
      routes: {
        // setOverwrites(channelId, …) has no communityId argument (spec
        // OutboundClient typedef), so the adapter reads the channel to find
        // its owning community. Reads are fine; the assertion pins that no
        // WRITE verbs hit the network while the flag is 0.
        "GET /v1/channels/chan-1": { id: "chan-1", guild_id: "elevated-guild-1" },
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const results = await Promise.all([
      outbound.addRole(cid, "u1", "r1"),
      outbound.removeRole(cid, "u1", "r1"),
      outbound.banMember(cid, "u1", "honeypot"),
      outbound.createChannel({ communityId: cid, name: "ticket-1", parentId: null, type: 0, overwrites: [] }),
      outbound.setOverwrites("chan-1", [{ id: "r1", kind: "role", allow: "1024", deny: "0" }]),
    ]);

    for (const res of results) {
      assert.equal(res.ok, false);
      assert.equal(res.code, "elevated_disabled");
      assert.match(res.error, /elevated_permissions=0/);
      assert.ok(!/token|Authorization/i.test(res.error), "no credential material in the error");
    }
    // setOverwrites resolves ownership via GET channel (read); no WRITE verbs ran.
    assert.equal(rest.calls.filter((c) => c.method === "POST" || c.method === "PUT" || c.method === "PATCH").length, 0);
    assert.equal(rest.calls.filter((c) => c.method === "DELETE").length, 0);
  });

  it("with the flag set to 1, addRole PUTs the Phase 0 role endpoint", async () => {
    setElevatedFlag(cid, 1);
    const rest = makeFakeRest({
      routes: { "PUT /v1/guilds/elevated-guild-1/members/u1/roles/r1": null },
    });
    const { outbound } = makeFakeHandle({ rest });
    const res = await outbound.addRole(cid, "u1", "r1");
    assert.deepEqual(res, { ok: true });
    assert.equal(rest.calls[0].method, "PUT");
    assert.equal(rest.calls[0].path, "/v1/guilds/elevated-guild-1/members/u1/roles/r1");
    setElevatedFlag(cid, 0);
  });

  it("reactions are NOT elevated in PR 6 and encode the emoji key", async () => {
    const rest = makeFakeRest({
      routes: {
        "PUT /v1/channels/444/messages/m-1/reactions/%F0%9F%91%8D/@me": null,
        "DELETE /v1/channels/444/messages/m-1/reactions/%F0%9F%91%8D/@me": {},
        "DELETE /v1/channels/444/messages/m-1/reactions/%F0%9F%91%8D": {},
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    assert.deepEqual(await outbound.addReaction("444", "m-1", "👍"), { ok: true });
    assert.equal(rest.calls[0].method, "PUT");
    assert.equal(
      rest.calls[0].path,
      "/v1/channels/444/messages/m-1/reactions/%F0%9F%91%8D/@me",
      "emojiKey is URI-encoded on the wire (Phase 0: %F0%9F%91%8D)",
    );

    assert.deepEqual(await outbound.removeUserReaction("444", "m-1", "👍", "bot-1"), { ok: true }, "the bot itself maps to @me");
    assert.equal(rest.calls[1].path, "/v1/channels/444/messages/m-1/reactions/%F0%9F%91%8D/@me");

    assert.deepEqual(await outbound.removeEmojiReaction("444", "m-1", "👍"), { ok: true });
    assert.equal(rest.calls[2].path, "/v1/channels/444/messages/m-1/reactions/%F0%9F%91%8D");
  });
});

describe("fluxer/outbound — identity + edit", () => {
  it("platform/instanceKey/botUserId come from the handle", () => {
    const rest = makeFakeRest({ routes: {} });
    const { outbound } = makeFakeHandle({ rest, userId: "bot-9" });
    assert.equal(outbound.platform, "fluxer");
    assert.equal(outbound.instanceKey, "https://fluxer.test");
    assert.equal(outbound.botUserId, "bot-9");
  });

  it("editMessage PATCHes the Phase 0 message endpoint", async () => {
    const rest = makeFakeRest({
      routes: { "PATCH /v1/channels/444/messages/m-1": { id: "m-1", edited_timestamp: "now" } },
    });
    const { outbound } = makeFakeHandle({ rest });
    const res = await outbound.editMessage(
      { communityId: COMMUNITY_ID, channelId: "444", messageId: "m-1" },
      { content: "updated" },
    );
    assert.deepEqual(res, { ok: true });
    assert.equal(rest.calls[0].method, "PATCH");
    assert.deepEqual(rest.calls[0].body, { content: "updated" });
  });

  it("a string payload shorthand becomes {content}", async () => {
    const rest = makeFakeRest({ routes: { "POST /v1/channels/444/messages": { id: "m" } } });
    const { outbound } = makeFakeHandle({ rest });
    await outbound.sendChannel("444", "plain text reply");
    assert.deepEqual(rest.calls[0].body, { content: "plain text reply" });
  });
});

describe("fluxer/outbound — AttachmentBuilder-shaped file entries", () => {
  it("sendChannel accepts { name, attachment } (discord.js AttachmentBuilder shape)", async () => {
    // Regression (prod 2026-10-01): handleLeaderboard renders a PNG via
    // @napi-rs/canvas into a discord.js AttachmentBuilder, which stores bytes
    // on `.attachment`, not `.data`. sendChannel rejected the entry
    // ("needs Buffer data, got undefined") and EVERY data-carrying
    // !leaderboard reply was silently dropped. The renderer passes the
    // builder through the reply payload untouched.
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/444/messages": { id: "m-lb" } },
    });
    const { outbound } = makeFakeHandle({ rest });
    const png = Buffer.from("fake-png-bytes");

    const res = await outbound.sendChannel("444", {
      content: "**Leaderboard — ranks 1–2**",
      files: [{ name: "boiler-snake-leaderboard.png", attachment: png }],
    });

    assert.equal(res.ok, true, res.error);
    const post = rest.calls.find((c) => c.method === "POST" && c.path === "/v1/channels/444/messages");
    assert.ok(post, "expected the multipart message POST");
    // No presigned flag on the fake handle → multipart (Phase 0 flow).
    assert.ok(post.body instanceof globalThis.FormData, "expected a FormData multipart body");
    const payload = JSON.parse(post.body.get("payload_json"));
    assert.equal(payload.content, "**Leaderboard — ranks 1–2**");
  });

  it("string attachment payloads still normalize (warning exports)", async () => {
    const rest = makeFakeRest({
      routes: { "POST /v1/channels/444/messages": { id: "m2" } },
    });
    const { outbound } = makeFakeHandle({ rest });
    const res = await outbound.sendChannel("444", {
      files: [{ name: "notes.md", attachment: "# export" }],
    });
    assert.equal(res.ok, true, res.error);
  });
});
