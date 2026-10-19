/**
 * The generic, community-agnostic 404 (#470 H1-8) — single source for the
 * three byte-identical copies in middleware/guildScope.js,
 * routes/leaderboard.js and routes/users.js. Never confirms or denies the
 * existence of anything (spec: cross-platform cookies are anonymous for a
 * route, and a missing leaderboard/user document answers the same plain 404).
 */
function respondGenericNotFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

module.exports = { respondGenericNotFound };
