/**
 * Views for the web XP leaderboard + per-user XP page
 * (roadmap/web-admin.md §8.6 "XP: leaderboard, history | Staff" row,
 * Phase 1 read-only — subtask 16).
 *
 * COMPOSED ENTIRELY with the escaped-by-default `html` helper: display
 * names resolved from the bot's member cache are DISCORD-controlled strings
 * and interpolate through html`` only (raw() never touches request/DB
 * data — same contract as views/users). The XSS suite pins this.
 *
 * Name fallback parity: slash /leaderboard falls back to
 * `User ${id}` when the member cache misses (features/xp
 * buildLeaderboardPagePayload) — renderLeaderboardBody uses the identical
 * fallback, so web and Discord show the same text.
 *
 * Progress bar: rendered with a DECILE BUCKET CLASS (lb-bar-0 … lb-bar-10,
 * CSS in public/styles.css) — never an inline style attribute, keeping the
 * CSP (no style-src unsafe-inline) fully effective.
 */

const { html } = require("../escape");
const { emptyState } = require("../components");

/** Slash parity: features/xp names cache-misses `User ${id}`. */
function displayNameOrId(entry, names) {
  const name = names instanceof Map ? names.get(entry.user_id) : null;
  return name || `User ${entry.user_id}`;
}

/** Preserves ?size while paging (?page is the moving part). */
function pageHref(guildId, page, size) {
  return `/g/${guildId}/leaderboard?page=${page}&size=${size}`;
}

/** Prev/next + honest page counter (GET links only — Phase 1 is read-only). */
function boardPager(board, guildId) {
  const from = board.total === 0 ? 0 : (board.page - 1) * board.size + 1;
  const to = (board.page - 1) * board.size + board.rows.length;
  const prev = board.hasPrev
    ? html`<a class="pager-prev" href="${pageHref(guildId, board.page - 1, board.size)}">← prev</a>`
    : html``;
  const next = board.hasNext
    ? html`<a class="pager-next" href="${pageHref(guildId, board.page + 1, board.size)}">next →</a>`
    : html``;
  return html`<p class="pager leaderboard-pager">
    ${prev}
    <span class="pager-count">showing ranks ${from}–${to} of ${board.total} · page ${board.page} of ${board.totalPages}</span>
    ${next}
  </p>`;
}

/**
 * Leaderboard page body. `board` = data/leaderboard.buildLeaderboardPage()
 * output; `names` = Map<userId, displayName|null> from the caller's
 * cache-only member read.
 */
function renderLeaderboardBody(req, { board, names }) {
  const guildId = req.guildAccess.guildId;
  const rows = board.rows.map(
    (entry) => html`
      <tr class="row-lb">
        <td class="lb-rank">${entry.rank}</td>
        <td class="lb-user">
          <a href="/g/${guildId}/users/${entry.user_id}">${displayNameOrId(entry, names)}</a>
          <code class="user-id">${entry.user_id}</code>
        </td>
        <td class="lb-xp">${entry.xp}</td>
        <td class="lb-level">${entry.level}</td>
      </tr>`
  );
  const table = board.rows.length
    ? html`<table class="list-table leaderboard-table">
        <thead>
          <tr><th>#</th><th>User</th><th>XP</th><th>Level</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`
    : emptyState("No XP data yet in this guild.");
  return html`
    ${board.total > 0 ? boardPager(board, guildId) : html``}
    ${table}
    <p class="hint">Top XP per guild · ${board.size} rows per page (cap 100) · ordering and level math are the same XP core the slash /leaderboard uses. Add ?page=N&amp;size=M to the URL to page.</p>`;
}

/** Decile bucket → CSS width class (never an inline style attribute). */
function barBucketClass(progress) {
  const decile = Math.max(0, Math.min(10, Math.round((Number(progress) || 0) * 10)));
  return `lb-bar-${decile}`;
}

/**
 * Per-user XP page body — rank + XP + level + progress-to-next-level.
 * The history note states the storage truth: NO XP-history table exists,
 * so slash /xp shows the same data set (parity, not a gap behind slash).
 */
function renderUserXpBody(req, { summary, name }) {
  const guildId = req.guildAccess.guildId;
  const label = name || `User ${summary.userId}`;
  return html`
    <section class="panel lb-user-xp">
      <h2>XP snapshot</h2>
      <dl class="kv">
        <dt>User</dt>
        <dd>${label} · <code class="user-id">${summary.userId}</code> · <a href="/g/${guildId}/users/${summary.userId}">full profile →</a></dd>
        <dt>Leaderboard rank</dt>
        <dd>#${summary.rank} of ${summary.total}</dd>
        <dt>XP</dt>
        <dd>${summary.xp}</dd>
        <dt>Level</dt>
        <dd>${summary.level}</dd>
        <dt>Progress to level ${summary.level + 1}</dt>
        <dd>
          <div class="lb-bar" role="img" aria-label="${summary.progressPct}% of the way to level ${summary.level + 1}">
            <div class="lb-bar-fill ${barBucketClass(summary.progress)}"></div>
          </div>
          ${summary.progressPct}% · ${summary.xpIntoLevel}/${summary.nextLevelXp - summary.levelStartXp} XP this level · ${summary.xpToNext} XP to level ${summary.level + 1}
        </dd>
      </dl>
    </section>
    <section class="panel lb-history">
      <h2>History</h2>
      <p class="lb-history-note">XP history over time is not stored — the database keeps only the current XP total per member (there is no xp-history table), so no timeline can be shown. This page shows rank, XP, level and level progress: the same data slash /xp displays.</p>
    </section>`;
}

/**
 * Friendly in-shell 404 MESSAGE (plain text — renderShellError escapes and
 * wraps it; userId is digits-only by the route's snowflake gate).
 * @param {{ userId: string }} opts
 * @returns {string}
 */
function renderUserXpNotFoundBody({ userId }) {
  return `No XP row exists for user ${userId} in this guild — they have never earned XP here, so they hold no leaderboard rank or level. Nothing to show.`;
}

module.exports = {
  displayNameOrId,
  pageHref,
  barBucketClass,
  renderLeaderboardBody,
  renderUserXpBody,
  renderUserXpNotFoundBody,
};
