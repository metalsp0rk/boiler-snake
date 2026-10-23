/**
 * Pure feed-state decisions for RSS feed notifications (issue #305, subtask 04).
 *
 * This module is the DECISION box behind the rss ticker: entry-key derivation,
 * seen-set partitioning (what to post vs. what to seed silently), the first
 * poll's last-hour window, the per-feed exponential backoff, and the
 * per-community polling-interval gate. It is deliberately PURE — no db, no
 * fetch, no Discord/Fluxer I/O, no replies: inputs are plain rows/values and
 * outputs are decisions/keys, so every rule is unit-testable in isolation.
 * The ticker (subtask 08) owns the repository writes (`addRssSeenEntry`,
 * `recordRssFeedSuccess` / `recordRssFeedFailure`, `pruneRssSeenForFeed`) and
 * the outbound sends; it consumes exactly the shapes returned here.
 *
 * Mirrored precedents (read the source, not a paraphrase):
 *
 *  - FIRST-POLL WINDOW — src/features/youtube/ticker.js `processChannel`:
 *      `if (info.published <= oneHourAgo) continue;`
 *    An entry is fresh iff its publish time is STRICTLY NEWER than
 *    now − 60 min. An entry published EXACTLY one hour ago is therefore NOT
 *    posted — here it lands in `toSeed` instead. Everything outside the
 *    window on a first poll (no `last_checked`) is seeded into the seen-set
 *    silently, so a freshly subscribed feed never blasts its archive.
 *
 *  - MISSING PUBLISHED DATE — youtube's `extractVideoInfo` resolves a missing
 *    date to `Date.now()`, i.e. a date-less entry counts as fresh and IS
 *    posted on the first poll. We mirror that exactly (documented
 *    spec-choice): `resolveEntryPublishedMs` falls back to `now`. The
 *    per-feed seen-set makes the choice safe — a date-less entry can be
 *    posted at most ONCE per feed; the spec's flood cap bounds the burst.
 *
 *  - INTERVAL GATE — youtube's `runYoutubeTick` eligibility filter:
 *    `nowMs - row.last_checked_at < intervalMs → skip`, never-checked (NULL)
 *    rows always due. `isRssPollDue` is that predicate restated as
 *    `last_checked + interval×60_000 <= now` with the spec's default of 15
 *    minutes (`rss_polling_interval_minutes`).
 *
 * Backoff (spec § Ticker): the retry window is `base × 2^failure_count`
 * capped at 6 h, where base is the community's polling interval; the
 * repository resets `failure_count` to 0 on success, which drops the window
 * back to plain base automatically.
 *
 * Seen-set cap: `RSS_SEEN_CAP` MIRRORS `SEEN_CAP` in
 * src/db/repositories/rss.js (facade alias `RSS_SEEN_CAP`) — it lives here as
 * a default only, because requiring the db layer from a pure unit would open
 * SQLite at load time. The ticker passes the FACADE constant explicitly;
 * test/rss.test.js pins both sides to 100.
 */

const { createHash } = require("node:crypto");

/**
 * `rss_polling_interval_minutes` fallback (schema DEFAULT 15, spec default
 * 15): anything missing or non-positive/non-finite reads as this.
 */
const DEFAULT_RSS_POLL_INTERVAL_MINUTES = 15;

/** Backoff ceiling (spec § Ticker: "base ×2, cap 6h"). */
const RSS_BACKOFF_CAP_MS = 6 * 60 * 60_000;

/** First-poll freshness window — youtube's 60-minute rule. */
const RSS_FIRST_POLL_WINDOW_MS = 60 * 60_000;

/**
 * Keys longer than this are replaced by a `sha256:<hex>` digest. 2048 is the
 * conservative browser/URL practical limit, so a verbatim key stays
 * address-shaped and debuggable while pathological feed data (data-URI
 * "links", base64 blobs) can never bloat the seen-set PK.
 */
const RSS_LONG_KEY_LENGTH = 2048;

/** Mirror of src/db/repositories/rss.js SEEN_CAP (facade `RSS_SEEN_CAP`). */
const RSS_SEEN_CAP = 100;

const MS_PER_MINUTE = 60_000;

/** Coerce an injectable clock; null/undefined/garbage fall back to wall clock. */
function coerceNowMs(value) {
  if (value == null) return Date.now();
  const n = Number(value);
  return Number.isFinite(n) ? n : Date.now();
}

/**
 * Canonical interval minutes for one community. Accepts whatever the
 * guildSettings column holds (INTEGER, string, null on legacy reads): a
 * finite number inside the command surface's 1–60 range is used as-is,
 * everything else falls back to 15. Stricter than youtube's
 * `Number(x) || 5` (which honors any positive value AND negatives fall
 * through) and now range-matched to the /setrss picker + the display
 * twin (review fix N1) — a row poisoned out-of-band can never poll on a
 * cadence the command surface can neither show nor police.
 *
 * @param {unknown} intervalMinutes raw `rss_polling_interval_minutes` value
 * @returns {number} minutes to poll on (1–60, default 15)
 */
function resolveRssIntervalMinutes(intervalMinutes) {
  // Review fix N1: ONE truth for the interval. /setrss interval exposes
  // 1–60, the display twin falls back for anything outside 1–60 — the
  // gate follows the same range so a row poisoned out-of-band (e.g. a
  // hand-stored 1440) can never poll on a cadence the UI can neither
  // show nor police. Out of range → the schema default, not a clamp.
  const n = Number(intervalMinutes);
  return Number.isFinite(n) && n >= 1 && n <= 60
    ? n
    : DEFAULT_RSS_POLL_INTERVAL_MINUTES;
}

/**
 * Per-feed exponential backoff window: `base × 2^failure_count`, clamped to
 * `maxBackoffMs` (default 6 h). `failure_count` 0 (the repository's success
 * reset) yields exactly the base interval, so no separate "reset" call is
 * needed — the counter IS the state. Overflow-safe: a huge failure count
 * produces the cap, never Infinity.
 *
 * @param {{
 *   intervalMinutes?: unknown,   // base, default 15 via resolveRssIntervalMinutes
 *   failureCount?: unknown,      // rss_feeds.failure_count (NaN/negative → 0)
 *   maxBackoffMs?: number,       // test knob; garbage → RSS_BACKOFF_CAP_MS
 * }} [opts]
 * @returns {number} milliseconds to wait before the next poll of this feed
 */
function rssBackoffIntervalMs(opts = {}) {
  const baseMs = resolveRssIntervalMinutes(opts.intervalMinutes) * MS_PER_MINUTE;
  const rawCap = Number(opts.maxBackoffMs);
  const capMs = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : RSS_BACKOFF_CAP_MS;
  const rawFc = Number(opts.failureCount);
  const failures = Number.isFinite(rawFc) && rawFc > 0 ? Math.floor(rawFc) : 0;
  if (failures === 0) return Math.min(baseMs, capMs);
  const grown = baseMs * 2 ** failures;
  return Number.isFinite(grown) ? Math.min(grown, capMs) : capMs;
}

/**
 * The wall-clock ms at which this feed may be polled again:
 * `last_checked + rssBackoffIntervalMs(...)`. A never-checked row (NULL /
 * 0 / garbage `last_checked`) is due immediately, expressed as `now`,
 * mirroring youtube's "NULL last_checked_at is always due" posture.
 *
 * @param {{
 *   lastChecked?: number|null,   // rss_feeds.last_checked (ms stamp) or null
 *   intervalMinutes?: unknown,
 *   failureCount?: unknown,
 *   now?: number,                // injectable clock, default Date.now()
 *   maxBackoffMs?: number,
 * }} [opts]
 * @returns {number} next-due timestamp in ms
 */
function rssNextDueAtMs(opts = {}) {
  const now = coerceNowMs(opts.now);
  const last = Number(opts.lastChecked);
  if (!(Number.isFinite(last) && last > 0)) return now;
  return last + rssBackoffIntervalMs(opts);
}

/**
 * The polling gate the ticker filters rows with: due iff
 * `last_checked + interval (× backoff) <= now`. With `failureCount` omitted
 * (or 0) this is exactly the base interval gate from the spec
 * (`last_checked + rss_polling_interval_minutes×60_000 <= now`, default 15
 * min); the ticker passes the row's `failure_count` to fold in the backoff.
 * The exactly-due instant is DUE (`>=`, youtube's strict `< interval` skip
 * restated).
 *
 * @param {{
 *   lastChecked?: number|null,
 *   intervalMinutes?: unknown,   // settings.rss_polling_interval_minutes
 *   failureCount?: unknown,      // rss_feeds.failure_count (default 0)
 *   now?: number,
 *   maxBackoffMs?: number,
 * }} [opts]
 * @returns {boolean} true when the feed should be polled this tick
 */
function isRssPollDue(opts = {}) {
  const now = coerceNowMs(opts.now);
  return now >= rssNextDueAtMs({ ...opts, now });
}

/**
 * Whitespace-trimmed, stringifiable key candidate from one feed field.
 * Numbers are stringified (Atom ids / hand-built fixtures); everything else
 * non-string is ignored.
 */
function keyCandidate(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return "";
  return value.trim();
}

/**
 * Any key past the length threshold collapses to `sha256:<64 hex>` —
 * a pure function of the value, so the digest is stable across polls,
 * reordering and process restarts (no random salt, no counters).
 */
function stableKey(value) {
  if (value.length <= RSS_LONG_KEY_LENGTH) return value;
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * The dedup identity of one rss-parser entry: guid wins (RSS `<guid>`),
 * then id (Atom `<id>`), then the permalink link; anything longer than
 * {@link RSS_LONG_KEY_LENGTH} is stored as its sha256 digest. The result
 * depends ONLY on those three fields — never on pubDate or array position —
 * which is what makes dedup robust to missing dates and reordered feeds
 * (spec § Dedup).
 *
 * @param {object|null} entry rss-parser entry (`{ guid?, id?, link? }`)
 * @returns {string|null} the stable entry key, or null when the entry is
 *   unannounceable (no guid, no id, no link → nothing to dedup on)
 */
function deriveEntryKey(entry) {
  if (!entry || typeof entry !== "object") return null;
  const guid = keyCandidate(entry.guid);
  if (guid) return stableKey(guid);
  const id = keyCandidate(entry.id);
  if (id) return stableKey(id);
  const link = keyCandidate(entry.link);
  if (link) return stableKey(link);
  return null;
}

/**
 * Publish time in ms, mirroring youtube's `extractVideoInfo` resolution
 * order: `pubDate` first, then the parser-normalized `isoDate`, and finally
 * the provided `now` for date-less or unparseable entries (SPEC CHOICE,
 * documented: youtube treats a missing date as `Date.now()`, so a date-less
 * entry is fresh and posts on the first poll — the seen-set keeps that to
 * once per entry).
 *
 * @param {object|null} entry rss-parser entry
 * @param {number} [now] injected clock used as the date-less fallback
 * @returns {number} publish timestamp in ms (never NaN)
 */
function resolveEntryPublishedMs(entry, now = Date.now()) {
  const fallback = coerceNowMs(now);
  if (!entry || typeof entry !== "object") return fallback;
  for (const candidate of [entry.pubDate, entry.isoDate]) {
    if (candidate == null || candidate === "") continue;
    const ms = new Date(candidate).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
}

/**
 * Split one fetched feed against the feed's bounded seen-set into what to
 * POST and what to SEED silently. Rules, in order per entry (feed order
 * preserved until the final sort):
 *
 *  1. unkeyable entry (see {@link deriveEntryKey}) → counted in
 *     `skippedUnkeyed`, never announced;
 *  2. key already in `seenKeys` → counted in `skippedSeen`, never reposted
 *     (this is the "entries already seen" guarantee);
 *  3. key already claimed by an earlier entry THIS batch → dropped (a feed
 *     serving the same item twice announces once);
 *  4. fresh on a FIRST poll (no `lastChecked`) iff
 *     `publishedMs > now - firstPollWindowMs` (youtube's
 *     `published <= oneHourAgo → skip` restated; exactly-one-hour-old is
 *     seeded, not posted) — everything else on a first poll seeds;
 *  5. fresh on a LATER poll iff `publishedMs > lastChecked` (youtube's
 *     watermark rule); an unseen-but-stale entry seeds instead of posting,
 *     which is what keeps pruned-out archive entries from resurfacing after
 *     a feed reorder.
 *
 * `toPost` is sorted OLDEST-FIRST (youtube #380 delivery order) so the
 * ticker can advance its watermark sequentially and slice the ≤5-per-feed
 * flood cap off the newest end; `toSeed` sorts the same way so the ticker
 * can backdate `seen_at` to `publishedMs` and keep prune order meaningful.
 * Every item is `{ key, entry, publishedMs }`. `pruneNeeded` is the
 * repository prune signal: the seen-set rows + this pass's new keys exceed
 * `seenCap`, so the ticker calls `pruneRssSeenForFeed(communityId, url,
 * RSS_SEEN_CAP)` after inserting (the repo prune is idempotent when not
 * needed — but skipping the write entirely is cheaper).
 *
 * @param {{
 *   entries?: object[],                  // rss-parser feed.entries
 *   seenKeys?: Iterable<string>,         // listRssSeenKeysForFeed output (array/Set)
 *   lastChecked?: number|null,           // rss_feeds.last_checked (null → first poll)
 *   now?: number,                        // injectable clock, default Date.now()
 *   firstPollWindowMs?: number,          // test knob; default 60 min
 *   seenCap?: number,                    // default RSS_SEEN_CAP (facade mirror)
 * }} [opts]
 * @returns {{
 *   toPost: Array<{ key: string, entry: object, publishedMs: number }>,
 *   toSeed: Array<{ key: string, entry: object, publishedMs: number }>,
 *   skippedSeen: number,
 *   skippedUnkeyed: number,
 *   pruneNeeded: boolean,
 * }}
 */
function partitionEntries(opts = {}) {
  const entries = Array.isArray(opts.entries) ? opts.entries : [];
  const now = coerceNowMs(opts.now);
  const rawWindow = Number(opts.firstPollWindowMs);
  const windowMs =
    Number.isFinite(rawWindow) && rawWindow >= 0 ? rawWindow : RSS_FIRST_POLL_WINDOW_MS;
  const rawCap = Number(opts.seenCap);
  const cap = Number.isFinite(rawCap) && rawCap >= 1 ? Math.floor(rawCap) : RSS_SEEN_CAP;

  const seen = new Set(opts.seenKeys ?? []);
  const lastChecked = Number(opts.lastChecked);
  const isFirstPoll = !(Number.isFinite(lastChecked) && lastChecked > 0);
  const firstPollCutoff = now - windowMs;

  const toPost = [];
  const toSeed = [];
  const claimed = new Set();
  let skippedSeen = 0;
  let skippedUnkeyed = 0;

  for (const entry of entries) {
    const key = deriveEntryKey(entry);
    if (key === null) {
      skippedUnkeyed += 1;
      continue;
    }
    if (seen.has(key)) {
      skippedSeen += 1;
      continue;
    }
    if (claimed.has(key)) continue; // duplicate inside one fetch
    claimed.add(key);

    const publishedMs = resolveEntryPublishedMs(entry, now);
    const fresh = isFirstPoll ? publishedMs > firstPollCutoff : publishedMs > lastChecked;
    (fresh ? toPost : toSeed).push({ key, entry, publishedMs });
  }

  // Oldest-first delivery order (youtube #380); ties keep feed order
  // (Array#sort is stable), so date-less entries announce in listing order.
  toPost.sort((a, b) => a.publishedMs - b.publishedMs);
  toSeed.sort((a, b) => a.publishedMs - b.publishedMs);

  return {
    toPost,
    toSeed,
    skippedSeen,
    skippedUnkeyed,
    pruneNeeded: seen.size + claimed.size > cap,
  };
}

module.exports = {
  DEFAULT_RSS_POLL_INTERVAL_MINUTES,
  RSS_BACKOFF_CAP_MS,
  RSS_FIRST_POLL_WINDOW_MS,
  RSS_LONG_KEY_LENGTH,
  RSS_SEEN_CAP,
  resolveRssIntervalMinutes,
  rssBackoffIntervalMs,
  rssNextDueAtMs,
  isRssPollDue,
  deriveEntryKey,
  resolveEntryPublishedMs,
  partitionEntries,
};
