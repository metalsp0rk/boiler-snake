/**
 * Raw-request micro-helpers shared by the /g/ route modules.
 *
 * These were hand-copied into nearly every mutation route (rawParams ×10,
 * readFields ×5, rawFlashQuery ×4). They are pure, tiny, and byte-frozen by
 * the redirect/flash tests, so a single audited copy is strictly safer than
 * N drifting forks.
 *
 * Doctrine (why these exist at all):
 *  - rawParams / rawFlashQuery parse the RAW query string off req.url, never
 *    req.query — the surfaces deliberately avoid a global urlencoded query
 *    parser (§8.1-3), so req.query is not populated for them.
 *  - readFields reads only req.bodyFields (the body-capped urlencoded parse
 *    from the CSRF/body middleware), never re-parsing the stream.
 */

/**
 * Query params from the raw url (empty when there is no "?"). Never req.query.
 * @param {string} rawUrl
 * @returns {URLSearchParams}
 */
function rawParams(rawUrl) {
  const idx = String(rawUrl || "").indexOf("?");
  return new URLSearchParams(idx === -1 ? "" : String(rawUrl).slice(idx + 1));
}

/**
 * The two flash keys (done/error) off the raw query. Never req.query.
 * @param {string} rawUrl
 * @returns {{ done: string|null, error: string|null }}
 */
function rawFlashQuery(rawUrl) {
  const params = rawParams(rawUrl);
  return { done: params.get("done"), error: params.get("error") };
}

/**
 * Body fields captured by the body-cap middleware (req.bodyFields). Absent /
 * non-object ⇒ empty object (validation then refuses).
 * @param {object} req
 * @returns {Record<string, string>}
 */
function readFields(req) {
  const src = req?.bodyFields;
  return src && typeof src === "object" ? src : {};
}

module.exports = { rawParams, rawFlashQuery, readFields };
