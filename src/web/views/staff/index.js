/**
 * Views for the staff-roles page + command-visibility sync status panel
 * (roadmap/web-admin.md §8.6 "Staff & roles" + "Command visibility" rows).
 *
 * Phase 1 shipped this read-only; Phase 2 (subtask 25) ADDED the mutation
 * forms that POST to routes/staff.js:
 *  - staff-role add / remove / setlevel forms — rendered ONLY for the ADMIN
 *    viewer tier (§8.6 mutate column = Admin; the POST routes carry
 *    requireTier("admin") as the actual gate — a hidden form is UX, the
 *    middleware is security);
 *  - level→role mapping table + set / remove forms — every viewer here is
 *    ≥ staff tier, matching the /leveltorole slash handler's isStaff gate
 *    (the POST routes carry requireTier("staff")).
 * Every form embeds the hidden `_csrf` field from req.csrfToken (§8.7; the
 * /g/ CSRF middleware enforces it). No inline handlers anywhere (CSP).
 *
 * Phase 3 (subtask 31) adds the ADMIN sync-trigger form INSIDE the sync
 * panel (§8.6 "Command visibility … | Admin (sync)"): rendered ONLY when the
 * viewer is admin AND the guild has a stored command-permission
 * authorization AND the env is configured — POSTing it re-runs the SAME
 * service the slash `/staff syncpermissions` runs against the SAME stored
 * OAuth authorization (web login tokens are never sent to Discord —
 * decision 9). The PRG flash banner (views/syncAction) renders ONLY
 * whitelisted slugs — a hostile ?error= value is inert (§8.7).
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

const { html, raw } = require("../escape");
const { emptyState, banner } = require("../components");
const { formatWhen } = require("../users");
const {
  syncFlashBanner,
  renderSyncTriggerForm,
} = require("../syncAction");

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
        overwrites. Level→role mappings whose role sits above the bot's
        highest role are refused up front when the guild cache can prove it.
      </p>
      <p class="staff-advisory-line">
        <strong>Write tier:</strong> staff-role mutations
        (<code>/staff role add</code>, <code>/staff role remove</code>,
        <code>/staff role setlevel</code>) are <strong>Manage Server (server
        admin)</strong> actions — the forms below carry the same
        <span class="badge badge-tier badge-tier-admin">admin</span> gate
        (§8.6). Web writes landed in Phase 2; level→role mapping writes match
        the slash <code>/leveltorole</code> staff gate. The command-visibility
        sync trigger landed in Phase 3: admins re-run it from the panel below,
        reusing the stored slash OAuth (§8.8) — the authorization itself stays
        the slash's one-time Discord consent
        (<code>/staff syncpermissions</code>).
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

/** Level→role mappings table (slash `/leveltorole list` parity, stored order). */
function levelRolesTable(levelRoles, resolveName) {
  if (!levelRoles || !levelRoles.available) {
    return emptyState(
      "Unavailable — the level_roles read failed for this guild."
    );
  }
  if (!levelRoles.rows.length) {
    return emptyState(
      "No level→role mappings configured. Slash: /leveltorole set <role> <level> <drop-days>."
    );
  }
  return html`<table class="list-table staff-table level-roles-table">
    <thead>
      <tr><th scope="col">Role ID</th><th scope="col">Level required</th><th scope="col">Drop grace (days)</th></tr>
    </thead>
    <tbody>
      ${levelRoles.rows.map(
        (r) => html`<tr>
          <td>${roleRef(r.roleId, resolveName)}</td>
          <td>${r.levelRequired == null ? html`<em class="muted">—</em>` : r.levelRequired}</td>
          <td>${r.dropGraceDays == null ? html`<em class="muted">—</em>` : r.dropGraceDays}</td>
        </tr>`
      )}
    </tbody>
  </table>`;
}

/* ---------------------------------------------------------------------------
 * Phase 2 mutation forms (subtask 25). Plain html POST forms (no JS needed);
 * each embeds the CSRF token. Tiers below are RENDERING policy (UX); the
 * requireTier middleware on the POST routes is the security boundary.
 * ------------------------------------------------------------------------- */

/** Hidden CSRF input (the /g/ CSRF middleware enforces it on every POST). */
function csrfInput(csrfToken) {
  return html`<input type="hidden" name="_csrf" value="${csrfToken || ""}"/>`;
}

/** Shared role-id text input (numeric snowflake; the route re-validates). */
function roleIdInput() {
  return html`<label>Role ID
    <input type="text" name="role_id" inputmode="numeric" autocomplete="off"
      placeholder="e.g. 500000000000000001" required maxlength="20"/>
  </label>`;
}

/** junior|senior picker — mirrors the slash level option (whitelist). */
function staffLevelSelect(name) {
  return html`<label>Level
    <select name="${name}">
      <option value="senior">senior (tickets + staff gate)</option>
      <option value="junior">junior (staff gate only)</option>
    </select>
  </label>`;
}

/**
 * Admin-tier staff-role mutation panel (§8.6 mutate tier = Admin). Rendered
 * ONLY when the viewer's tier is admin; every form POSTs to one of the
 * /g/:guildId/staff/role/* routes.
 */
function staffRoleForms({ guildId, csrfToken }) {
  const base = `/g/${guildId}/staff/role`;
  return html`
    <section class="panel staff-mutate-panel">
      <h2>Manage staff roles <span class="badge badge-tier badge-tier-admin">admin</span></h2>
      <p class="subheading">
        Same service layer and validation as the slash <code>/staff role</code>
        commands (server-admin tier). One audit row (<code>admin_audit</code>,
        origin <code>web</code>) is written per mutation.
      </p>
      <form class="staff-mutate-form" method="post" action="${base}/add">
        ${csrfInput(csrfToken)} ${roleIdInput()} ${staffLevelSelect("level")}
        <button type="submit" class="btn">Add / update staff role</button>
      </form>
      <form class="staff-mutate-form" method="post" action="${base}/setlevel">
        ${csrfInput(csrfToken)} ${roleIdInput()} ${staffLevelSelect("level")}
        <button type="submit" class="btn">Change level</button>
      </form>
      <form class="staff-mutate-form" method="post" action="${base}/remove">
        ${csrfInput(csrfToken)} ${roleIdInput()}
        <button type="submit" class="btn btn-danger">Remove staff role</button>
      </form>
    </section>`;
}

/**
 * Level→role mapping panel: current mappings + set / remove forms. Slash
 * parity: /leveltorole gates on isStaff — every viewer who reached this
 * page (view tier staff) satisfies it (§8.3 tier ladder ⊇ isStaff roles).
 */
function levelRoleForms({ guildId, csrfToken }) {
  const base = `/g/${guildId}/staff/levelrole`;
  return html`
    <section class="panel staff-mutate-panel level-role-panel">
      <h2>Manage level→role mappings</h2>
      <p class="subheading">
        Same service layer and validation as the slash <code>/leveltorole</code>
        commands (staff tier). Mapping a role requires the bot's highest role
        to be above it; Discord rejects the assignment otherwise.
      </p>
      <form class="staff-mutate-form" method="post" action="${base}/set">
        ${csrfInput(csrfToken)} ${roleIdInput()}
        <label>Level required
          <input type="number" name="level" min="0" step="1" required/>
        </label>
        <label>Drop grace (days)
          <input type="number" name="drop_days" min="0" step="1" required/>
        </label>
        <button type="submit" class="btn">Set mapping</button>
      </form>
      <form class="staff-mutate-form" method="post" action="${base}/remove">
        ${csrfInput(csrfToken)} ${roleIdInput()}
        <button type="submit" class="btn btn-danger">Remove mapping</button>
      </form>
    </section>`;
}

/**
 * Command-visibility sync status panel (§8.6 "Command visibility: sync
 * status + trigger" row). Status is ALWAYS informational; since Phase 3
 * (subtask 31) it additionally carries the ADMIN trigger form — rendered
 * ONLY with a server-supplied `trigger` context whose tier is admin, whose
 * guild has a stored authorization and whose env is configured. The web
 * NEVER runs OAuth (authorization stays the slash's one-time consent) and
 * the POST route carries requireTier("admin") as the actual gate — a hidden
 * form is UX, the middleware is security. The /commands page passes NO
 * trigger context: that surface stays forms-free (Phase-1 pin).
 *
 * @param {object} input
 * @param {{available: boolean, status: object|null}} input.oauth from
 *   data/staffData.js (already token-stripped status projection)
 * @param {object|null} input.envConfig sanitized env config:
 *   { available, ready, redirectUri, missing[] } — NO secret values.
 * @param {{guildId: string, csrfToken: string|null, tier: string|null}|null} [input.trigger]
 *   render context for the ADMIN sync-trigger form (see above)
 * @param {{done: string|null, error: string|null}|null} [input.flash]
 *   whitelisted PRG flash (views/syncAction flashFromQuery output)
 */
function renderSyncStatusPanel({ oauth, envConfig, trigger, flash }) {
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
        and sync once via <code>/staff syncpermissions</code> in Discord — the web
        trigger reuses that stored authorization, it never runs OAuth itself.
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

  // TRIGGER rendering policy (the POST route's requireTier("admin") is the
  // security boundary): admin viewer + CSRF bound + stored authorization +
  // env ready. Everything else keeps this panel purely informational.
  const triggerBlock =
    trigger &&
    trigger.guildId &&
    trigger.csrfToken &&
    trigger.tier === "admin" &&
    oauth.available &&
    status &&
    envConfig &&
    envConfig.ready
      ? renderSyncTriggerForm({
          guildId: trigger.guildId,
          csrfToken: trigger.csrfToken,
          returnTarget: "staff",
        })
      : html``;

  return html`
    <section class="panel staff-sync-panel">
      <h2>Command visibility sync</h2>
      ${syncFlashBanner(flash)}
      <p class="sync-state-row">Authorization ${authBadge} · ${envBadge}</p>
      ${authorizedMeta} ${errorBlock} ${envBlock} ${triggerBlock}
      <p class="subheading">
       
      </p>
    </section>`;
}

/**
 * Body for GET /g/:guildId/staff — staff_roles table, level legend, the
 * advisory strip, the level→role mappings, the mutation forms (admin-only
 * staff-role forms; staff-level level-role forms) and the command-visibility
 * sync status panel.
 * @param {object} input
 * @param {object} input.view getStaffView() result (data/staffData.js)
 * @param {(roleId: string) => string|null} [input.resolveRoleName] cache-only
 * @param {object|null} [input.envConfig] sanitized (see panel docs)
 * @param {string|null} [input.guildId] current guild (form actions); absent ⇒
 *   NO forms render (pure read-only rendering stays possible for callers that
 *   pass no context, e.g. a future preview)
 * @param {string|null} [input.tier] viewer tier (req.guildAccess.tier):
 *   staff-role forms render ONLY for "admin" (§8.6 mutate tier)
 * @param {string|null} [input.csrfToken] req.csrfToken for hidden _csrf
 * @param {{done: string|null, error: string|null}|null} [input.flash]
 *   whitelisted PRG flash for the sync panel (views/syncAction)
 */
function renderStaffBody({ view, resolveRoleName, envConfig, guildId, tier, csrfToken, flash }) {
  const roles = view.roles || { available: false, rows: [], seniors: 0, juniors: 0 };
  const levelRoles = view.levelRoles || { available: false, rows: [] };
  const counts = roles.available
    ? html`<p class="counts"><strong>${roles.rows.length}</strong> staff role${
        roles.rows.length === 1 ? "" : "s"
      } · ${roles.seniors} senior · ${roles.juniors} junior</p>`
    : html``;

  const canMutate = Boolean(guildId) && Boolean(csrfToken);

  return html`
    <div class="staff-grid">
      <section class="panel staff-roles-panel">
        <h2>Staff roles</h2>
        ${counts} ${staffRolesTable(roles, resolveRoleName)} ${levelLegend()}
      </section>
      ${canMutate && tier === "admin" ? staffRoleForms({ guildId, csrfToken }) : html``}
      <section class="panel level-roles-config-panel">
        <h2>Level→role mappings</h2>
        ${levelRolesTable(levelRoles, resolveRoleName)}
      </section>
      ${canMutate ? levelRoleForms({ guildId, csrfToken }) : html``}
      ${advisoryStrip()}
      ${renderSyncStatusPanel({
        oauth: view.oauth,
        envConfig,
        trigger: { guildId, csrfToken, tier },
        flash,
      })}
    </div>`;
}

/**
 * Body for GET /g/:guildId/commands — the command-visibility sync status
 * view (§8.6 row; panel component shared with the staff page so the two
 * can never diverge). READ-ONLY — no forms here (the §8.8 Phase 1
 * "no forms on /commands" pin); it still renders the whitelisted PRG
 * flash because the sync redirect may land here (return=commands).
 * @param {object} input see renderStaffBody (roles unused here)
 * @param {{done: string|null, error: string|null}|null} [input.flash]
 */
function renderCommandsBody({ view, envConfig, flash }) {
  return html`
    <div class="staff-grid">
      ${renderSyncStatusPanel({ oauth: view.oauth, envConfig, flash })}
    </div>`;
}

module.exports = {
  levelPill,
  levelLegend,
  advisoryStrip,
  staffRoleForms,
  levelRoleForms,
  levelRolesTable,
  renderSyncStatusPanel,
  renderStaffBody,
  renderCommandsBody,
  raw,
};
