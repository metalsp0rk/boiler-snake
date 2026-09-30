/**
 * Shared guild-switcher list for /g/:guildId pages.
 *
 * Every console page hands the shell the SAME guild list: the session's
 * cached accessible-guilds projection (already gated by guildScope's
 * resolve() this request — normally zero network), with the viewed guild
 * force-present so a degraded projection never drops the active tab.
 * Ten byte-identical copies of this function predated this module.
 */

/**
 * @param {{resolve: Function, listGuilds: Function}} resolver shared
 *   guild-access resolver (same instance guildScope used this request)
 * @param {object} req post-guildScope request (webSession + guildAccess set)
 * @returns {Promise<{id: string, name: string}[]>} mutable copy, current first-guaranteed
 */
async function shellGuilds(resolver, req) {
  const listed = await resolver.listGuilds(req.webSession);
  const guilds = listed.guilds.slice();
  // PR 2: the viewed guild is identified by its INTEGER community id in
  // links; force-present so a degraded projection never drops the active tab.
  const currentId = req.guildAccess.communityId;
  if (!guilds.some((g) => g.communityId === currentId)) {
    guilds.unshift({
      id: req.guildAccess.guildId,
      communityId: currentId,
      name: String(currentId),
    });
  }
  return guilds;
}

module.exports = { shellGuilds };
