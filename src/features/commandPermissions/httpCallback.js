/**
 * HTTP handler for OAuth redirect after command-permission authorization.
 */

const {
  verifyOAuthState,
} = require("./oauthState");
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
    const desc = url.searchParams.get("error_description") || errParam;
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      htmlPage(
        "Authorization cancelled",
        `<p>${escapeHtml(desc)}</p><p>You can close this tab and return to Discord.</p>`,
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

  try {
    const { accessToken } = await exchangeAuthorizationCode({
      guildId: verified.guildId,
      code,
      authorizedByUserId: verified.userId,
    });

    const result = await applyGuildCommandPermissions(verified.guildId, {
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
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      htmlPage(
        "Sync failed",
        `<p>${escapeHtml(err?.message || "Unknown error")}</p>
         <p>Run <code>/staff syncpermissions</code> again or check server logs.</p>`,
        false
      )
    );
  }

  return true;
}

/**
 * @param {string} s
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = {
  handleCommandPermissionOAuthCallback,
};
