/**
 * Views for the Phase-4 session administration surface (roadmap/web-admin.md
 * §8.3 sessions + §8.7 secret hygiene — subtask web-admin-phase4-02).
 *
 * TWO pages share this module:
 *  - YOUR sessions (staff shell tier — every console visitor has one):
 *    the viewer's OWN live web sessions with a revoke control per row; the
 *    row matching the current cookie is labelled "current" and revoking it
 *    IS a logout.
 *  - WEB sessions (admin tier, System area): EVERY live session in the
 *    store. The table carries no guild column and none is faked — the page
 *    labels the list system-wide, honest over convenient.
 *
 * SECRET HYGIENE (§8.7) — the reason this view exists as its own audited
 * module: a session id is the cookie-equivalent of a credential, so it is
 * NEVER interpolated anywhere (not in a cell, a form field, or a title).
 * Rows are identified by what the user can SEE — discord_tag + created /
 * last-seen / expires timestamps — and the revoke form carries only those
 * non-secret selectors ((owner, created_at); the server resolves the row).
 *
 * COMPOSED entirely with the escaped-by-default `html` helper (../escape.js)
 * — same XSS contract as the other surfaces; PRG flash renders ONLY fixed
 * messages chosen by whitelisted slug (the raw query value is never
 * echoed — §8.7).
 */

const { html } = require("../escape");
const { banner, emptyState, userRef } = require("../components");
const { formatWhen } = require("../users");

/**
 * PRG flash vocabulary (frozen slugs → fixed messages; the *query value* is
 * only ever a map lookup — unknown slugs render nothing). Every refusal
 * states NOTHING was changed, because every refusal IS zero-write.
 */
const FLASH_DONE = Object.freeze({
  session_revoked:
    "Session revoked — its cookie is dead immediately (revoking the current session signed you out).",
});

const FLASH_ERROR = Object.freeze({
  invalid_selection:
    "That session could not be selected — use a Revoke button on a listed row. Nothing was changed.",
  session_gone:
    "That session was already revoked or expired — nothing more to do. Nothing else was changed.",
});

/**
 * Whitelist the PRG query: { done, error } where each value is a KNOWN slug
 * or null. Anything else (junk, arrays, hostile strings) is dropped — the
 * flash map lookup is the only consumer.
 * @param {{done?: unknown, error?: unknown}|undefined|null} query
 */
function flashFromQuery(query) {
  const done =
    typeof query?.done === "string" && FLASH_DONE[query.done] ? query.done : null;
  const error =
    typeof query?.error === "string" && FLASH_ERROR[query.error]
      ? query.error
      : null;
  return { done, error };
}

/**
 * Flash banner for the PRG round-trip (frozen message chosen by slug —
 * never the raw query value).
 * @param {{done: string|null, error: string|null}|null} flash
 */
function flashBanner(flash) {
  if (!flash) return html``;
  if (flash.error && FLASH_ERROR[flash.error]) {
    return banner("warn", FLASH_ERROR[flash.error]);
  }
  if (flash.done && FLASH_DONE[flash.done]) {
    return banner("info", FLASH_DONE[flash.done]);
  }
  return html``;
}

/** "current" badge for the row matching the caller's own cookie (the id is
 * compared server-side only — it is NEVER rendered, §8.7). */
function currentBadge(isCurrent) {
  if (!isCurrent) return html``;
  return html` <span class="badge badge-tier">current</span>`;
}

/**
 * One self-service row: who/what (tag) + the three timestamps + the revoke
 * form. The form's ONLY data field is created_at — a timestamp the user can
 * already see, NOT the session id (§8.7).
 * @param {object} input
 * @param {object} input.session WebSession (userId/discordTag/createdAt/lastSeenAt/expiresAt)
 * @param {string} input.guildId
 * @param {string} input.csrfToken
 * @param {boolean} input.isCurrent
 */
function renderSelfRow({ session, guildId, csrfToken, isCurrent }) {
  const gid = encodeURIComponent(guildId);
  return html`
    <tr>
      <td>
        ${session.discordTag || session.userId}
        ${currentBadge(isCurrent)}
      </td>
      <td>${formatWhen(session.createdAt)}</td>
      <td>${formatWhen(session.lastSeenAt)}</td>
      <td>${formatWhen(session.expiresAt)}</td>
      <td class="ticket-action-cells">
        <form class="ticket-inline-form" method="post" action="/g/${gid}/sessions/revoke">
          <input type="hidden" name="_csrf" value="${csrfToken || ""}"/>
          <input type="hidden" name="created_at" value="${session.createdAt}"/>
          <button type="submit" class="btn btn-write btn-sm">Revoke</button>
        </form>
      </td>
    </tr>`;
}

/**
 * Your-sessions page body (staff tier — every console visitor qualifies;
 * guildScope denies tier-less visitors with the generic 404 upstream).
 *
 * @param {object} input
 * @param {string} input.guildId server-derived (guildScope snowflake)
 * @param {object[]} input.sessions the VIEWER's own live sessions only
 * @param {string|null} input.currentId id matching the request cookie (compare-only)
 * @param {string|null} input.csrfToken
 * @param {{done: string|null, error: string|null}|null} [input.flash]
 */
function renderYourSessionsBody({ guildId, sessions, currentId, csrfToken, flash }) {
  // Array (not .join("")) — html renders SafeString arrays element-by-
  // element; a joined PLAIN string would be escaped as inert text.
  const rows = (sessions || []).map((session) =>
    renderSelfRow({
      session,
      guildId,
      csrfToken,
      isCurrent: !!currentId && session.id === currentId,
    })
  );
  return html`
    ${flashBanner(flash)}
    <section class="panel sessions-panel">
      <h2>Signed-in sessions</h2>
      ${sessions && sessions.length
        ? html`<table class="list-table sessions-table">
            <thead>
              <tr>
                <th>Account</th><th>Created</th><th>Last seen</th>
                <th>Expires</th><th>Action</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`
        : emptyState("No active web console sessions for your account.")}
      <p class="hint">
        Every browser that signed in through this console has one session.
        Revoke from a device you no longer trust — its cookie stops working
        on the very next request. Revoking the row marked
        <strong>current</strong> signs THIS browser out too. Session rows
        expire on their own after the idle window and never live past 7
        days; session secrets are never shown here (§8.7).
      </p>
    </section>`;
}

/**
 * One admin row: the OWNER is the interesting column (user reference + tag
 * snapshot), then the same three timestamps + the revoke form carrying
 * (target_user_id, created_at) — both non-secret selectors (§8.7).
 * @param {object} input
 */
function renderSystemRow({ session, guildId, csrfToken, isCurrent, names }) {
  const gid = encodeURIComponent(guildId);
  return html`
    <tr>
      <td>${userRef(guildId, session.userId, names)}</td>
      <td>${session.discordTag || "—"}</td>
      <td>
        ${formatWhen(session.createdAt)}
        ${currentBadge(isCurrent)}
      </td>
      <td>${formatWhen(session.lastSeenAt)}</td>
      <td>${formatWhen(session.expiresAt)}</td>
      <td class="ticket-action-cells">
        <form class="ticket-inline-form" method="post" action="/g/${gid}/system/sessions/revoke">
          <input type="hidden" name="_csrf" value="${csrfToken || ""}"/>
          <input type="hidden" name="target_user_id" value="${session.userId}"/>
          <input type="hidden" name="created_at" value="${session.createdAt}"/>
          <button type="submit" class="btn btn-write btn-sm">Revoke</button>
        </form>
      </td>
    </tr>`;
}

/**
 * Admin "Web sessions" page body (System area, ADMIN tier). HONEST
 * system-wide framing: web sessions are global (the table has no guild
 * column), so this is EVERY live console session — never a fake per-guild
 * slice.
 *
 * @param {object} input
 * @param {string} input.guildId server-derived (shell + form targets)
 * @param {object[]} input.sessions every live session (bounded read)
 * @param {string|null} input.currentId viewer's own session id (compare-only)
 * @param {string|null} input.csrfToken
 * @param {{done: string|null, error: string|null}|null} [input.flash]
 * @param {Map<string,string|null>|null} [input.names] member-cache names
 */
function renderSystemSessionsBody({
  guildId,
  sessions,
  currentId,
  csrfToken,
  flash,
  names = null,
}) {
  const rows = (sessions || []).map((session) =>
    renderSystemRow({
      session,
      guildId,
      csrfToken,
      isCurrent: !!currentId && session.id === currentId,
      names,
    })
  );
  return html`
    ${flashBanner(flash)}
    <section class="panel system-sessions-panel">
      <h2>Live web sessions (system-wide)</h2>
      ${sessions && sessions.length
        ? html`<table class="list-table system-sessions-table">
            <thead>
              <tr>
                <th>User</th><th>Tag</th><th>Created</th><th>Last seen</th>
                <th>Expires</th><th>Action</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`
        : emptyState("No active web console sessions anywhere.")}
      <p class="hint">
        Web console sessions are GLOBAL (they are not per-guild), so this
        list spans every server this bot serves — labelled honestly instead
        of pretending a guild slice exists. Revoke kills the session row
        immediately (the cookie is dead on its next request); a kicked
        person simply signs in again via OAuth, so this is containment for
        a stolen/lost device, not a ban. Session ids are never displayed
        (§8.7).
      </p>
    </section>`;
}

module.exports = {
  FLASH_DONE,
  FLASH_ERROR,
  flashFromQuery,
  flashBanner,
  renderYourSessionsBody,
  renderSystemSessionsBody,
};
