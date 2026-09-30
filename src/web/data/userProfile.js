/**
 * Read-model for the web user pages (roadmap/web-admin.md §8.6 "Users:
 * unified profile (XP, warnings, notes)" [Staff] + "Users: Activity tab"
 * [Senior], Phase 1 read-only — subtask 15).
 *
 * Query-budget contract (§8.6, review-blocking):
 *  - every query carries the guild id from req.guildAccess.communityId — there is
 *    NO cross-guild aggregation here and no way to call these helpers without
 *    one (first positional arg of every function is communityId);
 *  - every list is LIMIT-bounded well below 100 (search ≤50; warnings /
 *    notes / tickets ≤10 per page with offset paging);
 *  - counts are point aggregates on the existing
 *    (community_id, user_id[, created_at]) indexes — no full scans;
 *  - the ONE raw-SQL query in this file (recentTicketsForUser) exists because
 *    the tickets repository has no per-user "any status" list helper and
 *    warnings.js / staffNotes.js are read-only for this subtask; it is
 *    guild-scoped, index-driven and LIMIT/OFFSET-bounded.
 *
 * Slash parity: warnings/notes sections mirror src/features/userinfo/index.js
 * (LIST_LIMIT 10, "showing X of Y"); the Activity tab reuses the EXACT
 * service functions the slash Activity gate calls (buildChannelRanking /
 * buildCategoryRanking from features/userActivity/service.js), so web and
 * slash can never drift in WHICH data senior staff sees.
 */

const {
  getUser,
  searchUsers: searchUsersRepo,
  getGuildSettings,
  listWarnings,
  countWarnings,
  countActiveWarnings,
  listStaffNotes,
  countStaffNotes,
  getUserActivityMeta,
  db,
} = require("../../db");
const { levelFromXp } = require("../../core/xpMath");
const {
  buildChannelRanking,
  buildCategoryRanking,
  normalizeWindow,
} = require("../../features/userActivity/service");

/** Snowflake shape gate for :userId / search text (same shape as guild ids). */
const { URL_ID_RE: USER_ID_RE } = require("../shared/snowflake");

/** Hard caps. LIST caps mirror the slash userinfo card (10 rows per view). */
const SEARCH_LIMIT = 50;
const LIST_LIMIT = 10;

/** Clamp offsets so a hostile `?o=999999999` cannot drive deep scans. */
const MAX_OFFSET = 1000;

/**
 * Bounded "recent tickets involving this user, any status" (creator, added
 * member, or named staff — the §8.4 participant classes minus message
 * authors, which would need a ticket_messages scan and is out of budget).
 * newest-first by ticket_number; LIMIT ≤ LIST_LIMIT.
 * @param {number} communityId
 * @param {string} userId
 * @param {{ limit?: number, offset?: number }} [opts]
 * @returns {object[]}
 */
function recentTicketsForUser(communityId, userId, opts = {}) {
  // +1 headroom: callers request LIST_LIMIT+1 to detect "more" — still ≤100.
  const limit = Math.min(Math.max(Number(opts.limit) || LIST_LIMIT, 1), LIST_LIMIT + 1);
  const offset = Math.min(Math.max(Number(opts.offset) || 0, 0), MAX_OFFSET);
  return db
    .prepare(
      `
    SELECT t.id, t.ticket_number, t.status, t.reason, t.created_at, t.closed_at,
           t.archived, t.creator_user_id, t.staff_owner_id,
           (t.creator_user_id = ?) AS is_creator
    FROM tickets t
    WHERE t.community_id = ?
      AND (
        t.creator_user_id = ?
        OR EXISTS (SELECT 1 FROM ticket_members tm
                   WHERE tm.ticket_id = t.id AND tm.user_id = ?)
        OR EXISTS (SELECT 1 FROM ticket_staff ts
                   WHERE ts.ticket_id = t.id AND ts.user_id = ?)
      )
    ORDER BY t.ticket_number DESC
    LIMIT ? OFFSET ?
    `
    )
    // Placeholder order follows the SQL TEXT: SELECT is_creator ← userId,
    // then WHERE guild, creator, member, staff, then LIMIT/OFFSET.
    .all(userId, communityId, userId, userId, userId, limit, offset);
}

/**
 * Cheap existence matrix (all point lookups on indexed keys). A user with no
 * bot footprint anywhere has no profile page — the web panel cannot verify
 * Discord membership without the bot's member cache, so "unknown user"
 * renders the friendly not-found instead of an empty profile (§8.6).
 * @param {number} communityId
 * @param {string} userId
 * @returns {boolean}
 */
function userHasData(communityId, userId) {
  if (!!getUser(communityId, userId)) return true;
  if (countWarnings(communityId, userId, { includeVoided: true }) > 0) return true;
  if (countStaffNotes(communityId, userId, { includeDeleted: true }) > 0) return true;
  if (!!getUserActivityMeta(communityId, userId)) return true;
  return recentTicketsForUser(communityId, userId, { limit: 1 }).length > 0;
}

/**
 * Normalize one list offset from the query string.
 * @param {string|null|undefined} raw
 * @returns {number}
 */
function readOffset(raw) {
  return Math.min(Math.max(Number(raw) || 0, 0), MAX_OFFSET);
}

/**
 * Full unified profile read-model for the staff-tier page. ONE known flag +
 * XP/level + warning/note/ticket sections, all guild-scoped and bounded.
 *
 * @param {number} communityId MUST be req.guildAccess.communityId
 * @param {string} userId snowflake (validated by the caller)
 * @param {{ warnOffset?: number, noteOffset?: number, ticketOffset?: number }} [page]
 * @returns {{ known: boolean } & object}
 */
function buildUserProfile(communityId, userId, page = {}) {
  const warnOffset = readOffset(page.warnOffset);
  const noteOffset = readOffset(page.noteOffset);
  const ticketOffset = readOffset(page.ticketOffset);

  const userRow = getUser(communityId, userId);
  const warnsActive = countActiveWarnings(communityId, userId);
  const warnsTotal = countWarnings(communityId, userId, { includeVoided: true });
  const notesActive = countStaffNotes(communityId, userId, { includeDeleted: false });
  const notesTotal = countStaffNotes(communityId, userId, { includeDeleted: true });
  const ticketsTotalGuess = recentTicketsForUser(communityId, userId, {
    limit: LIST_LIMIT + 1,
    offset: ticketOffset,
  });
  const ticketsHasMore = ticketsTotalGuess.length > LIST_LIMIT;
  const tickets = ticketsHasMore ? ticketsTotalGuess.slice(0, LIST_LIMIT) : ticketsTotalGuess;

  const settings = getGuildSettings(communityId);
  const xp = userRow ? userRow.xp : 0;

  const known =
    !!userRow ||
    warnsTotal > 0 ||
    notesTotal > 0 ||
    tickets.length > 0 ||
    !!getUserActivityMeta(communityId, userId);

  return {
    known,
    userId,
    xp,
    tracked: !!userRow,
    level: levelFromXp(xp, settings?.level_xp_factor ?? null),
    counts: {
      warnsActive,
      warnsTotal,
      notesActive,
      notesTotal,
    },
    warnings: {
      rows: listWarnings(communityId, userId, {
        includeVoided: true,
        limit: LIST_LIMIT,
        offset: warnOffset,
      }),
      offset: warnOffset,
      total: warnsTotal,
    },
    notes: {
      rows: listStaffNotes(communityId, userId, {
        includeDeleted: false,
        limit: LIST_LIMIT,
        offset: noteOffset,
      }),
      offset: noteOffset,
      total: notesActive,
    },
    tickets: {
      rows: tickets,
      offset: ticketOffset,
      hasMore: ticketsHasMore,
    },
  };
}

/**
 * Senior-only Activity read-model — THE /userinfo Activity data set, built by
 * the same service functions the slash card uses (window normalize included).
 * `guild` / `joinedMs` come from the bot's caches via the caller's client
 * seam; when absent the service degrades exactly like slash does for
 * unresolvable channels/join dates (#<id> labels, min-1-week rate).
 *
 * Boundedness: sumByChannel is a per-user GROUP BY over that user's rows in
 * ONE guild (indexed PK prefix community_id+user_id); rendered rows are sliced to
 * the service's own TOP_CHANNELS/TOP_CATEGORIES (15). This is the identical
 * footprint the shipped slash path runs per senior request — no new scan.
 *
 * @param {number} communityId
 * @param {string} userId
 * @param {{ win?: string|null, page?: string|null, guild?: object|null, joinedMs?: number|null }} [opts]
 * @returns {{ ranking: object, window: string, page: "channels"|"categories", joinedMs: number|null }}
 */
function buildUserActivity(communityId, userId, opts = {}) {
  const win = normalizeWindow(opts.win);
  const wantPage = opts.page === "ca" || opts.page === "c" ? "categories" : "channels";
  const joinedMs = opts.joinedMs ?? null;
  const rankingOpts = {
    communityId,
    userId,
    guild: opts.guild ?? null,
    window: win,
    joinedMs,
  };
  const ranking =
    wantPage === "categories"
      ? buildCategoryRanking(rankingOpts)
      : buildChannelRanking(rankingOpts);
  return { ranking, window: win, page: wantPage, joinedMs };
}

/**
 * Staff-tier user search (users index page). Delegates to the users
 * repository helper (id exact/prefix only, LIMIT ≤50, no scans) and adds the
 * per-guild level for display.
 *
 * @param {number} communityId
 * @param {string|null|undefined} rawQuery
 * @returns {{ query: string, results: { user_id: string, xp: number, level: number }[], searched: boolean }}
 */
function searchGuildUsers(communityId, rawQuery, opts = {}) {
  const q = String(rawQuery ?? "").trim().slice(0, 64);
  if (!q) return { query: "", results: [], searched: false };
  const settings = getGuildSettings(communityId);
  const factor = settings?.level_xp_factor ?? null;
  // §8.15-15.10: numeric queries keep the exact/prefix id search (works
  // offline, DB-only). NAME queries resolve through caller-supplied
  // member-cache ids (opts.nameMatchIds — the ROUTE owns the cache);
  // untracked members never appear here, only tracked rows.
  const numeric = /^[0-9]{1,20}$/.test(q);
  const rows = numeric
    ? searchUsersRepo(communityId, q, { limit: SEARCH_LIMIT })
    : (Array.isArray(opts.nameMatchIds) ? opts.nameMatchIds : [])
        .slice(0, SEARCH_LIMIT)
        .flatMap((id) => searchUsersRepo(communityId, String(id), { limit: 1 }));
  return {
    query: q,
    searched: true,
    results: rows.map((r) => ({ ...r, level: levelFromXp(r.xp, factor) })),
  };
}

module.exports = {
  USER_ID_RE,
  SEARCH_LIMIT,
  LIST_LIMIT,
  MAX_OFFSET,
  readOffset,
  userHasData,
  buildUserProfile,
  buildUserActivity,
  searchGuildUsers,
  // tests / Phase 2+ reuse
  recentTicketsForUser,
};
