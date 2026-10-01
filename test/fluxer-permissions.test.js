/**
 * Unit tests for src/platform/fluxer/permissions.js (PR 8) — the spec
 * § Permissions contract (roadmap/fluxer.md 507–566) and the Phase 0
 * checklist assertions (spec line 1140), verbatim where pinned.
 *
 * SDK-free (spec § Existing suites): loads fluxer/permissions.js with the
 * fake transport from test/helpers/fluxer.js. Bigint discipline is the point
 * of the module — every assertion keeps masks as BigInt end to end.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { cleanup } = loadDb();

const {
  hasBit,
  parsePermissionsBits,
  everyoneRoleId,
  computeChannelPermissions,
  resolveFluxerPermissions,
  ALL_PERMISSIONS,
  ADMINISTRATOR,
  MANAGE_GUILD,
} = require("../src/platform/fluxer/permissions");
const { createFluxerOutbound } = require("../src/platform/fluxer/outbound");
const {
  makeFakeRest,
  makeFakeHandle,
  gatewayMessage,
} = require("./helpers/fluxer");
const { normalizeFluxerMessage } = require("../src/platform/fluxer/normalize");
const { parsePrefix } = require("../src/platform/fluxer/commands");
const { dispatchPrefixCommand } = require("../src/platform/fluxer/dispatch");
const { buildDefaultRegistry } = require("../src/commands/registry");
const { ensureCommunity } = require("../src/platform/community");

after(cleanup);

const INSTANCE = "https://fluxer.test";
const GUILD = "1554590611015729152";
const CHANNEL = "555000111";
const BIT_54 = 1n << 54n; // VIEW_CHANNEL_MEMBERS — past Number.MAX_SAFE_INTEGER
const SEND_MESSAGES = 1n << 11n;

/** Capture console.warn calls for the closed-rule / rule-3 assertions. */
async function captureWarns(fn) {
  const orig = console.warn;
  const logged = [];
  console.warn = (...args) => logged.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return logged;
}

describe("fluxer/permissions — Phase 0 checklist (spec 1140, verbatim)", () => {
  it("hasBit is one hasBit(bigint, bigint): bit 54, ALL, and the Number guard", () => {
    assert.equal(hasBit(1n << 54n, 1n << 54n), true);
    assert.equal(hasBit(parsePermissionsBits((1n << 54n).toString()), 1n << 54n), true);
    assert.equal(hasBit(parsePermissionsBits((1n << 54n).toString()), MANAGE_GUILD), false);
    assert.equal(Number.isSafeInteger(Number((1n << 54n).toString())), false, "that Number is not a mask");
    assert.equal(hasBit(ALL_PERMISSIONS, MANAGE_GUILD), true);
    assert.equal(ALL_PERMISSIONS, (1n << 64n) - 1n, "ALL is the CONCRETE uint64 mask");
    assert.equal(ADMINISTRATOR, 1n << 3n);
    assert.equal(MANAGE_GUILD, 1n << 5n);
  });

  it("hasBit refuses non-bigint arguments (the string signature is not supported)", () => {
    // Spec 542: hasBit("18014398509481984", 54n) is NOT a supported signature.
    assert.throws(() => hasBit("18014398509481984", 54n), TypeError);
    assert.throws(() => hasBit(54n, 54), TypeError, "a bit INDEX is not a mask");
    assert.throws(() => hasBit(1n << 54n, Number(1n << 54n)), TypeError);
  });

  it("parsePermissionsBits is the closed rule: decimal 1–20 chars only, bad → 0n + warn", async () => {
    assert.equal(parsePermissionsBits("0"), 0n);
    assert.equal(parsePermissionsBits("18014398509481984"), 1n << 54n);
    assert.equal(parsePermissionsBits("18446744073709551615"), (1n << 64n) - 1n);
    assert.equal(parsePermissionsBits("00032"), 32n, "leading zeros parse (never compare masks on the string)");

    const warns = await captureWarns(async () => {
      for (const bad of ["", "1e10", "-32", "0x20", "32 ", " 32", "32n", "1".repeat(21), 32, 32n, null, undefined, {}]) {
        assert.equal(parsePermissionsBits(bad), 0n, `closed rule: ${String(bad)} ⇒ 0n`);
      }
    });
    assert.equal(warns.length, 13, "every invalid mask is logged (spec 516: a bad mask is 0n AND logged)");
    assert.ok(
      warns.every((w) => w.startsWith("[fluxer] invalid permissions mask, using 0:")),
      "the log line names the failure",
    );
    const long = warns[7];
    assert.ok(long.includes(JSON.stringify("1".repeat(20))), "echo is capped at 20 chars");
    assert.ok(!long.includes("1".repeat(21)), "never echo more than 20 characters");
  });

  it("everyoneRoleId is the recorded Phase 0 rule: String(guild.id)", () => {
    assert.equal(everyoneRoleId({ id: GUILD, name: "@everyone" }), GUILD);
    assert.equal(everyoneRoleId({ id: 42n }), "42", "coerced to string");
  });
});

describe("fluxer/permissions — computeChannelPermissions (pure algorithm)", () => {
  const guild = { id: GUILD, ownerId: "owner-1" };

  it("owner → ALL (spec 526)", () => {
    const perms = computeChannelPermissions({
      member: { id: "owner-1", roleIds: [] },
      guild,
      channel: null,
      roles: [{ id: GUILD, permissions: "0" }],
    });
    assert.equal(perms, ALL_PERMISSIONS);
  });

  it("administrator short-circuit ignores a channel deny (spec 531, checklist)", () => {
    const perms = computeChannelPermissions({
      member: { id: "u-1", roleIds: ["r-admin"] },
      guild,
      // A channel denying MANAGE_GUILD to the admin's role must NOT apply.
      channel: {
        permissionOverwrites: [{ id: "r-admin", type: 0, allow: "0", deny: String(MANAGE_GUILD) }],
      },
      roles: [
        { id: GUILD, permissions: "0" },
        { id: "r-admin", permissions: String(ADMINISTRATOR) },
      ],
    });
    assert.equal(perms, ALL_PERMISSIONS);
    assert.equal(hasBit(perms, MANAGE_GUILD), true);
  });

  it("a channel deny of the send bit clears it for a non-admin (checklist)", () => {
    const everyoneBase = SEND_MESSAGES | MANAGE_GUILD; // "2304"
    const perms = computeChannelPermissions({
      member: { id: "u-1", roleIds: [] },
      guild,
      // The everyone overwrite is keyed by the guild id (Phase 0), type 0.
      channel: {
        permissionOverwrites: [{ id: GUILD, type: 0, allow: "0", deny: String(SEND_MESSAGES) }],
      },
      roles: [{ id: GUILD, permissions: String(everyoneBase) }],
    });
    assert.equal(perms, MANAGE_GUILD, "send bit denied, the rest of the base survives");
    assert.equal(hasBit(perms, SEND_MESSAGES), false, "checklist: send bit cleared for a non-admin");
    assert.equal(hasBit(perms, MANAGE_GUILD), true);
  });

  it("the everyone role's mask is unioned before member roles (checklist)", () => {
    const perms = computeChannelPermissions({
      member: { id: "u-1", roleIds: ["r-mod"] },
      guild,
      channel: null,
      roles: [
        { id: GUILD, permissions: String(SEND_MESSAGES) }, // base 2048
        { id: "r-mod", permissions: String(MANAGE_GUILD) }, // role 32
      ],
    });
    assert.equal(perms, SEND_MESSAGES | MANAGE_GUILD, "union: everyone | role");
  });

  it("role overwrites union as (perms & ~deny) | allow (type 0 = role, Phase 0 field name)", () => {
    const perms = computeChannelPermissions({
      member: { id: "u-1", roleIds: ["r-mod"] },
      guild,
      channel: {
        permissionOverwrites: [{ id: "r-mod", type: 0, allow: "512", deny: String(SEND_MESSAGES) }],
      },
      roles: [
        { id: GUILD, permissions: String(SEND_MESSAGES | MANAGE_GUILD) },
        { id: "r-mod", permissions: "0" },
      ],
    });
    assert.equal(perms, MANAGE_GUILD | 512n, "send denied, bit 9 allowed, manage guild kept");
  });

  it("the member overwrite (type 1 = member) applies last", () => {
    const perms = computeChannelPermissions({
      member: { id: "u-1", roleIds: [] },
      guild,
      channel: {
        permissionOverwrites: [
          { id: GUILD, type: 0, allow: "0", deny: "0" },
          { id: "u-1", type: 1, allow: "0", deny: String(MANAGE_GUILD) },
        ],
      },
      roles: [{ id: GUILD, permissions: String(SEND_MESSAGES | MANAGE_GUILD) }],
    });
    assert.equal(perms, SEND_MESSAGES, "the member deny strips MANAGE_GUILD last");
  });

  it("deny-then-allow: a bit in BOTH of one overwrite ends allowed (spec 532/538 order)", () => {
    const perms = computeChannelPermissions({
      member: { id: "u-1", roleIds: [] },
      guild,
      channel: {
        permissionOverwrites: [
          { id: "u-1", type: 1, allow: String(MANAGE_GUILD), deny: String(MANAGE_GUILD) },
        ],
      },
      roles: [{ id: GUILD, permissions: "0" }],
    });
    assert.equal(perms, MANAGE_GUILD, "deny applies first, then allow re-sets the bit");
  });

  it("role objects are matched by id and parsed from DECIMAL STRINGS (bit 54 safe)", () => {
    const perms = computeChannelPermissions({
      member: { id: "u-1", roleIds: ["555", "666"] },
      guild,
      channel: null,
      roles: [
        { id: GUILD, permissions: "0" },
        { id: "555", permissions: (1n << 54n).toString() },
        { id: "666", permissions: "32" },
      ],
    });
    assert.equal(perms, BIT_54 | 32n, "a bit-54 mask survives — no Number() on the way");
  });

  it("everyone role missing from a populated role list → base 0n + rule-3 log (spec 563)", async () => {
    let perms;
    const warns = await captureWarns(async () => {
      perms = computeChannelPermissions(
        {
          member: { id: "u-1", roleIds: ["r-mod"] },
          guild,
          channel: null,
          roles: [{ id: "r-mod", permissions: String(MANAGE_GUILD) }], // no role with id == guild.id
        },
        INSTANCE,
      );
    });
    assert.equal(perms, MANAGE_GUILD, "member role bits still apply; the everyone base is dropped, not guessed");
    assert.equal(warns.length, 1);
    assert.equal(warns[0], `[fluxer] ${INSTANCE} everyone role missing guild=${GUILD}`);
  });

  it("nullish inputs fail closed to 0n (no member, no roles, no channel)", async () => {
    let perms;
    const warns = await captureWarns(async () => {
      perms = computeChannelPermissions({});
    });
    assert.equal(perms, 0n);
    assert.equal(warns.length, 0, "an ABSENT role list is a cache miss, not a missing everyone role");
  });
});

describe("fluxer/permissions — resolveFluxerPermissions (fail-closed, spec 559–564)", () => {
  const COMMUNITY_ID = ensureCommunity({
    platform: "fluxer",
    instanceKey: INSTANCE,
    externalGuildId: GUILD,
  });

  it("a gateway member payload costs ZERO REST calls (instance-cache path)", async () => {
    const rest = makeFakeRest({ routes: {} });
    const { outbound } = makeFakeHandle({ rest });
    const res = await resolveFluxerPermissions({
      outbound,
      communityId: COMMUNITY_ID,
      userId: "5",
      channelId: CHANNEL,
      instanceKey: INSTANCE,
      member: { roleIds: [], bot: false, username: "tester" },
    });
    assert.equal(res.ok, true);
    assert.equal(res.channelPermissions, 0n, "no role ids → fail-closed 0n mask");
    assert.deepEqual(res.memberRoleIds, []);
    assert.equal(res.memberBot, false);
    assert.deepEqual(res.author, { id: "5", username: "tester", bot: false });
    assert.deepEqual(rest.calls, [], "a roleless gateway member must not fan out to the network");
  });

  it("rule 1: member fetch failure → ok:false with the exact copy (handler not called)", async () => {
    const rest = makeFakeRest({ routes: {} }); // GET member → 404 FAKE_NO_ROUTE
    const { outbound } = makeFakeHandle({ rest });
    const res = await resolveFluxerPermissions({
      outbound,
      communityId: COMMUNITY_ID,
      userId: "ghost",
      channelId: CHANNEL,
      instanceKey: INSTANCE,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "member_unresolvable");
    assert.ok(
      res.error.startsWith("Could not resolve your member record:"),
      `spec-pinned copy, got: ${res.error}`,
    );
    assert.ok(rest.calls.some((c) => c.method === "GET" && c.path === `/v1/guilds/${GUILD}/members/ghost`));
  });

  it("rule 1: a throwing fetchMember is caught, never a rejection", async () => {
    const fakeOutbound = {
      async fetchMember() {
        throw new Error("socket hung up");
      },
    };
    const orig = console.error;
    console.error = () => {};
    try {
      const res = await resolveFluxerPermissions({
        outbound: fakeOutbound,
        communityId: COMMUNITY_ID,
        userId: "5",
        channelId: CHANNEL,
        instanceKey: INSTANCE,
      });
      assert.equal(res.ok, false);
      assert.equal(res.code, "member_unresolvable");
    } finally {
      console.error = orig;
    }
  });

  it("rule 2: roles missing with role ids → fetchRoles; failure fails closed to 0n, role ids still returned", async () => {
    const rest = makeFakeRest({ routes: {} }); // GET roles → 404 → []
    const { outbound } = makeFakeHandle({ rest });
    const res = await resolveFluxerPermissions({
      outbound,
      communityId: COMMUNITY_ID,
      userId: "5",
      channelId: CHANNEL,
      instanceKey: INSTANCE,
      member: { roleIds: ["r-mod"], bot: false },
    });
    assert.equal(res.ok, true, "the handler may run: the staff_roles table is consulted from memberRoleIds");
    assert.equal(res.channelPermissions, 0n, "role objects unresolvable → mask stays 0n (not admin)");
    assert.deepEqual(res.memberRoleIds, ["r-mod"]);
    assert.ok(rest.calls.some((c) => c.method === "GET" && c.path === `/v1/guilds/${GUILD}/roles`));
  });

  it("rule 2 tail: role ids missing → the roles copy", async () => {
    const fakeOutbound = {
      async fetchMember() {
        return { id: "5", username: "no-roles", bot: false }; // no roleIds array
      },
    };
    const res = await resolveFluxerPermissions({
      outbound: fakeOutbound,
      communityId: COMMUNITY_ID,
      userId: "5",
      channelId: CHANNEL,
      instanceKey: INSTANCE,
      member: { roleIds: null }, // payload member without role ids → fetchMember
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "roles_unresolvable");
    assert.ok(res.error.startsWith("Could not resolve your roles:"), `spec copy, got: ${res.error}`);
  });

  it("guild owner → ALL through the fetch path (fetchGuild feeds the owner check)", async () => {
    const rest = makeFakeRest({
      routes: {
        "GET /v1/guilds/99887766/roles": [{ id: "99887766", permissions: "0" }],
      },
    });
    const handle = {
      instanceKey: INSTANCE,
      userId: "bot-1",
      rest,
      fetchGuild: async () => ({ id: "99887766", name: "B", ownerId: "u-owner", afkChannelId: null }),
    };
    const outbound = createFluxerOutbound(handle);
    const cid = ensureCommunity({ platform: "fluxer", instanceKey: INSTANCE, externalGuildId: "99887766" });
    const res = await resolveFluxerPermissions({
      outbound,
      communityId: cid,
      userId: "u-owner",
      channelId: CHANNEL,
      instanceKey: INSTANCE,
      member: { roleIds: [], bot: false },
    });
    assert.equal(res.ok, true);
    assert.equal(res.channelPermissions, ALL_PERMISSIONS);
    assert.equal(hasBit(res.channelPermissions, MANAGE_GUILD), true);
  });

  it("a Manage Guild role resolves through fetchRoles (the staff gate's admin path)", async () => {
    const rest = makeFakeRest({
      routes: {
        "GET /v1/guilds/99887766/roles": [
          { id: "99887766", permissions: "18014536052624961" }, // Phase 0 base mask
          { id: "r-mod", permissions: "32" }, // MANAGE_GUILD only
        ],
      },
    });
    const handle = {
      instanceKey: INSTANCE,
      userId: "bot-1",
      rest,
      // Not the owner — the mask must come from the role math, not the owner rule.
      fetchGuild: async () => ({ id: "99887766", name: "B", ownerId: "someone-else", afkChannelId: null }),
    };
    const outbound = createFluxerOutbound(handle);
    const cid = ensureCommunity({ platform: "fluxer", instanceKey: INSTANCE, externalGuildId: "99887766" });
    const res = await resolveFluxerPermissions({
      outbound,
      communityId: cid,
      userId: "u-mod",
      channelId: CHANNEL,
      instanceKey: INSTANCE,
      member: { roleIds: ["r-mod"], bot: false },
    });
    assert.equal(res.ok, true);
    // Base 18014536052624961 | 32; the base has no bit 5, so 32 comes from the role.
    assert.equal(res.channelPermissions & MANAGE_GUILD, MANAGE_GUILD);
    assert.equal(hasBit(res.channelPermissions, 1n << 54n), true, "the @everyone base mask rides along");
  });

  it("channel overwrites reach the mask through fetchChannel (role deny path)", async () => {
    const rest = makeFakeRest({
      routes: {
        "GET /v1/guilds/99887766/roles": [
          { id: "99887766", permissions: "32" },
          { id: "r-mod", permissions: "0" },
        ],
        "GET /v1/channels/777": {
          id: "777",
          type: 0,
          permission_overwrites: [{ id: "r-mod", type: 0, allow: "0", deny: "32" }],
        },
      },
    });
    const handle = {
      instanceKey: INSTANCE,
      userId: "bot-1",
      rest,
      // Not the owner: the mask must come from everyone base 32, then the
      // channel's role deny must clear it.
      fetchGuild: async () => ({ id: "99887766", name: "B", ownerId: "someone-else", afkChannelId: null }),
    };
    const outbound = createFluxerOutbound(handle);
    const cid = ensureCommunity({ platform: "fluxer", instanceKey: INSTANCE, externalGuildId: "99887766" });
    const res = await resolveFluxerPermissions({
      outbound,
      communityId: cid,
      userId: "u-mod",
      channelId: "777",
      instanceKey: INSTANCE,
      member: { roleIds: ["r-mod"], bot: false },
    });
    assert.equal(res.ok, true);
    assert.equal(res.channelPermissions, 0n, "the @everyone 32 is denied by the role overwrite in THIS channel");
  });
});

describe("fluxer/permissions — dispatch integration (step 2.5, fail closed)", () => {
  const COMMUNITY_ID = ensureCommunity({
    platform: "fluxer",
    instanceKey: INSTANCE,
    externalGuildId: GUILD,
  });
  const registry = buildDefaultRegistry();
  const P = { registryCommands: registry.commands, prefix: "!" };

  function fluxerMessage(overrides = {}) {
    const normalized = normalizeFluxerMessage(
      {
        t: "MESSAGE_CREATE",
        d: gatewayMessage({ content: "", channel_id: CHANNEL, guild_id: GUILD, ...overrides }),
      },
      { instanceKey: INSTANCE },
    );
    normalized.communityId = COMMUNITY_ID;
    return normalized;
  }

  it("a member record the gateway did not carry + fetch failure aborts BEFORE the handler", async () => {
    const rest = makeFakeRest({ routes: { [`POST /v1/channels/${CHANNEL}/messages`]: { id: "d-1" } } });
    const { outbound } = makeFakeHandle({ rest });
    const message = fluxerMessage({ content: "!xp" });
    delete message.memberRoleIds; // simulate a payload without the member record
    message.memberRoleIds = null;
    const parsed = parsePrefix("!xp", P);
    assert.ok(parsed && !parsed.usageError);

    const orig = console.error;
    console.error = () => {};
    try {
      await dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor: null });
    } finally {
      console.error = orig;
    }

    const posts = rest.calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
    assert.equal(posts.length, 1, "exactly one reply, no handler DM");
    assert.ok(
      posts[0].body.content.startsWith("Could not resolve your member record:"),
      `the specific fail-closed copy, got: ${posts[0].body.content}`,
    );
    assert.ok(
      !rest.calls.some((c) => c.path === "/v1/users/@me/channels"),
      "the /xp handler never ran (its DM channel open is absent)",
    );
  });

  it("a gateway member payload adds ZERO GET calls to a normal command run", async () => {
    const rest = makeFakeRest({
      routes: {
        "POST /v1/users/@me/channels": { id: "dm-42", type: 1 },
        "POST /v1/channels/dm-42/messages": { id: "r-1" },
        "GET /v1/guilds/1554590611015729152/roles": [{ id: GUILD, permissions: "0" }],
        [`GET /v1/channels/${CHANNEL}`]: { id: CHANNEL, type: 0, permission_overwrites: null },
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const message = fluxerMessage({ content: "!xp" });
    const parsed = parsePrefix("!xp", P);

    await dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor: null });

    assert.equal(rest.calls[0].method, "POST", "permission resolution never precedes the reply path");
    assert.equal(rest.calls[0].path, "/v1/users/@me/channels");
    assert.equal(
      rest.calls.filter((c) => c.method === "GET").length,
      0,
      "the member payload IS the instance cache — a roleless author costs no REST",
    );
  });

  it("a member WITH roles resolves masks through the REST routes (staff admin path)", async () => {
    const rest = makeFakeRest({
      routes: {
        "GET /v1/guilds/1554590611015729152/roles": [
          { id: GUILD, permissions: "0" },
          { id: "r-admin", permissions: String(ADMINISTRATOR) },
        ],
        [`GET /v1/channels/${CHANNEL}`]: { id: CHANNEL, type: 0, permission_overwrites: [] },
        "POST /v1/users/@me/channels": { id: "dm-9", type: 1 },
        "POST /v1/channels/dm-9/messages": { id: "r-9" },
      },
    });
    const handle = {
      instanceKey: INSTANCE,
      userId: "bot-1",
      rest,
      fetchGuild: async () => ({ id: GUILD, name: "B", ownerId: "someone-else", afkChannelId: null }),
    };
    handle.outbound = createFluxerOutbound(handle);
    const message = fluxerMessage({ content: "!xp" });
    message.memberRoleIds = ["r-admin"];
    const parsed = parsePrefix("!xp", P);

    await dispatchPrefixCommand(handle.outbound, message, parsed, { registry, supervisor: null });

    // The handler ran (its DM went out) and roles were consulted exactly once.
    assert.ok(rest.calls.some((c) => c.path === "/v1/channels/dm-9/messages"));
    assert.equal(
      rest.calls.filter((c) => c.method === "GET" && c.path === "/v1/guilds/1554590611015729152/roles").length,
      1,
      "fetchRoles runs exactly once for the member's role ids",
    );
  });
});
