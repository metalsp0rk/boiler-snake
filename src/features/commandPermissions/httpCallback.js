/**
 * HTTP handler for OAuth redirect after command-permission authorization.
 *
 * The signed OAuth state carries the EXTERNAL Discord guild id (it is minted
 * from interaction.guildId). This callback is the edge: it resolves the
 * internal community id via ensureCommunity before touching any converted
 * repository (roadmap/fluxer.md § Repository boundary).
 */

const {
  verifyOAuthState,
  PURPOSES,
} = require("./oauthState");
const {
  ensureCommunity,
  discordCommunityId,
} = require("../../platform/community");
const { exchangeAuthorizationCode } = require("./oauthTokens");
const { applyGuildCommandPermissions } = require("./sync");

/**
 * @param {string} title
 * @param {string} bodyHtml
 * @param {boolean} ok
 */
function htmlPage(title, bodyHtml, ok) {
  const color = ok ? "#57f287" : "#ed4245";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #313338; color: #dbdee1;
      display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
    .card { background: #2b2d31; border-radius: 8px; padding: 2rem; max-width: 28rem;
      box-shadow: 0 8px 24px rgba(0,0,0,.4); }
    h1 { font-size: 1.25rem; margin: 0 0 0.75rem; color: ${color}; }
    p { margin: 0.5rem 0; line-height: 1.45; }
    code { background: #1e1f22; padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    ${bodyHtml}
  </div>
</body>
</html>`;
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {URL} url
 * @returns {Promise<boolean>} true if handled
 */
async function handleCommandPermissionOAuthCallback(req, res, url) {
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return true;
  }

  const errParam = url.searchParams.get("error");
  if (errParam) {
    // #466 (C1-10): the browser sees the BOUNDED OAuth error token only —
    // never error_description. The provider's free-text is envelope material
    // (it has echoed redirect URIs): logged (rule 2), not rendered (§8.7
    // codes-only doctrine, same as the web login callbacks).
    console.warn(
      `[commandPermissions] OAuth callback refused: ${errParam} ${url.searchParams.get("error_description") || ""}`,
    );
    const token = /^[a-z0-9_]{1,64}$/.test(errParam) ? errParam : "unknown_error";
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      htmlPage(
        "Authorization cancelled",
        `<p>Discord reported <code>${escapeHtml(token)}</code> — no permissions were changed. You can close this tab and return to Discord.</p>`,
        false
      )
    );
    return true;
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      htmlPage(
        "Invalid callback",
        `<p>Missing <code>code</code> or <code>state</code>.</p>`,
        false
      )
    );
    return true;
  }

  const verified = verifyOAuthState(state);
  if (!verified) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      htmlPage(
        "Invalid or expired link",
        `<p>Run <code>/staff syncpermissions</code> again in Discord to get a fresh authorize link.</p>`,
        false
      )
    );
    return true;
  }

  // Audit §6 P1 (#193): purpose binding is only real if EVERY callback CHECKS
  // it (roadmap/web-admin.md §8.3). States minted for another flow — the web
  // login flows (web_login / web_login_fluxer) — must never complete a
  // command-permissions grant, even when correctly signed. Legacy untagged
  // states resolve to `cmd_perms` inside verifyOAuthState, so existing
  // authorize links are unaffected. verifyOAuthState has already consumed the
  // state's single-use nonce (Discord purposes), so the rejected state is
  // burned here and cannot be replayed into its own flow's callback either.
  if (verified.purpose !== PURPOSES.CMD_PERMS) {
    console.warn(
      "[commandPermissions] OAuth callback: state rejected (wrong purpose " +
        `"${verified.purpose}", expected "${PURPOSES.CMD_PERMS}")`
    );
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      htmlPage(
        "Wrong authorization link",
        `<p>This authorize link was issued for the <code>${escapeHtml(
          verified.purpose
        )}</code> flow, not command-permission sync.</p>` +
          `<p>Run <code>/staff syncpermissions</code> again in Discord to get the correct authorize link.</p>`,
        false
      )
    );
    return true;
  }

  // Fluxer PR 2: the OAuth state carries the EXTERNAL snowflake; the token
  // store and sync key by the integer communities.id. Resolve it now — an
  // unregistered guild gets the actionable "run /staff syncpermissions"
  // cause (same page as a bad state) instead of a foreign-key miss.
  const communityId = discordCommunityId(verified.guildId);
  if (communityId == null) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      htmlPage(
        "Invalid or expired link",
        `<p>Run <code>/staff syncpermissions</code> again in Discord to get a fresh authorize link.</p>`,
        false
      )
    );
    return true;
  }

  try {
    const { accessToken } = await exchangeAuthorizationCode({
      communityId,
      code,
      authorizedByUserId: verified.userId,
    });

    const result = await applyGuildCommandPermissions(communityId, {
      accessToken,
    });

    const failNote =
      result.failed.length > 0
        ? `<p><strong>Some commands failed:</strong> ${escapeHtml(
            result.failed.map((f) => f.name).join(", ")
          )}. Check bot logs or re-run sync.</p>`
        : "";
    const missNote =
      result.missingCommands.length > 0
        ? `<p>Not registered in this guild yet: ${escapeHtml(
            result.missingCommands.join(", ")
          )}. Run <code>npm run register</code>.</p>`
        : "";

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      htmlPage(
        "Command visibility synced",
        `<p>Updated <strong>${result.updated.length}</strong> staff command(s) for <code>${escapeHtml(
          verified.guildId
        )}</code> with <strong>${result.roleCount}</strong> staff role(s).</p>
         ${failNote}${missNote}
         <p>You can close this tab and return to Discord. Staff members may need a moment for the command list to refresh.</p>`,
        result.failed.length === 0
      )
    );
  } catch (err) {
    console.error(
      "[commandPermissions] OAuth callback error:",
      err?.message || err
    );
    // #466 (C1-10): err.message here is built from Discord's
    // error_description (oauthTokens.js) — internal plumbing text reaching
    // an UNAUTHENTICATED browser page, and the empty-message fallback
    // printed exactly the banned phrase "Unknown error" (rules 3+4). The
    // page now shows a mapped, actionable cause; the full error stays in
    // the log line above.
    const code = typeof err?.code === "string" ? err.code : "";
    const reason =
      code === "invalid_grant"
        ? "The authorization code expired or was already used."
        : code === "invalid_client"
          ? "The bot's OAuth credentials were rejected — check CLIENT_ID/CLIENT_SECRET."
          : code === "redirect_uri_mismatch"
            ? "The redirect URI does not match the Discord application settings."
            : "The token exchange or the role sync failed.";
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      htmlPage(
        "Sync failed",
        `<p>${escapeHtml(reason)}</p>
         <p>Run <code>/staff syncpermissions</code> again — the specific cause is in the server log under <code>[commandPermissions] OAuth callback error</code>.</p>`,
        false
      )
    );
  }

  return true;
}

/**
 * @param {string} s
 */
// #452: shared core escaper — this copy escaped only 4 chars (no `&#39;`),
// an attribute-injection foothold the moment a value lands in a single-quoted
// attribute. The core escaper handles all five.
const { escapeHtml } = require("../../core/escapeHtml");

module.exports = {
  handleCommandPermissionOAuthCallback,
};
