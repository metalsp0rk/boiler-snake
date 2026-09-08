/**
 * Views for the staff-roles page + command-visibility sync status panel
 * (roadmap/web-admin.md §8.6 "Staff & roles" + "Command visibility" rows —
 * subtask 19, Phase 1 READ-ONLY: zero forms, zero controls that mutate;
 * role writes land in Phase 2 (subtask 25) and the sync trigger in
 * Phase 3 (subtask 31), both Admin-tier).
 *
 * COMPOSED ENTIRELY with the escaped-by-default `html` helper: role ids,
 * cached role names, the stored last_sync_error string, the derived
 * redirect URI and every env-var NAME interpolate through it — raw()
 * appears ONLY around static markup constants. The XSS probe lives in
 * test/web-routes-staff.test.js.
 *
 * Secrets (§8.7): the panel renders env-variable NAMES (from
 * commandPermissions/config.missing) and the OPERATOR-FACING redirect URI
 * only — env values, tokens and secrets are never passed into these
 * functions at all (the route sanitizes its env reads before calling).
 */

const { html } = require("../escape");
const { emptyState, banner } = require("../components");
const { formatWhen } = require("../users");

/** Whitelisted staff levels → CSS class suffix (never interpolate raw data). */
const LEVEL_KINDS = Object.freeze({ junior: "junior", senior: "senior" });

function levelPill(level) {
  const kind = LEVEL_KINDS[level] || "junior";
  return html`<span class="staff-level staff-level-${kind}">${kind}</span>`;
}

/**
 * Level-gate badge row (AGENTS.md §4 intent, mirrored from the slash
 * /staff role list wording): WHAT each level confers.
 */
function levelLegend() {
  return html`
    <ul class="staff-legend">
      <li>${levelPill("junior")} — staff gate: <strong>Manage Server OR any
        staff role</strong> unlocks staff commands; junior roles are also
        honeypot-exempt. No automatic ticket-channel view.</li>
      <li>${levelPill("senior")} — everything junior gets PLUS ticket-channel
        visibility overwrites and the <code>/userinfo</code> Activity tab.</li>
    </ul>`;
}

/**
 * Static advisory note strip (AGENTS.md §4 + "Bot role must be above roles
 * it manages" gotcha + §8.6 write-tier column). All constants — nothing
 * interpolated, nothing to escape.
 */
function advisoryStrip() {
  return html`
    <aside class="staff-advisory" role="note">
      <p class="staff-advisory-line">
        <strong>Bot role position:</strong> the bot's own role must sit
        <strong>above</strong> every role it manages in the server role list —
        otherwise Discord rejects role assignments and ticket-channel
        overwrites. This page only tells you what is configured; it cannot
        verify role positions.
      </p>
      <p class="staff-advisory-line">
        <strong>Write tier:</strong> staff-role mutations
        (<code>/staff role add</code>, <code>/staff role remove</code>,
        <code>/staff role setlevel</code>) and the sync trigger
        (<code>/staff syncpermissions</code>) are <strong>Manage Server
        (server admin) slash-only</strong> today — see the
        <span class="badge badge-tier badge-tier-admin">admin</span> write-tier
        on the §8.6 rows. Web writes arrive in Phase 2, the web sync button in
        Phase 3 (§8.8); this view triggers nothing.
      </p>
    </aside>`;
}

/**
 * Role reference: the ID is the source-of-truth value. An OPTIONAL cached
 * name (bot member cache via the getClient seam) decorates it in
 * parentheses — cache-only, never fetched; absent ⇒ id alone (graceful).
 */
function roleRef(roleId, resolveName) {
  if (!roleId) return html`<em class="muted">—</em>`;
  const name = typeof resolveName === "function" ? resolveName(roleId) : null;
  return html`<code class="role-id">${roleId}</code>${name
    ? html` <span class="role-name">(${name})</span>`
    : html``}`;
}

/** Staff roles table (slash `/staff role list` parity, ordered as stored). */
function staffRolesTable(roles, resolveName) {
  if (!roles.available) {
    return emptyState(
      "Unavailable — the staff_roles read failed for this guild."
    );
  }
  if (!roles.rows.length) {
    return emptyState(
      "No staff roles configured. Slash: /staff role add <role> junior|senior (server admin)."
    );
  }
  return html`<table class="list-table staff-table">
    <thead>
      <tr><th scope="col">Role ID</th><th scope="col">Level</th><th scope="col">Added</th></tr>
    </thead>
    <tbody>
      ${roles.rows.map(
        (r) => html`<tr>
          <td>${roleRef(r.roleId, resolveName)}</td>
          <td>${levelPill(r.level)}</td>
          <td>${formatWhen(r.addedAt)}</td>
        </tr>`
      )}
    </tbody>
  </table>`;
}

/**
 * Command-visibility sync status panel (§8.6 "Command visibility: sync
 * status" row). Purely informational — it NEVER triggers an OAuth flow or
 * a sync (Phase 3 action, Admin tier, subtask 31).
 *
 * @param {object} input
 * @param {{available: boolean, status: object|null}} input.oauth from
 *   data/staffData.js (already token-stripped status projection)
 * @param {object|null} input.envConfig sanitized env config:
 *   { available, ready, redirectUri, missing[] } — NO secret values.
 */
function renderSyncStatusPanel({ oauth, envConfig }) {
  const status = oauth && oauth.available ? oauth.status : null;

  const authBadge = !oauth.available
    ? html`<span class="badge badge-state badge-state-unknown">unknown</span>`
    : status
      ? html`<span class="badge badge-state badge-state-ok">authorized</span>`
      : html`<span class="badge badge-state badge-state-none">not authorized</span>`;

  const envBadge = !envConfig || !envConfig.available
    ? html`<span class="badge badge-state badge-state-unknown">unknown</span>`
    : envConfig.ready
      ? html`<span class="badge badge-state badge-state-ok">environment ready</span>`
      : html`<span class="badge badge-state badge-state-none">environment not configured</span>`;

  const authorizedMeta = status
    ? html`<p class="sync-meta">
        Authorized by <code>${status.authorizedByUserId || "?"}</code> ·
        ${status.authorizedAt ? `authorized ${formatWhen(status.authorizedAt)}` : "authorization age unknown"}
        · last sync ${status.lastSyncAt ? formatWhen(status.lastSyncAt) : html`<em>never completed</em>`}
      </p>`
    : html`<p class="sync-meta">
        This guild has no stored command-permission authorization, so staff-tier
        slash commands show only to Manage Server members. An admin can authorize
        and sync once via <code>/staff syncpermissions</code> in Discord (the web
        trigger arrives in Phase 3).
      </p>`;

  const envBlock =
    envConfig && envConfig.available
      ? envConfig.ready
        ? html`<p class="sync-env">
            Environment is configured. The redirect URI below must be registered
            in the Discord Developer Portal (OAuth2 → Redirects):
            <code class="sync-redirect">${envConfig.redirectUri || "—"}</code>
          </p>`
        : html`<p class="sync-env">
            OAuth command-permission sync is not configured on this host.
            Missing environment variable${envConfig.missing.length === 1 ? "" : "s"}
            (names only — values are never shown here):
            ${envConfig.missing.map((name) => html` <code class="sync-env-missing">${name}</code>`)}
          </p>`
      : html`<p class="sync-env">Environment configuration state is unavailable.</p>`;

  const errorBlock =
    status && status.lastSyncError
      ? banner("error", `Last sync reported an error: ${status.lastSyncError}`)
      : html``;

  return html`
    <section class="panel staff-sync-panel">
      <h2>Command visibility sync</h2>
      <p class="sync-state-row">Authorization ${authBadge} · ${envBadge}</p>
      ${authorizedMeta} ${errorBlock} ${envBlock}
      <p class="subheading">
        Read-only status (§8.6). Syncing pushes
        <code>staff_roles</code> allow-overwrites onto staff-tier slash
        commands; triggering it stays a server-admin action (slash
        <code>/staff syncpermissions</code> today, web action in Phase 3).
        This page never performs OAuth or sync work.
      </p>
    </section>`;
}

/**
 * Body for GET /g/:guildId/staff — staff_roles table, level legend, the
 * static advisory strip, and the command-visibility sync status panel
 * (the §8.6 "Command visibility" view, surfaced here and on its own
 * /g/:guildId/commands page).
 * @param {object} input
 * @param {object} input.view getStaffView() result (data/staffData.js)
 * @param {(roleId: string) => string|null} [input.resolveRoleName] cache-only
 * @param {object|null} [input.envConfig] sanitized (see panel docs)
 */
function renderStaffBody({ view, resolveRoleName, envConfig }) {
  const roles = view.roles || { available: false, rows: [], seniors: 0, juniors: 0 };
  const counts = roles.available
    ? html`<p class="counts"><strong>${roles.rows.length}</strong> staff role${
        roles.rows.length === 1 ? "" : "s"
      } · ${roles.seniors} senior · ${roles.juniors} junior</p>`
    : html``;
  return html`
    <div class="staff-grid">
      <section class="panel staff-roles-panel">
        <h2>Staff roles</h2>
        ${counts} ${staffRolesTable(roles, resolveRoleName)} ${levelLegend()}
      </section>
      ${advisoryStrip()}
      ${renderSyncStatusPanel({ oauth: view.oauth, envConfig })}
    </div>`;
}

/**
 * Body for GET /g/:guildId/commands — the command-visibility sync status
 * view (§8.6 row; panel component shared with the staff page so the two
 * can never diverge).
 * @param {object} input see renderStaffBody (roles unused here)
 */
function renderCommandsBody({ view, envConfig }) {
  return html`
    <div class="staff-grid">
      ${renderSyncStatusPanel({ oauth: view.oauth, envConfig })}
    </div>`;
}

module.exports = {
  levelPill,
  levelLegend,
  advisoryStrip,
  renderSyncStatusPanel,
  renderStaffBody,
  renderCommandsBody,
};
