/**
 * Issue #200 (audit §6 P2, highest leverage): SDK-SHAPED contract tests
 * against real SDK model instances (loaded ONLY through the guarded
 * loadFluxerSdk site — the package name never appears in this file).
 *
 * The pre-#200 suite verified a MODEL OF THE PLATFORMS: every Fluxer fixture
 * hand-built wire shapes, so C1/C2 (and the avatar/embed gaps) hid behind
 * green tests — "the mocks are the specification, and the specification is
 * wrong" (audit §1). These tests feed normalize.js the EXACT objects the
 * production gateway emits, built from the real SDK classes, so a model
 * rename under us fails the suite instead of shipping silent emptiness.
 *
 * What the gateway actually emits (read from the SDK dist, not the fixtures —
 * line refs into the pinned SDK build 3.1.0 bundle):
 *   MESSAGE_CREATE      → new Message(client, d) (+ indexMember when the
 *                         guild is cached: message.member is a GETTER reading
 *                         guild.members.get(author.id) — NOT the raw d.member)
 *   MESSAGE_UPDATE      → (oldMessage|null, new Message(client, merged))
 *   MESSAGE_DELETE      → new PartialMessage(...) (camelCase identity, no author gate)
 *   MESSAGE_REACTION_*  → {reaction: MessageReaction, user: User, message,
 *                         channel, member: GuildMember|null, messageId,
 *                         channelId, emoji, userId} — NO top-level guildId;
 *                         the guild rides on reaction.guildId.
 *
 * Client-stub policy (issue #183 pattern, EXTENDED): the real Client is
 * constructed directly (its constructor is offline-safe). Fidelity: the SDK
 * code paths that EXECUTE here are the Client constructor (cache limits,
 * managers, REST *configuration* — no sockets), getOrCreateUser (real User
 * upsert into the real UserManager cache), and the real Guild / GuildMember /
 * GuildMemberRoleManager / Message / MessageReaction / PartialMessage /
 * MessageSticker constructors plus the real SDK collection package (Collection).
 * NOT executed: login, WebSocket I/O, REST traffic, and the SDK's internal
 * gateway-dispatch registry (not exported) — its two handlers that matter
 * here (MESSAGE_CREATE's member indexing, emitReaction's payload
 * composition) are replicated verbatim in the helpers below and cited to
 * their dist lines. The #183 minimal-stub file
 * (fluxer-normalize-sdk-member.test.js) stays as the narrow fallback proof;
 * this file runs the real-Client end of the seam.
 *
 * The SDK models are loaded through src/platform/fluxer/client.js's single
 * guarded load site (loadFluxerSdk): this file NEVER references the package
 * name (enforced by fluxer-sdk-import-guard.test.js), and when the package
 * is not installed the loader resolves to null and the SDK tests SKIP —
 * keeping `npm test` green without the SDK (roadmap/fluxer.md § Tests).
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
// client.js pulls in src/bot/pipelines (→ features → db), so it needs it.
const { cleanup } = loadDb();

const {
  normalizeFluxerMessage,
  normalizeFluxerReaction,
  normalizeFluxerMessageDelete,
} = require("../src/platform/fluxer/normalize");
const { assertNormalizedMessage } = require("../src/platform/normalizedMessageContract");
const { loadFluxerSdk } = require("../src/platform/fluxer/client");

after(cleanup);

// Kicked off at module scope; awaited inside the SDK tests (no top-level
// await in CJS). null = package absent → those tests skip.
const sdkPromise = loadFluxerSdk("unit-test/sdk-contract");

/**
 * Await the real SDK module through the guarded load site and verify the
 * FULL model surface these tests need.
 * @returns {Promise<object|null>} null ONLY when the package is not
 *   installed (guarded loader resolved null → tests skip); a resolved SDK
 *   missing any required export throws with the specific cause instead of
 *   skipping silently — a renamed export IS the drift this suite hunts.
 */
async function sdkModels() {
  const mod = await sdkPromise;
  if (!mod) return null;
  // CJS interop belt: named exports first (prod client.js reads them
  // directly), default-namespace fallback.
  const ns = typeof mod.Client === "function" ? mod : mod?.default;
  if (!ns) {
    throw new Error(
      "SDK loaded but exposes no Client export — SDK surface changed; update the issue #200 contract tests",
    );
  }
  const required = [
    "Client",
    "Guild",
    "GuildMember",
    "GuildMemberRoleManager",
    "Message",
    "MessageReaction",
    "PartialMessage",
    "User",
  ];
  const missing = required.filter((name) => typeof ns[name] !== "function");
  if (missing.length > 0) {
    throw new Error(
      `SDK surface changed: exports missing (${missing.join(", ")}) — update the issue #200 contract tests`,
    );
  }
  if (!ns.Events || typeof ns.Events !== "object") {
    throw new Error(
      "SDK surface changed: the Events enum object is gone — update the issue #200 contract tests",
    );
  }
  return ns;
}

const GUILD_ID = "1554590611015729152";
const CHANNEL_ID = "1554600000000000002";
const MSG_ID = "1554600000000000001";
const USER_ID = "1554600000000000003";
const MENTION_ID = "1554600000000000009";
const ROLE_STAFF = "1554600000000000010";
const ROLE_SENIOR = "1554600000000000012";
const TS_ISO = "2026-10-11T12:00:00.000Z";

/** Wire `author` object (snake_case, as the gateway sends it). */
function wireUser(over = {}) {
  return {
    id: USER_ID,
    username: "talker",
    discriminator: "0001",
    global_name: "Talker G",
    avatar: "a HASH",
    avatar_color: null,
    flags: 0,
    bot: false,
    ...over,
  };
}

/** Wire member object as the MESSAGE_CREATE `d.member` field carries it. */
function wireMember(over = {}) {
  return {
    roles: [ROLE_STAFF, ROLE_SENIOR],
    joined_at: TS_ISO,
    nick: "T!",
    avatar: null,
    ...over,
  };
}

/**
 * Raw MESSAGE_CREATE `d` in full gateway wire shape (snake_case) with real
 * content in every arm normalize reads.
 */
function wireMessageCreate(over = {}) {
  return {
    id: MSG_ID,
    channel_id: CHANNEL_ID,
    guild_id: GUILD_ID,
    author: wireUser(),
    content: "hello <@1554600000000000009>",
    timestamp: TS_ISO,
    edited_timestamp: null,
    pinned: false,
    tts: false,
    attachments: [
      {
        id: "att-1",
        filename: "shot.png",
        content_type: "image/png",
        size: 4242,
        url: "https://media.test/shot.png",
        flags: 8,
      },
    ],
    embeds: [
      {
        title: "Title",
        description: "Desc",
        url: "https://e.test",
        color: 16711680,
        fields: [{ name: "f", value: "v", inline: true }],
      },
    ],
    mentions: [wireUser({ id: MENTION_ID, username: "mentioned", bot: false })],
    mention_roles: [ROLE_SENIOR],
    mention_channels: [],
    mention_everyone: false,
    stickers: [{ id: "stk-1", name: "CoolSticker", description: null, tags: "" }],
    // Snapshot wire shape per the SDK's toMessageSnapshot view: content/
    // timestamp at the TOP level of the snapshot entry (not nested under
    // `message`):
    message_snapshots: [{ content: "forwarded", timestamp: TS_ISO }],
    type: 0,
    flags: 16,
    webhook_id: null,
    member: wireMember(),
    nonce: null,
    ...over,
  };
}

/**
 * REAL, offline client: `new Client()` performs cache-limit resolution, the
 * managers, and REST *configuration* only — no socket, no login, no request
 * ever leaves this object (verified: the constructor opens no handles and
 * these tests never call rest/login/fromDiscovery).
 */
function makeRealClient(sdk) {
  return new sdk.Client({ logLevel: "error" });
}

/** Real Guild, cached the way GUILD_CREATE caches it (client.guilds.set). */
function seedRealGuild(sdk, client, guildId = GUILD_ID) {
  const guild = new sdk.Guild(client, { id: guildId, name: "Contract Guild", member_count: 2 });
  client.guilds.set(guild.id, guild);
  return guild;
}

/**
 * Build a real GuildMember the way the gateway handlers do: indexMember →
 * cacheMember (dist: `new GuildMember(guild.client, {...data, guild_id},
 * guild); guild.members.set(member.id, member)`).
 */
function indexRealMember(sdk, client, guild, memberWire) {
  if (!memberWire?.user?.id) return null;
  const member = new sdk.GuildMember(client, { ...memberWire, guild_id: guild.id }, guild);
  guild.members.set(member.id, member);
  return member;
}

/**
 * Produce the EXACT MESSAGE_CREATE event payload: the handler (dist
 * messageHandlers.MESSAGE_CREATE) indexes `{...d.member, user: d.author}`
 * into the cached guild and emits `new Message(client, d)`.
 */
function hydrateMessageCreate(sdk, client, wireD) {
  if (wireD.guild_id && wireD.member && wireD.author) {
    const guild = client.guilds.get(wireD.guild_id);
    if (guild) {
      indexRealMember(sdk, client, guild, { ...wireD.member, user: wireD.author });
    }
  }
  return new sdk.Message(client, wireD);
}

/**
 * Produce the EXACT reaction payload: emitReaction (dist) builds a real
 * MessageReaction from the raw wire object, indexes `data.member` WITHOUT the
 * author merge (so a member without user.id yields member: null), resolves
 * the user, and emits the FLAT camelCase payload {reaction, user, message,
 * channel, member, messageId, channelId, emoji, userId} — note there is NO
 * top-level guildId; the guild rides on reaction.guildId.
 */
function buildReactionEmit(sdk, client, wireD) {
  const reaction = new sdk.MessageReaction(client, wireD);
  const guild = wireD.guild_id ? client.guilds.get(wireD.guild_id) : undefined;
  const member = guild && wireD.member ? indexRealMember(sdk, client, guild, wireD.member) : null;
  const user =
    member?.user ??
    client.users.get(wireD.user_id) ??
    client.getOrCreateUser({
      id: wireD.user_id,
      username: "Unknown",
      discriminator: "0",
      global_name: null,
      avatar: null,
      avatar_color: null,
      flags: 0,
    });
  return {
    reaction,
    user,
    message: null, // uncached in these tests (client._getMessageCache hit only)
    channel: null,
    member,
    messageId: wireD.message_id,
    channelId: wireD.channel_id,
    emoji: {
      name: wireD.emoji.name,
      ...("id" in wireD.emoji ? { id: wireD.emoji.id } : {}),
      ...("animated" in wireD.emoji ? { animated: wireD.emoji.animated } : {}),
    },
    userId: wireD.user_id,
  };
}

// ---------------------------------------------------------------------------
// 1. Real hydrated Message → normalizeFluxerMessage, field by field
// ---------------------------------------------------------------------------

describe("platform/fluxer/normalize — real SDK Message contract (issue #200)", () => {
  it("normalizes the exact MESSAGE_CREATE instance field by field and passes the #201 validator", async (t) => {
    const sdk = await sdkModels();
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");

    const client = makeRealClient(sdk);
    seedRealGuild(sdk, client);
    const message = hydrateMessageCreate(sdk, client, wireMessageCreate());
    assert.ok(message instanceof sdk.Message, "the gateway emits the hydrated Message instance");

    // Genuinely SDK-shaped, not a lookalike:
    assert.ok(message.author instanceof sdk.User, "author is the REAL User from the client cache");
    assert.ok(message.attachments instanceof Map, "attachments ride as the SDK Collection");

    const out = normalizeFluxerMessage(message, { instanceKey: "https://fluxer.test" });
    assert.ok(out, "expected a normalized message");

    // Identity triple + platform tags.
    assert.equal(out.platform, "fluxer");
    assert.equal(out.instanceKey, "https://fluxer.test");
    assert.equal(out.communityId, null, "contract 4: the pipeline fills communityId");
    assert.equal(out.externalGuildId, GUILD_ID, "camelCase guildId read (no guild_id on the instance)");
    assert.equal(out.id, MSG_ID);
    assert.equal(out.channelId, CHANNEL_ID);

    // Author: the instance carries a REAL User, not the raw wire object.
    assert.equal(out.authorId, USER_ID);
    assert.equal(out.authorBot, false);
    assert.equal(
      out.authorDisplayName,
      "Talker G",
      "display name comes from the User's camelCase globalName (wire global_name does NOT exist on the instance)",
    );
    assert.equal(out.authorRaw, message.author, "authorRaw IS the real User instance (identity)");
    // AVATARS — the audit named this a hidden gap: pin what the real author
    // instance exposes for the surfaces that read it.
    assert.equal(out.authorRaw.avatar, "a HASH", "avatar hash rides on the instance as `avatar`");
    assert.equal(out.authorRaw.avatarColor, null);
    assert.equal(out.authorRaw.username, "talker");
    assert.equal(typeof out.authorRaw.avatarURL, "function", "avatarURL() is a METHOD on the instance — never a string field");
    assert.equal(typeof out.authorRaw.displayAvatarURL, "function");
    assert.equal(String(out.authorRaw), `<@${USER_ID}>`, "User.toString() is the mention string");

    // Timestamps: the instance has NO `timestamp` field — normalize must fall
    // through to `createdAt` (a real Date).
    assert.equal(message.timestamp, undefined, "the instance exposes createdAt, not timestamp");
    assert.ok(out.createdAt instanceof Date);
    assert.equal(out.createdAt.getTime(), Date.parse(TS_ISO));

    // Mentions: USER INSTANCES → ids + the id→bot map + raw objects for dispatch.
    assert.deepEqual(out.mentions.users, [MENTION_ID]);
    assert.equal(out.mentionBots.get(MENTION_ID), false);
    assert.equal(out.mentionUsersRaw.length, 1);
    assert.equal(out.mentionUsersRaw[0].username, "mentioned");
    assert.deepEqual(out.mentions.roles, [ROLE_SENIOR], "mentionRoles stays a plain id array on the instance");
    // SDK limitation pinned (issue #200 finding): the hydrated Message does
    // NOT surface mention_channels at all, so channel mentions arrive with
    // empty ids/types on the guild pipeline. Nothing may pretend otherwise.
    assert.equal(message.mentionChannels, undefined);
    assert.deepEqual(out.mentions.channels, []);
    assert.equal(out.channelTypes.size, 0);

    // Attachments Collection → the relay shape (audit: attachment mapping
    // reads camelCase contentType on the SDK view — pinned here).
    assert.deepEqual(out.attachments, [
      {
        name: "shot.png",
        url: "https://media.test/shot.png",
        id: "att-1",
        size: 4242,
        contentType: "image/png",
        flags: 8,
      },
    ]);

    // Embeds + message flags (issue #200 passthroughs): the instance carries
    // the SDK camelCase embed VIEW (toMessageEmbed) and a bigint-backed
    // MessageFlagsBitField.
    assert.equal(out.embeds.length, 1);
    assert.equal(out.embeds[0].title, "Title");
    assert.equal(out.embeds[0].fields[0].name, "f");
    assert.equal(out.embeds[0].type, "rich", "the SDK view adds its camelCase defaults — passed through verbatim");
    assert.equal(out.flags, 16, "MessageFlagsBitField unwrapped to a number (relay CONTAINS_EXPLICIT_MEDIA reads it)");

    // Stickers: MessageSticker instances → plain {id,name}.
    assert.equal(message.stickers[0].constructor.name, "MessageSticker");
    assert.deepEqual(out.stickers, [{ id: "stk-1", name: "CoolSticker" }]);

    // Snapshots: the SDK hydrates each snapshot entry (toMessageSnapshot);
    // normalize forwards the hydrated view VERBATIM (forwards ride the relay §10.5).
    assert.equal(out.messageSnapshots.length, 1);
    assert.equal(out.messageSnapshots[0], message.messageSnapshots[0], "hydrated entries forwarded by reference");
    assert.equal(out.messageSnapshots[0].content, "forwarded");
    assert.equal(out.webhookId, null);
    assert.equal(out.type, 0);
    assert.equal(out.parsePrefix, null);

    // Member: the instance has NO stored member — `.member` is a GETTER
    // reading the cached guild, returning a REAL GuildMember whose `roles`
    // is the ROLE MANAGER (audit C2).
    assert.ok(message.member instanceof sdk.GuildMember);
    assert.ok(message.member.roles instanceof sdk.GuildMemberRoleManager);
    assert.deepEqual(out.memberRoleIds, [ROLE_STAFF, ROLE_SENIOR], "ids come from the manager's roleIds getter");
    assert.equal(out.memberRaw, message.member, "memberRaw IS the real GuildMember (identity)");

    // And the WHOLE output must satisfy the #201 pipeline-boundary contract.
    assertNormalizedMessage(out, { boundary: "onMessageCreate (issue #200 SDK shape)" });
  });

  it("yields memberRoleIds [] for the cold-cache case the gateway really hits (member getter → null)", async (t) => {
    const sdk = await sdkModels();
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");

    // NO guild seeded: message.member (the getter) resolves to null exactly
    // like a gateway message that races GUILD_CREATE — the member must be
    // resolved from REST/cache by consumers, normalize invents nothing.
    const client = makeRealClient(sdk);
    const message = hydrateMessageCreate(sdk, client, wireMessageCreate());
    assert.equal(message.member, null);

    const out = normalizeFluxerMessage(message, { instanceKey: "https://fluxer.test" });
    assert.ok(out, "a guild-cold message still normalizes");
    assert.deepEqual(out.memberRoleIds, []);
    assert.equal(out.memberRaw, null);
    assertNormalizedMessage(out, { boundary: "onMessageCreate (issue #200 cold-cache shape)" });
  });

  it("keeps the wire payload path alive (member.roles array) beside the instance path", async (t) => {
    const sdk = await sdkModels();
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");

    // Same raw wire d, BOTH shapes of the seam: the gateway instance AND the
    // raw payload (Phase-0 law) must agree on every field normalize promises.
    const client = makeRealClient(sdk);
    seedRealGuild(sdk, client);
    const d = wireMessageCreate();
    const fromInstance = normalizeFluxerMessage(hydrateMessageCreate(sdk, client, d), {
      instanceKey: "https://fluxer.test",
    });
    const fromWire = normalizeFluxerMessage({ t: "MESSAGE_CREATE", d }, {
      instanceKey: "https://fluxer.test",
    });
    for (const field of [
      "id", "channelId", "externalGuildId", "authorId", "authorBot",
      "content", "memberRoleIds", "flags", "type",
    ]) {
      assert.deepEqual(fromInstance[field], fromWire[field], `instance and wire disagree on ${field}`);
    }
    assert.equal(fromInstance.authorDisplayName, fromWire.authorDisplayName);
    assert.deepEqual(fromInstance.attachments, fromWire.attachments);
    assert.equal(fromInstance.createdAt.getTime(), fromWire.createdAt.getTime());
    assertNormalizedMessage(fromWire, { boundary: "onMessageCreate (issue #200 wire cross-shape)" });
  });
});

// ---------------------------------------------------------------------------
// 2. Voice: the SDK ships NO voice model — the repo's voice path consumes the
//    communities-row readiness flag, never a hydrated instance.
// ---------------------------------------------------------------------------

describe("platform/fluxer — voice-state readiness contract (issue #200)", () => {
  it("pins the SDK's voice surface: NO VoiceState model, wire passthrough only", async (t) => {
    const sdk = await sdkModels();
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");

    // The pinned SDK build (3.1.0) passes VOICE_STATE_UPDATE through as the raw wire
    // object and VoiceStatesSync carries the raw `voice_states` array: there
    // is no model class to construct. If a future SDK ships one, THIS fails
    // — deliberately: the voice XP path (src/features/voice/index.js) must
    // then be re-decided against the real model, not quietly start guessing.
    assert.equal(
      sdk.VoiceState,
      undefined,
      "the SDK started exporting a VoiceState model — revisit the Fluxer voice-readiness decision (voice_states_complete) before trusting it",
    );
    assert.equal(sdk.Events.VoiceStateUpdate, "voiceStateUpdate");
    assert.equal(sdk.Events.VoiceStatesSync, "voiceStatesSync");
  });

  it("the readiness gate the repo actually consumes: communities.voice_states_complete is 0", () => {
    // The real row a Fluxer community gets: the voice tick awards ONLY when
    // the flag is 1, so a gateway voice payload can never earn XP from a
    // guessed shape (src/features/voice/index.js).
    const { ensureCommunity, getCommunityById } = require("../src/platform/community");
    const id = ensureCommunity({
      platform: "fluxer",
      instanceKey: "https://voice-contract.test",
      externalGuildId: "1554590611015729999",
    });
    const row = getCommunityById(id);
    assert.equal(row.platform, "fluxer");
    assert.equal(Number(row.voiceStatesComplete), 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Reaction payloads per the SDK's emit shape
// ---------------------------------------------------------------------------

describe("platform/fluxer/normalize — real SDK reaction emit (issue #200)", () => {
  it("normalizes the exact emitReaction payload (flat camel ids, guild ONLY on reaction.guildId)", async (t) => {
    const sdk = await sdkModels();
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");

    const client = makeRealClient(sdk);
    const guild = seedRealGuild(sdk, client);
    const wire = {
      user_id: USER_ID,
      channel_id: CHANNEL_ID,
      message_id: MSG_ID,
      guild_id: GUILD_ID,
      emoji: { name: "party", id: "1554600000000000077", animated: true },
      member: { user: wireUser(), roles: [ROLE_STAFF], joined_at: TS_ISO },
    };
    const payload = buildReactionEmit(sdk, client, wire);

    // Pin the emit shape itself (normalize must not assume more than this):
    assert.ok(payload.reaction instanceof sdk.MessageReaction);
    assert.ok(payload.user instanceof sdk.User);
    assert.ok(payload.member instanceof sdk.GuildMember);
    assert.equal(
      "guildId" in payload,
      false,
      "the emit has NO top-level guildId — the guild rides on reaction.guildId",
    );
    assert.equal(payload.reaction.guildId, GUILD_ID);

    const out = normalizeFluxerReaction(payload, { instanceKey: "https://fluxer.test" });
    assert.ok(out, "expected a normalized reaction");
    assert.equal(out.platform, "fluxer");
    assert.equal(out.externalGuildId, GUILD_ID, "lifted via the reaction.guildId fallback — C-class drift this pin catches");
    assert.equal(out.messageId, MSG_ID);
    assert.equal(out.channelId, CHANNEL_ID);
    assert.equal(out.userId, USER_ID);
    assert.equal(out.userBot, false, "read from the REAL User instance");
    assert.equal(out.emojiKey, "1554600000000000077", "custom emoji → id key");
    assert.equal(out.communityId, null);

    // A bot user in the SAME emit position flips userBot (never defaulted).
    const botWire = {
      ...wire,
      user_id: "1554600000000000050",
      member: { user: wireUser({ id: "1554600000000000050", bot: true }), roles: [], joined_at: TS_ISO },
    };
    const botPayload = buildReactionEmit(sdk, client, botWire);
    const botOut = normalizeFluxerReaction(botPayload, { instanceKey: "https://fluxer.test" });
    assert.equal(botOut.userBot, true);
    assert.equal(botOut.userId, "1554600000000000050");
  });

  it("unicode emoji keys, and required-field gaps are null (logged)", async (t) => {
    const sdk = await sdkModels();
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");

    const client = makeRealClient(sdk);
    seedRealGuild(sdk, client);
    const unicode = buildReactionEmit(sdk, client, {
      user_id: USER_ID,
      channel_id: CHANNEL_ID,
      message_id: MSG_ID,
      guild_id: GUILD_ID,
      emoji: { name: "🎉" },
    });
    assert.equal(normalizeFluxerReaction(unicode, { instanceKey: "i" }).emojiKey, "🎉");

    const orig = console.error;
    const lines = [];
    console.error = (...args) => lines.push(args.join(" "));
    try {
      const noUser = { ...unicode };
      delete noUser.userId;
      assert.equal(normalizeFluxerReaction(noUser, { instanceKey: "i" }), null);
      assert.ok(lines.some((l) => l.includes('"user_id"')), `missing-field log expected, got: ${lines}`);
    } finally {
      console.error = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// 4. MESSAGE_DELETE emit → real PartialMessage; MESSAGE_UPDATE emit → real Message
// ---------------------------------------------------------------------------

describe("platform/fluxer/normalize — real update/delete emits (issue #200)", () => {
  it("lifts the identity triple from the real PartialMessage the MESSAGE_DELETE handler emits", async (t) => {
    const sdk = await sdkModels();
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");

    const client = makeRealClient(sdk);
    // toPartialMessage(client, {...}) is what MESSAGE_DELETE emits (dist):
    const partial = new sdk.PartialMessage(client, {
      id: MSG_ID,
      channelId: CHANNEL_ID,
      guildId: GUILD_ID,
      channel: null,
      content: null,
      authorId: USER_ID,
      author: null,
      createdAt: new Date(TS_ISO),
    });
    assert.equal(partial.partial, true, "the discriminant the delete intake tolerates (no author gate applies)");

    const out = normalizeFluxerMessageDelete(partial, { instanceKey: "https://fluxer.test" });
    assert.deepEqual(out, {
      platform: "fluxer",
      instanceKey: "https://fluxer.test",
      communityId: null,
      externalGuildId: GUILD_ID,
      id: MSG_ID,
      channelId: CHANNEL_ID,
    });
  });

  it("normalizes the MESSAGE_UPDATE new-state Message instance directly (dual-shape reads)", async (t) => {
    const sdk = await sdkModels();
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");

    const client = makeRealClient(sdk);
    seedRealGuild(sdk, client);
    // The handler emits (old|null, new Message(client, merged)) and the
    // client hook normalizes the NEW state directly.
    const merged = { ...wireMessageCreate(), content: "edited body", flags: 0 };
    const updated = new sdk.Message(client, merged);
    const out = normalizeFluxerMessage(updated, { instanceKey: "https://fluxer.test" });
    assert.equal(out.content, "edited body");
    assert.equal(out.flags, 0, "flags lifted to a plain 0 (number), not null");
    assertNormalizedMessage(out, { boundary: "onMessageCreate (issue #200 update shape)" });
  });
});

// ---------------------------------------------------------------------------
// 5. User-instance contract for the surfaces that read author fields
// ---------------------------------------------------------------------------

describe("platform/fluxer — real User instance contract (issue #200)", () => {
  it("pins the field surface linking/dispatch/context read off authorRaw", async (t) => {
    const sdk = await sdkModels();
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");

    const client = makeRealClient(sdk);
    const user = client.getOrCreateUser({
      id: USER_ID,
      username: "talker",
      discriminator: "0001",
      global_name: "Talker G",
      avatar: "HASH",
      avatar_color: 0x123456,
      flags: 4194304,
      bot: false,
      system: false,
      banner: "BANNER",
    });
    assert.ok(user instanceof sdk.User);
    // What src/platform/fluxer/{context,dispatch}.js read from authorRaw:
    assert.equal(user.id, USER_ID);
    assert.equal(user.username, "talker", "context.js ResolvedUser reads authorRaw.username — SNAKE username does not exist on the instance");
    assert.equal(user.globalName, "Talker G", "camelCase globalName (NOT global_name)");
    // What an avatar consumer must use (audit: string-checking a method is not best-effort):
    assert.equal(user.avatar, "HASH");
    assert.equal(user.avatarColor, 0x123456);
    assert.equal(user.banner, "BANNER");
    assert.equal(user.bot, false);
    assert.equal(user.system, false);
    const url = user.avatarURL();
    assert.match(url, /^https:\/\//, "avatarURL() yields the https CDN URL offline (instance endpoints)");
    assert.equal(user.displayAvatarURL(), url);
  });
});

// ---------------------------------------------------------------------------
// 6. DELIBERATE FIXTURE-DRIFT TESTS — the proof of the mechanism
// ---------------------------------------------------------------------------

describe("FIXTURE DRIFT (issue #200): SDK shape changes FAIL THE SUITE", () => {
  it("DELIBERATE FIXTURE DRIFT: renaming the real roleIds getter makes normalize THROW loudly, not silently yield []", async (t) => {
    const sdk = await sdkModels();
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");

    const client = makeRealClient(sdk);
    const guild = seedRealGuild(sdk, client);
    const real = indexRealMember(sdk, client, guild, {
      user: wireUser(),
      roles: [ROLE_STAFF, ROLE_SENIOR],
      joined_at: TS_ISO,
    });
    assert.equal(real.roles.roleIds.length, 2, "baseline: the real getter yields the ids");

    // Simulate the SDK shipping a rename (roleIds → ids) UNDER us by Proxying
    // the real manager. The C2 failure mode — silent [] memberRoleIds, every
    // staff check skipping its REST fallback — must now be a LOUD throw.
    const driftedRoles = new Proxy(real.roles, {
      get(target, prop, receiver) {
        if (prop === "roleIds") return undefined; // getter removed
        return Reflect.get(target, prop, receiver);
      },
    });
    const driftedMember = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "roles") return driftedRoles;
        return Reflect.get(target, prop, receiver);
      },
    });

    assert.throws(
      () =>
        normalizeFluxerMessage(
          {
            id: MSG_ID,
            channelId: CHANNEL_ID,
            guildId: GUILD_ID,
            author: real.user,
            content: "x",
            member: driftedMember,
          },
          { instanceKey: "https://fluxer.test" },
        ),
      (err) =>
        err instanceof TypeError &&
        /roleIds/i.test(err.message) &&
        /drift/i.test(err.message) &&
        err.message.includes(MSG_ID),
      "drift must throw a specific TypeError naming roleIds AND the message id (AGENTS.md rule 2 — the drop log must be reproducible from the line alone); an empty [] here is the C2 lockout shipping green again",
    );

    // Control: the UNPROXIED real member still normalizes fine (the throw is
    // the drift, not the fixture).
    const ok = normalizeFluxerMessage(
      {
        id: MSG_ID,
        channelId: CHANNEL_ID,
        guildId: GUILD_ID,
        author: real.user,
        content: "x",
        member: real,
      },
      { instanceKey: "https://fluxer.test" },
    );
    assert.deepEqual(ok.memberRoleIds, [ROLE_STAFF, ROLE_SENIOR]);
  });

  it("DELIBERATE FIXTURE DRIFT: renaming the real Message's id makes normalize DROP the message (identity gate), never pass a null id downstream", async (t) => {
    const sdk = await sdkModels();
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");

    const client = makeRealClient(sdk);
    seedRealGuild(sdk, client);
    const message = hydrateMessageCreate(sdk, client, wireMessageCreate());
    const drifted = new Proxy(message, {
      get(target, prop, receiver) {
        if (prop === "id") return undefined; // simulate the rename
        return Reflect.get(target, prop, receiver);
      },
    });
    // The identity gate returns null → the pipeline's #201 boundary never
    // sees half-shaped traffic (onMessageCreate logs and skips).
    assert.equal(normalizeFluxerMessage(drifted, { instanceKey: "https://fluxer.test" }), null);
  });
});
