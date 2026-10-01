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
        "GET /v1/channels/444/messages": [], // history probe: panel predates the page
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
      lines.some((l) => l.includes("presence check skipped") && l.includes("single-message fetch")),
      "presence degrades with a NAMED skip (no fetchMessage surface — spec 375–397)",
    );
    assert.ok(
      lines.some((l) => l.includes("Stale reaction cleanup skipped") && l.includes("reaction-list")),
      "stale cleanup degrades with a NAMED skip (no reaction enumeration surface)",
    );
    const patch = rest.calls.find((c) => c.method === "PATCH");
    assert.equal(typeof patch.body.embeds[0], "object", "embeds are plain JSON on the wire");
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
