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
 *
 * FLUXER PR 10: `resolve` gains a per-community provider branch. A Fluxer
 * community requires a FLUXER session with the same instanceKey (mismatch =
 * the same generic deny), rotates the stored access token inside the 24h
 * refresh window (persist-before-use, §Token exchange and refresh), lists
 * guilds through the user token (∩ the instance-scoped login snapshot), and
 * resolves staff/senior from the BOT's outbound member fetch — the matrix
 * above maps 1:1: fetch failure ⇒ deny + degraded, admin-via-snapshot stands.
 * Discord sessions never enter a Fluxer code path and vice versa.
 */

const { createDiscordApi } = require("./discordApi");
const { getBotGuildIds } = require("./botGuilds");
const { buildGuildSnapshot } = require("./login");
const { decryptAccessToken, encryptAccessToken } = require("./tokens");
const { getTierCacheTtlMs } = require("../config");
const {
  getWebSessionAuth,
  setWebSessionAuth,
  memberHasStaffRole,
  memberHasSeniorStaffRole,
} = require("../../db");
const {
  getCommunityById,
  getCommunityByExternal,
} = require("../../platform/community");

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
/** Same snowflake gate as login.js GUILD_TARGET_RE / routes/dashboard. */
const { URL_ID_RE: GUILD_ID_RE } = require("../shared/snowflake");

const DEFAULT_MAX_CACHE_ENTRIES = 2000;

/**
 * Fluxer PR 10 (spec §Token exchange and refresh): rotate the access token
 * when it is within this window of expiring.
 */
const FLUXER_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

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
 * @param {number} communityId part of the mandated resolver signature (unused by
 *   the pure math; kept so call sites and the equivalence tests share one fn)
 * @param {object} ctx
 * @param {{owner?: boolean, permissions?: string}|null} [ctx.snapshotEntry]
 *   this viewer's guild_snapshot entry for the guild (decimal-string perms +
 *   owner flag)
 * @param {string[]|null} [ctx.memberRoleIds] role ids from
 *   guilds.members.read (null = unresolvable)
 * @param {"staff"|"senior"|null} [ctx.staffRoleTier] staff_roles.level tier
 *   of roleIds ∩ staff_roles (see {@link staffRoleTierFor})
 * @returns {null|"staff"|"senior"|"admin"}
 */
function resolveTier(communityId, ctx = {}) {
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
 * @param {number} communityId
 * @param {string[]|null} memberRoleIds
 * @param {{memberHasStaffRole: Function, memberHasSeniorStaffRole: Function}} staffRoleApi
 * @returns {"staff"|"senior"|null}
 */
function staffRoleTierFor(communityId, memberRoleIds, staffRoleApi) {
  if (!Array.isArray(memberRoleIds) || memberRoleIds.length === 0) return null;
  if (staffRoleApi.memberHasSeniorStaffRole(communityId, memberRoleIds)) return "senior";
  if (staffRoleApi.memberHasStaffRole(communityId, memberRoleIds)) return "staff";
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
 * @param {{getWebSessionAuth: Function, setWebSessionAuth: Function}} [options.store]
 * @param {{decryptAccessToken: Function, encryptAccessToken: Function}} [options.tokenApi]
 * @param {{memberHasStaffRole: Function, memberHasSeniorStaffRole: Function}} [options.staffRoleApi]
 * @param {number} [options.ttlMs] cache TTL; default: getTierCacheTtlMs() live
 * @param {() => number} [options.now] clock (tests use a fake clock)
 * @param {number} [options.maxCacheEntries] per-cache entry bound
 * @param {() => Array<{instanceKey: string, apiBase: string|null, clientId: string|null,
 *   clientSecret: string|null}>} [options.getFluxerWebInstances]
 *   Fluxer login-instance provider (features/web boot; tests inject).
 *   Default: none — Fluxer communities then resolve admin-via-snapshot only
 *   and degrade like a member-fetch outage for staff/senior (§8.3 row 2).
 * @param {(communityId: number) => object|null} [options.getCommunityClient]
 *   OutboundClient accessor for bot-member fetches (staff tier; spec
 *   §Guild intersection and staff tier item 5). Default: null.
 * @param {(apiBase: string) => object} [options.fluxerTokenApi]
 *   Fluxer API factory (token refresh + guild list). Default: lazy
 *   require("./fluxerApi").createFluxerApi({apiBase, fetchImpl}).
 * @param {number} [options.fluxerRefreshWindowMs] refresh lead time;
 *   default: 24 h (spec §Token exchange and refresh)
 * @returns {{
 *   resolve: (session: {id: string, userId: string}|null, guildId: string)
 *     => Promise<{status: "ok"|"deny"|"reauth"|"anon", tier?: string, reason?: string,
 *                 retry?: boolean, degraded?: boolean, guildId?: string}>,
 *   listGuilds: (session: {id: string, userId: string}|null)
 *     => Promise<{guilds: Array<{id: string, name: string}>, degraded: boolean, reauth?: boolean}>,
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
  const store = options.store || { getWebSessionAuth, setWebSessionAuth };
  const tokenApi =
    options.tokenApi || { decryptAccessToken, encryptAccessToken };
  const staffRoleApi =
    options.staffRoleApi || { memberHasStaffRole, memberHasSeniorStaffRole };
  const getFluxerWebInstances = options.getFluxerWebInstances || (() => []);
  const getCommunityClient = options.getCommunityClient || (() => null);
  // Lazy default so requiring this module never hard-depends on the Fluxer
  // API surface (dark boots and Discord-only deployments stay untouched).
  const fluxerApiFactory =
    options.fluxerTokenApi ||
    ((apiBase) => {
      const { createFluxerApi } = require("./fluxerApi");
      return createFluxerApi({ apiBase, fetchImpl: options.fetchImpl });
    });
  const refreshWindowMs =
    options.fluxerRefreshWindowMs != null
      ? options.fluxerRefreshWindowMs
      : FLUXER_REFRESH_WINDOW_MS;
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
      // name/icon are kept for the shell's guild switcher (subtask 11); the
      // tier math ignores them.
      const stored = parseStoredSnapshot(store.getWebSessionAuth(session.id))
        .filter((g) => g && typeof g.id === "string" && botIds.has(g.id))
        .map((g) => ({
          id: g.id,
          name: typeof g.name === "string" ? g.name : null,
          icon: typeof g.icon === "string" ? g.icon : null,
          owner: g.owner === true,
          permissions: g.permissions,
        }));
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

  // -------------------------------------------------------------------------
  // Fluxer PR 10 branches (spec §Token exchange and refresh, §Guild
  // intersection and staff tier). Discord code paths above and below are
  // untouched; fluxer sessions never enter them.
  // -------------------------------------------------------------------------

  /**
   * Configured login entry for one instance key (apiBase + OAuth creds).
   * Provider throws / missing entry / missing apiBase → null (fail closed).
   */
  function fluxerInstanceEntry(instanceKey) {
    let entries;
    try {
      entries = getFluxerWebInstances();
    } catch (err) {
      console.warn(
        "[web] fluxer instances provider failed:",
        err?.code || err?.message || err
      );
      return null;
    }
    if (!Array.isArray(entries)) return null;
    return entries.find((e) => e && e.instanceKey === instanceKey) ?? null;
  }

  /** Fluxer API bound to an instance's discovered apiBase; null when unresolvable. */
  function fluxerApiFor(instanceKey) {
    const entry = fluxerInstanceEntry(instanceKey);
    if (!entry) return null;
    if (typeof entry.apiBase !== "string" || !entry.apiBase) return null;
    try {
      return fluxerApiFactory(entry.apiBase);
    } catch (err) {
      console.warn(
        `[web] fluxer api construction failed for instance ${instanceKey}:`,
        err?.code || err?.message || err
      );
      return null;
    }
  }

  /**
   * Read the session's Fluxer AT, rotating it FIRST when it lands within the
   * 24h refresh window (spec §Token exchange and refresh): the new pair is
   * PERSISTED BEFORE USE, so a crash after Fluxer consumes the presented
   * refresh token never leaves the caller holding a dead grant. Any refresh
   * denial (invalid_grant, missing creds, transport failure) is the existing
   * `reauth` status — the old token is never retried.
   * @returns {Promise<{ok: true, token: string, authRow: object}|{ok: false, result: object}>}
   */
  async function acquireFluxerToken(session, authRow, at) {
    if (!authRow || !authRow.access_token_enc) {
      return { ok: false, result: { status: "reauth", reason: "no_token" } };
    }
    const expiresAt =
      authRow.token_expires_at != null &&
      Number.isFinite(Number(authRow.token_expires_at))
        ? Number(authRow.token_expires_at)
        : null;
    const needsRefresh =
      expiresAt !== null && expiresAt - at < refreshWindowMs;
    if (!needsRefresh || !authRow.refresh_token_enc) {
      // Live AT outside the window (or a row with no refresh token at all):
      // plain read — expired rows land on reauth "token_expired" exactly like
      // the Discord path.
      const tok = readAccessToken(tokenApi, authRow, at);
      if (!tok.ok) return { ok: false, result: { status: "reauth", reason: tok.reason } };
      return { ok: true, token: tok.token, authRow };
    }

    let refreshToken = null;
    try {
      refreshToken = tokenApi.decryptAccessToken(authRow.refresh_token_enc);
    } catch {
      // Static line only — never envelope material (§8.7).
      console.warn(
        "[web] fluxer token refresh: refresh envelope decrypt failed (secret rotation?) — re-auth required"
      );
      return { ok: false, result: { status: "reauth", reason: "token_decrypt_failed" } };
    }

    const entry = fluxerInstanceEntry(session.instanceKey);
    if (
      !entry ||
      typeof entry.apiBase !== "string" ||
      !entry.apiBase ||
      !entry.clientId ||
      !entry.clientSecret
    ) {
      // No api base (discovery not run/failed) or no OAuth creds: the grant
      // cannot be rotated here. ids only — never token material.
      console.warn(
        `[web] fluxer token refresh unavailable for instance=${session.instanceKey} user=${session.userId} (missing apiBase/creds) — re-auth required`
      );
      return { ok: false, result: { status: "reauth", reason: "token_revoked" } };
    }

    let rotated = null;
    try {
      const api = fluxerApiFactory(entry.apiBase);
      rotated = await api.refreshToken({
        refreshToken,
        clientId: entry.clientId,
        clientSecret: entry.clientSecret,
      });
    } catch (err) {
      // invalid_grant (err.code "fluxer_refresh_denied") and transport/shape
      // failures share ONE outcome: the session must re-auth. Never retry the
      // consumed token. ids + error code only.
      console.warn(
        `[web] fluxer token refresh failed (instance=${session.instanceKey}, user=${session.userId}): ${err?.code || err?.message || err}`
      );
      return { ok: false, result: { status: "reauth", reason: "token_revoked" } };
    }

    let accessEnc = null;
    let refreshEnc = null;
    try {
      accessEnc = tokenApi.encryptAccessToken(rotated.accessToken);
      refreshEnc = rotated.refreshToken
        ? tokenApi.encryptAccessToken(rotated.refreshToken)
        : null;
    } catch (err) {
      console.warn(
        "[web] fluxer token refresh: envelope encrypt failed — re-auth required:",
        err?.message || err
      );
      return { ok: false, result: { status: "reauth", reason: "token_revoked" } };
    }

    // PERSIST BEFORE USE (spec): one UPDATE carrying the new pair + expiries,
    // with the login guild snapshot passed through so rotation never blanks
    // the switcher list.
    try {
      const persisted = store.setWebSessionAuth(session.id, {
        accessTokenEnc: accessEnc,
        tokenExpiresAt: Number.isInteger(rotated.expiresAt) ? rotated.expiresAt : null,
        scopes: rotated.scopes ?? null,
        guildSnapshot: authRow.guild_snapshot ?? null,
        refreshTokenEnc: refreshEnc,
        refreshExpiresAt: Number.isInteger(rotated.refreshExpiresAt)
          ? rotated.refreshExpiresAt
          : null,
      });
      if (!persisted) {
        // Row vanished (logout/revocation mid-flight) — nothing to serve on.
        return { ok: false, result: { status: "reauth", reason: "token_revoked" } };
      }
    } catch (err) {
      console.warn(
        "[web] fluxer token refresh persist failed:",
        err?.code || err?.message || err
      );
      return {
        ok: false,
        result: { status: "deny", reason: "store_unavailable", retry: true },
      };
    }

    console.warn(
      `[web] fluxer token refreshed (instance=${session.instanceKey}, user=${session.userId})`
    );
    return {
      ok: true,
      token: rotated.accessToken,
      authRow: {
        ...authRow,
        access_token_enc: accessEnc,
        token_expires_at: Number.isInteger(rotated.expiresAt) ? rotated.expiresAt : null,
        scopes: rotated.scopes ?? null,
        refresh_token_enc: refreshEnc,
        refresh_expires_at: Number.isInteger(rotated.refreshExpiresAt)
          ? rotated.refreshExpiresAt
          : null,
      },
    };
  }

  /**
   * User∩snapshot guild list for a Fluxer session. The login snapshot is
   * already instance-scoped (login kept only communities that exist for this
   * instance), so "intersect by external id" is user-list ∩ snapshot ids —
   * the same shape the Discord degraded path builds. A fetch failure falls
   * back to the stored snapshot (degraded:true), bounded by the next TTL
   * (§8.3 row 3).
   */
  async function getFluxerAccessGuilds(session, accessToken, at, authRow) {
    const cached = accessLists.get(session.id);
    if (cached && at - cached.at < ttl()) {
      return { list: cached.guilds, degraded: false };
    }
    const storedList = () => {
      const stored = parseStoredSnapshot(authRow)
        .filter((g) => g && typeof g.id === "string")
        .map((g) => ({
          id: g.id,
          name: typeof g.name === "string" ? g.name : null,
          icon: typeof g.icon === "string" ? g.icon : null,
          owner: g.owner === true,
          permissions: g.permissions,
        }));
      const list = new Map(stored.map((g) => [g.id, g]));
      cacheSet(accessLists, session.id, { guilds: list, at });
      return { list, degraded: true };
    };
    const api = fluxerApiFor(session.instanceKey);
    if (!api) {
      console.warn(
        `[web] fluxer guildAccess: no api base for instance=${session.instanceKey}; using stored snapshot until next TTL`
      );
      return storedList();
    }
    try {
      const userGuilds = await api.listCurrentUserGuilds(accessToken);
      // Same builder as login/Discord: one shape + the 200-cap. Intersection
      // set = the login snapshot's external guild ids for THIS instance.
      const snapshotIds = new Set(
        parseStoredSnapshot(authRow)
          .filter((g) => g && typeof g.id === "string")
          .map((g) => g.id)
      );
      const fresh = buildGuildSnapshot(userGuilds, snapshotIds);
      const list = new Map(fresh.map((g) => [g.id, g]));
      cacheSet(accessLists, session.id, { guilds: list, at });
      return { list, degraded: false };
    } catch (err) {
      if (err?.status === 401) return { reauth: true };
      console.warn(
        "[web] fluxer guildAccess: guild-list refresh failed; using stored snapshot until next TTL"
      );
      return storedList();
    }
  }

  /**
   * Role ids for a Fluxer member via the BOT's outbound client
   * (outbound.fetchMember(communityId, userId)) — never a user-scope role
   * read. DEVIATION (flagged): the spec cache key is
   * `${platform}:${instanceKey}:${externalGuildId}`; this adds the userId
   * prefix so the shared per-USER memberRoles cache cannot leak one user's
   * roles to another (the spec key alone would mint tiers across users).
   */
  async function getFluxerMemberRoleIds(session, cid, externalGuildId, at) {
    const key = `${session.userId}:fluxer:${session.instanceKey ?? "discord"}:${externalGuildId}`;
    const cached = memberRoles.get(key);
    if (cached && at - cached.at < ttl()) {
      return { roleIds: cached.roleIds };
    }
    let outbound = null;
    try {
      outbound = getCommunityClient(cid);
    } catch (err) {
      console.warn(
        "[web] fluxer guildAccess: community client lookup failed:",
        err?.code || err?.message || err
      );
      return { failed: true };
    }
    if (!outbound || typeof outbound.fetchMember !== "function") {
      // Spec §Supervisor: a missing client is a logged skip, tier fails
      // closed to the §8.3 row-2 shape (deny + degraded), never a guess.
      console.warn(
        `[web] fluxer guildAccess: no outbound client for community ${cid} — staff/senior unresolvable`
      );
      return { failed: true };
    }
    try {
      const member = await outbound.fetchMember(cid, session.userId);
      if (!member) {
        // fetchMember swallows REST failures to null; treat null as
        // unresolvable (spec §Guild intersection item 6). Left-members drop
        // out of the guild list on the next TTL refresh.
        console.warn(
          `[web] fluxer guildAccess: member fetch returned no member for community ${cid} — staff/senior unresolvable`
        );
        return { failed: true };
      }
      const roleIds = Array.isArray(member.roleIds)
        ? member.roleIds.filter((r) => typeof r === "string")
        : [];
      cacheSet(memberRoles, key, { roleIds, at });
      return { roleIds };
    } catch (err) {
      console.warn(
        "[web] fluxer guildAccess: member role fetch failed — staff/senior unresolvable until retry:",
        err?.code || err?.message || err
      );
      return { failed: true };
    }
  }

  /**
   * Resolve the viewer's tier for one community. Never throws: every failure
   * lands in a status the middleware maps to redirect / 404 / proceed.
   * @param {{id: string, userId: string}|null} session req.webSession
   * @param {number|string} communityId internal communities.id (fluxer PR 2 —
   *   the route carries the integer; a numeric string is accepted and
   *   canonicalized, snowflakes fail the gate)
   */
  async function resolve(session, communityId) {
    if (!session || !session.id || !session.userId) {
      return { status: "anon" };
    }
    const cid = typeof communityId === "string" ? Number(communityId) : communityId;
    if (
      typeof cid !== "number" ||
      !Number.isSafeInteger(cid) ||
      cid < 1 ||
      cid > 2_147_483_647
    ) {
      return { status: "deny", reason: "bad_guild_id" };
    }
    // Map the internal id to the platform-facing external id (REST + snapshot
    // keys are external). A community with no external id cannot be tiered
    // from platform data: deny (renders the generic 404).
    let community = null;
    try {
      community = getCommunityById(cid) ?? null;
    } catch (err) {
      console.warn(
        "[web] guildAccess: community lookup failed:",
        err?.code || err?.message || err
      );
      return { status: "deny", reason: "store_unavailable", retry: true };
    }
    const externalGuildId = community?.externalGuildId ?? null;
    if (!community || !externalGuildId) {
      return { status: "deny", reason: "not_in_access_list" };
    }
    const at = now();

    // Fluxer PR 10 (spec §"Session columns and cookies"): the session must
    // match the community's platform AND instance. A Discord session can
    // never open a Fluxer community and vice versa; a session for ANOTHER
    // Fluxer instance is not identity either. Mismatch is the same generic
    // deny the resolver already uses for "not in your list" — no enumeration.
    // (Legacy hand-built session objects default to the discord identity.)
    const sessionPlatform = session.platform ?? "discord";
    const sessionInstance = session.instanceKey ?? "discord";
    if (
      sessionPlatform !== community.platform ||
      sessionInstance !== (community.instanceKey ?? "discord")
    ) {
      return { status: "deny", reason: "not_in_access_list" };
    }
    const isFluxer = community.platform === "fluxer";

    let authRow = null;
    try {
      authRow = store.getWebSessionAuth(session.id);
    } catch (err) {
      // Fail closed (session store hiccup ≠ escalation).
      console.warn("[web] guildAccess: session auth lookup failed:", err?.code || err?.message || err);
      return { status: "deny", reason: "store_unavailable", retry: true };
    }

    let accessToken = null;
    let liveAuthRow = authRow;
    if (isFluxer) {
      const tokF = await acquireFluxerToken(session, authRow, at);
      if (!tokF.ok) return tokF.result;
      accessToken = tokF.token;
      liveAuthRow = tokF.authRow;
    } else {
      const tok = readAccessToken(tokenApi, authRow, at);
      if (!tok.ok) return { status: "reauth", reason: tok.reason };
      accessToken = tok.token;
    }

    let lists;
    try {
      lists = isFluxer
        ? await getFluxerAccessGuilds(session, accessToken, at, liveAuthRow)
        : await getAccessGuilds(session, accessToken, at);
    } catch (err) {
      // Bot-guild provider blew up: fail CLOSED (never serve a tier we
      // cannot bound-check against bot membership).
      console.warn("[web] guildAccess: bot-guild provider failed:", err?.code || err?.message || err);
      return { status: "deny", reason: "bot_guilds_unavailable", retry: true };
    }
    if (lists.reauth) return { status: "reauth", reason: "token_revoked" };

    const entry = lists.list.get(externalGuildId);
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
      const roles = isFluxer
        ? await getFluxerMemberRoleIds(session, cid, externalGuildId, at)
        : await getMemberRoleIds(session, externalGuildId, accessToken, at);
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

    const staffRoleTier = staffRoleTierFor(cid, memberRoleIds, staffRoleApi);
    const tier = resolveTier(cid, { snapshotEntry: entry, memberRoleIds, staffRoleTier });
    if (!tier) return { status: "deny", reason: "no_tier", degraded };
    return { status: "ok", tier, guildId: externalGuildId, communityId: cid, degraded };
  }

  /**
   * Display list for the shell's guild switcher (subtask 11, §8.3): the
   * SAME cached access list `resolve` gates against — the switcher can
   * never show a guild the router would 404. Discord sessions: bot∩user
   * (fresh guilds payload or stored-snapshot fallback, see getAccessGuilds).
   * Fluxer sessions (PR 10): user∩snapshot over the Fluxer guild list with
   * the SAME token acquisition + refresh rotation as resolve. Names come
   * from the fresh payload or the stored snapshot; entries with no
   * communities row for the session's (platform, instanceKey) render
   * label-only (never a 404 link). NEVER throws: on any failure the switcher
   * just renders with fewer/no guilds; the per-request gate (`resolve`)
   * stays the security boundary.
   * @param {{id: string, userId: string}|null} session
   * @returns {Promise<{guilds: Array<{id: string, name: string}>, degraded: boolean, reauth?: boolean}>}
   */
  async function listGuilds(session) {
    if (!session || !session.id || !session.userId) {
      return { guilds: [], degraded: false, reauth: true };
    }
    try {
      const at = now();
      const platform = session.platform ?? "discord";
      const authRow = store.getWebSessionAuth(session.id);
      let accessToken = null;
      let lists = null;
      if (platform === "fluxer") {
        const tokF = await acquireFluxerToken(session, authRow, at);
        if (!tokF.ok) return { guilds: [], degraded: false, reauth: true };
        accessToken = tokF.token;
        lists = await getFluxerAccessGuilds(session, accessToken, at, tokF.authRow);
      } else {
        const tok = readAccessToken(tokenApi, authRow, at);
        if (!tok.ok) return { guilds: [], degraded: false, reauth: true };
        accessToken = tok.token;
        lists = await getAccessGuilds(session, accessToken, at);
      }
      if (lists.reauth) return { guilds: [], degraded: false, reauth: true };
      const instanceKey = session.instanceKey ?? "discord";
      const guilds = [...lists.list.values()]
        .map((g) => ({
          id: g.id,
          // Fluxer PR 2: the switcher LINKS by integer community id; entries
          // with no communities row render label-only (never a 404 link).
          // PR 10: mapping is per (platform, instanceKey) — the same snowflake
          // on another Fluxer instance is NOT this session's community.
          communityId: (() => {
            try {
              return getCommunityByExternal(platform, instanceKey, g.id);
            } catch {
              return null;
            }
          })(),
          // Never an empty <option>: ids are the stable fallback label.
          name: typeof g.name === "string" && g.name.trim() ? g.name : g.id,
        }))
        .sort((a, b) =>
          a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
          a.id.localeCompare(b.id)
        );
      return { guilds, degraded: !!lists.degraded };
    } catch (err) {
      console.warn(
        "[web] guildAccess.listGuilds failed closed:",
        err?.code || err?.message || err
      );
      return { guilds: [], degraded: true };
    }
  }

  /** Drop a session's cached guild list (logout / member-left events). */
  function invalidateSession(sessionId) {
    if (sessionId) accessLists.delete(sessionId);
  }

  /**
   * Drop cached member role ids (role-change events may call this).
   * Accepts the EXTERNAL snowflake (Discord events) or the INTEGER community
   * id (web callers) — the memberRoles cache keys by the external id, so an
   * integer is mapped through the registry first (PR 2). Fluxer PR 10: an
   * integer mapping to a fluxer row also clears the platform-scoped
   * `userId:fluxer:instance:external` key (see getFluxerMemberRoleIds).
   */
  function invalidateUserGuild(userId, guildId) {
    if (!userId) return;
    if (guildId != null && guildId !== "") {
      let external = String(guildId);
      let community = null;
      if (Number.isSafeInteger(guildId) && guildId >= 1) {
        try {
          community = getCommunityById(guildId);
        } catch {
          community = null;
        }
        external = community?.externalGuildId ?? String(guildId);
      }
      memberRoles.delete(`${userId}:${external}`);
      if (community?.platform === "fluxer") {
        memberRoles.delete(
          `${userId}:fluxer:${community.instanceKey}:${external}`
        );
      }
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

  return { resolve, listGuilds, invalidateSession, invalidateUserGuild, _clearCachesForTests };
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
