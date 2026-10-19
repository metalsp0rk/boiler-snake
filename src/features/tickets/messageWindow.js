"use strict";

/**
 * Shared history-window walk (#472 LT-16.2).
 *
 * The archive transcript fetcher (close.js) and the on-demand summary
 * history reader (admin.js) hand-wrote the SAME walk twice: 100-per-page
 * `before` cursor over a newest-first channel history, hard cap,
 * oldest-of-page snowflake cursor, stop on short page, oldest-first sort
 * with an id tie-break. The sort/cursor arithmetic existing twice meant a
 * pagination fix had to land twice — this is the single home for it.
 *
 * Platform differences stay at the call sites: `fetchPage` returns RAW
 * items carrying an `id` (discord.js Collection values, Fluxer adapter
 * messages), `normalize` maps one raw item to the row shape used for
 * sorting and downstream rendering (`message_id` + `sent_at` required).
 */

const PAGE_SIZE = 100;

/**
 * @param {(opts: { limit: number, before?: string }) => Promise<Array<{id: string|number}>|null>} fetchPage
 *   resolves one page (empty/null ends the walk); throws propagate.
 * @param {(raw: object) => {message_id: string|number, sent_at: number}} normalize
 * @param {number} max hard cap on collected rows (never a silent "all")
 * @param {number} [page] page size (default 100 — the platform channel max)
 * @returns {Promise<object[]>} oldest-first
 */
async function fetchHistoryWindow({ fetchPage, normalize, max, page = PAGE_SIZE }) {
  const collected = [];
  let before = undefined;

  while (collected.length < max) {
    const batch = await fetchPage({ limit: page, ...(before ? { before } : {}) });
    if (!batch || batch.length === 0) break;

    for (const item of batch) {
      collected.push(normalize(item));
    }

    // Oldest id of the page (channels answer newest-first; snowflake compare,
    // with a lexicographic fallback for non-numeric ids from test fakes).
    const oldest = batch.reduce((a, b) => {
      try {
        return BigInt(a.id) < BigInt(b.id) ? a : b;
      } catch {
        return String(a.id) < String(b.id) ? a : b;
      }
    });
    before = oldest.id;
    if (batch.length < page) break;
  }

  collected.sort((a, b) => {
    if (a.sent_at !== b.sent_at) return a.sent_at - b.sent_at;
    return String(a.message_id).localeCompare(String(b.message_id));
  });
  return collected;
}

module.exports = { fetchHistoryWindow, PAGE_SIZE };
