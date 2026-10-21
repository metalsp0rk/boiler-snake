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
 *
 * #644 OPTIONAL SECTION: a sectioned surface (integrations today; settings
 * has its own redirectSettings) passes `sectionIds` — its frozen page-section
 * set — to the FACTORY, and the handler passes the chosen section as the
 * fifth argument of every redirect. The `at` query + fragment are written
 * ONLY when sectionIds was passed AND the value is in that frozen set:
 *   accepted:  ?<flag>=<slug>&at=<section>#<section>
 *   omitted/unknown: today's bytes ?<flag>=<slug>, NOTHING appended.
 * Surfaces that pass no sectionIds (grant XP, moderation, tickets, sessions,
 * system) never grow an `at`, even if a call site accidentally sends one —
 * the guard is the set, not the argument's presence. The raw section value is
 * only ever tested for set membership; nothing submitted reaches Location.
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
 * @param {Iterable<string>|null} [spec.sectionIds] #644 frozen page-section
 *   set for sectioned pages; omitted/null ⇒ this writer can NEVER emit `at`
 * @returns {(res: import("http").ServerResponse, guildId: string, flag: string, slug: string, section?: string) => void}
 */
function makeFlashRedirect({ pageOf, doneTable, errorTable, headers, sectionIds = null }) {
  const allowedSections = sectionIds ? new Set(sectionIds) : null;
  return function respondFlash(res, guildId, flag, slug, section) {
    const safeFlag = flag === "done" ? "done" : "error";
    const table = safeFlag === "done" ? doneTable : errorTable;
    const safeSlug =
      typeof slug === "string" && table[slug] ? slug : Object.keys(table)[0];
    let location = `${pageOf(guildId)}?${safeFlag}=${safeSlug}`;
    // #644: `at` is a server-chosen code constant only ever written when the
    // surface DECLARED its section set and the value is a member of it.
    // Unknown/omitted sections keep the historical bytes exactly.
    if (
      allowedSections &&
      typeof section === "string" &&
      allowedSections.has(section)
    ) {
      location += `&at=${section}#${section}`;
    }
    res.writeHead(302, {
      Location: location,
      "Cache-Control": "no-store",
      ...(headers || {}),
    });
    res.end();
  };
}

module.exports = { makeFlashRedirect };
