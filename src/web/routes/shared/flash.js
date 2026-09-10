/**
 * PRG flash-redirect core (§8.7 no-echo invariant, one audited
 * implementation).
 *
 * Every mutation surface mints its redirect as
 *   ?<done|error>=<slug>
 * where BOTH flag and slug are re-validated against the view's frozen
 * vocabulary tables before the Location header exists — so even a bug at a
 * call site can never reflect submitted input into a redirect. The
 * validation-then-redirect order is the contract; individual surfaces keep
 * their own tables, page builder, and header set (all pinned byte-exact by
 * route tests — pass them through verbatim).
 */

/**
 * Build a surface's flash redirect writer.
 *
 * @param {object} spec
 * @param {(guildId: string) => string} spec.pageOf concrete page path for
 *   the guild (every existing surface builder already encodes what it needs)
 * @param {Readonly<Record<string, string>>} spec.doneTable
 * @param {Readonly<Record<string, string>>} spec.errorTable
 * @param {Record<string, string>} [spec.headers] extra headers beyond
 *   Location + Cache-Control: no-store (e.g. the integrations nosniff)
 * @returns {(res: import("http").ServerResponse, guildId: string, flag: string, slug: string) => void}
 */
function makeFlashRedirect({ pageOf, doneTable, errorTable, headers }) {
  return function respondFlash(res, guildId, flag, slug) {
    const safeFlag = flag === "done" ? "done" : "error";
    const table = safeFlag === "done" ? doneTable : errorTable;
    const safeSlug =
      typeof slug === "string" && table[slug] ? slug : Object.keys(table)[0];
    res.writeHead(302, {
      Location: `${pageOf(guildId)}?${safeFlag}=${safeSlug}`,
      "Cache-Control": "no-store",
      ...(headers || {}),
    });
    res.end();
  };
}

module.exports = { makeFlashRedirect };
