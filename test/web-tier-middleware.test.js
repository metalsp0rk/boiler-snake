/**
 * Subtask 07 — tier resolution gate (roadmap/web-admin.md §8.3 tier +
 * degradation tables, §8.6 cross-cutting 404, §8.1-5/8; §8.8 Phase 0b "tier
 * middleware matrix"). FULLY OFFLINE: fake discordApi objects, fake store,
 * fake clock; real SQLite for staff_roles (the §8.3 "uncached, cheap" input
 * stays real). node --test only.
 *
 * Suites:
 *  A. resolveTier pure matrix incl. bitset edge cases (ADMINISTRATOR-without-
 *     MANAGE_GUILD, decimal-string BigInt parsing incl. a value a Number-based
 *     check would false-positive on, owner, junk/fail-closed strings);
 *  B. equivalence proof vs src/core/permissions.js slash gates for identical
 *     (roleIds, manageGuildBit, staffRoleIds) inputs (§8.1-5) — real
 *     PermissionsBitField + real staff_roles rows;
 *  C. resolver: anon, bot∩ membership, staff/senior/admin paths, decrypt /
 *     expiry / 401 ⇒ re-auth, member-left deny + guild-list refresh,
 *     snapshot-admin survives member-fetch outage, staff/senior deny+retry
 *     under the same outage, fake-clock TTL (role ids + guild list), uncached
 *     staff_roles (revocation), cache invalidation;
 *  D. HTTP middleware (express + real session rows + fetch): anon → login
 *     redirect parity with guildShell, tier matrix staff/senior/admin ×
 *     routes, cross-guild probe ⇒ 404 "Not found" (never 403/302),
 *     decrypt-fail row ⇒ re-auth redirect, requireTier mount-bug ⇒ 500.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// ---------------------------------------------------------------------------
// loadDb() FIRST: clears the src require cache and binds DB_PATH to a temp
// file, so every src module below (and the db singleton the gates and
// repositories share) runs against the test DB.
// ---------------------------------------------------------------------------
const { api, tmpDir } = loadDb();

const {
  resolveTier,
  staffRoleTierFor,
  snapshotGrantsAdmin,
  parsePermissionsBits,
  createGuildAccessResolver,
  TIER_RANK,
} = require("../src/web/auth/guildAccess");
const {
  createGuildScopeMiddleware,
  loginRedirectTarget,
} = require("../src/web/middleware/guildScope");
const { requireTier } = require("../src/web/middleware/requireTier");
const { createSessionMiddleware } = require("../src/web/middleware/session");
const permissions = require("../src/core/permissions");
const sessionPolicy = require("../src/web/auth/sessions");
const tokens = require("../src/web/auth/tokens");
const { PermissionsBitField, PermissionFlagsBits } = require("discord.js");

// Clearly-fake placeholder secret (AGENTS.md: never real-looking secrets).
const SESSION_SECRET = "test-ti…-abc";

const USER_ADMIN = "428190112345678901";
const USER_SENIOR = "428190112345678902";
const USER_STAFF = "428190112345678903";
const USER_PLAIN = "428190112345678904";

const GUILD_A = "100000000000000001"; // the served guild (bot∩user)
const GUILD_B = "200000000000000002"; // exists, but never in the viewer's list
const GUILD_NOBOT = "300000000000000003"; // user's guild, bot NOT in it

const ROLE_JUNIOR = "500000000000000011";
const ROLE_SENIOR = "500000000000000012";
const ROLE_NOISE = "500000000000000013"; // in the guild, not a staff role

const ENV_KEYS = ["SESSION_SECRET", "CLIENT_SECRET", "PUBLIC_BASE_URL", "WEB_TIER_CACHE_TTL_MS"];
let savedEnv;

/** Decimal bitset helpers (BigInt — never Number on permission strings). */
const DEC = (bits) => bits.toString(10);
const MG = 1n << 5n; // MANAGE_GUILD
const ADMIN = 1n << 3n; // ADMINISTRATOR
const ALL_BITS = Object.values(PermissionFlagsBits).reduce((acc, b) => acc | b, 0n);

before(() => {
  savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
  process.env.SESSION_SECRET = SESSION_SECRET;
  delete process.env.CLIENT_SECRET;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.WEB_TIER_CACHE_TTL_MS;
  api.addStaffRole(GUILD_A, ROLE_JUNIOR, "junior");
  api.addStaffRole(GUILD_A, ROLE_SENIOR, "senior");
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv?.[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ===========================================================================
// A. resolveTier — pure decision matrix (§8.3)
// ===========================================================================
describe("resolveTier (pure)", () => {
  const ctx = (snapshotEntry, memberRoleIds = null, staffRoleTier = null) => ({
    snapshotEntry,
    memberRoleIds,
    staffRoleTier,
  });

  it("owner:true is admin even with zero permissions (owner override)", () => {
    assert.equal(resolveTier(GUILD_A, ctx({ owner: true, permissions: "0" })), "admin");
    // Precedence: admin outranks everything, even an unresolvable member.
    assert.equal(
      resolveTier(GUILD_A, ctx({ owner: true, permissions: "0" }, null, "staff")),
      "admin"
    );
  });

  it("MANAGE_GUILD bit ⇒ admin; ADMINISTRATOR bit ALONE ⇒ admin (mirror of Discord's member_permissions expansion)", () => {
    assert.equal(resolveTier(GUILD_A, ctx({ owner: false, permissions: DEC(MG) })), "admin");
    assert.equal(resolveTier(GUILD_A, ctx({ owner: false, permissions: DEC(ADMIN) })), "admin");
    assert.equal(
      resolveTier(GUILD_A, ctx({ owner: false, permissions: DEC(MG | ADMIN) })),
      "admin"
    );
  });

  it("decimal-string BigInt parsing: >2^53 bitsets incl. a trap a Number-based check would false-positive on", () => {
    // 2^53 exact as a double but bits 3/5 clear ⇒ NOT admin.
    assert.equal(
      resolveTier(GUILD_A, ctx({ owner: false, permissions: "9007199254740992" }, [], null)),
      null
    );
    // 2^63-1 (all low bits set) ⇒ admin — impossible to check with Number.
    assert.equal(
      resolveTier(GUILD_A, ctx({ owner: false, permissions: "9223372036854775807" })),
      "admin"
    );
    // 2^64-64: bits 0-5 CLEAR (no MANAGE_GUILD/ADMINISTRATOR) but a JS Number
    // rounds it to 2^64 whose low bits look "all set" — a Number-based gate
    // would wrongly mint admin here. BigInt must not.
    assert.equal(
      resolveTier(
        GUILD_A,
        ctx({ owner: false, permissions: "18446744073709551552" }, [ROLE_JUNIOR], "staff")
      ),
      "staff"
    );
    // Big non-admin bitset alone ⇒ no tier at all.
    assert.equal(
      resolveTier(GUILD_A, ctx({ owner: false, permissions: "104324673" }, [], null)),
      null
    );
  });

  it("malformed permissions strings fail CLOSED to non-admin (never minted, never thrown)", () => {
    assert.equal(parsePermissionsBits("not-a-number"), 0n);
    assert.equal(parsePermissionsBits("1e10"), 0n); // scientific notation: junk
    assert.equal(parsePermissionsBits("-32"), 0n); // two's-complement BigInt & trap
    assert.equal(parsePermissionsBits(""), 0n);
    assert.equal(parsePermissionsBits(32), 0n); // wrong type: junk
    assert.equal(parsePermissionsBits("32"), 32n);
    for (const junk of ["-32", "1e10", "not-a-number", "", undefined, 32]) {
      assert.equal(
        resolveTier(GUILD_A, ctx({ owner: false, permissions: junk }, [], null)),
        null,
        `permissions=${JSON.stringify(junk)} must never mint admin`
      );
    }
  });

  it("staff/senior need resolvable role ids; memberRoleIds=null is deny, not a guess", () => {
    assert.equal(
      resolveTier(GUILD_A, ctx({ owner: false, permissions: "0" }, null, "senior")),
      null,
      "senior staffTier without role ids ⇒ unresolvable ⇒ null (§8.3 matrix)"
    );
    assert.equal(resolveTier(GUILD_A, ctx({ owner: false, permissions: "0" }, [], null)), null);
    assert.equal(
      resolveTier(GUILD_A, ctx({ owner: false, permissions: "0" }, [ROLE_JUNIOR], "staff")),
      "staff"
    );
    assert.equal(
      resolveTier(GUILD_A, ctx({ owner: false, permissions: "0" }, [ROLE_SENIOR], "senior")),
      "senior"
    );
  });

  it("precedence admin > senior > staff and snapshot-missing falls through", () => {
    assert.equal(
      resolveTier(GUILD_A, ctx({ owner: false, permissions: DEC(MG) }, [ROLE_SENIOR], "senior")),
      "admin"
    );
    assert.equal(resolveTier(GUILD_A, ctx(null, [ROLE_SENIOR], "senior")), "senior");
    assert.equal(resolveTier(GUILD_A, ctx(undefined, [], null)), null);
    assert.equal(snapshotGrantsAdmin({ owner: false, permissions: "0" }), false);
    assert.equal(snapshotGrantsAdmin(null), false);
  });
});

// ===========================================================================
// B. Slash↔web equivalence (§8.1-5): same (roleIds, manageGuildBit,
// staffRoleIds) inputs ⇒ web tier rank ⇔ core/permissions.js gates.
// Mapping rule (web-login-notes.md §4/§6): Discord COMPUTES interaction
// member_permissions with the ADMINISTRATOR short-circuit expanded and the
// owner holding all bits; the /users/@me/guilds bitset is the raw OR-
// aggregate without that expansion. So the equivalent slash view of a
// snapshot is: admin-bearing snapshot ⇒ ALL bits in memberPermissions.
// ===========================================================================
describe("guildAccess ⇔ src/core/permissions.js equivalence", () => {
  function slashView(guildId, bits, roleIds) {
    const interaction = {
      guildId,
      memberPermissions: new PermissionsBitField(bits),
      member: { roles: { cache: new Map(roleIds.map((id) => [id, {}])) } },
    };
    return {
      admin: permissions.isAdminOrMod(interaction) === true,
      staff: permissions.isStaff(interaction) === true,
      senior: permissions.isSeniorStaff(interaction) === true,
    };
  }

  function webView(snapshotEntry, roleIds, guildId = GUILD_A) {
    const staffRoleTier = staffRoleTierFor(guildId, roleIds, {
      memberHasStaffRole: api.memberHasStaffRole,
      memberHasSeniorStaffRole: api.memberHasSeniorStaffRole,
    });
    return resolveTier(guildId, {
      snapshotEntry,
      memberRoleIds: roleIds,
      staffRoleTier,
    });
  }

  function assertEquivalent(label, snapshotEntry, roleIds, guildId = GUILD_A) {
    const bitsBigInt =
      typeof snapshotEntry?.permissions === "string" && /^\d+$/.test(snapshotEntry.permissions)
        ? BigInt(snapshotEntry.permissions)
        : 0n;
    const ownerOrAdmin = snapshotEntry?.owner === true || (bitsBigInt & ADMIN) === ADMIN;
    const slash = slashView(guildId, ownerOrAdmin ? ALL_BITS : bitsBigInt, roleIds);
    const tier = webView(snapshotEntry, roleIds, guildId);
    const rank = tier ? TIER_RANK[tier] : 0;
    assert.equal(tier === "admin", slash.admin, `${label}: admin mismatch (tier=${tier})`);
    assert.equal(rank >= TIER_RANK.staff, slash.staff, `${label}: staff mismatch (tier=${tier})`);
    assert.equal(rank >= TIER_RANK.senior, slash.senior, `${label}: senior mismatch (tier=${tier})`);
  }

  const cases = [
    ["manage_guild only, no roles", { owner: false, permissions: DEC(MG) }, []],
    ["administrator only, no roles", { owner: false, permissions: DEC(ADMIN) }, []],
    ["owner, zero perms", { owner: true, permissions: "0" }, []],
    ["no perms, junior staff role", { owner: false, permissions: "0" }, [ROLE_JUNIOR]],
    ["no perms, senior staff role", { owner: false, permissions: "0" }, [ROLE_SENIOR]],
    ["no perms, junior+senior roles", { owner: false, permissions: "0" }, [ROLE_JUNIOR, ROLE_SENIOR]],
    ["no perms, non-staff role only", { owner: false, permissions: "0" }, [ROLE_NOISE]],
    ["no perms, no roles", { owner: false, permissions: "0" }, []],
    [
      "big non-admin bitset + junior",
      { owner: false, permissions: "18446744073709551552" },
      [ROLE_JUNIOR],
    ],
    ["manage_guild + senior staff role", { owner: false, permissions: DEC(MG) }, [ROLE_SENIOR]],
  ];

  for (const [label, snap, roles] of cases) {
    it(`matches the slash gates: ${label}`, () => assertEquivalent(label, snap, roles));
  }

  it("staff roles are guild-scoped in both transports (role of guild B is noise in A)", () => {
    assertEquivalent("guild-scoped (in A)", { owner: false, permissions: "0" }, [ROLE_JUNIOR]);
    // The same role id is NOT a staff role of GUILD_B in either transport:
    assert.equal(webView({ owner: false, permissions: "0" }, [ROLE_JUNIOR], GUILD_B), null);
    assert.equal(
      permissions.isStaff({
        guildId: GUILD_B,
        memberPermissions: new PermissionsBitField(0n),
        member: { roles: { cache: new Map([[ROLE_JUNIOR, {}]]) } },
      }),
      false
    );
  });
});

// ===========================================================================
// C. createGuildAccessResolver — degradation matrix + caches (fake clock)
// ===========================================================================
describe("guildAccess resolver (fakes + fake clock)", () => {
  const FAR = Date.now() + 24 * 3600_000;

  /**
   * Fake discordApi + store + clock. Tokens encode the user id
   * ("tok-<userId>") so the member fake can look up fixtures per user.
   */
  function makeHarness(cfg = {}) {
    const state = {
      clock: Date.now(),
      guildsCalls: 0,
      memberCalls: 0,
      userGuilds: cfg.userGuilds ?? [
        { id: GUILD_A, name: "A", icon: null, owner: false, permissions: "0" },
      ],
      botGuilds: cfg.botGuilds ?? [GUILD_A],
      memberRolesByUserGuild: cfg.memberRolesByUserGuild ?? {},
      guildsFail: cfg.guildsFail ?? null, // Error with .status to simulate
      memberFail: cfg.memberFail ?? null,
      botGuildsThrow: cfg.botGuildsThrow ?? false,
      snapshot: cfg.snapshot ?? null, // stored guild_snapshot for fallback
      // Tokens encode the user id ("tok-<userId>") so the member fake can
      // resolve per-user fixtures without a real Discord round-trip.
      token: cfg.token ?? `tok-${cfg.userId ?? USER_STAFF}`,
      tokenExpiresAt: cfg.tokenExpiresAt ?? FAR,
      ttlMs: cfg.ttlMs ?? 60_000,
    };

    const discord = {
      async getUserGuilds() {
        state.guildsCalls += 1;
        if (state.guildsFail) throw state.guildsFail;
        return state.userGuilds.map((g) => ({ ...g }));
      },
      async getUserGuildMember(token, guildId) {
        state.memberCalls += 1;
        if (state.memberFail) throw state.memberFail;
        const userId = String(token).replace(/^tok-/, "");
        const roles = state.memberRolesByUserGuild[`${userId}:${guildId}`];
        if (!roles) {
          const err = new Error("Unknown Guild");
          err.status = 404;
          throw err;
        }
        return { roles: [...roles] };
      },
    };

    const store = {
      getWebSessionAuth: () => ({
        id: "sess-1",
        access_token_enc: state.token,
        token_expires_at: state.tokenExpiresAt,
        scopes: "identify guilds guilds.members.read",
        guild_snapshot: state.snapshot,
      }),
    };
    const tokenApi = {
      decryptAccessToken: (env) => {
        if (typeof env === "string" && env.startsWith("tok-")) return env;
        const err = new Error("web session token envelope failed verification");
        err.code = "web_token_envelope_invalid";
        throw err;
      },
    };

    const resolver = createGuildAccessResolver({
      discord,
      store,
      tokenApi,
      botGuilds: async () => {
        if (state.botGuildsThrow) throw new Error("client torn down");
        return [...state.botGuilds];
      },
      now: () => state.clock,
      ttlMs: state.ttlMs,
    });
    const session = { id: "sess-1", userId: cfg.userId ?? USER_STAFF };
    return { resolver, state, session };
  }

  const staffMember = { [`${USER_STAFF}:${GUILD_A}`]: [ROLE_JUNIOR] };
  const seniorMember = { [`${USER_SENIOR}:${GUILD_A}`]: [ROLE_SENIOR, ROLE_NOISE] };

  it("anonymous sessions short-circuit to 'anon'", async () => {
    const { resolver } = makeHarness();
    assert.deepEqual(await resolver.resolve(null, GUILD_A), { status: "anon" });
  });

  it("bot∩user membership gates the list: stranger and bot-absent guilds deny with ZERO member fetches", async () => {
    // Guild in the user's list but not the bot's (§8.3 row 1).
    const h1 = makeHarness({
      userGuilds: [
        { id: GUILD_NOBOT, owner: false, permissions: "0" },
      ],
      memberRolesByUserGuild: staffMember,
    });
    const r1 = await h1.resolver.resolve(h1.session, GUILD_NOBOT);
    assert.equal(r1.status, "deny");
    assert.equal(r1.reason, "not_in_access_list");
    assert.equal(h1.state.memberCalls, 0, "no escalation via member fetch on hidden guilds");

    // Guild in nobody's list at all.
    const h2 = makeHarness({ memberRolesByUserGuild: staffMember });
    const r2 = await h2.resolver.resolve(h2.session, GUILD_B);
    assert.equal(r2.status, "deny");
    assert.equal(r2.reason, "not_in_access_list");

    // Malformed guild id never reaches Discord.
    const r3 = await h2.resolver.resolve(h2.session, "oops");
    assert.equal(r3.status, "deny");
    assert.equal(r3.reason, "bad_guild_id");
  });

  it("bot-guild provider failure fails CLOSED (retry deny, not a grant)", async () => {
    const h = makeHarness({ botGuildsThrow: true, memberRolesByUserGuild: staffMember });
    const res = await h.resolver.resolve(h.session, GUILD_A);
    assert.equal(res.status, "deny");
    assert.equal(res.reason, "bot_guilds_unavailable");
    assert.equal(res.retry, true);
  });

  it("staff / senior tiers via role ids ∩ staff_roles (real SQLite rows)", async () => {
    const h = makeHarness({ memberRolesByUserGuild: staffMember });
    const res = await h.resolver.resolve(h.session, GUILD_A);
    assert.equal(res.status, "ok");
    assert.equal(res.tier, "staff");
    assert.equal(res.guildId, GUILD_A);

    const h2 = makeHarness({
      userId: USER_SENIOR,
      memberRolesByUserGuild: seniorMember,
    });
    const res2 = await h2.resolver.resolve(h2.session, GUILD_A);
    assert.equal(res2.status, "ok");
    assert.equal(res2.tier, "senior", "senior staff_roles.level wins over junior (§8.3)");

    // In-guild member with no staff role ⇒ deny (no_tier), NOT a 403 hint.
    const h3 = makeHarness({ userId: USER_PLAIN, memberRolesByUserGuild: {} });
    // no member fixture ⇒ 404 (member left) below; give them an empty membership:
    h3.state.memberRolesByUserGuild[`${USER_PLAIN}:${GUILD_A}`] = [];
    const res3 = await h3.resolver.resolve(h3.session, GUILD_A);
    assert.equal(res3.status, "deny");
    assert.equal(res3.reason, "no_tier");
  });

  it("admin fast path: snapshot owner needs NO member fetch (and survives member 404)", async () => {
    const h = makeHarness({
      userId: USER_ADMIN,
      userGuilds: [{ id: GUILD_A, owner: true, permissions: "104324673" }],
      memberRolesByUserGuild: {}, // member fetch would 404 — never attempted
    });
    const res = await h.resolver.resolve(h.session, GUILD_A);
    assert.equal(res.status, "ok");
    assert.equal(res.tier, "admin");
    assert.equal(h.state.memberCalls, 0, "admin resolves from the snapshot alone");
  });

  it("re-auth signals: missing token, expired token, decrypt failure, 401", async () => {
    const noTok = makeHarness({ token: "" });
    assert.equal((await noTok.resolver.resolve(noTok.session, GUILD_A)).status, "reauth");

    const expired = makeHarness({ tokenExpiresAt: Date.now() - 1000 });
    const r2 = await expired.resolver.resolve(expired.session, GUILD_A);
    assert.equal(r2.status, "reauth");
    assert.equal(r2.reason, "token_expired");

    const corrupt = makeHarness({ token: "v1.tampered.envelope.bytes" });
    const r3 = await corrupt.resolver.resolve(corrupt.session, GUILD_A);
    assert.equal(r3.status, "reauth");
    assert.equal(r3.reason, "token_decrypt_failed");

    const revoked = makeHarness({
      memberRolesByUserGuild: staffMember,
      guildsFail: Object.assign(new Error("Unauthorized"), { status: 401 }),
    });
    const r4 = await revoked.resolver.resolve(revoked.session, GUILD_A);
    assert.equal(r4.status, "reauth");
    assert.equal(r4.reason, "token_revoked");
  });

  it("member left (404): deny NOW + guild list refreshes NEXT resolve (§8.3 row 4)", async () => {
    const h = makeHarness({ memberRolesByUserGuild: {} }); // no member fixture ⇒ 404
    const r1 = await h.resolver.resolve(h.session, GUILD_A);
    assert.equal(r1.status, "deny");
    assert.equal(r1.reason, "member_left");
    assert.equal(h.state.guildsCalls, 1);

    // The left guild drops out of the refreshed intersection next resolve.
    h.state.userGuilds = [];
    const r2 = await h.resolver.resolve(h.session, GUILD_A);
    assert.equal(r2.status, "deny");
    assert.equal(r2.reason, "not_in_access_list");
    assert.equal(h.state.guildsCalls, 2, "list cache was invalidated ⇒ re-checked");
    assert.equal(h.state.memberCalls, 1, "member not re-fetched for a guild already gone");
  });

  it("member-fetch outage: snapshot-admin keeps working; staff/senior deny with retry + degraded banner flag (§8.3 row 2)", async () => {
    const boom = () => Object.assign(new Error("discord 5xx"), { status: 500 });

    const admin = makeHarness({
      userId: USER_ADMIN,
      userGuilds: [{ id: GUILD_A, owner: true, permissions: "0" }],
      memberFail: boom(),
    });
    const rAdmin = await admin.resolver.resolve(admin.session, GUILD_A);
    assert.equal(rAdmin.status, "ok", "admin tier resolves via snapshot during the outage");
    assert.equal(rAdmin.tier, "admin");

    const staff = makeHarness({ memberRolesByUserGuild: staffMember, memberFail: boom() });
    const rStaff = await staff.resolver.resolve(staff.session, GUILD_A);
    assert.equal(rStaff.status, "deny");
    assert.equal(rStaff.reason, "roles_unavailable");
    assert.equal(rStaff.retry, true);
    assert.equal(rStaff.degraded, true, "operator banner flag set (§8.3)");

    // Transient ⇒ retried on the next request (no negative caching).
    staff.state.memberFail = null;
    const rRetry = await staff.resolver.resolve(staff.session, GUILD_A);
    assert.equal(rRetry.status, "ok");
    assert.equal(rRetry.tier, "staff");
  });

  it("guild-list refresh failure falls back to stored snapshot ∩ bot list (degraded), bot filter still applies", async () => {
    const snapshot = [
      { id: GUILD_A, name: "A", icon: null, owner: true, permissions: "0" },
      { id: GUILD_NOBOT, name: "gone", icon: null, owner: false, permissions: "0" },
    ];
    const h = makeHarness({
      userId: USER_ADMIN,
      memberRolesByUserGuild: {},
      guildsFail: Object.assign(new Error("discord down"), { status: 503 }),
      snapshot: JSON.stringify(snapshot),
    });
    const res = await h.resolver.resolve(h.session, GUILD_A);
    assert.equal(res.status, "ok");
    assert.equal(res.tier, "admin");
    assert.equal(res.degraded, true, "stored-snapshot fallback is flagged (§8.3 row 3)");

    const r2 = await h.resolver.resolve(h.session, GUILD_NOBOT);
    assert.equal(r2.status, "deny", "bot-membership filter applies to the fallback too");
  });

  it("cache TTL (fake clock): role ids + guild list re-fetched at WEB_TIER_CACHE_TTL_MS, not before (§8.1-8)", async () => {
    const h = makeHarness({ memberRolesByUserGuild: staffMember, ttlMs: 60_000 });
    const t0 = h.state.clock;

    assert.equal((await h.resolver.resolve(h.session, GUILD_A)).tier, "staff");
    assert.deepEqual([h.state.guildsCalls, h.state.memberCalls], [1, 1]);

    h.state.clock = t0 + 30_000; // < TTL: served from cache
    assert.equal((await h.resolver.resolve(h.session, GUILD_A)).tier, "staff");
    assert.deepEqual([h.state.guildsCalls, h.state.memberCalls], [1, 1], "cached within TTL");

    h.state.clock = t0 + 60_000; // == TTL: stale ⇒ both re-checked
    assert.equal((await h.resolver.resolve(h.session, GUILD_A)).tier, "staff");
    assert.deepEqual([h.state.guildsCalls, h.state.memberCalls], [2, 2], "revocation bounded by TTL");
  });

  it("staff_roles stays UNCACHED: role revocation lands immediately (§8.3 'none (cheap)')", async () => {
    const h = makeHarness({ memberRolesByUserGuild: staffMember });
    assert.equal((await h.resolver.resolve(h.session, GUILD_A)).tier, "staff");

    api.removeStaffRole(GUILD_A, ROLE_JUNIOR);
    try {
      const res = await h.resolver.resolve(h.session, GUILD_A);
      assert.equal(res.status, "deny");
      assert.equal(res.reason, "no_tier");
      assert.equal(h.state.memberCalls, 1, "role ids came from cache; only the SQLite read re-ran");
    } finally {
      api.addStaffRole(GUILD_A, ROLE_JUNIOR, "junior");
    }
  });

  it("invalidateUserGuild / invalidateSession force re-fetch", async () => {
    const h = makeHarness({ memberRolesByUserGuild: staffMember });
    await h.resolver.resolve(h.session, GUILD_A);
    h.resolver.invalidateUserGuild(USER_STAFF, GUILD_A);
    await h.resolver.resolve(h.session, GUILD_A);
    assert.equal(h.state.memberCalls, 2, "role-id cache dropped");
    assert.equal(h.state.guildsCalls, 1, "list cache untouched by user invalidation");
    h.resolver.invalidateSession("sess-1");
    await h.resolver.resolve(h.session, GUILD_A);
    assert.equal(h.state.guildsCalls, 2, "list cache dropped");
  });
});

// ===========================================================================
// D. HTTP layer: guildScope + requireTier over a real express app
// ===========================================================================
describe("guildScope + requireTier over HTTP", () => {
  /** @type {import("http").Server} */
  let server;
  let base;
  const cookieIds = {};
  let memberCalls = 0;

  const snapshotA = (userId, entry) => JSON.stringify([entry ?? {
    id: GUILD_A,
    name: "A",
    icon: null,
    owner: userId === USER_ADMIN,
    permissions: userId === USER_ADMIN ? "0" : "104324673",
  }]);

  /** Create a real session row with encrypted AT + guild snapshot. */
  function mkSession(userId, { corrupt = false, expired = false, snapshot } = {}) {
    const s = sessionPolicy.createSession({ userId });
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: corrupt
        ? "v1.junk.junk.junk"
        : tokens.encryptAccessToken(`tok-${userId}`),
      tokenExpiresAt: expired ? Date.now() - 10_000 : Date.now() + 3_600_000,
      scopes: "identify guilds guilds.members.read",
      guildSnapshot: snapshot ?? snapshotA(userId),
    });
    return s.id;
  }

  /** Fake discordApi keyed off the per-user token string. */
  const fakeDiscord = {
    async getUserGuilds(token) {
      const userId = String(token).replace(/^tok-/, "");
      if (userId === USER_ADMIN || userId === USER_SENIOR || userId === USER_STAFF || userId === USER_PLAIN) {
        return [
          { id: GUILD_A, name: "A", icon: null, owner: userId === USER_ADMIN, permissions: userId === USER_ADMIN ? "0" : "104324673" },
          { id: GUILD_NOBOT, name: "no-bot", icon: null, owner: false, permissions: "0" },
        ];
      }
      return [];
    },
    async getUserGuildMember(token, guildId) {
      memberCalls += 1;
      const userId = String(token).replace(/^tok-/, "");
      if (guildId === GUILD_A) {
        if (userId === USER_STAFF) return { roles: [ROLE_JUNIOR] };
        if (userId === USER_SENIOR) return { roles: [ROLE_SENIOR, ROLE_NOISE] };
        return { roles: [] };
      }
      const err = new Error("Unknown Guild");
      err.status = 404;
      throw err;
    },
  };

  const okHandler = (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(req.guildAccess));
  };

  before(async () => {
    const resolver = createGuildAccessResolver({
      discord: fakeDiscord,
      botGuilds: async () => [GUILD_A], // bot serves ONLY guild A
      now: Date.now,
      ttlMs: 60_000,
    });

    const app = express();
    app.disable("x-powered-by");
    app.use(createSessionMiddleware());
    // The subtask-11 mount pattern: prefix param scope ahead of /g routes.
    app.use("/g/:guildId", createGuildScopeMiddleware({ resolver }));
    app.get("/g/:guildId", okHandler);
    app.get("/g/:guildId/tickets", requireTier("staff"), okHandler);
    app.get("/g/:guildId/activity", requireTier("senior"), okHandler);
    app.get("/g/:guildId/system", requireTier("admin"), okHandler);
    app.get("/g/:guildId/deep/nested/shape", requireTier("staff"), okHandler);
    // INTENTIONAL mount bug for the fail-closed 500 assertion:
    app.get("/misconfigured", requireTier("staff"), okHandler);
    // Generic catch-all exactly like app.js's handleNotFound:
    app.use((req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    });

    server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;

    cookieIds.admin = mkSession(USER_ADMIN);
    cookieIds.senior = mkSession(USER_SENIOR);
    cookieIds.staff = mkSession(USER_STAFF);
    cookieIds.plain = mkSession(USER_PLAIN);
    cookieIds.corrupt = mkSession(USER_STAFF, { corrupt: true });
    cookieIds.expired = mkSession(USER_STAFF, { expired: true });
  });

  after(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
  });

  /** @param {string} path @param {{id?: string}} [opts] */
  async function get(path, opts = {}) {
    const res = await fetch(`${base}${path}`, {
      redirect: "manual",
      headers: opts.id ? { cookie: `web_session=${opts.id}` } : undefined,
    });
    const body = await res.text();
    return { res, body };
  }

  it("anonymous /g/* redirect is byte-identical to the guildShell placeholder", () => {
    assert.equal(loginRedirectTarget(GUILD_A), `/auth/login?guild=${GUILD_A}`);
    assert.equal(loginRedirectTarget("oops"), "/auth/login");
    assert.equal(loginRedirectTarget(`${GUILD_A}/../../x`), "/auth/login");
  });

  it("anonymous → 302 /auth/login (snowflake carries ?guild=; junk never echoes)", async () => {
    const good = await get(`/g/${GUILD_A}`);
    assert.equal(good.res.status, 302);
    assert.equal(good.res.headers.get("location"), `/auth/login?guild=${GUILD_A}`);
    assert.equal(good.res.headers.get("cache-control"), "no-store");

    const weird = await get("/g/oops");
    assert.equal(weird.res.status, 302);
    assert.equal(weird.res.headers.get("location"), "/auth/login");
  });

  it("tier matrix: staff / senior / admin × {staff, senior, admin} routes (§8.8 0b)", async () => {
    const matrix = [
      // [cookieKey, expectedTier, routeTier → pass?]
      ["staff", "staff", { staff: true, senior: false, admin: false }],
      ["senior", "senior", { staff: true, senior: true, admin: false }],
      ["admin", "admin", { staff: true, senior: true, admin: true }],
    ];
    const routeOf = { staff: "/tickets", senior: "/activity", admin: "/system" };
    for (const [key, tier, wants] of matrix) {
      const shell = await get(`/g/${GUILD_A}`, { id: cookieIds[key] });
      assert.equal(shell.res.status, 200, `${key} shell`);
      assert.deepEqual(JSON.parse(shell.body), { guildId: GUILD_A, tier, degraded: false });
      for (const need of ["staff", "senior", "admin"]) {
        const r = await get(`/g/${GUILD_A}${routeOf[need]}`, { id: cookieIds[key] });
        if (wants[need]) {
          assert.equal(r.res.status, 200, `${key} on ${need} route must pass`);
        } else {
          assert.equal(r.res.status, 403, `${key} on ${need} route must be 403`);
          assert.equal(r.body, "Forbidden");
        }
      }
    }
    assert.ok(memberCalls > 0, "staff/senior tiers actually fetched role ids");
  });

  it("in-guild member without staff role → generic 404 (never 403)", async () => {
    const r = await get(`/g/${GUILD_A}/tickets`, { id: cookieIds.plain });
    assert.equal(r.res.status, 404);
    assert.equal(r.body, "Not found", "indistinguishable from the catch-all");
  });

  it("cross-guild probe: guild-A session hits every guild-B route shape ⇒ 404, never 403/302 (§8.13-10)", async () => {
    for (const key of ["staff", "senior", "admin", "plain"]) {
      const shapes = [
        `/g/${GUILD_B}`,
        `/g/${GUILD_B}/tickets`,
        `/g/${GUILD_B}/activity`,
        `/g/${GUILD_B}/system`,
        `/g/${GUILD_B}/deep/nested/shape`,
      ];
      for (const path of shapes) {
        const r = await get(path, { id: cookieIds[key] });
        assert.equal(r.res.status, 404, `${key} ${path}`);
        assert.equal(r.body, "Not found", `${key} ${path} body`);
      }
      // User is in GUILD_NOBOT but the bot is not → identical 404 (§8.3 row 1).
      const nb = await get(`/g/${GUILD_NOBOT}/tickets`, { id: cookieIds[key] });
      assert.equal(nb.res.status, 404);
      // Logged-in + malformed guild id → 404 (echoing nothing).
      const bad = await get("/g/999/tickets", { id: cookieIds[key] });
      assert.equal(bad.res.status, 404);
    }
  });

  it("unusable sessions redirect to re-auth: corrupt envelope + expired token", async () => {
    for (const key of ["corrupt", "expired"]) {
      const r = await get(`/g/${GUILD_A}`, { id: cookieIds[key] });
      assert.equal(r.res.status, 302, `${key} ⇒ login redirect, not 403/500`);
      assert.equal(r.res.headers.get("location"), `/auth/login?guild=${GUILD_A}`);
    }
  });

  it("requireTier without guildAccess fails CLOSED with a generic 500 (mount bug)", async () => {
    const r = await get("/misconfigured", { id: cookieIds.admin });
    assert.equal(r.res.status, 500);
    assert.equal(r.body, "Internal error");
    assert.throws(() => requireTier("root"), TypeError);
  });
});
