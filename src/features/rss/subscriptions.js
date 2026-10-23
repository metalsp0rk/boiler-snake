/**
 * RSS subscription service (issue #305, subtask 07) — the {ok, error} box the
 * /rss + /setrss commands compose over. Everything the staff commands need on
 * top of the merged upstream units, and NOTHING re-implemented:
 *
 *  - src/features/rss/feedFetch.js — `validateFeedUrl` is the add-time gate
 *    (scheme, shape, SSRF class-check) and `guardedFetchForFeed` is the ONLY
 *    transport (add-time fetch, test fetch); rss-parser only ever sees text
 *    the guard already fetched (≤1 MiB), never its own requester.
 *  - src/features/rss/poller.js — `pollFeedRow` is the poll engine; `/rss
 *    check` is a thin wrapper carrying `force: true` (that export's actual
 *    gate-bypass name — it skips ONLY the interval/backoff clock gate; the
 *    config + client gates stay enforced inside).
 *  - src/features/rss/format.js — `buildNotification` shapes the notification
 *    (used by testPostLatest below; the strict #272 allowedMentions arms live
 *    in format.js, not here).
 *  - the db facade (injected or default) — rss repository + guildSettings.
 *
 * Contract (AGENTS.md error law #6): every function resolves to
 * `{ ok:false, error }` with a SPECIFIC, actionable cause — never replies to
 * Discord, never throws. Handlers decide how to surface the cause (rule 3).
 *
 * `/rss test` deliberately does NOT reuse pollFeedRow. pollFeedRow is the
 * STATEFUL engine: it claims seen-set keys, advances last_checked, stores
 * validators, and bumps failure_count. A diagnostic "post the latest entry"
 * must be side-effect-free — claiming the tested entry in the seen-set would
 * silence the ticker's real announcement of that entry on the next due poll
 * (exactly the youtube /testnotification posture: a test never advances the
 * watermark). The cheapest honest reuse is format.buildNotification +
 * outbound.sendChannel — the SAME two lines the poller composes for a real
 * send — with zero repository writes. `/rss check` IS the stateful path and
 * calls pollFeedRow(force) verbatim.
 */

const { validateFeedUrl, guardedFetchForFeed } = require("./feedFetch");
const {
  buildNotification,
  neutralizeRichText,
  RSS_TITLE_MAX_LENGTH,
} = require("./format");
const { pollFeedRow } = require("./poller");
const {
  resolveEntryPublishedMs,
  DEFAULT_RSS_POLL_INTERVAL_MINUTES,
} = require("./feedState");

/** Spec default for the per-community subscription cap. */
const DEFAULT_MAX_FEEDS_PER_COMMUNITY = 20;

/**
 * Per-community subscription cap (spec: default 20, env override
 * RSS_MAX_FEEDS_PER_COMMUNITY). Read PER CALL through an injectable env
 * source — the feedUserAgent() posture: operators flip the knob without
 * the code caching a stale answer, tests inject their own env object.
 * The `env.RSS_MAX_FEEDS_PER_COMMUNITY` read site is what
 * test/env-parity.test.js pins (registered in .env.example + EXPECTED_VARS).
 * @param {Record<string,string|undefined>} [env]
 * @returns {number}
 */
function maxFeedsPerCommunity(env = process.env) {
  // NOTE: the read MUST stay a plain `env.RSS_MAX_FEEDS_PER_COMMUNITY` dot
  // access — test/env-parity.test.js's `env.NAME` scan pattern does not
  // match optional chaining, and a silent scan miss diverges the pin.
  const raw = Number(String(env.RSS_MAX_FEEDS_PER_COMMUNITY ?? "").trim());
  return Number.isFinite(raw) && raw >= 1
    ? Math.floor(raw)
    : DEFAULT_MAX_FEEDS_PER_COMMUNITY;
}

/**
 * Lazy facade default (call-time require, poller.js idiom): keeps this unit
 * loadable before the db layer binds and lets the loadDb() test harness's
 * cache reset rebind it cleanly.
 */
function defaultDb() {
  return require("../../db");
}

let defaultParser = null;

/** Single shared rss-parser instance (stateless for parseString). Mirrors
 * poller.js's getDefaultParser — rss-parser 3.13.0 exposes `parseString`
 * (verified against the installed copy by subtask 06). */
function getDefaultParser() {
  if (!defaultParser) {
    const Parser = require("rss-parser");
    defaultParser = new Parser();
  }
  return defaultParser;
}

/** Parse seam identical to poller.js's parseFeedText (parseString for the
 * real package, parseFromString accepted for doubles/future majors). */
function parseFeedText(parser, text) {
  if (typeof parser.parseString === "function") return parser.parseString(text);
  if (typeof parser.parseFromString === "function") {
    return parser.parseFromString(text);
  }
  return Promise.reject(
    new Error("parser seam offers neither parseString nor parseFromString"),
  );
}

/** rss-parser answers in `items`; `entries` rides some doubles/docs. */
function feedEntriesFrom(feed) {
  if (Array.isArray(feed?.items)) return feed.items;
  if (Array.isArray(feed?.entries)) return feed.entries;
  return [];
}

function trimOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

/** The standing config gate BOTH /rss add and /rss test enforce up front
 * (subtask 07 AC: "unset notify channel surfaces as an actionable error").
 * The poller's refused-config outcome covers the tick; here staff gets the
 * fix in the reply, not a silent idle subscription. */
const NO_CHANNEL_ERROR =
  "no RSS notification channel is set — set one with /setrss channel first";

function channelGate(settings) {
  const channelId = trimOrNull(settings?.rss_notification_channel_id);
  return channelId
    ? { channelId, refusal: null }
    : { channelId: null, refusal: NO_CHANNEL_ERROR };
}

/**
 * Newest entry by publication time (testPostLatest's pick). Reuses
 * feedState.resolveEntryPublishedMs — the same publication-time derivation
 * the dedupe/window math runs on — so the test posts exactly what the
 * poller would consider the freshest item.
 */
function latestEntry(items, now) {
  let best = null;
  let bestMs = -Infinity;
  for (const entry of items) {
    const ms = resolveEntryPublishedMs(entry, now);
    if (ms > bestMs) {
      best = entry;
      bestMs = ms;
    }
  }
  return best;
}

/** Reply-safe one-line label for an entry (format.js neutralization, then a
 * reply-line clamp below the embed-title cap). */
function entryLabel(entry, fallbackUrl) {
  const raw = trimOrNull(entry?.title) || trimOrNull(entry?.link) || String(fallbackUrl ?? "");
  const safe = neutralizeRichText(raw);
  const chars = Array.from(safe);
  const max = Math.min(80, RSS_TITLE_MAX_LENGTH);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : safe;
}

/**
 * Subscribe: channel gate → cap → validateFeedUrl (scheme + add-time SSRF)
 * → guarded fetch (≤1 MiB) → rss-parser parse → ≥1 item → resolve stored
 * feed_title/feed_link → repository insert (duplicate = refusal via the
 * repo's documented null return).
 *
 * @param {{
 *   communityId: number,
 *   rawUrl: string,
 *   displayName?: string|null,
 *   addedBy?: string|null,
 *   settings?: object,
 *   db?: object,
 *   env?: Record<string,string|undefined>,
 *   fetchImpl?: Function,   // transport seam → guardedFetchForFeed (tests)
 *   resolveHost?: Function, // DNS seam (tests + private-address refusal)
 *   parser?: object,        // rss-parser seam (tests)
 * }} params
 * @returns {Promise<{ ok: true, feed: object, settings: object, cap: number }
 *   | { ok: false, error: string }>}
 */
async function addFeed({
  communityId,
  rawUrl,
  displayName = null,
  addedBy = null,
  settings,
  db = defaultDb(),
  env = process.env,
  fetchImpl,
  resolveHost,
  parser,
} = {}) {
  try {
    const rowSettings = settings ?? db.getGuildSettings(communityId);

    // Standing config gate FIRST (cheap, and it is the actionable one).
    const gate = channelGate(rowSettings);
    if (gate.refusal) return { ok: false, error: gate.refusal };

    // Cap BEFORE the network: an over-cap community learns about the cap
    // without anyone's feed host being polled.
    const cap = maxFeedsPerCommunity(env);
    const count = db.countRssFeedsForCommunity(communityId);
    if (count >= cap) {
      return {
        ok: false,
        error:
          `this community already has ${count} RSS feeds and the cap is ${cap} ` +
          `(RSS_MAX_FEEDS_PER_COMMUNITY) — remove one with /rss remove first`,
      };
    }

    // Add-time URL gate (scheme, shape, SSRF class-check). The reason is the
    // guard's own wording — rule 3: the staff reply carries the CAUSE.
    const valid = await validateFeedUrl(rawUrl, { resolveHost });
    if (!valid.ok) return { ok: false, error: valid.reason };

    // Prove the URL is a subscribable FEED now (spec: scheme, SSRF, parses,
    // ≥1 item) — a stored row that can never post is a silent-drop factory.
    const fetched = await guardedFetchForFeed(valid.url, { fetchImpl, resolveHost });
    if (!fetched.ok) {
      return { ok: false, error: `could not fetch the feed: ${fetched.reason}` };
    }
    if (fetched.notModified) {
      // No conditional headers were sent — a 304 here is a broken host.
      return {
        ok: false,
        error: "feed server answered HTTP 304 to a first fetch — try again",
      };
    }

    let feed;
    try {
      feed = await parseFeedText(parser ?? getDefaultParser(), fetched.text);
    } catch (err) {
      return {
        ok: false,
        error: `could not parse the feed: ${String(err?.message || err)}`,
      };
    }
    const items = feedEntriesFrom(feed);
    if (!items.length) {
      return {
        ok: false,
        error: "the feed has no items yet — refusing to subscribe to an empty feed",
      };
    }

    // Null = the repository's documented duplicate refusal (INSERT guard on
    // the same (community, url)); a THROW here is a real DB failure and
    // lands on the catch below with its cause.
    const feedRow = db.addRssFeed(communityId, valid.url, {
      displayName: trimOrNull(displayName),
      feedTitle: trimOrNull(feed?.title),
      feedLink: trimOrNull(feed?.link),
      addedBy: trimOrNull(addedBy),
    });
    if (!feedRow) {
      return {
        ok: false,
        error: "already subscribed to this feed — /rss remove it first to re-subscribe",
      };
    }

    return { ok: true, feed: feedRow, settings: rowSettings, cap };
  } catch (err) {
    // Never-throw contract (error law #6): even a throwing seam lands here.
    const cause = String(err?.message || err);
    console.error(
      `[rss] addFeed unexpected failure (community=${communityId}):`,
      cause,
    );
    return { ok: false, error: `unexpected add failure: ${cause}` };
  }
}

/**
 * Unsubscribe (seen-set cleanup is the repository's own removeFeed contract).
 * Returns the removed row so the handler can name it in the reply + audit.
 *
 * @returns {Promise<{ ok: true, feed: object } | { ok: false, error: string }>}
 */
async function removeFeed({ communityId, url, db = defaultDb() } = {}) {
  try {
    const row = db.getRssFeed(communityId, url);
    if (!row) {
      return {
        ok: false,
        error: "no subscription found for that feed — check /rss list",
      };
    }
    const removed = db.removeRssFeed(communityId, url);
    if (!removed) {
      // Raced with a concurrent remove (community teardown?) — honest state.
      return {
        ok: false,
        error: "the subscription was already removed (concurrent change) — check /rss list",
      };
    }
    return { ok: true, feed: row };
  } catch (err) {
    const cause = String(err?.message || err);
    console.error(
      `[rss] removeFeed unexpected failure (community=${communityId}):`,
      cause,
    );
    return { ok: false, error: `unexpected remove failure: ${cause}` };
  }
}

/**
 * List: the community's feeds (created_at ASC, repository order) + settings
 * + the cap the count is shown against (RSS_MAX_FEEDS_PER_COMMUNITY aware).
 *
 * @returns {Promise<{ ok: true, feeds: object[], settings: object, cap: number }
 *   | { ok: false, error: string }>}
 */
async function listFeeds({
  communityId,
  db = defaultDb(),
  env = process.env,
} = {}) {
  try {
    return {
      ok: true,
      feeds: db.listRssFeedsForCommunity(communityId),
      settings: db.getGuildSettings(communityId),
      cap: maxFeedsPerCommunity(env),
    };
  } catch (err) {
    const cause = String(err?.message || err);
    console.error(
      `[rss] listFeeds unexpected failure (community=${communityId}):`,
      cause,
    );
    return { ok: false, error: `unexpected list failure: ${cause}` };
  }
}

/**
 * `/rss test`: fetch now and post the LATEST entry to the notify channel as
 * a one-off diagnostic (mirrors /testnotification). Side-effect-free BY
 * DESIGN — no seen-set claim, no watermark, no failure counter (see the
 * module header for why pollFeedRow would be the wrong reuse here). Format
 * and allowedMentions come from format.buildNotification verbatim — the same
 * composition the poller performs for a real send.
 *
 * @param {{
 *   communityId: number,
 *   feed: object,                 // stored rss_feeds row (handler-resolved)
 *   outbound: object|null,        // OutboundClient (commandCtx.outbound)
 *   settings?: object,
 *   db?: object,
 *   parser?: object,
 *   fetchImpl?: Function,
 *   resolveHost?: Function,
 *   now?: number,
 * }} params
 * @returns {Promise<{ ok: true, channelId: string, feed: object, entryLabel: string }
 *   | { ok: false, error: string }>}
 */
async function testPostLatest({
  communityId,
  feed,
  outbound,
  settings,
  db = defaultDb(),
  parser,
  fetchImpl,
  resolveHost,
  now,
} = {}) {
  try {
    if (!feed || !feed.url) {
      return { ok: false, error: "no stored feed row to test" };
    }
    const rowSettings = settings ?? db.getGuildSettings(communityId);
    const gate = channelGate(rowSettings);
    if (gate.refusal) return { ok: false, error: gate.refusal };

    if (!outbound || typeof outbound.sendChannel !== "function") {
      return {
        ok: false,
        error: "this community's platform client is not connected yet — try again once the bot is online",
      };
    }

    const fetched = await guardedFetchForFeed(feed.url, { fetchImpl, resolveHost });
    if (!fetched.ok) {
      return { ok: false, error: `could not fetch the feed: ${fetched.reason}` };
    }
    if (fetched.notModified) {
      return {
        ok: false,
        error: "feed server answered HTTP 304 to a fresh fetch — nothing to post",
      };
    }

    let parsed;
    try {
      parsed = await parseFeedText(parser ?? getDefaultParser(), fetched.text);
    } catch (err) {
      return {
        ok: false,
        error: `could not parse the feed: ${String(err?.message || err)}`,
      };
    }
    const items = feedEntriesFrom(parsed);
    if (!items.length) {
      return { ok: false, error: "the feed has no items to announce" };
    }

    const entry = latestEntry(items, now ?? Date.now());
    const payload = buildNotification(entry, feed, {
      channelId: gate.channelId,
      notifyRoleId: rowSettings.rss_notify_role_id,
    });
    if (!payload) {
      // HEADLINE RULE (format.js): no title AND no permalink = unannounceable.
      return {
        ok: false,
        error: "the latest entry has neither a title nor a link — nothing announceable to post",
      };
    }

    try {
      const sent = await outbound.sendChannel(gate.channelId, payload);
      if (!sent || sent.ok !== true) {
        throw new Error(sent?.error || "sendChannel returned no result");
      }
    } catch (err) {
      const cause = String(err?.message || err);
      console.error(
        `[rss] /rss test send failed (community=${communityId} url=${feed.url}): ${cause}`,
      );
      return { ok: false, error: `could not post the test notification: ${cause}` };
    }

    return {
      ok: true,
      channelId: gate.channelId,
      feed,
      entryLabel: entryLabel(entry, feed.url),
    };
  } catch (err) {
    const cause = String(err?.message || err);
    console.error(
      `[rss] testPostLatest unexpected failure (community=${communityId}):`,
      cause,
    );
    return { ok: false, error: `unexpected test failure: ${cause}` };
  }
}

/**
 * `/rss check`: force ONE real poll of a stored row NOW — the live-
 * verification analogue of the tick. Direct pollFeedRow reuse with
 * `force: true` (the export's actual gate-bypass flag: skips the
 * interval/backoff clock gate ONLY; the config + client gates stay enforced
 * inside). Returns pollFeedRow's own result shape (already a never-throw
 * { ok, outcome, posted, skipped, error? } box) so the handler can map every
 * outcome; `refused-config` gains the actionable cause.
 *
 * @returns {Promise<{ ok: boolean, outcome: string, posted: number, skipped: number, error?: string }>}
 */
async function forcePoll({
  feed,
  settings,
  outbound,
  db = defaultDb(),
  parser,
  fetchImpl,
  resolveHost,
  now,
} = {}) {
  try {
    if (!feed || !feed.url) {
      return {
        ok: false,
        outcome: "error",
        posted: 0,
        skipped: 0,
        error: "no stored feed row to poll",
      };
    }
    const res = await pollFeedRow({
      row: feed,
      settings: settings ?? db.getGuildSettings(feed.community_id),
      db,
      parser,
      fetchImpl,
      resolveHost,
      now,
      outbound,
      force: true,
    });
    if (res.outcome === "refused-config" && !res.error) {
      return { ...res, error: NO_CHANNEL_ERROR };
    }
    return res;
  } catch (err) {
    // pollFeedRow never throws; this net covers a throwing seam ABOVE it
    // (e.g. the settings read) with the same result shape.
    const cause = String(err?.message || err);
    console.error(
      `[rss] forcePoll unexpected failure (url=${feed?.url ?? "?"}):`,
      cause,
    );
    return {
      ok: false,
      outcome: "error",
      posted: 0,
      skipped: 0,
      error: `unexpected poll failure: ${cause}`,
    };
  }
}

module.exports = {
  DEFAULT_MAX_FEEDS_PER_COMMUNITY,
  NO_CHANNEL_ERROR,
  DEFAULT_RSS_POLL_INTERVAL_MINUTES,
  maxFeedsPerCommunity,
  addFeed,
  removeFeed,
  listFeeds,
  testPostLatest,
  forcePoll,
};
