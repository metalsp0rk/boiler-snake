/**
 * Guild dashboard data assembly (roadmap/web-admin.md §8.6 Dashboard row,
 * subtask 14 — Phase 1 read, data only; charts are Phase 4).
 *
 * THE QUERY-BUDGET RULE (§8.6, review-blocking) drives every decision here:
 *  - ALL DB reads go through the existing src/db facade — no new SQL, no
 *    direct table access, no repositories edits (this module is a read-only
 *    wrapper; repositories stay owned by the db layer);
 *  - list sections ride the repository's own hard caps: topUsers is called
 *    with LIMIT 10, listOpenTickets is capped at 50 by the repo itself
 *    (default 25, max 50) — the "50+" saturation is DISPLAYED, never hidden;
 *  - the whole assembled snapshot is cached per guild for
 *    DEFAULT_CACHE_TTL_MS (30 s, the §8.6 floor; env WEB_DASHBOARD_CACHE_TTL_MS
 *    may RAISE it but can never lower it below the floor). A second request
 *    inside the window issues ZERO dashboard queries (pinned by tests).
 *  - guildActivityStats() is the one UNBOUNDED-WINDOW aggregate (SUM over the
 *    guild's ALL-TIME user_channel_message_daily rows; guild-prefixed PK
 *    scan, SQL-side, not JS). There is NO bounded per-window/per-kind helper
 *    in the repositories, so per the subtask rule it is cached aggressively
 *    and REPORTED as a gap — see "data-source gaps" in the module footer.
 *
 * DATA-SOURCE GAPS (report for the design doc, 2026-09-08):
 *  1. activity_log: no per-guild windowed aggregate helper (24 h / 7 d counts
 *     per kind). idx_activity_recent leads with user_id, so a guild-wide
 *     window scan would need a new (guild_id, created_at, kind) index + a
 *     `activityKindTotals(guildId, sinceMs)` helper. → NOT rendered.
 *  2. user_channel_message_daily: no bounded "last N days guild totals"
 *     helper (would be a cheap PK-prefix day-range scan, LIMIT ≤31).
 *     → substituted with the cached all-time guildActivityStats snapshot.
 *  3. voice_sessions: facade has only per-user get (no per-guild list) →
 *     live voice occupancy is NOT rendered; a `listVoiceSessions(guildId)`
 *     helper (table is bounded by connected users) would fix this.
 *  4. tickets: no COUNT helper for open tickets (only countArchivedTickets) →
 *     the open count is derived from the capped list rows and saturates at
 *     50 with an explicit "50+" display.
 *  5. admin_audit rows are a perfect bounded recent-events source
 *    (listAdminAudit, LIMIT ≤100, indexed) but §8.6 assigns the audit
 *     VIEWER to ADMIN — surfacing its rows on a Staff dashboard would be a
 *     tier violation, so the dashboard deliberately does NOT show them.
 *  6. No ticker exposes state (see data/tickerHealth.js header) and music
 *     needs the bot client for a player read → both arrive as injected
 *    providers; unwired renders "unknown/unavailable", never a guess.
 *
 * Design: pure factory (db/clock/TTL/providers injectable, like
 * auth/guildAccess.js). Cache is insertion-ordered with a size cap and
 * lazy expiry — no timers, nothing to clean up.
 */

const {
  snapshotTickerHealth,
  TICKER_STATUSES,
} = require("./tickerHealth");
const { DEFAULT_CACHE_TTL_MS, MIN_CACHE_TTL_MS, DEFAULT_MAX_ENTRIES, numOrNull, textOrNull, makeCacheSet } = require("./_shared");

const asFiniteNumber = numOrNull;
const clampText = textOrNull;


/** Hard caps for every list section (§8.6: LIMIT ≤ 100; all well under). */
const DASHBOARD_LIMITS = Object.freeze({
  XP_LEADERS: 10, // topUsers(guildId, 10) — SQL LIMIT
  OPEN_TICKET_ROWS: 50, // listOpenTickets repo cap is 50 — display saturates
  NEWEST_TICKETS: 5, // rows rendered in the "newest" section
});

const SECTION_OK = "ok";
const SECTION_UNAVAILABLE = "unavailable";

/**
 * Live env read (every knob in this project reads env live). The value may
 * only RAISE the TTL above the §8.6 floor; anything below the floor is
 * clamped (with one loud log per read is fine — clamping is rare).
 * @returns {number}
 */
function getDashboardCacheTtlMs() {
  const raw = String(process.env.WEB_DASHBOARD_CACHE_TTL_MS || "").trim();
  if (!raw) return DEFAULT_CACHE_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CACHE_TTL_MS;
  if (n < MIN_CACHE_TTL_MS) {
    console.warn(
      `[web] WEB_DASHBOARD_CACHE_TTL_MS=${n} is below the §8.6 30s floor — clamped to ${MIN_CACHE_TTL_MS}.`
    );
    return MIN_CACHE_TTL_MS;
  }
  return n;
}

/** Static-line warn (code/message only, like guildAccess); never rendered. */
function warnOnceLine(label, err) {
  console.warn(
    `[web] dashboard: ${label} failed:`,
    err?.code || err?.name || err?.message || "unknown"
  );
}

/**
 * Run one sync facade read, degrading to null on ANY throw (DB hiccup on a
 * dashboard panel must blank THAT panel, not 500 the page).
 * @param {() => unknown} read
 * @param {string} label static label for the log line
 */
function guardRead(read, label) {
  try {
    return { ok: true, value: read() };
  } catch (err) {
    warnOnceLine(label, err);
    return { ok: false, value: null };
  }
}


/** Clamp helper: [min, max] with NaN → fallback. */
function clampNum(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}


/**
 * Normalize one injected now-playing provider result to the view contract.
 * Anything unrecognized degrades to `unknown` — the dashboard never
 * fabricates a track (§8.6 spirit: honest data only).
 * @param {unknown} raw
 */
function normalizeNowPlaying(raw) {
  if (raw == null) return { status: "unknown", detail: "not wired" };
  if (typeof raw !== "object") return { status: "unknown" };
  const status = ["playing", "idle", "unavailable", "unknown"].includes(raw.status)
    ? raw.status
    : "unknown";
  const out = { status };
  const title = clampText(raw.title, 200);
  const author = clampText(raw.author, 120);
  const detail = clampText(raw.detail, 160);
  if (title) out.title = title;
  if (author) out.author = author;
  if (detail) out.detail = detail;
  if (typeof raw.paused === "boolean") out.paused = raw.paused;
  const positionMs = asFiniteNumber(raw.positionMs);
  if (positionMs !== null && positionMs >= 0) out.positionMs = Math.floor(positionMs);
  const upcoming = asFiniteNumber(raw.upcoming);
  if (upcoming !== null && upcoming >= 0) out.upcoming = Math.floor(upcoming);
  return out;
}

/**
 * Build a read-only now-playing snapshot from the music feature's live
 * player state (features/music/lavalink.js + lavaqueue player). EXPORTED
 * so a future boot wiring can pass `getNowPlaying: (guildId) =>
 * snapshotMusicPlayer(client, guildId)` WITHOUT this module ever importing
 * the bot runtime. Every failure mode degrades; lavalink-down is normal.
 *
 * @param {object|null} client discord.js client (or a test fake with
 *   `_lavalinkManager`)
 * @param {string} guildId
 * @param {{getManager: Function, isNodeReady: Function}} [musicApi]
 *   defaults to src/features/music/lavalink.js (test seam)
 */
function snapshotMusicPlayer(client, guildId, musicApi = require("../../features/music/lavalink")) {
  try {
    if (!client) return { status: "unknown", detail: "no client wired" };
    const manager = musicApi.getManager(client);
    if (!manager) return { status: "unavailable", detail: "lavalink not configured" };
    if (!musicApi.isNodeReady(client)) {
      return { status: "unavailable", detail: "no lavalink node connected" };
    }
    const player = manager.getPlayer?.(guildId) || null;
    if (!player) return { status: "idle", detail: "no active player in this guild" };
    const current = player.queue?.current;
    if (!current) return { status: "idle", detail: "queue empty" };
    const info = current.info || {};
    const upcoming = Array.isArray(player.queue?.tracks)
      ? player.queue.tracks.length
      : null;
    return normalizeNowPlaying({
      status: "playing",
      title: info.title,
      author: info.author,
      paused: !!player.paused,
      positionMs: Number(player.position) || 0,
      upcoming,
    });
  } catch {
    // Music state must never break the dashboard — degrade to unknown.
    return { status: "unknown", detail: "player read failed" };
  }
}

/** Coerce one ticker entry from any injected provider to the view shape. */
function normalizeTickerEntry(entry, index) {
  if (!entry || typeof entry !== "object") {
    return { name: `ticker-${index + 1}`, status: "unknown" };
  }
  const name = clampText(entry.name, 64) || `ticker-${index + 1}`;
  const status = TICKER_STATUSES.includes(entry.status) ? entry.status : "unknown";
  const out = { name, status };
  const lastTickAt = asFiniteNumber(entry.lastTickAt);
  if (lastTickAt !== null) out.lastTickAt = lastTickAt;
  const ageMs = asFiniteNumber(entry.ageMs);
  if (ageMs !== null && ageMs >= 0) out.ageMs = Math.floor(ageMs);
  const detail = clampText(entry.detail, 160);
  if (detail) out.detail = detail;
  return out;
}

/**
 * Pure factory for a per-guild cached dashboard data source.
 *
 * @param {object} [options]
 * @param {object} [options.db] src/db facade (default: live require — tests
 *   inject a counting proxy; facade methods are looked up PER CALL so
 *   monkey-patched facade methods are what actually run)
 * @param {() => number} [options.now] clock (fake in tests)
 * @param {number} [options.ttlMs] cache TTL; default getDashboardCacheTtlMs()
 *   (env, clamped to the §8.6 30 s floor); tests inject any value
 * @param {number} [options.maxEntries] cache entry cap (insertion-ordered)
 * @param {(guildId: string) => unknown|Promise<unknown>} [options.getNowPlaying]
 *   injected now-playing provider; default: "unknown / not wired"
 * @param {(guildId: string) => unknown[]|Promise<unknown[]>} [options.getTickerHealth]
 *   default: data/tickerHealth.js registry snapshot
 * @returns {{
 *   getDashboard: (guildId: string) => Promise<object>,
 *   invalidate: (guildId?: string) => void,
 *   _cacheSizeForTests: () => number,
 * }}
 */
function createDashboardData(options = {}) {
  const facade = options.db || require("../../db");
  const now = options.now || Date.now;
  const ttlMs =
    options.ttlMs != null
      ? clampNum(options.ttlMs, { min: 1, max: 24 * 3600_000, fallback: DEFAULT_CACHE_TTL_MS })
      : getDashboardCacheTtlMs();
  const maxEntries = clampNum(options.maxEntries, {
    min: 1,
    max: 5000,
    fallback: DEFAULT_MAX_ENTRIES,
  });
  const getNowPlaying = options.getNowPlaying || null;
  const getTickerHealth = options.getTickerHealth || null;

  /** guildId → { data, cachedAt, expiresAt, served } (never mutated after store) */
  const cache = new Map();

  const cacheSet = makeCacheSet(cache, maxEntries);

  async function readTickers() {
    const read = getTickerHealth || ((/* guildId */) => snapshotTickerHealth(now()));
    try {
      const raw = await read();
      const list = Array.isArray(raw) ? raw : [];
      return list.map(normalizeTickerEntry);
    } catch (err) {
      warnOnceLine("ticker health", err);
      return [];
    }
  }

  async function readNowPlaying(guildId) {
    if (!getNowPlaying) return { status: "unknown", detail: "not wired" };
    try {
      return normalizeNowPlaying(await getNowPlaying(guildId));
    } catch (err) {
      warnOnceLine("now-playing", err);
      return { status: "unknown", detail: "source failed" };
    }
  }

  /**
   * ONE uncached assembly. Each DB section is individually guarded so a
   * single failing read blanks one panel, not the page.
   * @param {string} guildId
   * @param {number} at
   */
  async function buildSnapshot(guildId, at) {
    // -- Activity: bounded facade reads + the ONE cached all-time aggregate.
    const stats = guardRead(() => facade.guildActivityStats(guildId), "activity stats");
    const settings = guardRead(
      () => facade.getGuildActivitySettings(guildId),
      "activity settings"
    );
    const backfillActive = guardRead(
      () => facade.guildHasActiveBackfill(guildId),
      "backfill state"
    );
    const leaders = guardRead(
      () => facade.topUsers(guildId, DASHBOARD_LIMITS.XP_LEADERS),
      "xp leaders"
    );

    const messageTracking =
      stats.ok && stats.value
        ? {
            trackedMessages: Number(stats.value.message_total) || 0,
            dayRows: Number(stats.value.day_rows) || 0,
            ignoreCount: Number(stats.value.ignore_count) || 0,
            collectFromMs: asFiniteNumber(settings.value?.collect_from_ms),
            backfillStatus:
              clampText(settings.value?.guild_backfill_status, 32) || "unknown",
            backfillActive: backfillActive.ok ? !!backfillActive.value : null,
          }
        : null;

    const xpLeaders = leaders.ok
      ? (Array.isArray(leaders.value) ? leaders.value : [])
          .slice(0, DASHBOARD_LIMITS.XP_LEADERS)
          .map((r) => ({
            userId: String(r.user_id ?? ""),
            xp: Number(r.xp) || 0,
          }))
      : null;

    // -- Open tickets: repo hard-caps this list at 50 (SQL LIMIT).
    const openRes = guardRead(
      () => facade.listOpenTickets(guildId, { limit: DASHBOARD_LIMITS.OPEN_TICKET_ROWS }),
      "open tickets"
    );
    const openRows = openRes.ok && Array.isArray(openRes.value) ? openRes.value : [];
    const tickets = {
      available: openRes.ok,
      openCount: openRows.length,
      // True when the capped read may be hiding more rows (§8.6: display it).
      openCountSaturated: openRows.length >= DASHBOARD_LIMITS.OPEN_TICKET_ROWS,
      newest: openRows.slice(0, DASHBOARD_LIMITS.NEWEST_TICKETS).map((t) => ({
        id: t.id,
        ticketNumber: Number(t.ticket_number) || 0,
        reason: clampText(t.reason, 120),
        creatorUserId: String(t.creator_user_id ?? ""),
        createdAt: Number(t.created_at) || 0,
      })),
    };

    const [tickers, nowPlaying] = await Promise.all([
      readTickers(),
      readNowPlaying(guildId),
    ]);

    return {
      guildId,
      generatedAt: at,
      activity: {
        // "unavailable" only when EVERY activity read failed.
        status:
          messageTracking || xpLeaders ? SECTION_OK : SECTION_UNAVAILABLE,
        messageTracking,
        xpLeaders,
      },
      tickets,
      tickers,
      nowPlaying,
    };
  }

  /**
   * Cached dashboard snapshot for one guild. Cache hits run no DB and no
   * provider code at all (§8.6 acceptance: second request within the window
   * issues no new aggregate queries).
   * @param {string} guildId
   * @returns {Promise<object>} snapshot + `freshness` (fromCache, ageMs)
   */
  async function getDashboard(guildId) {
    if (typeof guildId !== "string" || !guildId) {
      throw new TypeError("getDashboard: guildId must be a non-empty string");
    }
    const at = now();
    const cached = cache.get(guildId);
    if (cached && cached.expiresAt > at) {
      const { data, cachedAt, expiresAt } = cached;
      return {
        ...data,
        freshness: {
          generatedAt: cachedAt,
          cacheExpiresAt: expiresAt,
          ageMs: Math.max(0, at - cachedAt),
          fromCache: true,
        },
      };
    }
    const data = await buildSnapshot(guildId, at);
    cacheSet(guildId, { data, cachedAt: at, expiresAt: at + ttlMs, served: 0 });
    return {
      ...data,
      freshness: {
        generatedAt: at,
        cacheExpiresAt: at + ttlMs,
        ageMs: 0,
        fromCache: false,
      },
    };
  }

  /** Drop one guild's entry (or all). Exposed for wiring/tests. */
  function invalidate(guildId) {
    if (guildId === undefined) cache.clear();
    else cache.delete(guildId);
  }

  return {
    getDashboard,
    invalidate,
    _cacheSizeForTests: () => cache.size,
  };
}

/** Lazily built process-wide default (production / routes without injection). */
let defaultInstance = null;
function getDefaultDashboardData() {
  if (!defaultInstance) defaultInstance = createDashboardData();
  return defaultInstance;
}

function _resetDefaultDashboardDataForTests() {
  defaultInstance = null;
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  MIN_CACHE_TTL_MS,
  DASHBOARD_LIMITS,
  getDashboardCacheTtlMs,
  snapshotMusicPlayer,
  createDashboardData,
  getDefaultDashboardData,
  _resetDefaultDashboardDataForTests,
};
