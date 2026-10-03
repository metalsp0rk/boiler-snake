/**
 * Unit tests for the Fluxer reaction-role service entries + pipeline wiring
 * (PR 9, roadmap/fluxer.md § Outbound client + Feature matrix: reaction-role
 * panels are Fluxer v1 — reactions are NOT elevated; the role legs run through
 * addRole/removeRole, which self-gate on K8 `elevated_permissions`).
 *
 * Fake handle (test/helpers/fluxer.js): every request is recorded in
 * rest.calls, and routes are keyed "METHOD /path". Wire shapes are the SHIPPED
 * outbound bodies:
 *   addReaction          PUT  /v1/channels/{c}/messages/{m}/reactions/{encEmoji}/@me
 *   removeUserReaction   DELETE /v1/channels/{c}/messages/{m}/reactions/{encEmoji}/{userId}
 *   addRole              PUT  /v1/guilds/{g}/members/{u}/roles/{r}
 *   removeRole           DELETE /v1/guilds/{g}/members/{u}/roles/{r}
 * Panel + option rows live in the real DB (loadDb) — the service resolves the
 * panel by INTEGER communityId + messageId, exactly like the Discord handlers.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { api: dbApi, cleanup } = loadDb();

const service = require("../src/features/reactionRoles/service");
const { ensureCommunity } = require("../src/platform/community");
const { makeFakeRest, makeFakeHandle } = require("./helpers/fluxer");

after(cleanup);

const INSTANCE = "https://fluxer.test";
const GUILD = "99";
const CH = "444";
const USER = "user-5";
const ROLE = "role-7";
const EMOJI = "👍";
const EMOJI_ENC = encodeURIComponent(EMOJI);

const COMMUNITY_ID = ensureCommunity({
  platform: "fluxer",
  instanceKey: INSTANCE,
  externalGuildId: GUILD,
});

const reactPutPath = (msgId) =>
  `/v1/channels/${CH}/messages/${msgId}/reactions/${EMOJI_ENC}/@me`;
const userReactDeletePath = (msgId) =>
  `/v1/channels/${CH}/messages/${msgId}/reactions/${EMOJI_ENC}/${USER}`;
const rolePutPath = (u = USER, r = ROLE) => `/v1/guilds/${GUILD}/members/${u}/roles/${r}`;
const roleDeletePath = (u = USER, r = ROLE) =>
  `/v1/guilds/${GUILD}/members/${u}/roles/${r}`;
const memberGetPath = (u = USER) => `/v1/guilds/${GUILD}/members/${u}`;

function setElevatedFlag(value) {
  dbApi.db
    .prepare("UPDATE communities SET elevated_permissions=? WHERE id=?")
    .run(value, COMMUNITY_ID);
}

function seedPanel(messageId, { emojiKey = EMOJI, roleId = ROLE, minLevel = 0, removable = 1 } = {}) {
  dbApi.createReactionRolePanel(COMMUNITY_ID, CH, messageId, "Roles", "React to get a role.");
  dbApi.upsertReactionRoleOption(COMMUNITY_ID, messageId, emojiKey, emojiKey, roleId, minLevel, removable);
}

function normalized(overrides = {}) {
  return {
    platform: "fluxer",
    instanceKey: INSTANCE,
    communityId: COMMUNITY_ID,
    externalGuildId: GUILD,
    messageId: "500",
    channelId: CH,
    userId: USER,
    userBot: false,
    emojiKey: EMOJI,
    ...overrides,
  };
}

/** Capture console.log/.error/.warn for the duration of fn (AGENTS.md log pins). */
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

function hits(rest, method, path) {
  return rest.calls.filter((c) => c.method === method && c.path === path);
}

describe("fluxer reaction roles — reaction add (flag 1)", () => {
  it("issues the option reaction PUT (exact emoji encoding) and the role PUT grant", async () => {
    setElevatedFlag(1);
    seedPanel("500");
    const rest = makeFakeRest({
      routes: {
        [`GET ${memberGetPath()}`]: { user: { id: USER, username: "u", bot: false }, roles: [] },
        [`PUT ${reactPutPath("500")}`]: null,
        [`PUT ${rolePutPath()}`]: null,
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const { result, lines } = await withConsole(() =>
      service.handleReactionRoleAddFluxer(outbound, normalized({ messageId: "500" })),
    );

    assert.equal(result.handled, true, "panel reactions are consumed (no reaction XP)");
    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);

    // Shipped addReaction wire: PUT .../reactions/{encodeURIComponent(key)}/@me
    assert.equal(hits(rest, "PUT", reactPutPath("500")).length, 1, "option reaction issued");
    assert.ok(
      rest.calls.some((c) => c.path.includes(`/reactions/${EMOJI_ENC}/@me`)),
      "emojiKey is URI-encoded on the path",
    );
    // Shipped addRole wire: PUT /v1/guilds/{g}/members/{u}/roles/{r}
    const grant = hits(rest, "PUT", rolePutPath());
    assert.equal(grant.length, 1, "role grant issued through outbound.addRole");
    assert.ok(
      lines.some((l) => l.includes("[reactionRoles] Granted role role-7") && l.includes("community")),
      "console audit line names role, user and community",
    );
  });
});

describe("fluxer reaction roles — K8 gate (flag 0)", () => {
  it("reaction PUT IS issued; role PUT is NOT (gate short-circuits, no network)", async () => {
    setElevatedFlag(0);
    seedPanel("501");
    const rest = makeFakeRest({
      routes: {
        [`GET ${memberGetPath()}`]: { user: { id: USER, username: "u", bot: false }, roles: [] },
        [`PUT ${reactPutPath("501")}`]: null,
        // NOTE: no role PUT route — a flag-0 code path that touched the wire
        // would surface as FAKE_NO_ROUTE 404, and the zero-hit assert below.
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const { result, lines } = await withConsole(() =>
      service.handleReactionRoleAddFluxer(outbound, normalized({ messageId: "501" })),
    );

    assert.equal(result.handled, true, "panel reaction is consumed at flag 0 too");
    assert.equal(result.ok, false, "the role leg reports the gate outcome");
    assert.equal(result.code, "elevated_disabled");
    assert.equal(hits(rest, "PUT", reactPutPath("501")).length, 1, "reactions ship at flag 0 (not elevated)");
    assert.equal(hits(rest, "PUT", rolePutPath()).length, 0, "elevated role PUT never touches the wire at flag 0");
    assert.ok(
      lines.some(
        (l) =>
          l.includes("[reactionRoles] role grant deferred: elevated_permissions=0") &&
          l.includes(`community ${COMMUNITY_ID}`) &&
          l.includes(USER),
      ),
      "ONE informative deferral line with the specific gate reason",
    );
  });

  it("un-configured emoji on a managed panel → user reaction stripped, no role calls", async () => {
    setElevatedFlag(1);
    seedPanel("502");
    const partyKey = "🎉";
    const deletePath = `/v1/channels/${CH}/messages/502/reactions/${encodeURIComponent(partyKey)}/${USER}`;
    const rest = makeFakeRest({
      routes: {
        [`GET ${memberGetPath()}`]: { user: { id: USER, username: "u", bot: false }, roles: [] },
        [`DELETE ${deletePath}`]: {},
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const { result } = await withConsole(() =>
      service.handleReactionRoleAddFluxer(outbound, normalized({ messageId: "502", emojiKey: partyKey })),
    );

    assert.equal(result.handled, true, "unconfigured reactions on panels are consumed");
    assert.equal(hits(rest, "DELETE", deletePath).length, 1, "strip → removeUserReaction (PR 9 mapping)");
    assert.equal(rest.calls.filter((c) => c.method === "PUT").length, 0, "no role/reaction grants for unconfigured emoji");
  });
});

describe("fluxer reaction roles — un-react (remove path)", () => {
  it("flag 1: DELETE role + DELETE the user's reaction", async () => {
    setElevatedFlag(1);
    seedPanel("503");
    const rest = makeFakeRest({
      routes: {
        [`GET ${memberGetPath()}`]: { user: { id: USER, username: "u", bot: false }, roles: [ROLE] },
        [`DELETE ${roleDeletePath()}`]: {},
        [`DELETE ${userReactDeletePath("503")}`]: {},
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const { result } = await withConsole(() =>
      service.handleReactionRoleRemoveFluxer(outbound, normalized({ messageId: "503" })),
    );

    assert.equal(result.handled, true);
    assert.equal(result.ok, true);
    assert.equal(hits(rest, "DELETE", roleDeletePath()).length, 1, "removable option drops the role");
    assert.equal(hits(rest, "DELETE", userReactDeletePath("503")).length, 1, "user reaction cleaned off the panel");
  });

  it("flag 0: role call skipped (no DELETE on the wire); reaction cleanup still runs", async () => {
    setElevatedFlag(0);
    seedPanel("504");
    const rest = makeFakeRest({
      routes: {
        [`GET ${memberGetPath()}`]: { user: { id: USER, username: "u", bot: false }, roles: [ROLE] },
        // No DELETE role route: any flag-0 wire hit would FAKE_NO_ROUTE.
        [`DELETE ${userReactDeletePath("504")}`]: {},
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const { result, lines } = await withConsole(() =>
      service.handleReactionRoleRemoveFluxer(outbound, normalized({ messageId: "504" })),
    );

    assert.equal(result.handled, true);
    assert.equal(result.ok, false);
    assert.equal(result.code, "elevated_disabled");
    assert.equal(hits(rest, "DELETE", roleDeletePath()).length, 0, "role leg is gated, not wired, at flag 0");
    assert.equal(hits(rest, "DELETE", userReactDeletePath("504")).length, 1, "reactions are never elevated");
    assert.ok(
      lines.some((l) => l.includes("role removal deferred: elevated_permissions=0")),
      "specific deferral line for the remove leg",
    );
  });

  it("non-removable option keeps the role (Discord parity)", async () => {
    setElevatedFlag(1);
    seedPanel("506", { removable: 0 });
    const rest = makeFakeRest({
      routes: {
        [`GET ${memberGetPath()}`]: { user: { id: USER, username: "u", bot: false }, roles: [ROLE] },
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const { result } = await withConsole(() =>
      service.handleReactionRoleRemoveFluxer(outbound, normalized({ messageId: "506" })),
    );

    assert.equal(result.handled, true);
    assert.equal(rest.calls.length, 0, "permanent option: no member fetch, no role delete, no reaction delete");
  });
});

describe("fluxer reaction roles — min-level gate", () => {
  it("level below option min_level: reaction stripped + DM with the specific cause, no role grant", async () => {
    setElevatedFlag(1);
    seedPanel("507", { minLevel: 5 });
    dbApi.setXp(COMMUNITY_ID, USER, 0); // level 0 < 5 (floor(sqrt(xp/100)))
    const rest = makeFakeRest({
      routes: {
        [`GET ${memberGetPath()}`]: { user: { id: USER, username: "u", bot: false }, roles: [] },
        [`PUT ${reactPutPath("507")}`]: null,
        [`DELETE ${userReactDeletePath("507")}`]: {},
        "POST /v1/users/@me/channels": { id: "dm-9" },
        "POST /v1/channels/dm-9/messages": { id: "dm-m1" },
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const { result } = await withConsole(() =>
      service.handleReactionRoleAddFluxer(outbound, normalized({ messageId: "507" })),
    );

    assert.equal(result.handled, true);
    assert.equal(hits(rest, "PUT", rolePutPath()).length, 0, "under-leveled users never reach the role wire");
    assert.equal(hits(rest, "DELETE", userReactDeletePath("507")).length, 1, "claim reaction is stripped");
    const dm = rest.calls.find((c) => c.method === "POST" && c.path === "/v1/channels/dm-9/messages");
    assert.ok(dm, "DM sent via the K2 DM channel open + message post");
    assert.match(dm.body.content, /You need \*\*Level 5\*\*/, "DM names the concrete requirement");
  });
});

describe("fluxer reaction roles — deployPanelFluxer", () => {
  it("sendChannel posts the plain-JSON embed, seeds option reactions, and reports per-option failures", async () => {
    setElevatedFlag(1);
    const rest = makeFakeRest({
      routes: {
        "POST /v1/channels/444/messages": { id: "m-77" },
        [`PUT /v1/channels/444/messages/m-77/reactions/${encodeURIComponent("👍")}/@me`]: null,
        // 🎉 route intentionally absent → 404 → collected into failed[].
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const options = [
      { emoji_key: "👍", emoji_display: "👍", role_id: ROLE, min_level: 0, removable: true },
      { emoji_key: "🎉", emoji_display: "🎉", role_id: "role-8", min_level: 0, removable: true },
    ];
    const { result } = await withConsole(() =>
      service.deployPanelFluxer(outbound, COMMUNITY_ID, CH, {
        embedPayload: { title: "T", description: "D" },
        options,
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.messageId, "m-77");
    const post = rest.calls.find((c) => c.method === "POST" && c.path === "/v1/channels/444/messages");
    assert.ok(post, "panel embed posted via sendChannel");
    assert.deepEqual(post.body.embeds, [{ title: "T", description: "D" }], "plain JSON embed (no builder class)");
    assert.deepEqual(post.body.allowed_mentions, { parse: [] }, "no-ping policy mirrors the Discord deploy");

    assert.equal(
      rest.calls.filter((c) =>
        c.method === "PUT" && c.path.startsWith("/v1/channels/444/messages/m-77/reactions/"),
      ).length,
      2,
      "one addReaction per option (flag 1 — and flag 0 too, reactions are not elevated)",
    );

    // Warnings pattern: partial success is REPORTED, not swallowed.
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].emojiKey, "🎉");
    assert.match(result.failed[0].error, /404/, "failed leg names the API cause");

    // DB persistence mirrors the Discord deploy write set.
    const panel = dbApi.getReactionRolePanel(COMMUNITY_ID, "m-77");
    assert.equal(panel.title, "T", "panel row persisted");
    assert.equal(dbApi.getReactionRoleOption(COMMUNITY_ID, "m-77", "👍").role_id, ROLE, "option rows persisted");
  });
});

describe("fluxer reaction roles — refreshPanelMessageFluxer", () => {
  it("edits the embed, re-issues option reactions, and names every degraded leg", async () => {
    setElevatedFlag(1);
    seedPanel("512");
    const rest = makeFakeRest({
      routes: {
        "GET /v1/channels/444/messages/512": () => ({ id: "512", channel_id: "444" }),
        "PATCH /v1/channels/444/messages/512": null,
        [`PUT /v1/channels/444/messages/512/reactions/${EMOJI_ENC}/@me`]: null,
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const { result, lines } = await withConsole(() =>
      service.refreshPanelMessageFluxer(outbound, COMMUNITY_ID, {
        message_id: "512",
        channel_id: CH,
      }),
    );

    assert.equal(result.ok, true, "best-effort refresh succeeds when every available leg succeeds");
    assert.equal(hits(rest, "PATCH", "/v1/channels/444/messages/512").length, 1, "embed text via editMessage");
    assert.equal(
      hits(rest, "PUT", `/v1/channels/444/messages/512/reactions/${EMOJI_ENC}/@me`).length,
      1,
      "option reaction ensured (idempotent PUT)",
    );
    assert.ok(
      !lines.some((l) => l.includes("presence check")),
      "presence resolves via fetchMessage (PR 5) — no degraded leg when the GET succeeds",
    );
    assert.ok(
      lines.some((l) => l.includes("Stale reaction cleanup skipped") && l.includes("reaction-list")),
      "stale cleanup degrades with a NAMED skip (no reaction enumeration surface)",
    );
    const patch = rest.calls.find((c) => c.method === "PATCH");
    assert.equal(typeof patch.body.embeds[0], "object", "embeds are plain JSON on the wire");
  });

  it("404 on the presence probe is conclusive: 'Panel message is missing', no writes", async () => {
    seedPanel("523");
    const rest = makeFakeRest({
      routes: {
        "GET /v1/channels/444/messages/523": () => {
          const e = new Error("Not Found");
          e.status = 404;
          throw e;
        },
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const { result } = await withConsole(() =>
      service.refreshPanelMessageFluxer(outbound, COMMUNITY_ID, {
        message_id: "523",
        channel_id: CH,
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /Panel message is missing/);
    assert.equal(hits(rest, "PATCH", "/v1/channels/444/messages/523").length, 0, "no edit on a gone message");
    assert.equal(rest.calls.filter((c) => c.method === "PUT").length, 0, "no reactions on a gone message");
  });

  it("non-404 probe failure is named and the refresh continues", async () => {
    seedPanel("524");
    const rest = makeFakeRest({
      routes: {
        "GET /v1/channels/444/messages/524": () => {
          const e = new Error("Forbidden");
          e.status = 403;
          throw e;
        },
        "PATCH /v1/channels/444/messages/524": null,
        [`PUT /v1/channels/444/messages/524/reactions/${EMOJI_ENC}/@me`]: null,
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const { result, lines } = await withConsole(() =>
      service.refreshPanelMessageFluxer(outbound, COMMUNITY_ID, {
        message_id: "524",
        channel_id: CH,
      }),
    );
    assert.equal(result.ok, true, "a permissioned probe does not delete a live panel's refresh");
    assert.ok(
      lines.some((l) => l.includes("presence check inconclusive") && l.includes("Forbidden")),
      "non-404 probe failure is logged by name with the cause",
    );
  });
});

describe("fluxer reaction roles — pending emoji (PR 5, gap #1)", () => {
  const MSG = "9000000000000000001";
  function fluxerMsg(overrides = {}) {
    return {
      platform: "fluxer",
      instanceKey: INSTANCE,
      communityId: COMMUNITY_ID,
      externalGuildId: GUILD,
      id: MSG,
      channelId: CH,
      authorId: USER,
      authorBot: false,
      authorDisplayName: "admin",
      content: "👍",
      createdAt: "2026-10-02T00:00:00.000Z",
      ...overrides,
    };
  }
  function postBodies(rest) {
    return rest.calls
      .filter((c) => c.method === "POST" && c.path === `/v1/channels/${CH}/messages`)
      .map((c) => c.body);
  }
  const ROLES_ROUTE = `GET /v1/guilds/${GUILD}/roles`;
  const ROLES = [{ id: ROLE, name: "Elite", position: 5, permissions: "0" }];

  it("option add: emoji upserts the option, seeds the reaction, refreshes the embed, confirms, clears the session", async () => {
    dbApi.createReactionRolePanel(COMMUNITY_ID, CH, "600", "Roles", "React to get a role.");
    service.setPendingOptionAdd(COMMUNITY_ID, USER, {
      messageId: "600",
      roleId: ROLE,
      level: 3,
      removable: true,
      channelId: CH,
    });
    const rest = makeFakeRest({
      routes: {
        [`GET /v1/channels/${CH}/messages/600`]: () => ({ id: "600", channel_id: CH }),
        [`PATCH /v1/channels/${CH}/messages/600`]: null,
        [`PUT /v1/channels/${CH}/messages/600/reactions/${EMOJI_ENC}/@me`]: null,
        [ROLES_ROUTE]: () => ROLES,
        [`POST /v1/channels/${CH}/messages`]: () => ({ id: "910" }),
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const { result, lines } = await withConsole(() =>
      service.handlePendingOptionEmojiMessageFluxer(outbound, fluxerMsg()),
    );

    assert.equal(result.handled, true);
    assert.deepEqual(lines.filter((l) => l.includes("failed")), [], "no degraded legs");

    // Option persisted with the session's role/level/removable.
    const opt = dbApi.getReactionRoleOption(COMMUNITY_ID, "600", EMOJI);
    assert.ok(opt, "option row created");
    assert.equal(String(opt.role_id), ROLE);
    assert.equal(Number(opt.min_level), 3);

    // Panel embed refreshed + option reaction seeded (idempotent PUT).
    assert.equal(hits(rest, "PATCH", `/v1/channels/${CH}/messages/600`).length, 1);
    assert.equal(
      hits(rest, "PUT", `/v1/channels/${CH}/messages/600/reactions/${EMOJI_ENC}/@me`).length,
      1,
    );

    // Confirmation names the role by NAME (K10: no Discord mention markup).
    const confirms = postBodies(rest);
    assert.equal(confirms.length, 1, "exactly one confirmation send");
    assert.match(confirms[0].content, /Configured 👍 → \*\*Elite\*\*/);
    assert.match(confirms[0].content, /Level 3\+/);
    assert.match(confirms[0].content, /panel `600`/);
    assert.deepEqual(confirms[0].allowed_mentions, { parse: [] }, "never pings from confirmations");
    assert.ok(
      !confirms[0].content.includes("<@&"),
      "no <@&role> markup in Fluxer copy",
    );

    // Emoji config message stays (no deleteMessage surface) — named on the log.
    assert.ok(
      lines.some((l) => l.includes("left in place") && l.includes("no deleteMessage")),
      "message-retention degradation is named (AGENTS: no silent drop)",
    );

    // Session consumed.
    assert.equal(service.hasPendingOptionEmoji(COMMUNITY_ID, USER), false);
  });

  it("option add rolls a session open across a retry: non-emoji keeps the wait alive with help copy", async () => {
    dbApi.createReactionRolePanel(COMMUNITY_ID, CH, "601", "Roles", "React to get a role.");
    service.setPendingOptionAdd(COMMUNITY_ID, USER, {
      messageId: "601",
      roleId: ROLE,
      level: 0,
      removable: true,
      channelId: CH,
    });
    const rest = makeFakeRest({
      routes: { [`POST /v1/channels/${CH}/messages`]: () => ({ id: "911" }) },
    });
    const { outbound } = makeFakeHandle({ rest });

    const { result } = await withConsole(() =>
      // parseEmojiInput treats plain text as a label; the unparseable input
      // is an empty message (attachment-only) — parsed null → help copy.
      service.handlePendingOptionEmojiMessageFluxer(outbound, fluxerMsg({ content: "" })),
    );
    assert.equal(result.handled, true, "an open session consumes the message");
    const body = postBodies(rest)[0];
    assert.match(body.content, /doesn't look like an emoji/);
    assert.match(body.content, /Still waiting/);
    assert.deepEqual(body.message_reference, { message_id: MSG }, "reply references the admin's message");
    assert.equal(service.hasPendingOptionEmoji(COMMUNITY_ID, USER), true, "session stays open for a retry");
  });

  it("stop cancels with a referenced reply and clears the session", async () => {
    dbApi.createReactionRolePanel(COMMUNITY_ID, CH, "602", "Roles", "React to get a role.");
    service.setPendingOptionAdd(COMMUNITY_ID, USER, {
      messageId: "602",
      roleId: ROLE,
      level: 0,
      removable: true,
      channelId: CH,
    });
    const rest = makeFakeRest({
      routes: { [`POST /v1/channels/${CH}/messages`]: () => ({ id: "912" }) },
    });
    const { outbound } = makeFakeHandle({ rest });

    const { result } = await withConsole(() =>
      service.handlePendingOptionEmojiMessageFluxer(outbound, fluxerMsg({ content: "STOP" })),
    );
    assert.equal(result.handled, true);
    const body = postBodies(rest)[0];
    assert.match(body.content, /Cancelled — no longer waiting for an emoji/);
    assert.deepEqual(body.message_reference, { message_id: MSG });
    assert.equal(service.hasPendingOptionEmoji(COMMUNITY_ID, USER), false);
  });

  it("custom emoji the instance rejects (reaction 404) rolls the option back and keeps the session open", async () => {
    dbApi.createReactionRolePanel(COMMUNITY_ID, CH, "603", "Roles", "React to get a role.");
    const custom = "<:party:123456789012345678>";
    const parsed = service.parseEmojiInput(custom);
    assert.ok(parsed?.isCustom, "fixture: custom emoji parses");
    const customEnc = encodeURIComponent(parsed.reactIdent);
    service.setPendingOptionAdd(COMMUNITY_ID, USER, {
      messageId: "603",
      roleId: ROLE,
      level: 0,
      removable: true,
      channelId: CH,
    });
    const rest = makeFakeRest({
      routes: {
        [`GET /v1/channels/${CH}/messages/603`]: () => ({ id: "603", channel_id: CH }),
        [`PATCH /v1/channels/${CH}/messages/603`]: null,
        [`PUT /v1/channels/${CH}/messages/603/reactions/${customEnc}/@me`]: () => {
          const e = new Error("Emoji not found");
          e.status = 404;
          throw e;
        },
        [`POST /v1/channels/${CH}/messages`]: () => ({ id: "913" }),
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const { result, lines } = await withConsole(() =>
      service.handlePendingOptionEmojiMessageFluxer(outbound, fluxerMsg({ content: custom })),
    );
    assert.equal(result.handled, true);

    // Valid-by-acceptance: the reaction POST rejected the emoji → row rolled back.
    assert.equal(dbApi.getReactionRoleOption(COMMUNITY_ID, "603", parsed.key), null,
      "rejected option must not linger (a dead reaction can never grant the role)");
    const body = postBodies(rest)[0];
    assert.match(body.content, /rejected by the server/);
    assert.match(body.content, /Emoji not found/, "the instance's specific cause reaches the reply");
    assert.match(body.content, /Still waiting — try another emoji/);
    assert.equal(service.hasPendingOptionEmoji(COMMUNITY_ID, USER), true, "session stays open for a valid emoji");
    void lines;
  });

  it("option remove: the emoji deletes the row, refreshes the panel, confirms", async () => {
    seedPanel("604");
    service.setPendingOptionRemove(COMMUNITY_ID, USER, { messageId: "604", channelId: CH });
    const rest = makeFakeRest({
      routes: {
        [`GET /v1/channels/${CH}/messages/604`]: () => ({ id: "604", channel_id: CH }),
        [`PATCH /v1/channels/${CH}/messages/604`]: null,
        [`POST /v1/channels/${CH}/messages`]: () => ({ id: "914" }),
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const { result } = await withConsole(() =>
      service.handlePendingOptionEmojiMessageFluxer(outbound, fluxerMsg({ content: "👍" })),
    );
    assert.equal(result.handled, true);
    assert.equal(dbApi.getReactionRoleOption(COMMUNITY_ID, "604", EMOJI), null, "option row deleted");
    assert.equal(hits(rest, "PATCH", `/v1/channels/${CH}/messages/604`).length, 1, "embed refreshed");
    assert.match(postBodies(rest)[0].content, /Removed 👍 from panel `604`/);
    assert.equal(service.hasPendingOptionEmoji(COMMUNITY_ID, USER), false);
  });

  it("remove for an emoji with no option: soft failure keeps the session open", async () => {
    seedPanel("605"); // seeded with EMOJI
    service.setPendingOptionRemove(COMMUNITY_ID, USER, { messageId: "605", channelId: CH });
    const rest = makeFakeRest({
      routes: {
        [`GET /v1/channels/${CH}/messages/605`]: () => ({ id: "605", channel_id: CH }),
        [`POST /v1/channels/${CH}/messages`]: () => ({ id: "915" }),
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const { result } = await withConsole(() =>
      service.handlePendingOptionEmojiMessageFluxer(outbound, fluxerMsg({ content: "🎉" })),
    );
    assert.equal(result.handled, true);
    assert.match(postBodies(rest)[0].content, /No option for 🎉 on panel `605`/);
    assert.equal(service.hasPendingOptionEmoji(COMMUNITY_ID, USER), true, "soft failure keeps the wait alive");
  });

  it("option cap: the 21st emoji is a hard failure and clears the session", async () => {
    dbApi.createReactionRolePanel(COMMUNITY_ID, CH, "606", "Roles", "React to get a role.");
    for (let i = 0; i < service.MAX_OPTIONS_PER_PANEL; i += 1) {
      dbApi.upsertReactionRoleOption(COMMUNITY_ID, "606", `k${i}`, `e${i}`, ROLE, 0, true);
    }
    service.setPendingOptionAdd(COMMUNITY_ID, USER, {
      messageId: "606",
      roleId: ROLE,
      level: 0,
      removable: true,
      channelId: CH,
    });
    const rest = makeFakeRest({
      routes: { [`POST /v1/channels/${CH}/messages`]: () => ({ id: "916" }) },
    });
    const { outbound } = makeFakeHandle({ rest });

    const { result } = await withConsole(() =>
      service.handlePendingOptionEmojiMessageFluxer(outbound, fluxerMsg()),
    );
    assert.equal(result.handled, true);
    assert.match(postBodies(rest)[0].content, /already has 20 options/);
    assert.equal(service.hasPendingOptionEmoji(COMMUNITY_ID, USER), false, "cap hit clears the wait");
  });

  it("a bot author is never consumed and a session-less message is a no-op", async () => {
    service.setPendingOptionAdd(COMMUNITY_ID, USER, {
      messageId: "607",
      roleId: ROLE,
      level: 0,
      removable: true,
      channelId: CH,
    });
    const rest = makeFakeRest({ routes: {} });
    const { outbound } = makeFakeHandle({ rest });

    const bot = await service.handlePendingOptionEmojiMessageFluxer(
      outbound,
      fluxerMsg({ authorBot: true }),
    );
    assert.equal(bot.handled, false, "bot messages never feed the emoji session");

    const other = await service.handlePendingOptionEmojiMessageFluxer(
      outbound,
      fluxerMsg({ authorId: "someone-else" }),
    );
    assert.equal(other.handled, false, "only the session owner's messages are consumed");
    assert.equal(rest.calls.length, 0, "no sends for non-matching messages");
    assert.equal(service.hasPendingOptionEmoji(COMMUNITY_ID, USER), true, "session intact");

    // A message with no resolvable community is a clean no-op.
    const orphan = await service.handlePendingOptionEmojiMessageFluxer(
      outbound,
      { ...fluxerMsg(), communityId: null, externalGuildId: null, instanceKey: null },
    );
    assert.equal(orphan.handled, false);
    service.clearPendingOptionEmoji(COMMUNITY_ID, USER);
  });

  it("session keyed by community: a Discord-snowflake guild id string cannot open the Fluxer session (gap #1 collision pin)", async () => {
    dbApi.createReactionRolePanel(COMMUNITY_ID, CH, "608", "Roles", "React to get a role.");
    service.setPendingOptionAdd(COMMUNITY_ID, USER, {
      messageId: "608",
      roleId: ROLE,
      level: 0,
      removable: true,
      channelId: CH,
    });
    const rest = makeFakeRest({ routes: {} });
    const { outbound } = makeFakeHandle({ rest });

    // Same author id, external id that stringifies to the INTEGER community id —
    // the old `${externalGuildId}:${userId}` key would collide here.
    const attacker = await service.handlePendingOptionEmojiMessageFluxer(
      outbound,
      fluxerMsg({ communityId: null, externalGuildId: String(COMMUNITY_ID) }),
    );
    assert.equal(
      attacker.handled,
      false,
      "keying by the internal id means an external id equal to the community id cannot hijack the session",
    );
    service.clearPendingOptionEmoji(COMMUNITY_ID, USER);
  });
});

describe("fluxer pipelines — reaction wiring (PR 9 replaces the PR 6 stubs)", () => {
  // Loaded lazily so the DB contract (loadDb first) holds.
  const pipelines = require("../src/bot/pipelines");

  it("onFluxerReactionAdd: panel reaction is handled ⇒ NO reaction XP", async () => {
    setElevatedFlag(1);
    seedPanel("510");
    const rest = makeFakeRest({
      routes: {
        [`GET ${memberGetPath()}`]: { user: { id: USER, username: "u", bot: false }, roles: [] },
        [`PUT ${reactPutPath("510")}`]: null,
        [`PUT ${rolePutPath()}`]: null,
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const before = dbApi.getXp(COMMUNITY_ID, USER);

    await pipelines.onFluxerReactionAdd(outbound, normalized({ messageId: "510" }));

    assert.equal(hits(rest, "PUT", rolePutPath()).length, 1, "pipeline reaches the fluxer service grant path");
    assert.equal(dbApi.getXp(COMMUNITY_ID, USER), before, "handled panel reactions earn no reaction XP (Discord parity)");
  });

  it("onFluxerReactionAdd: bot reactions are skipped entirely (no wire calls)", async () => {
    const rest = makeFakeRest({ routes: {} });
    const { outbound } = makeFakeHandle({ rest });
    await pipelines.onFluxerReactionAdd(outbound, normalized({ messageId: "511", userBot: true }));
    assert.equal(rest.calls.length, 0, "bot reactions never hit the wire");
  });

  it("onFluxerReactionRemove: runs the remove path and the PR 6 log stub is gone", async () => {
    setElevatedFlag(1);
    seedPanel("513");
    const rest = makeFakeRest({
      routes: {
        [`GET ${memberGetPath()}`]: { user: { id: USER, username: "u", bot: false }, roles: [ROLE] },
        [`DELETE ${roleDeletePath()}`]: {},
        [`DELETE ${userReactDeletePath("513")}`]: {},
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const { lines } = await withConsole(() =>
      pipelines.onFluxerReactionRemove(outbound, normalized({ messageId: "513" })),
    );

    assert.equal(hits(rest, "DELETE", roleDeletePath()).length, 1, "un-react drives the role removal leg");
    assert.equal(hits(rest, "DELETE", userReactDeletePath("513")).length, 1, "un-react cleans the panel reaction");
    assert.ok(
      !lines.some((l) => l.includes("panel handling lands in PR 9")),
      "the PR 6 log-only stub is replaced by the real remove path",
    );
  });
});
