/**
 * Root page body (UX v1.1, roadmap/web-admin.md §8.15): the viewer's staff
 * guilds as a clickable list — replacing the legacy "/" transcript-archive
 * alias (archive keeps /t). Rows carry the tier badge resolve() computed;
 * NEVER a gate (routing still decides). Escaped-by-default html throughout.
 */

const { html } = require("../escape");
const { tierBadge, emptyState } = require("../components");

/**
 * @param {object} input
 * @param {Array<{id: string, name: string|null, tier: string|null}>} input.rows
 * @param {boolean} [input.degraded] tier/list degraded flag
 * @param {boolean} [input.truncated] more guilds existed than rendered
 * @returns {import("../escape").SafeString}
 */
function renderGuildListBody({ rows = [], degraded = false, truncated = false }) {
  const transcripts = html`<p class="subheading"><a href="/t">Ticket transcripts →</a></p>`;
  if (!rows.length) {
    return html`
      ${emptyState(
        "You do not manage any guild this bot is in. The console lists guilds where you hold ManageGuild or a configured staff role."
      )}
      ${transcripts}`;
  }
  const list = html`<ul class="guild-list">
    ${rows.map(
      (g) => html`<li class="guild-list-row">
        <a class="guild-list-link" href="/g/${g.id}">${g.name || g.id}</a>
        ${tierBadge(g.tier)}
      </li>`
    )}
  </ul>`;
  return html`
    ${list}
    ${truncated
      ? html`<p class="subheading">List shows the first ${String(rows.length)} guilds; deeper guilds remain reachable at /g/&lt;guildId&gt;.</p>`
      : html``}
    ${degraded
      ? html`<p class="subheading">Permission data may be stale — tier badges can lag up to the cache TTL.</p>`
      : html``}
    ${transcripts}`;
}

module.exports = { renderGuildListBody };
