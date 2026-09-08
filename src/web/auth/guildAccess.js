/**
 * Per-session guild + tier resolution (roadmap/web-admin.md §8.3, §8.1-5/8;
 * subtask 07 — the HARD GATE for Phases 1-3).
 *
 * Equivalence with the slash gates (src/core/permissions.js) is the whole
 * point: the panel must never be a bypass (§8.1-5). The slash gates decide
 * on (memberPermissions bitset, member role ids, staff_roles rows):
 *   isAdminOrMod   ⇔ memberPermissions.has(ManageGuild)   [discord.js
 *                    PermissionFlagsBits]
 *   isStaff        ⇔ isAdminOrMod || memberHasStaffRole(guildId, roleIds)
 *   isSeniorStaff  ⇔ isAdminOrMod || memberHasSeniorStaffRole(guildId, roleIds)
 * The web decides on the SAME semantics expressed through the OAuth surface
 * (live-docs facts, .tmp/external-context/discord-oauth/web-login-notes.md §4-6):
 *   - `/users/@me/guilds[].permissions` is the guild-level permission bitset
 *     as a DECIMAL STRING (BigInt territory) with `owner:true` as the
 *     authoritative override. Discord computes interaction member_permissions
 *     WITH the ADMINISTRATOR short-circuit expanded (admin ⇒ every bit set),
 *     while the guilds-scope string is the raw role OR-aggregate WITHOUT
 *     that expansion — so the web gate must test the ADMINISTRATOR bit
 *     explicitly to stay provably equivalent to `memberPermissions.has(
 *     ManageGuild)` on the same member. Owner always passes (owner-ship is
 *     not a role).
 *   - `guilds.members.read` member objects carry ROLE IDS ONLY (no computed
 *     permissions over REST) — staff/senior membership therefore resolves
 *     roleIds ∩ staff_roles via the SAME db-facade predicates the slash gates
 *     use (memberHasStaffRole / memberHasSeniorStaffRole), read uncached.
 * `resolveTier(guildId, ctx)` below is the pure decision function both the
 * resolver and the equivalence tests run against; the resolver only fetches
 * the ctx inputs. (guildId is part of the mandated call signature for
 * call-site symmetry; the pure math reads `ctx` only.)
 *
 * §8.3 degradation matrix (deliberate, not accidental):
 *  - bot not in guild           → guild absent from the (bot∩user) access
 *                                 list → deny (middleware renders 404; the
 *                                 switcher simply never lists it)
 *  - member fetch unavailable   → snapshot-admin STILL resolves (bitset path
 *                                 needs no member fetch); staff/senior are
 *                                 unresolvable → deny with retry=true and the
 *                                 operator banner flag (degraded:true) is set
 *  - stored guild-list refresh  → bounded by WEB_TIER_CACHE_TTL_MS (§8.1-8);
 *                                 a failed refresh falls back to the stored
 *                                 snapshot ∩ current bot list, degraded:true
 *  - member left (404)          → deny + the session's cached guild list is
 *                                 dropped so the next resolve re-checks
 *  - decrypt failure / expired / revoked AT → re-auth signal (status
 *                                 'reauth'; middleware redirects to login)
 * Everything NOT in this matrix fails CLOSED (deny) on Discord errors.
 *
 * Caches (per §8.3 table): member role ids per USER+GUILD and the derived
 * bot∩user access list per SESSION, both TTL-bound by getTierCacheTtlMs()
 * (revocation latency is honestly bounded by the TTL, never "instant",
 * §8.1-8). staff_roles stays UNCACHED (cheap SQLite, §8.3). The 5-min
 * bot-roles cache from the §8.3 table is NOT needed for tier math — that
 * fetch is "(attribution only)" (shows WHICH role carries ManageGuild) and
 * lands with the Phase-1 UI that displays it.
 *
 * SECURITY: token material never logs; deny reasons are machine codes only —
 * the middleware renders every deny as the same generic 404 (§8.6, no guild
 * enumeration).
 */

const { createDiscordApi } = require("./discordApi");
const { getBotGuildIds } = require("./botGuilds");
const { buildGuildSnapshot } = require("./login");
const { decryptAccessToken } = require("./tokens");
const { getTierCacheTtlMs } = require("../config");
const {
  getWebSessionAuth,
  memberHasStaffRole,
  memberHasSeniorStaffRole,
} = require("../../db");

/** Tier ladder: higher rank satisfies every lower requirement (§8.6). */
const TIER_RANK = Object.freeze({ staff: 1, senior: 2, admin: 3 });
const TIERS = Object.freeze(["staff", "senior", "admin"]);

/**
 * Discord permission bits (BigInt — decimal strings may exceed 2^53, never
 * Number-parse them; web-login-notes.md "Pitfall checklist").
 * MANAGE_GUILD = 1<<5, ADMINISTRATOR = 1<<3.
 */
const MANAGE_GUILD_BIT = 1n << 5n;
const ADMINISTRATOR_BIT = 1n << 3n;

/** Unsigned decimal string only: rejects "", "1e10", "-32" (two's-complement
 *  BigInt &-tricks), garbage, and absurd lengths. Anything else ⇒ 0 bits. */
const PERMISSIONS_DECIMAL_RE = /^\d{1,20}$/;
/** Same snowflake gate as login.js GUILD_TARGET_RE / routes/guildShell. */
const GUILD_ID_RE = /^[0-9]{5,20}$/;

const DEFAULT_MAX_CACHE_ENTRIES = 2000;

/**
 * Parse a permission bitset string to BigInt, failing CLOSED to 0n (a
 * malformed snapshot value must never mint admin).
 * @param {unknown} value decimal string from the snapshot / guilds payload
 * @returns {bigint}
 */
function parsePermissionsBits(value) {
  if (typeof value !== "string" || !PERMISSIONS_DECIMAL_RE.test(value)) {
    return 0n;
  }
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Admin fast path — the exact mirror of isAdminOrMod over snapshot inputs:
 * owner (authoritative override) OR the MANAGE_GUILD bit OR the
 * ADMINISTRATOR bit (compensating for the guilds-scope string NOT carrying
 * Discord's member_permissions admin expansion; see header).
 * @param {{owner?: boolean, permissions?: string}|null|undefined} snapshotEntry
 * @returns {boolean}
 */
function snapshotGrantsAdmin(snapshotEntry) {
  if (!snapshotEntry || typeof snapshotEntry !== "object") return false;
  if (snapshotEntry.owner === true) return true;
  const bits = parsePermissionsBits(snapshotEntry.permissions);
  return (
    (bits & MANAGE_GUILD_BIT) === MANAGE_GUILD_BIT ||
    (bits & ADMINISTRATOR_BIT) === ADMINISTRATOR_BIT
  );
}

/**
 * Pure tier decision from already-resolved inputs (§8.3: "Decision inputs
 * are (roleIds, manageGuildBit, staffRoleIds) so the slash-command gates and
 * web middleware stay provably equivalent"). Precedence admin > senior >
 * staff. memberRoleIds === null means "role ids unresolvable" (member fetch
 * failed): only the snapshot admin path survives, everything else is null —
 * never a guess.
 *
 * @param {string} guildId part of the mandated resolver signature (unused by
 *   the pure math; kept so call sites and the equivalence tests share one fn)
 * @param {object} ctx
 * @param {{owner?: boolean, permissions?: string}|null} [ctx.snapshotEntry]
 *   this viewer's guild_snapshot entry for guildId (decimal-string perms +
 *   owner flag)
 * @param {string[]|null} [ctx.memberRoleIds] role ids from
 *   guilds.members.read (null = unresolvable)
 * @param {"staff"|"senior"|null} [ctx.staffRoleTier] staff_roles.level tier
 *   of roleIds ∩ staff_roles (see {@link staffRoleTierFor})
 * @returns {null|"staff"|"senior"|"admin"}
 */
function resolveTier(guildId, ctx = {}) {
  const { snapshotEntry = null, memberRoleIds = null, staffRoleTier = null } = ctx;
  if (snapshotGrantsAdmin(snapshotEntry)) return "admin";
  if (!Array.isArray(memberRoleIds)) return null; // fail closed, no role ids
  if (staffRoleTier === "senior") return "senior";
  if (staffRoleTier === "staff") return "staff";
  return null;
}

/**
 * roleIds ∩ staff_roles as a tier, via the SAME db predicates the slash
 * gates use (uncached, §8.3 — cheap SQLite; revoking a staff role therefore
 * takes effect on the next request, not on the next TTL).
 * @param {string} guildId
 * @param {string[]|null} memberRoleIds
 * @param {{memberHasStaffRole: Function, memberHasSeniorStaffRole: Function}} staffRoleApi
 * @returns {"staff"|"senior"|null}
 */
function staffRoleTierFor(guildId, memberRoleIds, staffRoleApi) {
  if (!Array.isArray(memberRoleIds) || memberRoleIds.length === 0) return null;
  if (staffRoleApi.memberHasSeniorStaffRole(guildId, memberRoleIds)) return "senior";
  if (staffRoleApi.memberHasStaffRole(guildId, memberRoleIds)) return "staff";
  return null;
}

/**
 * Resolve the encrypted per-session AT (§8.5/025). Every failure mode here
 * is a re-auth signal: missing envelope, expired token, or a decrypt throw
 * (SESSION_SECRET rotation ⇒ envelope invalid, §8.5).
 * @returns {{ok: true, token: string}|{ok: false, reason: string}}
 */
function readAccessToken(tokenApi, authRow, at) {
  if (!authRow || !authRow.access_token_enc) {
    return { ok: false, reason: "no_token" };
  }
  if (
    Number.isFinite(Number(authRow.token_expires_at)) &&
    authRow.token_expires_at !== null &&
    Number(authRow.token_expires_at) <= at
  ) {
    return { ok: false, reason: "token_expired" };
  }
  try {
    return { ok: true, token: tokenApi.decryptAccessToken(authRow.access_token_enc) };
  } catch {
    // Static line only — never envelope or token material (§8.7).
    console.warn(
      "[web] guildAccess: session token decrypt failed (secret rotation?) — re-auth required"
    );
    return { ok: false, reason: "token_decrypt_failed" };
  }
}

/** Parse the stored guild_snapshot JSON (written by login.js) fail-safe. */
function parseStoredSnapshot(authRow) {
  try {
    const parsed = JSON.parse(authRow?.guild_snapshot || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Build a per-request tier resolver over one session store. All external
 * I/O is injected (discordApi, bot-guild provider, db accessors, clock) so
 * the whole matrix runs offline (§8.11).
 *
 * @param {object} [options]
 * @param {{getUserGuilds: Function, getUserGuildMember: Function}} [options.discord]
 *   defaults to createDiscordApi({apiBase, fetchImpl})
 * @param {string} [options.apiBase] @param {typeof fetch} [options.fetchImpl]
 * @param {() => Promise<string[]>|string[]} [options.botGuilds] defaults to
 *   the wired provider (auth/botGuilds.js)
 * @param {{getWebSessionAuth: Function}} [options.store]
 * @param {{decryptAccessToken: Function}} [options.tokenApi]
 * @param {{memberHasStaffRole: Function, memberHasSeniorStaffRole: Function}} [options.staffRoleApi]
 * @param {number} [options.ttlMs] cache TTL; default: getTierCacheTtlMs() live
 * @param {() => number} [options.now] clock (tests use a fake clock)
 * @param {number} [options.maxCacheEntries] per-cache entry bound
 * @returns {{
 *   resolve: (session: {id: string, userId: string}|null, guildId: string)
 *     => Promise<{status: "ok"|"deny"|"reauth"|"anon", tier?: string, reason?: string,
 *                 retry?: boolean, degraded?: boolean, guildId?: string}>,
 *   invalidateSession: (sessionId: string) => void,
 *   invalidateUserGuild: (userId: string, guildId?: string) => void,
 *   _clearCachesForTests: () => void,
 * }}
 */
function createGuildAccessResolver(options = {}) {
  const discord =
    options.discord ||
    createDiscordApi({ apiBase: options.apiBase, fetchImpl: options.fetchImpl });
  const botGuilds = options.botGuilds || getBotGuildIds;
  const store = options.store || { getWebSessionAuth };
  const tokenApi = options.tokenApi || { decryptAccessToken };
  const staffRoleApi =
    options.staffRoleApi || { memberHasStaffRole, memberHasSeniorStaffRole };
  const ttl =
    options.ttlMs != null
      ? () => options.ttlMs
      : () => getTierCacheTtlMs(); // live env read, like every other knob
  const now = options.now || Date.now;
  const maxCacheEntries = options.maxCacheEntries || DEFAULT_MAX_CACHE_ENTRIES;

  /** sessionId -> { guilds: Map<guildId, snapshotEntry>, at } */
  const accessLists = new Map();
  /** `${userId}:${guildId}` -> { roleIds: string[], at } */
  const memberRoles = new Map();

  // Insertion-ordered Map bound: evict the oldest entry when over cap so a
  // long-lived process cannot grow the cache without limit (shared process
  // with the bot — memory discipline, §8.6 query-budget spirit).
  function cacheSet(map, key, value) {
    map.set(key, value);
    while (map.size > maxCacheEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /**
   * bot∩user guild list for the session, rebuilt at most once per TTL
   * (§8.3 "session row guild_snapshot, re-checked at TTL"). The FRESH
   * /users/@me/guilds ∩ bot list is authoritative; on a non-401 fetch
   * failure we fall back to stored-snapshot ∩ bot list (admin fast path
   * survives, bounded by the next TTL — matrix row 3) rather than failing
   * every request.
   */
  async function getAccessGuilds(session, token, at) {
    const cached = accessLists.get(session.id);
    if (cached && at - cached.at < ttl()) {
      return { list: cached.guilds, degraded: false };
    }
    const botIds = new Set(await botGuilds()); // provider throws → caller fails closed
    try {
      const userGuilds = await discord.getUserGuilds(token);
      // Same builder as login: single source of truth for snapshot shape and
      // the bot∩user intersection (guilds scope returns ALL user guilds).
      const fresh = buildGuildSnapshot(userGuilds, botIds);
      const list = new Map(fresh.map((g) => [g.id, g]));
      cacheSet(accessLists, session.id, { guilds: list, at });
      return { list, degraded: false };
    } catch (err) {
      if (err?.status === 401) return { reauth: true };
      console.warn(
        "[web] guildAccess: guild-list refresh failed; using stored snapshot ∩ bot list until next TTL"
      );
      const stored = parseStoredSnapshot(store.getWebSessionAuth(session.id))
        .filter((g) => g && typeof g.id === "string" && botIds.has(g.id))
        .map((g) => ({ id: g.id, owner: g.owner === true, permissions: g.permissions }));
      const list = new Map(stored.map((g) => [g.id, g]));
      cacheSet(accessLists, session.id, { guilds: list, at }); // retry bounded by TTL
      return { list, degraded: true };
    }
  }

  /**
   * Role ids for user+guild (guilds.members.read), cached per USER+GUILD at
   * the tier TTL (§8.3/§8.1-8). 404 ⇒ member left; 401 ⇒ re-auth; any other
   * failure ⇒ unresolvable (matrix row 2 — staff/senior deny with retry).
   */
  async function getMemberRoleIds(session, guildId, token, at) {
    const key = `${session.userId}:${guildId}`;
    const cached = memberRoles.get(key);
    if (cached && at - cached.at < ttl()) {
      return { roleIds: cached.roleIds };
    }
    try {
      const member = await discord.getUserGuildMember(token, guildId);
      // REST gives ROLE IDS ONLY (live docs) — filter to strings defensively.
      const roleIds = Array.isArray(member?.roles)
        ? member.roles.filter((r) => typeof r === "string")
        : [];
      cacheSet(memberRoles, key, { roleIds, at });
      return { roleIds };
    } catch (err) {
      if (err?.status === 404) return { memberLeft: true };
      if (err?.status === 401) return { reauth: true };
      console.warn(
        "[web] guildAccess: member role fetch failed — staff/senior unresolvable until retry"
      );
      return { failed: true };
    }
  }

  /**
   * Resolve the viewer's tier for one guild. Never throws: every failure
   * lands in a status the middleware maps to redirect / 404 / proceed.
   * @param {{id: string, userId: string}|null} session req.webSession
   * @param {string} guildId
   */
  async function resolve(session, guildId) {
    if (!session || !session.id || !session.userId) {
      return { status: "anon" };
    }
    if (typeof guildId !== "string" || !GUILD_ID_RE.test(guildId)) {
      return { status: "deny", reason: "bad_guild_id" };
    }
    const at = now();

    let authRow = null;
    try {
      authRow = store.getWebSessionAuth(session.id);
    } catch (err) {
      // Fail closed (session store hiccup ≠ escalation).
      console.warn("[web] guildAccess: session auth lookup failed:", err?.code || err?.message || err);
      return { status: "deny", reason: "store_unavailable", retry: true };
    }

    const tok = readAccessToken(tokenApi, authRow, at);
    if (!tok.ok) return { status: "reauth", reason: tok.reason };

    let lists;
    try {
      lists = await getAccessGuilds(session, tok.token, at);
    } catch (err) {
      // Bot-guild provider blew up: fail CLOSED (never serve a tier we
      // cannot bound-check against bot membership).
      console.warn("[web] guildAccess: bot-guild provider failed:", err?.code || err?.message || err);
      return { status: "deny", reason: "bot_guilds_unavailable", retry: true };
    }
    if (lists.reauth) return { status: "reauth", reason: "token_revoked" };

    const entry = lists.list.get(guildId);
    if (!entry) {
      // Not bot∩user: hidden from the switcher, routes 404 (matrix row 1).
      return { status: "deny", reason: "not_in_access_list", degraded: !!lists.degraded };
    }

    let memberRoleIds = null;
    let degraded = !!lists.degraded;
    if (!snapshotGrantsAdmin(entry)) {
      // Admin tier is decided from the snapshot ALONE — the member read is
      // only needed for staff/senior, which is exactly what lets admins
      // keep working through a member-fetch outage (matrix row 2).
      const roles = await getMemberRoleIds(session, guildId, tok.token, at);
      if (roles.reauth) return { status: "reauth", reason: "token_revoked" };
      if (roles.memberLeft) {
        // Matrix row 4: deny now, refresh this session's guild list next
        // resolve (the left guild drops out of the fresh intersection).
        accessLists.delete(session.id);
        return { status: "deny", reason: "member_left", degraded };
      }
      if (roles.failed) {
        // Matrix row 2: staff/senior unresolvable — deny with retry + the
        // operator banner flag. (Escape hatch per §8.3: none needed for
        // admins; retry on TTL.)
        return { status: "deny", reason: "roles_unavailable", retry: true, degraded: true };
      }
      memberRoleIds = roles.roleIds;
    }

    const staffRoleTier = staffRoleTierFor(guildId, memberRoleIds, staffRoleApi);
    const tier = resolveTier(guildId, { snapshotEntry: entry, memberRoleIds, staffRoleTier });
    if (!tier) return { status: "deny", reason: "no_tier", degraded };
    return { status: "ok", tier, guildId, degraded };
  }

  /** Drop a session's cached guild list (logout / member-left events). */
  function invalidateSession(sessionId) {
    if (sessionId) accessLists.delete(sessionId);
  }

  /** Drop cached member role ids (role-change events may call this). */
  function invalidateUserGuild(userId, guildId) {
    if (!userId) return;
    if (guildId) {
      memberRoles.delete(`${userId}:${guildId}`);
      return;
    }
    for (const key of [...memberRoles.keys()]) {
      if (key.startsWith(`${userId}:`)) memberRoles.delete(key);
    }
  }

  function _clearCachesForTests() {
    accessLists.clear();
    memberRoles.clear();
  }

  return { resolve, invalidateSession, invalidateUserGuild, _clearCachesForTests };
}

module.exports = {
  TIER_RANK,
  TIERS,
  MANAGE_GUILD_BIT,
  ADMINISTRATOR_BIT,
  GUILD_ID_RE,
  parsePermissionsBits,
  snapshotGrantsAdmin,
  resolveTier,
  staffRoleTierFor,
  createGuildAccessResolver,
};
