/**
 * Secret-handling primitives (#470 H1-7).
 */

/**
 * Attach a token to a config/health handle WITHOUT letting it ride JSON
 * serialization or casual enumeration: the property exists (lookups work)
 * but is non-enumerable and read-only. Byte-identical copies lived in the
 * bridge Discord and Fluxer outbound modules.
 *
 * @template {object} T
 * @param {T} handle
 * @param {string} token
 * @returns {T}
 */
function hideToken(handle, token) {
  Object.defineProperty(handle, "token", {
    value: token,
    enumerable: false,
    writable: false,
  });
  return handle;
}

module.exports = { hideToken };
