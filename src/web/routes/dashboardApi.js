/**
 * DASHBOARD JSON API — the chart data endpoints (roadmap/web-admin.md §8.6
 * Dashboard row "1 (data) / 4 (charts)"; operator decision 2026-09-25:
 * charts render CLIENT-SIDE from these JSON endpoints, fed by the cached
 * dashboard aggregates — the first step of the client-server/API direction).
 *
 *   GET /g/:guildId/api/dashboard/activity.json
 *     → daily message totals, last 30 days (user_channel_message_daily,
 *       SQL-side GROUP BY day, ≤31 rows) — feeds the LINE chart.
 *   GET /g/:guildId/api/dashboard/xp-leaders.json
 *     → top 10 members by XP (topUsers LIMIT 10, same read the SSR page
 *       snapshot already runs) — feeds the BAR chart.
 *
 * Contract (identical gates to the lookups JSON surface, §8.15-15.10):
 *  - staff tier: guildScope (mounted by routes/dashboard.js BEFORE this
 *    registrar) answers anon/reauth with the byte-identical login redirect
 *    and stranger/cross-guild/bad-id with the generic 404 (never 403);
 *    requireTier("staff") then guards the staff floor in-guild (403 fixed);
 *  - framing: raw writeHead JSON, `Cache-Control: no-store` (session data),
 *    nosniff — never an HTML error page, never a stack in the body;
 *  - query budget (§8.6, review-blocking): both series come from the
 *    per-guild ≥30 s cache in src/web/data/dashboardData.js; every backing
 *    query is SQL-side aggregated with LIMIT ≤ 31/10 — no full scans, no
 *    per-request JS aggregation of raw rows;
 *  - honesty: points/leaders are ONLY real table data (zero-filled days are
 *    true "no tracked messages" days); a failed read reports
 *    `available:false` as a 500 JSON so the client shows an honest
 *    "chart unavailable" state instead of a fabricated chart.
 */

const { requireTier } = require("../middleware/requireTier");
const { resolveMemberNames } = require("./shared/discord-cache");
const { SERIES_LIMITS } = require("../data/dashboardData");

/** Version marker of the JSON shape (clients may branch on it). */
const API_VERSION = 1;

function json200(res, payload) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

function jsonError(res, status, code) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify({ error: code }));
}

/**
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {{getDailyActivitySeries: Function, getXpLeadersSeries: Function}} options.dashboardData
 *   createDashboardData() instance (app.js publishes the SAME instance the
 *   dashboard page uses — one cache per guild across page + API reads).
 * @param {(() => any)|null} [options.getClient] member-name cache seam
 *   (read-only; miss ⇒ raw ids as labels, never a fetch on a request path).
 * @param {number} [options.activityDays] x-axis window (default 30, clamped
 *   1..31 by the data layer; tests pass small values)
 */
function registerDashboardApiRoutes(app, options = {}) {
  const dashboard = options.dashboardData;
  if (!dashboard || typeof dashboard.getDailyActivitySeries !== "function") {
    throw new TypeError(
      "registerDashboardApiRoutes: dashboardData with getDailyActivitySeries is required"
    );
  }
  const getClient = typeof options.getClient === "function" ? options.getClient : null;
  const activityDays = Number.isFinite(Number(options.activityDays))
    ? Number(options.activityDays)
    : SERIES_LIMITS.DAILY_ACTIVITY_DAYS;

  // ---- daily activity series (line chart) ---------------------------------
  app.get("/g/:guildId/api/dashboard/activity.json", requireTier("staff"), async (req, res) => {
    try {
      const guildId = req.guildAccess.guildId;
      // Fluxer PR 2: data reads key by the integer community id.
      const communityId = req.guildAccess.communityId;
      const series = await dashboard.getDailyActivitySeries(communityId, { days: activityDays });
      if (!series.available) {
        // Loud server-side + honest client-side: the chart JS shows
        // "unavailable", never an empty-but-plausible chart.
        console.error(`[web] dashboardApi.activity: data unavailable (guild=${guildId})`);
        jsonError(res, 500, "activity_data_unavailable");
        return;
      }
      json200(res, {
        api: API_VERSION,
        series: "daily_activity",
        days: series.days,
        from: series.fromDay,
        to: series.toDay,
        points: series.points,
        generatedAt: series.freshness.generatedAt,
        fromCache: series.freshness.fromCache,
      });
    } catch (err) {
      console.error(
        `[web] dashboardApi.activity failed (guild=${req.guildAccess?.guildId}):`,
        err?.message || err
      );
      jsonError(res, 500, "activity_series_failed");
    }
  });

  // ---- XP leaders series (bar chart) --------------------------------------
  app.get("/g/:guildId/api/dashboard/xp-leaders.json", requireTier("staff"), async (req, res) => {
    try {
      const guildId = req.guildAccess.guildId;
      const communityId = req.guildAccess.communityId;
      const series = await dashboard.getXpLeadersSeries(communityId);
      if (!series.available) {
        console.error(`[web] dashboardApi.xpLeaders: data unavailable (guild=${guildId})`);
        jsonError(res, 500, "xp_leaders_data_unavailable");
        return;
      }
      // Cache-only display names for the bar labels (same seam the SSR
      // dashboard uses; miss ⇒ the raw id label, never a fetch here).
      const ids = series.leaders.map((l) => l.userId).filter(Boolean);
      const names = resolveMemberNames(getClient, guildId, ids);
      json200(res, {
        api: API_VERSION,
        series: "xp_leaders",
        limit: series.limit,
        leaders: series.leaders.map((l) => ({
          userId: l.userId,
          name: names?.get?.(l.userId) ?? null,
          xp: l.xp,
        })),
        generatedAt: series.freshness.generatedAt,
        fromCache: series.freshness.fromCache,
      });
    } catch (err) {
      console.error(
        `[web] dashboardApi.xpLeaders failed (guild=${req.guildAccess?.guildId}):`,
        err?.message || err
      );
      jsonError(res, 500, "xp_leaders_series_failed");
    }
  });
}

module.exports = { registerDashboardApiRoutes, API_VERSION };
