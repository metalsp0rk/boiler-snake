/**
 * Placeholder guild shell (roadmap/web-admin.md §8.8 Phase 0b exit
 * criterion: "unauthenticated `/g/*` → login redirect").
 *
 * This is a LOGIN gate only — deliberately minimal until subtask 07 mounts
 * guildScope (":guildId ∈ viewer access list else 404") + requireTier and
 * subtask 0c replaces it with the real shell. The guild ACCESS check is NOT
 * done here (the session's guild snapshot is 07's input); the placeholder
 * only distinguishes logged-in from anonymous.
 */

/** Same snowflake gate as the login return-target param (never echoed raw). */
const GUILD_TARGET_RE = /^[0-9]{5,20}$/;

/**
 * @param {import("express").Express} app
 */
function registerGuildShellRoutes(app) {
  app.get("/g/:guildId", (req, res) => {
    if (!req.webSession) {
      // Signed-in round-trip returns here via the purpose-tagged state's
      // guild target (login.js), so no separate "next" param is needed —
      // and an unvalidated target param could only ever become /auth/login
      // itself.
      const target =
        typeof req.params.guildId === "string" &&
        GUILD_TARGET_RE.test(req.params.guildId)
          ? `/auth/login?guild=${req.params.guildId}`
          : "/auth/login";
      res.writeHead(302, {
        Location: target,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end("Guild console placeholder — the panel lands in Phase 0c/1.");
  });
}

module.exports = {
  registerGuildShellRoutes,
};
