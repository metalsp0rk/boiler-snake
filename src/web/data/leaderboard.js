/**
 * Read-model for the web XP leaderboard + per-user XP page
 * (roadmap/web-admin.md §8.6 "XP: leaderboard, history | Staff" row,
 * Phase 1 read-only — subtask 16).
 *
 * XP HISTORY FINDING (§8.6 row says "leaderboard, history"):
 *  There is NO xp-history table anywhere under src/db/migrations/ — the
 *  `users` table stores only the CURRENT xp snapshot per (guild_id, user_id)
 *  and `activity_log` rows are per-event award counters with no XP-total
 *  series (no facade read builds an XP-over-time query either). Rather than
 *  fabricate a history, the per-user page shows what the data supports —
 *  rank position, XP, level and progress-to-next-level — which is EXACTLY
 *  the data set slash /xp renders (parity preserved; the limitation is
 *  rendered honestly on the page and reported for the design doc).
 *
 * Slash parity (acceptance: "no reimplementation"):
 *  - level: core/xpMath levelFromXp — the same function slash calls;
 *  - factor: Math.max(1, Number(level_xp_factor) || 100) — the exact
 *    expression features/xp buildLeaderboardPagePayload uses;
 *  - progress-within-level: the L²·factor formula from
 *    render/leaderboard.js levelProgress (kept private there, so it is
 *    mirrored line-for-line below, with a test pinned against it);
 *  - ordering: XP DESC, exactly like repository topUsers; the user_id ASC
 *    tie-break is ADDED for stable cross-page pagination (topUsers +
 *    slice() has no tie-break and can shuffle rows between slash button
 *    pages; a web pager must not).
 *
 * Query-budget contract (§8.6, review-blocking):
 *  - every read carries the guild id from req.guildAccess.guildId as its
 *    first filter — NO cross-guild aggregation is possible (first
 *    positional arg of every function is guildId);
 *  - the page read is LIMIT-bounded to PAGE_SIZE_MAX = 100 (hard cap,
 *    default 25) with OFFSET bounded by MAX_PAGE × PAGE_SIZE_MAX ≤ 1000
 *    rows scanned per request (the userProfile.js MAX_OFFSET=1000 rule);
 *  - totals are one COUNT(*) on the users PRIMARY KEY guild_id prefix
 *    (index-covered for the guild — no table scan), replacing slash's
 *    `limit*page+1` headroom fetch so no request ever asks SQL for more
 *    than PAGE_SIZE_MAX rows;
 *  - reads ride the same (guild_id …) PK index prefix as the shipped
 *    topUsers; a strict index-backed ORDER BY xp would need a new
 *    (guild_id, xp) index MIGRATION, which is outside this subtask's file
 *    ownership — flagged in the completion report instead.
 */

const { getUser, getGuildSettings, db } = require("../../db");
const { levelFromXp, clampXpTotal } = require("../../core/xpMath");

/** Snowflake shape gate for :userId (same shape as userProfile.js / guild ids). */
const { URL_ID_RE: USER_ID_RE } = require("../shared/snowflake");

/** Page size: default 25, HARD CAP 100 (§8.6 "top-100 cap"). */
const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;

/**
 * Page depth cap: with the ≤100 page cap this bounds OFFSET reads to
 * (MAX_PAGE-1)*PAGE_SIZE_MAX + PAGE_SIZE_MAX = 1000 rows scanned — the
 * exact ceiling userProfile.js sets via MAX_OFFSET.
 */
const MAX_PAGE = 10;

/**
 * Level-XP factor exactly as slash resolves it
 * (features/xp buildLeaderboardPagePayload: `Math.max(1, Number(settings.level_xp_factor) || 100)`;
 * levelFromXp re-applies the identical guard internally).
 * @param {object|null|undefined} settings
 * @returns {number}
 */
function resolveXpFactor(settings) {
  return Math.max(1, Number(settings?.level_xp_factor) || 100);
}

/**
 * Normalize the raw ?size query param (slash clampLeaderboardLimit parity:
 * invalid → default, otherwise floor + clamp to the hard cap).
 * @param {string|null|undefined} raw
 * @returns {number}
 */
function readPageSize(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return PAGE_SIZE_DEFAULT;
  return Math.min(n, PAGE_SIZE_MAX);
}

/**
 * Normalize the raw ?page query param: 1-based integer, junk → 1,
 * clamped to MAX_PAGE so OFFSET cannot drive deep scans.
 * @param {string|null|undefined} raw
 * @returns {number}
 */
function readPage(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_PAGE);
}

/**
 * Tracked-user count for ONE guild — COUNT(*) served from the users
 * PRIMARY KEY (guild_id, user_id) prefix: an index-only scan of the
 * guild's index range, never a full table scan.
 * @param {string} guildId
 * @returns {number}
 */
function countTrackedUsers(guildId) {
  const row = db
    .prepare(`SELECT COUNT(*) AS total FROM users WHERE guild_id=?`)
    .get(guildId);
  return Number(row?.total) || 0;
}

/**
 * One leaderboard page: rows decorated with rank + level, plus honest
 * pagination truth. Raw-SQL here follows the userProfile.js
 * recentTicketsForUser precedent (the facade topUsers has no OFFSET and
 * the shared repository is not editable by this subtask): guild-scoped,
 * index-prefixed, LIMIT/OFFSET-bounded.
 *
 * Rank = list position under the full ORDER BY (competition ranking with
 * ties would need a second aggregate; slash's own ranks ARE list positions
 * — `(page-1)*limit + idx + 1` — so parity says list position, and the
 * per-user page derives rank from the SAME order definition).
 *
 * @param {string} guildId MUST be req.guildAccess.guildId
 * @param {{ page?: string|number|null, size?: string|number|null }} [query]
 * @returns {{ rows: {rank: number, user_id: string, xp: number, level: number}[], page: number, size: number, total: number, totalPages: number, hasPrev: boolean, hasNext: boolean }}
 */
function buildLeaderboardPage(guildId, query = {}) {
  const size = readPageSize(query.size);
  const total = countTrackedUsers(guildId);
  const totalPages = Math.max(1, Math.ceil(total / size));

  // Page-overflow clamp: past-the-end never renders a blank page-9999;
  // it shows the last real page (totalPages already ≥1, so page ≥1).
  const page = Math.min(readPage(query.page), totalPages);

  const settings = getGuildSettings(guildId);
  const factor = resolveXpFactor(settings);

  let rows = [];
  if (total > 0) {
    const raw = db
      .prepare(
        `
      SELECT user_id, xp
      FROM users
      WHERE guild_id=?
      ORDER BY xp DESC, user_id ASC
      LIMIT ? OFFSET ?
      `
      )
      .all(guildId, size, (page - 1) * size);
    rows = raw.map((r, idx) => {
      // clampXpTotal mirrors the repository's own read-clamp (topUsers).
      const xp = clampXpTotal(r.xp);
      return {
        rank: (page - 1) * size + idx + 1,
        user_id: r.user_id,
        xp,
        level: levelFromXp(xp, factor),
      };
    });
  }

  return {
    rows,
    page,
    size,
    total,
    totalPages,
    hasPrev: page > 1,
    hasNext: page < totalPages,
  };
}

/**
 * Per-user XP read-model — the honest substitute for an XP-history tab
 * (see the file-header finding): rank position in THIS guild's
 * leaderboard, XP, level, and progress to the next level.
 *
 * Rank derives from the leaderboard's exact order definition
 * (xp DESC, user_id ASC): count of users ordered strictly ahead + 1.
 * One COUNT + one PK point-read + one total COUNT — three bounded reads,
 * no pagination needed.
 *
 * @param {string} guildId
 * @param {string} userId snowflake (route-validated); NO row → null
 * @returns {null | {
 *   userId: string, xp: number, level: number, rank: number, total: number,
 *   factor: number, levelStartXp: number, nextLevelXp: number,
 *   xpIntoLevel: number, xpToNext: number, progress: number, progressPct: number
 * }}
 */
function buildUserXpSummary(guildId, userId) {
  const row = getUser(guildId, userId); // read-only PK point-read, no seed
  if (!row) return null;

  const settings = getGuildSettings(guildId);
  const factor = resolveXpFactor(settings);
  const xp = row.xp; // getUser already clamps
  const level = levelFromXp(xp, factor);

  const ahead = db
    .prepare(
      `SELECT COUNT(*) AS ahead FROM users
       WHERE guild_id=? AND (xp > ? OR (xp = ? AND user_id < ?))`
    )
    .get(guildId, xp, xp, userId);

  // render/leaderboard.js levelProgress, mirrored line-for-line:
  // startXP = L^2 * factor; nextXP = (L+1)^2 * factor.
  const levelStartXp = level * level * factor;
  const nextLevelXp = (level + 1) * (level + 1) * factor;
  const denom = Math.max(1, nextLevelXp - levelStartXp);
  const progress = Math.max(0, Math.min(1, (xp - levelStartXp) / denom));

  return {
    userId,
    xp,
    level,
    rank: (Number(ahead?.ahead) || 0) + 1,
    total: countTrackedUsers(guildId),
    factor,
    levelStartXp,
    nextLevelXp,
    xpIntoLevel: Math.max(0, xp - levelStartXp),
    xpToNext: Math.max(0, nextLevelXp - xp),
    progress,
    progressPct: Math.round(progress * 100),
  };
}

module.exports = {
  USER_ID_RE,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  MAX_PAGE,
  resolveXpFactor,
  readPageSize,
  readPage,
  countTrackedUsers,
  buildLeaderboardPage,
  buildUserXpSummary,
};
