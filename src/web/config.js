/**
 * Web HTTP configuration (roadmap/web-admin.md §8.10).
 *
 * Owns the PUBLIC_HTTP_PORT / PUBLIC_BASE_URL (and legacy TICKET_* alias)
 * reads for the HTTP surface. Delegates to commandPermissions/config so the
 * alias precedence (PUBLIC_* wins over TICKET_*) and port normalization
 * (invalid → null) stay defined in exactly one place — Phase 0b adds the
 * session/auth knobs (SESSION_SECRET, WEB_* caches) beside these.
 */

const {
  getPublicHttpConfig,
} = require("../features/commandPermissions/config");

/**
 * @returns {{ port: number|null, publicBaseUrl: string|null }}
 */
function getHttpConfig() {
  return getPublicHttpConfig();
}

/**
 * Public URL for a transcript token (null if base URL unset).
 * @param {string} token
 * @returns {string|null}
 */
function transcriptPublicUrl(token) {
  const { publicBaseUrl } = getHttpConfig();
  if (!publicBaseUrl || !token) return null;
  return `${publicBaseUrl}/t/${token}`;
}

module.exports = {
  getHttpConfig,
  transcriptPublicUrl,
};
