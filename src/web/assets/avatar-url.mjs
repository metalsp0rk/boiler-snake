/** Discord CDN is the only cross-origin image the console CSP allows. */
export const CDN_PREFIX = "https://cdn.discordapp.com/";

/**
 * @param {unknown} url
 * @returns {boolean}
 */
export function isDiscordCdnAvatar(url) {
  return typeof url === "string" && url.startsWith(CDN_PREFIX);
}
