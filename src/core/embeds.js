/**
 * Embed helpers (#470 H1-7).
 */

/**
 * Normalize a discord.js MessageEmbed (or any toJSON-carrying embed object)
 * into the plain payload object outbound transports want. Plain objects pass
 * through untouched — mirrors (and stay type-safe for) the fluxer side.
 *
 * Byte-identical copies lived in the githubReleases/twitch/youtube tickers
 * and reactionRoles/service.
 *
 * @param {any} embed
 * @returns {any}
 */
function toPlainEmbed(embed) {
  return embed && typeof embed.toJSON === "function" ? embed.toJSON() : embed;
}

module.exports = { toPlainEmbed };
