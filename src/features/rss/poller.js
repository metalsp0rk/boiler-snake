/**
 * The RSS poller core (issue #305, subtask 06) — the ONE engine behind the
 * ticker (subtask 08) and `/rss check` (subtask 07). Composed entirely from
 * the merged upstream units; nothing in them is reimplemented here:
 *
 *  - src/features/rss/feedFetch.js — `guardedFetchForFeed` is the ONLY
 *    transport (per-poll SSRF re-validation + pinned DNS, stable UA, 10 s
 *    timeout, ≤1 MiB cap, conditional GET). rss-parser's own requester is
 *    never wired — the guard owns the socket — so rss-parser only ever sees
 *    text this unit already fetched (parseString).
 *  - src/features/rss/feedState.js — `isRssPollDue` (the community interval
 *    gate with the per-feed exponential backoff folded through
 *    failure_count) and `partitionEntries` (seen-set diff, first-hour
 *    window rule, prune signal).
 *  - src/features/rss/format.js — `buildNotification` shapes the VERBATIM
 *    `outbound.sendChannel` payload (the strict #272 allowedMentions arms
 *    live inside it; routing is here).
 *  - the db facade (injected or default) — rss repository writes
 *    (`addRssSeenEntry` / `recordRssFeedSuccess` / `recordRssFeedFailure` /
 *    `pruneRssSeenForFeed`) plus `RSS_SEEN_CAP`, which is passed to
 *    `partitionEntries` explicitly (the pure unit mirrors the repository
 *    constant only as a default; the ticker passes the facade one, per
 *    feedState's module header).
 *
 * Per-row flow (`pollFeedRow`) — NEVER throws; every path returns
 * `{ ok, outcome, posted, skipped, error? }` (services reply to nobody,
 * AGENTS.md error law #6):
 *
 *   config gate: settings.rss_notification_channel_id unset → refused-config
 *     (ZERO fetches; the caller counts/logs — /rss test & /rss check reply
 *     the cause to the staff member, the tick throttles its log)
 *   clock gate: isRssPollDue(last_checked, interval, failure_count) → backoff
 *   fetch: guardedFetchForFeed carrying the stored etag / last-modified
 *     304  → recordRssFeedSuccess({ lastChecked }) ONLY — the spec's "free
 *            poll advances last_checked only"; validators stay untouched
 *            (the repo's tri-state writes leave them alone) → not-modified
 *     fail → recordRssFeedFailure + exactly one [rss] error log → fetch-failed
 *   parse: parser.parseString(text) — rss-parser 3.13.0's REAL method name;
 *     the installed copy exposes `parseString`, NOT `parseFromString`
 *     (verified against node_modules/rss-parser/lib/parser.js). An injected
 *     parser seam may offer either; an unparseable body is a recorded
 *     failure, never a crash.
 *   partition: listRssSeenKeysForFeed → toPost / toSeed / pruneNeeded
 *   seed: addRssSeenEntry per toSeed key WITHOUT posting (seen_at backdated
 *     to publishedMs — feedState's documented prune-order contract).
 *   flood cap (≤5/feed/tick): toPost is oldest-first; the FIRST 5 are sent.
 *     OVERFLOW (the newest end) is marked seen WITHOUT posting and logged
 *     once — the exact twitch precedent (ticker.js `processNewClips`:
 *     `fresh.slice(0, MAX_MEDIA_PER_TICK)` sent, then "advance past EVERY
 *     fresh clip (even unsent ones) to bound the flood", drop logged).
 *     Overflow is NOT left unseen for the next tick; twitch does not.
 *   send loop (oldest-first, one try per send): addRssSeenEntry CLAIM
 *     (false → lost the race, skip + count) → buildNotification (null →
 *     skip + count) → outbound.sendChannel(channelId, payload). A send
 *     failure (throw OR `{ ok:false }`) logs the cause, records the failure
 *     and STOPS this feed's tick — the youtube #380 stop-at-first-failure
 *     shape; later entries of this tick stay unclaimed.
 *   success: recordRssFeedSuccess({ etag, lastModified, lastEntryKey,
 *     lastChecked }) (validators are stored exactly as feedFetch echoed them
 *     — its header documents "the poller just stores whatever comes back")
 *     + pruneRssSeenForFeed when the partition asked for it.
 *
 * Two decisions the merged upstream FORCES, documented loudly:
 *
 *  1. SEND FAILURE KEEPS THE CLAIM. The seen-row of the entry whose send
 *     failed is NOT deleted. The repository exposes no single-key seen
 *     release (`clearRssSeenForFeed` would wipe the WHOLE set and re-open
 *     every entry to a repost — the burn class inverted), and no feature
 *     here releases a consumed dedupe row on send failure (youtube's #380
 *     fix keeps a WATERMARK it never pre-consumed; twitch clips/VODs
 *     advance past failed sends outright). So the claim stays, the
 *     [rss] log names the burned key, and the loss is bounded by the
 *     claim-before-send ordering to exactly the one entry that failed.
 *  2. FAILURE vs THE ONE CLOCK COLUMN. rss_feeds has a single
 *     `last_checked` column (unlike youtube's split last_checked_at
 *     cadence / last_checked ordinal floor, #379/#380), so failure paths
 *     use it deliberately per FAULT CLASS: FETCH/PARSE failures stamp
 *     `now` — the documented repository intent ("the retry gate counts
 *     from THIS failure"); the body was already retrieved, and a persistent
 *     bad feed should back off from the failure, not from the old poll.
 *     SEND failures (a Discord-side fault) PRESERVE the prior watermark —
 *     stamping past it would make feedState's later-poll rule
 *     (`fresh iff publishedMs > last_checked`) silently seed the whole
 *     un-attempted backlog on the next poll. With the watermark preserved
 *     the backlog genuinely retries; only the claimed key is burned
 *     (decision #1). The tradeoff against the single column is a send
 *     failure gating off the OLD clock — the exponential failure_count
 *     still dominates (base×2^fc), so a flapping channel backs off anyway.
 *
 * `RSS_MAX_FEEDS_PER_COMMUNITY` is deliberately NOT read here — the cap
 * gates SUBSCRIPTIONS at `/rss add` (subtask 07); the poller polls every
 * row it is given, including an over-cap legacy backlog. It therefore
 * needs no `.env.example` / env-parity registration in this unit.
 *
 * `pollAllFeeds` is the tick sweep: ONE `listAllRssFeeds()` query, per-row
 * settings + interval/backoff gate + outbound routing via
 * `supervisor.clientForCommunity` (missing client → logged and skipped,
 * youtube resolveOutbound shape, no raw-client fallback), per-row try/catch
 * so one bad feed never aborts the sweep (twitch #198 precedent), and ONE
 * aggregate log per tick, only when real work happened.
 */

const { guardedFetchForFeed } = require("./feedFetch");
const {
  isRssPollDue,
  partitionEntries,
  RSS_SEEN_CAP: SEEN_CAP_FALLBACK,
} = require("./feedState");
const { buildNotification } = require("./format");
const { resolveOutbound } = require("../../core/outbound");

/** Spec: ≤5 posts per feed per tick (ticker.js MAX_MEDIA_PER_TICK twin). */
const MAX_POSTS_PER_FEED_PER_TICK = 5;

/**
 * Refused-config (no notify channel) is a STANDING config state, not an
 * event — re-warning every 5-minute tick would bury real failures. Mirror
 * of the youtube ticker's logApiIssue cadence: one line per community per
 * window, silent in between; the tick aggregate still counts every pass.
 */
const REFUSED_CONFIG_LOG_MS = 6 * 60 * 60_000;
const refusedConfigLoggedAt = new Map();

/**
 * Lazy facade default. Call-time require (not module-time) keeps this unit
 * loadable before the db layer binds and lets the loadDb() test harness's
 * cache reset rebind it cleanly — the repository layer's lazy-facade idiom.
 */
function defaultDb() {
  return require("../../db");
}

let defaultParser = null;

/** Single shared rss-parser instance (stateless for parseString). */
function getDefaultParser() {
  if (!defaultParser) {
    const Parser = require("rss-parser");
    defaultParser = new Parser();
  }
  return defaultParser;
}

/**
 * Parse feed text with the injected or default parser seam. rss-parser
 * 3.13.0's method is `parseString` (verified against the installed copy);
 * `parseFromString` is accepted for doubles/future majors. Never sync-
 * throws: a seam without either method rejects with a named cause.
 */
function parseFeedText(parser, text) {
  if (typeof parser.parseString === "function") return parser.parseString(text);
  if (typeof parser.parseFromString === "function") {
    return parser.parseFromString(text);
  }
  return Promise.reject(
    new Error("parser seam offers neither parseString nor parseFromString"),
  );
}

/** rss-parser hands entries in `items`; `entries` rides some doubles/docs. */
function feedEntriesFrom(feed) {
  if (Array.isArray(feed?.items)) return feed.items;
  if (Array.isArray(feed?.entries)) return feed.entries;
  return [];
}

/** Injectable-clock coercion (same posture as feedState.coerceNowMs). */
function coerceNowMs(value) {
  if (value == null) return Date.now();
  const n = Number(value);
  return Number.isFinite(n) ? n : Date.now();
}

function positiveIntOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** Newest claimed key of a partition (toPost/toSeed are oldest-first). */
function latestClaimedKey(partition) {
  const tails = [
    partition.toSeed[partition.toSeed.length - 1],
    partition.toPost[partition.toPost.length - 1],
  ].filter(Boolean);
  if (!tails.length) return undefined;
  const latest = tails.reduce((a, b) => (b.publishedMs > a.publishedMs ? b : a));
  return latest.key;
}

/**
 * Poll ONE rss_feeds row. Service-level: never throws, never replies to
 * Discord; every caller (ticker row loop, /rss check) maps the returned
 * outcome into whatever its user sees.
 *
 * @param {{
 *   row: object,                       // rss_feeds row (community_id, url, etag, last_modified, last_checked, failure_count, …)
 *   settings: object,                  // getGuildSettings(community_id) row
 *   db?: object,                       // db facade (default: require of src/db)
 *   parser?: { parseString|parseFromString },  // rss-parser seam (default: shared Parser)
 *   fetchImpl?: Function,              // transport seam → guardedFetchForFeed
 *   resolveHost?: Function,            // DNS seam → guardedFetchForFeed
 *   now?: number,                      // injectable clock, default Date.now()
 *   outbound?: object,                 // OutboundClient for the row's community
 *   force?: boolean,                   // skip the interval/backoff gate (caller owns it)
 *   maxPostsPerFeedPerTick?: number,   // flood-cap knob (tests), default 5
 * }} params
 * @returns {Promise<{
 *   ok: boolean,
 *   outcome: "posted"|"no-change"|"not-modified"|"backoff"|"refused-config"
 *     |"no-client"|"fetch-failed"|"parse-failed"|"send-failed"|"error",
 *   posted: number,
 *   skipped: number,
 *   error?: string,
 * }>}
 */
async function pollFeedRow({
  row,
  settings,
  db = defaultDb(),
  parser,
  fetchImpl,
  resolveHost,
  now,
  outbound = null,
  force = false,
  maxPostsPerFeedPerTick,
} = {}) {
  const communityId = row?.community_id;
  const url = row?.url;
  const nowMs = coerceNowMs(now);
  let posted = 0;
  let skipped = 0;

  try {
    // --- config gate (zero fetches on an unconfigured community) ----------
    const channelId = settings?.rss_notification_channel_id;
    if (!channelId) {
      return { ok: true, outcome: "refused-config", posted: 0, skipped: 0 };
    }

    // --- client gate (youtube resolveOutbound posture: nothing here ever
    //     falls back to a raw discord client) -------------------------------
    if (!outbound || typeof outbound.sendChannel !== "function") {
      console.warn(
        `[rss] no ready client for community ${communityId} — skipping ${url}`,
      );
      return {
        ok: false,
        outcome: "no-client",
        posted: 0,
        skipped: 0,
        error: `no ready client for community ${communityId}`,
      };
    }

    // --- interval / backoff gate (feedState owns the math) -----------------
    if (
      !force &&
      !isRssPollDue({
        lastChecked: row.last_checked,
        intervalMinutes: settings.rss_polling_interval_minutes,
        failureCount: row.failure_count,
        now: nowMs,
      })
    ) {
      return { ok: true, outcome: "backoff", posted: 0, skipped: 0 };
    }

    // --- conditional GET through the SSRF guard (per-poll re-validation) ---
    const res = await guardedFetchForFeed(url, {
      etag: row.etag ?? null,
      lastModified: row.last_modified ?? null,
      fetchImpl,
      resolveHost,
    });

    if (!res.ok) {
      // One log per failure (spec); the backoff window defers the next try.
      db.recordRssFeedFailure(communityId, url, { lastChecked: nowMs });
      console.error(
        `[rss] feed poll failed (community=${communityId} url=${url}): ${res.reason}`,
      );
      return {
        ok: false,
        outcome: "fetch-failed",
        posted: 0,
        skipped: 0,
        error: res.reason,
      };
    }

    if (res.notModified) {
      // Spec: 304 is a FREE poll — advance last_checked ONLY. The tri-state
      // repo write leaves etag / last_modified / last_entry_key alone
      // because we pass nothing but the clock (asserted by test).
      db.recordRssFeedSuccess(communityId, url, { lastChecked: nowMs });
      return { ok: true, outcome: "not-modified", posted: 0, skipped: 0 };
    }

    // --- parse (text ALREADY fetched by the guard — never a parser fetch) --
    let feed;
    try {
      feed = await parseFeedText(parser ?? getDefaultParser(), res.text);
    } catch (err) {
      const cause = String(err?.message || err);
      db.recordRssFeedFailure(communityId, url, { lastChecked: nowMs });
      console.error(
        `[rss] feed parse failed (community=${communityId} url=${url}): ${cause}`,
      );
      return {
        ok: false,
        outcome: "parse-failed",
        posted: 0,
        skipped: 0,
        error: cause,
      };
    }

    // --- dedup + first-poll window (pure decision box) ---------------------
    const seenCap = positiveIntOr(db?.RSS_SEEN_CAP, SEEN_CAP_FALLBACK);
    const partition = partitionEntries({
      entries: feedEntriesFrom(feed),
      seenKeys: db.listRssSeenKeysForFeed(communityId, url),
      lastChecked: row.last_checked,
      now: nowMs,
      seenCap,
    });

    // Seed silently: everything unseen-but-not-fresh enters the seen-set
    // without an announcement (the "fresh feed on subscribe never blasts its
    // archive" rule). seen_at backdated to publishedMs keeps prune order
    // meaningful (feedState's documented contract).
    for (const item of partition.toSeed) {
      db.addRssSeenEntry(communityId, url, item.key, item.publishedMs);
    }
    skipped +=
      partition.skippedSeen +
      partition.skippedUnkeyed +
      partition.toSeed.length;

    // --- flood cap split (twitch shape): oldest ≤5 sent, newest overflow
    //     marked seen WITHOUT posting, drop logged once ---------------------
    const cap = positiveIntOr(maxPostsPerFeedPerTick, MAX_POSTS_PER_FEED_PER_TICK);
    const toSend = partition.toPost.slice(0, cap);
    const overflow = partition.toPost.slice(cap);

    for (const item of toSend) {
      // CLAIM before sending (INSERT OR IGNORE): a concurrent poll of the
      // same feed (ticker vs /rss check) can never double-announce — only
      // one inserter gets true. On send failure the claim STAYS
      // (documented decision #1 in the module header: no single-key seen
      // release exists in the repository; the burned key is named in the
      // failure log).
      const claimed = db.addRssSeenEntry(communityId, url, item.key, item.publishedMs);
      if (!claimed) {
        skipped += 1; // lost the race — someone else announced it
        continue;
      }

      const payload = buildNotification(item.entry, row, {
        channelId,
        notifyRoleId: settings.rss_notify_role_id,
      });
      if (!payload) {
        // No headline, no permalink (format.js HEADLINE RULE): unannounceable
        // forever, not a timing loss — keep the claim, count the skip.
        skipped += 1;
        continue;
      }

      try {
        const sent = await outbound.sendChannel(channelId, payload);
        if (!sent || sent.ok !== true) {
          throw new Error(sent?.error || "sendChannel returned no result");
        }
      } catch (err) {
        const cause = String(err?.message || err);
        // REVIEW FIX (#305, S1): a SEND-side failure must not stamp
        // last_checked past the un-attempted backlog — with the watermark
        // preserved, every un-claimed entry is fresher than last_checked on
        // the next poll and genuinely retries (claim-before-send still
        // bounds the loss to the one burned key). Fetch/parse failures keep
        // stamping `now` (the transport retry gate counts from those).
        db.recordRssFeedFailure(communityId, url, {
          lastChecked: row.last_checked ?? null,
        });
        console.error(
          `[rss] notification send failed (community=${communityId} url=${url} key=${item.key}): ${cause} — ` +
            "stopping this feed's tick; the claimed key above stays seen (seen-set has no single-key release); " +
            "watermark preserved, so un-claimed entries retry on the next poll",
        );
        return {
          ok: false,
          outcome: "send-failed",
          posted,
          skipped,
          error: cause,
        };
      }
      posted += 1;
    }

    // Overflow (newest end, twitch semantics): seen WITHOUT posting. Only
    // reached when the send loop finished cleanly — a stopped tick leaves
    // overflow unclaimed (the failure path above returns first).
    if (overflow.length) {
      for (const item of overflow) {
        db.addRssSeenEntry(communityId, url, item.key, item.publishedMs);
        skipped += 1;
      }
      console.log(
        `[rss] ${url} (community=${communityId}): ${partition.toPost.length} new entries, announced ${toSend.length}, skipped ${overflow.length} (cap ${cap}/poll)`,
      );
    }

    // --- watermark + validators + bounded set (success path) ---------------
    const lastEntryKey = latestClaimedKey(partition);
    db.recordRssFeedSuccess(communityId, url, {
      etag: res.etag ?? null,
      lastModified: res.lastModified ?? null,
      ...(lastEntryKey !== undefined ? { lastEntryKey } : {}),
      lastChecked: nowMs,
    });
    if (partition.pruneNeeded) {
      db.pruneRssSeenForFeed(communityId, url, seenCap);
    }

    return {
      ok: true,
      outcome: posted > 0 ? "posted" : "no-change",
      posted,
      skipped,
    };
  } catch (err) {
    // Last-resort net (never-throw contract): a throwing seam / repo write
    // lands as a specific, logged error — never an exception that could
    // abort the caller's sweep.
    const cause = String(err?.message || err);
    console.error(
      `[rss] unexpected poll failure (community=${communityId ?? "?"} url=${url ?? "?"}):`,
      cause,
    );
    return { ok: false, outcome: "error", posted, skipped, error: cause };
  }
}

/**
 * The tick sweep the rss job (subtask 08) runs: ONE query across every
 * community, per-row gate → route → poll, per-row try/catch so one bad
 * feed never kills the sweep (twitch #198), one aggregate log per tick and
 * only when real work happened. Never throws.
 *
 * @param {{
 *   db?: object,
 *   supervisor?: object|null,   // PR 7 supervisor (clientForCommunity)
 *   parser?: object, fetchImpl?: Function, resolveHost?: Function,
 *   now?: number,
 *   limits?: { maxPostsPerFeedPerTick?: number },  // flood-cap knob (tests)
 * }} [options]
 * @returns {Promise<{
 *   feeds: number,          // rows listed this pass
 *   polled: number,         // rows that reached the transport
 *   posted: number,         // notifications sent
 *   skipped: number,        // rows skipped (refused-config / no client)
 *   failures: number,       // fetch / parse / send / unexpected failures
 *   notModified: number,    // 304 free polls
 *   notDue: number,         // interval/backoff gate closes (normal case)
 *   refusedConfig: number,  // subset of skipped: no rss_notification_channel_id
 *   noClient: number,       // subset of skipped: community client missing/not ready
 * }>}
 */
async function pollAllFeeds({
  db = defaultDb(),
  supervisor = null,
  parser,
  fetchImpl,
  resolveHost,
  now,
  limits = {},
} = {}) {
  const nowMs = coerceNowMs(now);
  const agg = {
    feeds: 0,
    polled: 0,
    posted: 0,
    skipped: 0,
    failures: 0,
    notModified: 0,
    notDue: 0,
    refusedConfig: 0,
    noClient: 0,
  };

  try {
    // The ticker's single query (empty table → [] → clean, silent skip).
    const rows = db.listAllRssFeeds();
    agg.feeds = rows.length;

    for (const row of rows) {
      try {
        const communityId = row.community_id;
        const settings = db.getGuildSettings(communityId);

        // Unconfigured community: no fetch, no client lookup. The counter
        // credits every such row to refused-config; the LOG is throttled
        // per community so a standing config gap never spams the tick.
        if (!settings?.rss_notification_channel_id) {
          agg.skipped += 1;
          agg.refusedConfig += 1;
          const last = refusedConfigLoggedAt.get(communityId) ?? 0;
          if (nowMs - last >= REFUSED_CONFIG_LOG_MS) {
            refusedConfigLoggedAt.set(communityId, nowMs);
            if (refusedConfigLoggedAt.size > 256) refusedConfigLoggedAt.clear();
            console.log(
              `[rss] community ${communityId} has no rss_notification_channel_id — skipping ${row.url} (re-logs at most every ${REFUSED_CONFIG_LOG_MS / 3_600_000}h)`,
            );
          }
          continue;
        }

        // Fixed cadence (job) + per-row interval/backoff gate (feedState),
        // the youtube #379/#429 model: due iff last_checked + interval
        // (× 2^failure_count, cap 6h) <= now.
        if (
          !isRssPollDue({
            lastChecked: row.last_checked,
            intervalMinutes: settings.rss_polling_interval_minutes,
            failureCount: row.failure_count,
            now: nowMs,
          })
        ) {
          agg.notDue += 1;
          continue;
        }

        // Per-row outbound routing (spec 576): missing / not-ready client →
        // logged and skipped; no raw-discord-client fallback exists here.
        const outbound = resolveOutbound(supervisor, communityId, { label: "rss" });
        if (!outbound) {
          console.warn(
            `[rss] no ready client for community ${communityId} — skipping ${row.url}`,
          );
          agg.skipped += 1;
          agg.noClient += 1;
          continue;
        }

        const res = await pollFeedRow({
          row,
          settings,
          db,
          parser,
          fetchImpl,
          resolveHost,
          now: nowMs,
          outbound,
          maxPostsPerFeedPerTick: limits.maxPostsPerFeedPerTick,
        });

        agg.posted += res.posted ?? 0;
        if (res.outcome === "not-modified") agg.notModified += 1;
        if (res.outcome === "backoff") {
          agg.notDue += 1; // defensive: same-snapshot gate cannot re-close
        } else if (res.outcome === "refused-config") {
          agg.skipped += 1;
          agg.refusedConfig += 1;
        } else if (res.outcome === "no-client") {
          agg.skipped += 1;
          agg.noClient += 1;
        } else {
          agg.polled += 1;
          if (!res.ok) agg.failures += 1;
        }
      } catch (err) {
        // Per-row isolation (twitch #198): a bad row drops itself with a
        // logged cause, never aborts the sweep.
        agg.failures += 1;
        console.error(
          `[rss] feed row poll threw (community=${row?.community_id ?? "?"} url=${row?.url ?? "?"}):`,
          err?.message || err,
        );
      }
    }

    // ONE aggregate log per tick, only when work happened (a silent all-
    // not-due pass is the normal cadence and stays quiet).
    if (agg.polled > 0 || agg.failures > 0 || agg.refusedConfig > 0 || agg.noClient > 0) {
      console.log(
        `[rss] tick: ${agg.polled}/${agg.feeds} feed(s) polled — ${agg.posted} posted, ${agg.notModified} not-modified, ${agg.failures} failure(s), ${agg.skipped} skipped`,
      );
    }
    return agg;
  } catch (err) {
    // The sweep itself is a detached async job — it ends in a logged line,
    // never a rejection that could surface as an unhandled rejection.
    console.error("[rss] tick sweep failed:", err?.message || err);
    return agg;
  }
}

/**
 * Acceptance-name aliases (subtask contract): `pollFeed(row, settings, deps)`
 * is pollFeedRow's positional-call twin; `pollDueFeeds(deps)` is pollAllFeeds.
 * The ticker (08) and /rss check (07) may call either pair.
 */
function pollFeed(row, settings, deps = {}) {
  return pollFeedRow({ ...deps, row, settings });
}

module.exports = {
  MAX_POSTS_PER_FEED_PER_TICK,
  pollFeedRow,
  pollAllFeeds,
  pollFeed,
  pollDueFeeds: pollAllFeeds,
};
