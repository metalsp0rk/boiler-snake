/**
 * Gork context window builder (roadmap/gork.md §7.2, design decision 5).
 *
 * Builds the conversation context fed to the LLM for a triggering keyword
 * message:
 *
 * - **Reply chain** (the trigger replies to another message): walk the chain
 *   upward via `message.reference` / `await message.fetchReference()`,
 *   collecting up to X messages (root included). If the chain is shorter
 *   than X, backfill with messages before the chain root in the same
 *   channel until X total.
 * - **Prior** (no reply reference): the X messages immediately before the
 *   keyword message in its channel.
 *
 * Rules (locked spec):
 * - Included: all readable messages — human and bot, including gork's own
 *   prior answers.
 * - Excluded: the triggering keyword message itself; messages with empty
 *   content are skipped (collection keeps going until X non-empty messages
 *   are collected or the channel has no more).
 * - Broken chain links (deleted/unfetchable reference) are skipped; the
 *   walk stops when the chain ends or X is reached.
 * - Shape: one line per message, `[username] content`, oldest → newest,
 *   joined with newlines.
 * - Caps: 500 chars per message, 12,000 chars total (same caps as the
 *   ticket transcript summarizer).
 *
 * Never throws: any fetch failure degrades to whatever was already
 * collected (possibly nothing — `{ text: "", collected: 0 }`).
 *
 * Testability: the async collection logic only touches the discord.js
 * surface listed in {@link GorkMessage} below, so unit tests can drive it
 * with plain fake objects (no Discord client, no network). An optional
 * `fetcher` dependency injects the `channel.messages.fetch` call for
 * tests that prefer to stub at that seam instead of faking the channel.
 *
 * Audit descriptor: callers (gork audit) render `mode` + `collected` as
 * e.g. "reply chain (4 msgs)" (`mode === "reply-chain"`) or
 * "10 prior messages" (`mode === "prior"`).
 */

/**
 * Minimal discord.js message surface this module reads. Fake test objects
 * implementing these fields/behaviors are fully sufficient.
 *
 * @typedef {object} GorkMessage
 * @property {string} id message id
 * @property {string|null} [content] raw message content (null/empty = skipped)
 * @property {{ username?: string, tag?: string }} [author]
 * @property {string} [channelId] channel the message lives in
 * @property {object|null} [reference] reply reference (`{ messageId }` or null)
 * @property {() => Promise<GorkMessage>} [fetchReference] fetches the referenced message; throws when unfetchable
 * @property {{ id?: string, messages: { fetch: (opts: { limit: number, before?: string }) => Promise<object> } }} [channel]
 */

/**
 * Minimal discord.js channel surface this module reads.
 *
 * @typedef {object} GorkChannel
 * @property {string} [id]
  * @property {{ fetch: (opts: { limit: number, before?: string }) => Promise<object> }} messages
  *   Returns a Collection or array of messages, NEWEST → oldest (the Discord
  *   REST API returns messages newest-first and discord.js preserves response
  *   order): messages strictly before `before`.
 */

const MIN_WINDOW = 1;
const MAX_WINDOW = 50;
const DEFAULT_WINDOW = 10;
/** Per-message content cap (same as the ticket transcript summarizer). */
const MESSAGE_CHAR_CAP = 500;
/** Total context cap (same as the ticket transcript summarizer). */
const TOTAL_CHAR_CAP = 12000;
/** Page size for `channel.messages.fetch` (discord.js max is 100). */
const PAGE_SIZE = 50;
/**
 * Max pages scanned when hunting X non-empty messages (bounds scanning of
 * channels full of empty-content messages). 4 × 50 = 200 messages scanned.
 */
const MAX_PAGES = 4;
/** Hard cap on reply-chain depth (cycle guard; X can never exceed 50). */
const MAX_CHAIN_DEPTH = 50;

/**
 * Clamp a configured context window to the spec'd range (1-50). Null,
 * empty, or non-numeric input degrades to the default (10).
 *
 * @param {unknown} value raw `gork_context_window` value
 * @returns {number} window size in messages (1-50)
 */
function clampWindowSize(value) {
  // Number(null) is 0 — treat null/empty strings as "not set", not zero.
  if (value == null || (typeof value === "string" && !value.trim())) {
    return DEFAULT_WINDOW;
  }
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_WINDOW;
  return Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, n));
}

/**
 * Whether the message carries a reply reference worth walking.
 *
 * @param {GorkMessage|null|undefined} message
 * @returns {boolean}
 */
function hasReference(message) {
  const reference = message ? message.reference : null;
  return Boolean(reference && (reference.messageId || reference.message_id));
}

/**
 * Whether the message has non-empty text content (whitespace-only counts
 * as empty). Empty-content messages are skipped from the context.
 *
 * @param {GorkMessage|null|undefined} message
 * @returns {boolean}
 */
function hasContent(message) {
  if (!message || message.content == null) return false;
  return String(message.content).trim().length > 0;
}

/**
 * Format one message as a context line: `[username] content` with the
 * content capped at MESSAGE_CHAR_CAP chars.
 *
 * @param {GorkMessage|null|undefined} message
 * @returns {string}
 */
function formatMessageLine(message) {
  const username = (message && message.author && message.author.username) || "unknown";
  const body = String((message && message.content) || "").slice(0, MESSAGE_CHAR_CAP);
  return `[${username}] ${body}`;
}

/**
 * Format an ordered (oldest → newest) list of messages into the final
 * context text: one line per message, joined with newlines, capped at
 * TOTAL_CHAR_CAP chars total.
 *
 * @param {GorkMessage[]} messages oldest → newest
 * @returns {string}
 */
function formatContext(messages) {
  return (messages || [])
    .map(formatMessageLine)
    .join("\n")
    .slice(0, TOTAL_CHAR_CAP);
}

/**
 * Default message fetch: discord.js `channel.messages.fetch(opts)`.
 *
 * @param {GorkChannel} channel
 * @param {{ limit: number, before?: string }} opts
 * @returns {Promise<object>} Collection or array of messages
 */
function defaultFetcher(channel, opts) {
  return channel.messages.fetch(opts);
}

/**
 * Walk the reply chain upward from the trigger message, collecting up to
 * `target` non-empty messages (root included).
 *
 * A broken link (fetchReference throws, returns nothing, or repeats an id
 * already seen) is skipped and ends the walk. Empty-content links are
 * skipped from the output but do not end the walk (they may lead to
 * non-empty ancestors).
 *
 * @param {GorkMessage} triggerMessage
 * @param {number} target max messages to collect (1-50)
 * @returns {Promise<GorkMessage[]>} collected chain, newest → oldest
 */
async function walkReplyChain(triggerMessage, target) {
  const chain = [];
  const seen = new Set(triggerMessage.id ? [triggerMessage.id] : []);
  let current = triggerMessage;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
    if (chain.length >= target) break;
    if (!hasReference(current)) break;
    let next;
    try {
      next = await current.fetchReference();
    } catch {
      break; // deleted/unfetchable link: skip it and stop walking
    }
    if (!next || !next.id || seen.has(next.id)) break;
    seen.add(next.id);
    if (hasContent(next)) chain.push(next);
    current = next;
  }
  return chain;
}

/**
 * Collect up to `target` non-empty messages from the channel, strictly
 * before `beforeId`, oldest → newest. Pages backward until X non-empty
 * messages are collected, the channel runs dry, or MAX_PAGES is reached.
 * Never throws: a failed fetch degrades to whatever was collected.
 *
 * @param {GorkChannel|null|undefined} channel
 * @param {number} target max messages to collect (1-50)
 * @param {string|null|undefined} beforeId fetch only messages before this id
 * @param {(channel: GorkChannel, opts: { limit: number, before?: string }) => Promise<object>} fetcher
 * @returns {Promise<GorkMessage[]>} collected messages, oldest → newest
 */
async function collectMessages(channel, target, beforeId, fetcher) {
  const collected = []; // oldest → newest
  let cursor = beforeId;
  let pages = 0;
  while (collected.length < target && cursor && pages < MAX_PAGES) {
    let batch;
    try {
      batch = await fetcher(channel, { limit: PAGE_SIZE, before: cursor });
    } catch {
      break; // fetch failed: degrade to what was collected
    }
    const values = batch && batch.values ? [...batch.values()] : [...(batch || [])];
    if (!values.length) break; // channel has no more messages
    // `values` is NEWEST → oldest (Discord REST contract) and strictly older
    // than everything already collected, so prepend. When the batch holds more
    // non-empty messages than we still need, take the newest ones (closest to
    // cursor = start of the array); reverse so `collected` stays oldest → newest.
    const fresh = values.filter(hasContent);
    const take = Math.min(fresh.length, target - collected.length);
    collected.unshift(...fresh.slice(0, take).reverse());
    // Advance past the whole batch (empty-content messages included) so
    // the next page goes further back instead of re-reading the same page.
    if (values.length < PAGE_SIZE) break; // channel exhausted
    cursor = values[values.length - 1].id;
    pages += 1;
  }
  return collected;
}

/**
 * Choose the `before` cursor for backfilling a short reply chain: the
 * chain root when it lives in the trigger's own channel, otherwise the
 * trigger message (backfill recent context from the trigger channel).
 *
 * @param {GorkMessage[]} chainOldestFirst
 * @param {GorkMessage} triggerMessage
 * @returns {string|null}
 */
function backfillBeforeId(chainOldestFirst, triggerMessage) {
  const root = chainOldestFirst[0];
  const triggerChannelId = triggerMessage && triggerMessage.channel ? triggerMessage.channel.id : null;
  if (root && root.id && root.channelId && root.channelId === triggerChannelId) {
    return root.id;
  }
  return triggerMessage ? triggerMessage.id : null;
}

/**
 * Assemble the final context result.
 *
 * @param {GorkMessage[]} messages oldest → newest
 * @param {"reply-chain"|"prior"} mode which collection path was used
 * @returns {{ text: string, mode: "reply-chain"|"prior", collected: number }}
 */
function toContextResult(messages, mode) {
  return {
    text: formatContext(messages),
    mode,
    collected: messages.length,
  };
}

/**
 * Build the Gork context window for a triggering keyword message.
 *
 * - Trigger **replies** to a message → walk the reply chain upward
 *   (up to `windowSize` messages, root included); if the chain is shorter,
 *   backfill with messages before the chain root in the same channel.
 *   `mode` is `"reply-chain"` (even when every link is broken and the
 *   backfill supplies all the context — the trigger was a reply).
 * - No reply reference → the `windowSize` non-empty messages immediately
 *   before the keyword message. `mode` is `"prior"`.
 *
 * The triggering message itself is always excluded; empty-content messages
 * are skipped; fetch failures degrade to whatever was collected. Never
 * throws.
 *
 * @param {GorkMessage} triggerMessage the keyword message that triggered gork
 * @param {number} windowSize guild `gork_context_window` (1-50; clamped here)
 * @param {object} [opts]
 * @param {(channel: GorkChannel, opts: { limit: number, before?: string }) => Promise<object>} [opts.fetcher]
 *   message fetch seam (defaults to `channel.messages.fetch`)
 * @returns {Promise<{ text: string, mode: "reply-chain"|"prior", collected: number }>}
 *   - `text`: `[username] content` lines, oldest → newest, newlines-joined
 *     (may be "" when nothing was collected); ≤12,000 chars
 *   - `mode`: `"reply-chain"` (trigger had a reference) or `"prior"`
 *   - `collected`: number of non-empty messages in `text`
 */
async function buildContext(triggerMessage, windowSize, opts = {}) {
  const target = clampWindowSize(windowSize);
  const fetcher = typeof opts.fetcher === "function" ? opts.fetcher : defaultFetcher;
  const channel = triggerMessage ? triggerMessage.channel : null;

  if (hasReference(triggerMessage)) {
    const chainNewestFirst = await walkReplyChain(triggerMessage, target);
    const chainOldestFirst = [...chainNewestFirst].reverse();
    let backfill = [];
    if (chainOldestFirst.length < target) {
      const beforeId = backfillBeforeId(chainOldestFirst, triggerMessage);
      backfill = await collectMessages(
        channel,
        target - chainOldestFirst.length,
        beforeId,
        fetcher,
      );
    }
    return toContextResult([...backfill, ...chainOldestFirst], "reply-chain");
  }

  const prior = await collectMessages(
    channel,
    target,
    triggerMessage ? triggerMessage.id : null,
    fetcher,
  );
  return toContextResult(prior, "prior");
}

module.exports = {
  buildContext,
  hasReference,
  hasContent,
  clampWindowSize,
  formatMessageLine,
  formatContext,
  MIN_WINDOW,
  MAX_WINDOW,
  DEFAULT_WINDOW,
  MESSAGE_CHAR_CAP,
  TOTAL_CHAR_CAP,
};
