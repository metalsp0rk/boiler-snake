/**
 * Issue #183 (audit C2): the real gateway hands normalizeFluxerMessage a
 * hydrated Message whose `member` is an SDK GuildMember instance — and a
 * GuildMember's `roles` is a GuildMemberRoleManager, NOT an id array. The
 * ids live behind the manager's `roleIds` getter. Hand-built wire fixtures
 * (test/helpers/fluxer.js) carry `member: { roles: [...] }` arrays, so the
 * old suite was structurally unable to catch the manager-vs-array confusion:
 * every real payload normalized to memberRoleIds: [] and payload-first
 * permission resolution then skipped the REST fallback — locking every
 * non-owner staff member out of !warn / !note / !ticket / !staff.
 *
 * These tests feed normalize.js a REAL SDK GuildMember instance (constructed
 * exactly the way the SDK's member indexer constructs it) plus the raw
 * wire-array shape as regression safety.
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

const { normalizeFluxerMessage } = require("../src/platform/fluxer/normalize");
const { assertNormalizedMessage } = require("../src/platform/normalizedMessageContract");
const { loadFluxerSdk } = require("../src/platform/fluxer/client");
const { gatewayMessage } = require("./helpers/fluxer");

after(cleanup);

// Kicked off at module scope; awaited inside the SDK tests (no top-level
// await in CJS). null = package absent → those tests skip.
const sdkPromise = loadFluxerSdk("unit-test/normalize-sdk-member");

const TS_ISO = "2026-10-11T12:00:00.000Z";
const GUILD_ID = "1554590611015729152";
const CHANNEL_ID = "1554600000000000002";
const MSG_ID = "1554600000000000001";
const USER_ID = "1554600000000000003";
const ROLE_STAFF = "1554600000000000010";
const ROLE_SENIOR = "1554600000000000012";

/**
 * Await the real SDK module through the guarded load site.
 * @returns {Promise<object|null>} null ONLY when the package is not
 *   installed (guarded loader resolved null → tests skip); a resolved SDK
 *   missing its GuildMember surface throws with the specific cause instead
 *   of skipping silently.
 */
async function sdkModels() {
  const mod = await sdkPromise;
  if (!mod) return null;
  // CJS interop belt: named exports first (prod client.js reads them
  // directly), default-namespace fallback.
  const ns = typeof mod.GuildMember === "function" ? mod : mod?.default;
  if (!ns || typeof ns.GuildMember !== "function") {
    throw new Error(
      "SDK loaded but exposes no GuildMember export — SDK surface changed; update the issue #183 member tests",
    );
  }
  return ns;
}

/**
 * Construct a REAL SDK GuildMember the way the SDK does (indexMember →
 * new GuildMember(client, wireData, guild)): the constructor indexes
 * data.user through client.getOrCreateUser and wraps data.roles in a
 * GuildMemberRoleManager. Only getOrCreateUser is exercised by the
 * constructor, so a minimal client stub suffices; the guild only backs
 * manager.cache, which these tests never touch.
 *
 * @param {object} sdk the real SDK module namespace
 * @param {{ roles: string[] }} opts member role ids (wire shape)
 * @returns {object} a real GuildMember instance
 */
function makeRealGuildMember(sdk, { roles }) {
  const fakeClient = { getOrCreateUser: (userData) => userData };
  const fakeGuild = { id: GUILD_ID, roles: new Map() };
  return new sdk.GuildMember(
    fakeClient,
    {
      user: {
        id: USER_ID,
        username: "staffy",
        discriminator: "0001",
        global_name: null,
        avatar: null,
        avatar_color: null,
        flags: 0,
        bot: false,
      },
      roles,
      joined_at: TS_ISO,
    },
    fakeGuild,
  );
}

describe("platform/fluxer/normalize — real SDK GuildMember (issue #183, audit C2)", () => {
  it("resolves memberRoleIds from a hydrated GuildMember (roles is a MANAGER, not an array)", async (t) => {
    const sdk = await sdkModels();
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");
    assert.ok(
      typeof sdk.GuildMemberRoleManager === "function",
      "SDK surface changed: GuildMemberRoleManager is no longer exported",
    );

    const member = makeRealGuildMember(sdk, { roles: [ROLE_STAFF, ROLE_SENIOR] });
    // The fixture is genuinely SDK-shaped, not a lookalike:
    assert.ok(member instanceof sdk.GuildMember);
    assert.ok(
      member.roles instanceof sdk.GuildMemberRoleManager,
      "a real GuildMember carries the role MANAGER on .roles — the exact confusion audit C2 is about",
    );

    const out = normalizeFluxerMessage(
      { t: "MESSAGE_CREATE", d: gatewayMessage({ member }) },
      { instanceKey: "https://fluxer.test" },
    );

    assert.ok(out, "expected a normalized message");
    assert.deepEqual(out.memberRoleIds, [ROLE_STAFF, ROLE_SENIOR]);
    assert.equal(out.memberRaw, member, "the member instance passes through untouched");
    // Issue #201: what the REAL gateway produces must satisfy the required-field
    // contract the pipeline asserts at its boundary.
    assertNormalizedMessage(out, { boundary: "onMessageCreate (issue #183 SDK shape)" });
  });

  it("yields NO ids (not a fallthrough) when a real manager holds zero role ids", async (t) => {
    const sdk = await sdkModels();
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");

    const member = makeRealGuildMember(sdk, { roles: [] });
    const out = normalizeFluxerMessage(
      { t: "MESSAGE_CREATE", d: gatewayMessage({ member }) },
      { instanceKey: "https://fluxer.test" },
    );

    assert.deepEqual(out.memberRoleIds, []);
    assertNormalizedMessage(out, { boundary: "onMessageCreate (issue #183 SDK shape)" });
  });

  it("resolves memberRoleIds from an SDK-message-shaped camelCase payload carrying a real GuildMember", async (t) => {
    const sdk = await sdkModels();
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");

    const member = makeRealGuildMember(sdk, { roles: [ROLE_STAFF, ROLE_SENIOR] });
    // What client.js's messageCreate hook actually passes: the hydrated
    // Message itself (camelCase fields; .member is the SDK's cached-member
    // getter returning a GuildMember).
    const out = normalizeFluxerMessage(
      {
        id: MSG_ID,
        channelId: CHANNEL_ID,
        guildId: GUILD_ID,
        author: { id: USER_ID, username: "staffy", bot: false },
        content: "!warn @user take five",
        createdAt: TS_ISO,
        mentionRoles: [ROLE_SENIOR],
        member,
      },
      { instanceKey: "https://fluxer.test" },
    );

    assert.ok(out, "expected a normalized message");
    assert.deepEqual(out.memberRoleIds, [ROLE_STAFF, ROLE_SENIOR]);
    assert.deepEqual(out.mentions.roles, [ROLE_SENIOR], "mentionRoles stays an ordinary id array");
    // Issue #201: the exact object client.js's messageCreate hook feeds the
    // pipeline (post-normalize) passes the boundary validator.
    assertNormalizedMessage(out, { boundary: "onMessageCreate (issue #183 SDK shape)" });
  });
});

describe("platform/fluxer/normalize — raw wire member.roles array (regression safety)", () => {
  it("still resolves memberRoleIds from a hand-built wire roles array", () => {
    const out = normalizeFluxerMessage(
      {
        t: "MESSAGE_CREATE",
        d: gatewayMessage({ member: { roles: [ROLE_STAFF, ROLE_SENIOR], nick: null } }),
      },
      { instanceKey: "https://fluxer.test" },
    );

    assert.deepEqual(out.memberRoleIds, [ROLE_STAFF, ROLE_SENIOR]);
    assertNormalizedMessage(out, { boundary: "onMessageCreate (wire-array regression shape)" });
  });

  it("defaults to [] when the payload carries no member or no roles", () => {
    const noMember = normalizeFluxerMessage(
      { t: "MESSAGE_CREATE", d: gatewayMessage({ member: undefined }) },
      { instanceKey: "https://fluxer.test" },
    );
    assert.deepEqual(noMember.memberRoleIds, []);
    assertNormalizedMessage(noMember, { boundary: "onMessageCreate (wire-array regression shape)" });

    const noRoles = normalizeFluxerMessage(
      { t: "MESSAGE_CREATE", d: gatewayMessage({ member: { nick: "hi" } }) },
      { instanceKey: "https://fluxer.test" },
    );
    assert.deepEqual(noRoles.memberRoleIds, []);
    assertNormalizedMessage(noRoles, { boundary: "onMessageCreate (wire-array regression shape)" });
  });
});
