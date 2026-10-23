const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");

/**
 * Repository section for RSS feed notifications (issue #305, subtask 02):
 * src/db/repositories/rss.js against a real migrated SQLite, plus the
 * guildSettings whitelist trio from migration 064. Feature-layer behavior
 * (SSRF validation, ticker gating, embed shapes) lives in the sibling test
 * files; this file carries the DB layer plus — appended below — the PURE
 * feed-state unit section for src/features/rss/feedState.js (subtask 04)
 * and the notification-format unit for src/features/rss/format.js
 * (subtask 05), neither of which needs a DB at all.
 */
describe("rss repository", () => {
  let api;
  let cleanup;

  before(() => {
    // Contract: loadDb() must run before any `src/` require in this file —
    // fresh temp DB_PATH + src require-cache reset, never the project-root DB.
    ({ api, cleanup } = loadDb());
  });

  after(() => cleanup?.());

  const URL_A = "https://example.com/feed.xml";
  const URL_B = "https://blog.example.org/rss";

  // -------------------------------------------------------------------------
  // Feed CRUD + cap count
  // -------------------------------------------------------------------------

  it("addFeed stores the row with defaults (NULL watermarks, failure_count 0)", () => {
    const cid = communityKey("rss-add");
    const row = api.addRssFeed(cid, " https://example.com/feed.xml ", {
      displayName: "Example News",
      feedTitle: "Example Feed",
      feedLink: "https://example.com",
      addedBy: "123456789012345678",
    });
    assert.ok(row, "insert returns the stored row");
    assert.equal(row.url, URL_A, "url trimmed but stored verbatim (PK is case-sensitive)");
    assert.equal(row.display_name, "Example News");
    assert.equal(row.feed_title, "Example Feed");
    assert.equal(row.feed_link, "https://example.com");
    assert.equal(row.added_by, "123456789012345678");
    assert.equal(row.etag, null);
    assert.equal(row.last_modified, null);
    assert.equal(row.last_entry_key, null);
    assert.equal(row.last_checked, null);
    assert.equal(row.failure_count, 0, "failure_count starts at the schema default 0");
    assert.ok(Number.isInteger(row.created_at) && Number.isInteger(row.updated_at));
  });

  it("re-adding the same (community, url) is refused with null; another community may take the URL", () => {
    const cid = communityKey("rss-dupe");
    const other = communityKey("rss-dupe-other");
    assert.ok(api.addRssFeed(cid, URL_A, {}));
    assert.equal(api.addRssFeed(cid, URL_A, {}), null, "duplicate is a REFUSAL, not an upsert");
    assert.equal(api.countRssFeedsForCommunity(cid), 1, "duplicate did not insert");

    const row2 = api.addRssFeed(other, URL_A, { displayName: "Same feed, other guild" });
    assert.ok(row2, "the same URL in another community is an independent row");
    assert.equal(api.countRssFeedsForCommunity(other), 1);
  });

  it("countFeedsForCommunity counts per community only (cap-check input)", () => {
    const cid = communityKey("rss-cap");
    const other = communityKey("rss-cap-other");
    api.addRssFeed(cid, URL_A, {});
    api.addRssFeed(cid, URL_B, {});
    api.addRssFeed(other, URL_B, {});
    assert.equal(api.countRssFeedsForCommunity(cid), 2);
    assert.equal(api.countRssFeedsForCommunity(other), 1);
    assert.equal(api.countRssFeedsForCommunity(communityKey("rss-cap-none")), 0);
  });

  it("getFeed / feedExists are community-scoped", () => {
    const cid = communityKey("rss-scope");
    const other = communityKey("rss-scope-other");
    api.addRssFeed(cid, URL_A, {});
    assert.ok(api.getRssFeed(cid, URL_A));
    assert.equal(api.rssFeedExists(cid, URL_A), true);
    assert.equal(api.getRssFeed(cid, "https://never-added.example/feed"), null);
    assert.equal(api.rssFeedExists(cid, URL_B), false);
    assert.equal(api.getRssFeed(other, URL_A), null, "invisible from another community");
    assert.equal(api.removeRssFeed(other, URL_A), false, "not deletable from another community");
    assert.equal(api.getRssFeed(cid, URL_A) !== null, true, "still present after the foreign miss");
  });

  it("listFeedsForCommunity / listAllRssFeeds read back subscriptions (single ticker query)", () => {
    const cid = communityKey("rss-list");
    const other = communityKey("rss-list-other");
    api.addRssFeed(cid, URL_A, { displayName: "A" });
    api.addRssFeed(cid, URL_B, { displayName: "B" });
    api.addRssFeed(other, URL_A, { displayName: "A2" });

    const mine = api.listRssFeedsForCommunity(cid);
    assert.deepEqual(mine.map((r) => r.url).sort(), [URL_A, URL_B].sort());
    assert.ok(mine.every((r) => r.community_id === cid));

    // The ticker's ONE query across every community — must carry both rows
    // (the per-community interval gate runs in the caller, youtube shape).
    const all = api.listAllRssFeeds();
    assert.ok(all.length >= 3);
    assert.ok(all.some((r) => r.community_id === cid && r.url === URL_A));
    assert.ok(all.some((r) => r.community_id === other && r.url === URL_A));

    assert.deepEqual(
      api.listRssFeedsForCommunity(communityKey("rss-list-none")),
      [],
      "empty community reads as []",
    );
  });

  it("removeFeed deletes the feed AND its seen rows (child-then-parent), reports true/false", () => {
    const cid = communityKey("rss-remove");
    api.addRssFeed(cid, URL_A, {});
    api.addRssFeed(cid, URL_B, {});
    api.addRssSeenEntry(cid, URL_A, "post-1");
    api.addRssSeenEntry(cid, URL_A, "post-2");
    api.addRssSeenEntry(cid, URL_B, "other-feed-post");

    assert.equal(api.removeRssFeed(cid, URL_A), true, "first remove lands");
    assert.equal(api.getRssFeed(cid, URL_A), null);
    assert.deepEqual(
      api.listRssSeenKeysForFeed(cid, URL_A),
      [],
      "seen rows die with the feed (no FK path — explicit child delete)",
    );
    assert.equal(api.removeRssFeed(cid, URL_A), false, "second remove is a no-op");
    assert.deepEqual(
      api.listRssSeenKeysForFeed(cid, URL_B),
      ["other-feed-post"],
      "other feeds untouched",
    );
  });

  // -------------------------------------------------------------------------
  // Watermark / fetch-state / failure counter
  // -------------------------------------------------------------------------

  it("updateFeedWatermark round-trips validators + watermark and honors tri-state fields", () => {
    const cid = communityKey("rss-wm");
    api.addRssFeed(cid, URL_A, {});

    api.updateRssFeedWatermark(cid, URL_A, {
      etag: 'W/"abc123"',
      lastModified: "Wed, 22 Oct 2026 10:00:00 GMT",
      lastEntryKey: "https://example.com/post-9",
      lastChecked: 1761100000000,
    });
    let row = api.getRssFeed(cid, URL_A);
    assert.equal(row.etag, 'W/"abc123"');
    assert.equal(row.last_modified, "Wed, 22 Oct 2026 10:00:00 GMT");
    assert.equal(row.last_entry_key, "https://example.com/post-9");
    assert.equal(row.last_checked, 1761100000000);

    // undefined fields are LEFT ALONE — the spec's 304 path advances the
    // clock only and must not blank the validators.
    api.updateRssFeedWatermark(cid, URL_A, { lastChecked: 1761100600000 });
    row = api.getRssFeed(cid, URL_A);
    assert.equal(row.etag, 'W/"abc123"', "304-style clock bump keeps validators");
    assert.equal(row.last_entry_key, "https://example.com/post-9");
    assert.equal(row.last_checked, 1761100600000);

    // explicit null CLEARS (a validator the server stopped sending is gone)
    api.updateRssFeedWatermark(cid, URL_A, { etag: null });
    assert.equal(api.getRssFeed(cid, URL_A).etag, null, "null clears the column");

    // no-op patch returns the row without a write and never throws
    const same = api.updateRssFeedWatermark(cid, URL_A, {});
    assert.equal(same.last_checked, 1761100600000);
    assert.equal(
      api.updateRssFeedWatermark(cid, "https://gone.example/feed", { etag: "x" }),
      null,
      "unknown feed reads back null",
    );
  });

  it("recordFeedFailure increments + stamps the clock; recordFeedSuccess resets to 0", () => {
    const cid = communityKey("rss-fail");
    api.addRssFeed(cid, URL_A, {});
    api.updateRssFeedWatermark(cid, URL_A, { etag: "keep-me", lastEntryKey: "k1" });

    let row = api.recordRssFeedFailure(cid, URL_A, { lastChecked: 111 });
    assert.equal(row.failure_count, 1);
    assert.equal(row.last_checked, 111, "failure stamps the retry gate clock");
    api.recordRssFeedFailure(cid, URL_A, { lastChecked: 222 });
    row = api.getRssFeed(cid, URL_A);
    assert.equal(row.failure_count, 2, "consecutive failures accumulate (backoff math input)");
    assert.equal(row.etag, "keep-me", "a failed fetch invalidates nothing");
    assert.equal(row.last_entry_key, "k1");

    row = api.recordRssFeedSuccess(cid, URL_A, { lastChecked: 333 });
    assert.equal(row.failure_count, 0, "success resets the backoff counter");
    assert.equal(row.last_checked, 333);

    // success without an explicit clock stamps a real one (gate always moves)
    row = api.recordRssFeedSuccess(cid, URL_A);
    assert.ok(row.last_checked >= 333);
    assert.equal(row.etag, "keep-me", "success alone never blanks validators");

    assert.equal(api.recordRssFeedFailure(cid, "https://gone.example/feed"), null);
    assert.equal(api.recordRssFeedSuccess(cid, "https://gone.example/feed"), null);
  });

  it("recordFeedSuccess can advance validators + watermark in the same write", () => {
    const cid = communityKey("rss-success-patch");
    api.addRssFeed(cid, URL_A, {});
    api.recordRssFeedFailure(cid, URL_A);

    const row = api.recordRssFeedSuccess(cid, URL_A, {
      etag: "etag-2",
      lastModified: "Thu, 23 Oct 2026 08:00:00 GMT",
      lastEntryKey: "post-42",
    });
    assert.equal(row.failure_count, 0);
    assert.equal(row.etag, "etag-2");
    assert.equal(row.last_modified, "Thu, 23 Oct 2026 08:00:00 GMT");
    assert.equal(row.last_entry_key, "post-42");
    assert.ok(Number.isInteger(row.last_checked), "poll clock stamped by default");
  });

  // -------------------------------------------------------------------------
  // Bounded per-feed seen-set
  // -------------------------------------------------------------------------

  it("addSeenEntry is idempotent (INSERT OR IGNORE) and reports first-insert", () => {
    const cid = communityKey("rss-seen-idem");
    assert.equal(api.addRssSeenEntry(cid, URL_A, "post-1"), true, "first mark inserts");
    assert.equal(api.addRssSeenEntry(cid, URL_A, "post-1"), false, "replay is a no-op, no throw");
    assert.equal(api.isRssSeen(cid, URL_A, "post-1"), true);
    assert.equal(api.isRssSeen(cid, URL_A, "post-x"), false);
    assert.deepEqual(api.listRssSeenKeysForFeed(cid, URL_A), ["post-1"]);
  });

  it("seen-set is scoped per (community, feed)", () => {
    const cid = communityKey("rss-seen-scope");
    const other = communityKey("rss-seen-scope-other");
    api.addRssSeenEntry(cid, URL_A, "shared-key");
    api.addRssSeenEntry(cid, URL_B, "b-only");

    assert.equal(api.isRssSeen(cid, URL_B, "shared-key"), false, "other feed cannot see it");
    assert.equal(api.isRssSeen(other, URL_A, "shared-key"), false, "other community cannot see it");
    assert.equal(api.addRssSeenEntry(other, URL_A, "shared-key"), true, "same key, own row");
    assert.deepEqual(api.listRssSeenKeysForFeed(cid, URL_A).sort(), ["shared-key"]);
    assert.deepEqual(api.listRssSeenKeysForFeed(other, URL_A).sort(), ["shared-key"]);
  });

  it("pruneSeenForFeed keeps the newest ~100 by seen_at, only for THAT feed", () => {
    const cid = communityKey("rss-prune");
    const total = 130;
    for (let i = 0; i < total; i++) {
      api.addRssSeenEntry(cid, URL_A, `k${String(i).padStart(3, "0")}`, 1_000_000 + i);
    }
    api.addRssSeenEntry(cid, URL_B, "neighbor", 1); // must survive untouched

    assert.equal(api.pruneRssSeenForFeed(cid, URL_A, 100), 30, "deletes exactly the excess");
    const kept = api.listRssSeenKeysForFeed(cid, URL_A);
    assert.equal(kept.length, 100);
    assert.equal(kept[0], "k030", "oldest survivors are the NEWEST 100");
    assert.equal(kept.at(-1), "k129");
    assert.ok(!kept.includes("k000"), "oldest rows are the first to go");
    assert.deepEqual(api.listRssSeenKeysForFeed(cid, URL_B), ["neighbor"]);

    assert.equal(api.pruneRssSeenForFeed(cid, URL_A, 100), 0, "at-cap prune is a no-op");
    assert.equal(api.pruneRssSeenForFeed(cid, URL_A, 200), 0, "over-cap prune is a no-op");
    assert.equal(api.pruneRssSeenForFeed(cid, "https://never.example/feed", 10), 0);

    // default cap rides on SEEN_CAP (100)
    for (let i = 0; i < 5; i++) {
      api.addRssSeenEntry(cid, URL_A, `extra-${i}`, 2_000_000 + i);
    }
    assert.equal(api.pruneRssSeenForFeed(cid, URL_A), 5, "default cap = RSS_SEEN_CAP");
    assert.equal(api.listRssSeenKeysForFeed(cid, URL_A).length, api.RSS_SEEN_CAP);
  });

  it("clearSeenForFeed empties one feed's set and reports the count", () => {
    const cid = communityKey("rss-seen-clear");
    api.addRssSeenEntry(cid, URL_A, "a1");
    api.addRssSeenEntry(cid, URL_A, "a2");
    api.addRssSeenEntry(cid, URL_B, "b1");
    assert.equal(api.clearRssSeenForFeed(cid, URL_A), 2);
    assert.deepEqual(api.listRssSeenKeysForFeed(cid, URL_A), []);
    assert.equal(api.clearRssSeenForFeed(cid, URL_A), 0, "second clear is a no-op");
    assert.deepEqual(api.listRssSeenKeysForFeed(cid, URL_B), ["b1"]);
  });

  it("garbage url / entry key fail fast instead of poisoning the PK", () => {
    const cid = communityKey("rss-garbage");
    assert.throws(() => api.addRssFeed(cid, "   "), /url required/);
    assert.throws(() => api.addRssSeenEntry(cid, URL_A, ""), /entry key required/);
    assert.throws(() => api.isRssSeen(cid, "", "k"), /url required/);
  });

  // -------------------------------------------------------------------------
  // Community cascade (migrations 062/063 declare real ON DELETE CASCADE)
  // -------------------------------------------------------------------------

  it("deleting a community cascades away its rss_feeds AND rss_seen rows", () => {
    const cid = communityKey("rss-cascade");
    const keep = communityKey("rss-cascade-keep");
    api.addRssFeed(cid, URL_A, {});
    api.addRssFeed(cid, URL_B, {});
    api.addRssSeenEntry(cid, URL_A, "doomed-1");
    api.addRssSeenEntry(cid, URL_A, "doomed-2");
    api.addRssFeed(keep, URL_A, {});
    api.addRssSeenEntry(keep, URL_A, "survivor");

    api.db.prepare("DELETE FROM communities WHERE id=?").run(cid);

    assert.equal(api.countRssFeedsForCommunity(cid), 0, "feeds cascaded");
    const seenLeft = api.db
      .prepare("SELECT COUNT(*) AS n FROM rss_seen WHERE community_id=?")
      .get(cid).n;
    assert.equal(seenLeft, 0, "seen rows cascaded");
    assert.equal(api.countRssFeedsForCommunity(keep), 1, "other community untouched");
    assert.deepEqual(api.listRssSeenKeysForFeed(keep, URL_A), ["survivor"]);
  });

  // -------------------------------------------------------------------------
  // guildSettings whitelist trio (migration 064)
  // -------------------------------------------------------------------------

  describe("guild_settings rss_* trio", () => {
    it("defaults on a fresh row: null channel, null role, interval 15", () => {
      const settings = api.getGuildSettings(communityKey("rss-settings-defaults"));
      assert.equal(settings.rss_notification_channel_id, null);
      assert.equal(settings.rss_notify_role_id, null);
      assert.equal(
        settings.rss_polling_interval_minutes,
        15,
        "schema DEFAULT 15 (youtube/twitch twin semantics)",
      );
    });

    it("whitelist registers the trio for set + round-trip, and null clears channel/role", () => {
      const cid = communityKey("rss-settings-roundtrip");
      const updated = api.updateGuildSettings(cid, {
        rss_notification_channel_id: "500000000000000001",
        rss_notify_role_id: "500000000000000002",
        rss_polling_interval_minutes: 30,
      });
      assert.equal(updated.rss_notification_channel_id, "500000000000000001");
      assert.equal(updated.rss_notify_role_id, "500000000000000002");
      assert.equal(updated.rss_polling_interval_minutes, 30);

      const cleared = api.updateGuildSettings(cid, {
        rss_notification_channel_id: null,
        rss_notify_role_id: null,
      });
      assert.equal(cleared.rss_notification_channel_id, null, "unset → no mention, no fallback");
      assert.equal(cleared.rss_notify_role_id, null);
      assert.equal(cleared.rss_polling_interval_minutes, 30, "interval survives unrelated writes");
    });

    it("non-whitelisted rss_* keys are dropped (whitelist is the write gate)", () => {
      const cid = communityKey("rss-settings-whitelist");
      const row = api.updateGuildSettings(cid, {
        rss_notification_channel_id: "500000000000000009",
        rss_bogus_column: "nope",
      });
      assert.equal(row.rss_notification_channel_id, "500000000000000009");
      assert.equal("rss_bogus_column" in row, false, "unknown key never reaches the row");
    });
  });
});

// ===========================================================================
// Pure feed-state unit (issue #305, subtask 04): src/features/rss/feedState.js
// — entry keys, seen-set partitioning + first-hour window, backoff math,
// interval gate. NO DB involved: every rule takes plain injected values, so
// this section needs no loadDb() contract. Requiring feedState at file-load
// time is guard-safe (it pulls node:crypto and nothing else from src/).
// ===========================================================================

const feedState = require("../src/features/rss/feedState");

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 1_761_200_000_000; // fixed clock — every window boundary below is exact
// rss-parser hands back RFC strings; NOW and every offset below are whole
// seconds, so the toUTCString round-trip is lossless (no ms drift at edges).
const iso = (ms) => new Date(ms).toUTCString();

describe("rss feedState — deriveEntryKey", () => {
  it("prefers guid, falls back to Atom id, then the permalink link", () => {
    assert.equal(
      feedState.deriveEntryKey({
        guid: "urn:uuid:abc",
        id: "atom-id-1",
        link: "https://example.com/post-1",
      }),
      "urn:uuid:abc",
      "guid wins when every stable id is present",
    );
    assert.equal(
      feedState.deriveEntryKey({ id: "atom-id-1", link: "https://example.com/post-1" }),
      "atom-id-1",
    );
    assert.equal(
      feedState.deriveEntryKey({ link: "https://example.com/post-1" }),
      "https://example.com/post-1",
      "permalink fallback for feeds with no stable ids",
    );
  });

  it("trims key candidates and lets blank ids fall through", () => {
    assert.equal(
      feedState.deriveEntryKey({ guid: "  \t ", id: " real-id ", link: "https://x.example/" }),
      "real-id",
      "a whitespace-only guid is no id at all",
    );
  });

  it("hashes very long keys to a stable sha256 digest; <= threshold stays verbatim", () => {
    const base = "https://example.com/very/long/";
    const atLimit = base + "x".repeat(feedState.RSS_LONG_KEY_LENGTH - base.length);
    assert.equal(atLimit.length, feedState.RSS_LONG_KEY_LENGTH);
    assert.equal(
      feedState.deriveEntryKey({ link: atLimit }),
      atLimit,
      "keys at the threshold stay address-shaped",
    );

    const overLimit = atLimit + "y";
    const key = feedState.deriveEntryKey({ link: overLimit });
    assert.match(key, /^sha256:[0-9a-f]{64}$/, "over-long links digest");
    assert.equal(key, feedState.deriveEntryKey({ link: overLimit }), "digest is deterministic");
    assert.notEqual(
      key,
      feedState.deriveEntryKey({ link: overLimit + "z" }),
      "different links hash apart",
    );
  });

  it("keys are stable across missing pubDate and reordered/rebuilt entries", () => {
    const entry = { guid: "g-1", link: "https://example.com/p", title: "A" };
    const rebuilt = { title: "A", link: "https://example.com/p", guid: "g-1" }; // fields reshuffled, no pubDate
    assert.equal(
      feedState.deriveEntryKey(entry),
      feedState.deriveEntryKey(rebuilt),
      "field order never leaks into the key",
    );
    assert.equal(
      feedState.deriveEntryKey({ ...entry, pubDate: iso(NOW) }),
      "g-1",
      "the key never depends on pubDate",
    );
  });

  it("returns null for entries with no guid, no id and no link", () => {
    assert.equal(feedState.deriveEntryKey({ title: "identity-less" }), null);
    assert.equal(feedState.deriveEntryKey({ guid: "", id: null, link: undefined }), null);
    assert.equal(feedState.deriveEntryKey(null), null);
    assert.equal(feedState.deriveEntryKey(undefined), null);
  });
});

describe("rss feedState — resolveEntryPublishedMs", () => {
  it("pubDate wins; isoDate is the parser fallback", () => {
    assert.equal(feedState.resolveEntryPublishedMs({ pubDate: iso(NOW - MIN) }, NOW), NOW - MIN);
    assert.equal(
      feedState.resolveEntryPublishedMs({ isoDate: new Date(NOW - 2 * MIN).toISOString() }, NOW),
      NOW - 2 * MIN,
    );
    assert.equal(
      feedState.resolveEntryPublishedMs({ pubDate: iso(NOW), isoDate: iso(NOW - 10 * MIN) }, NOW),
      NOW,
      "pubDate is checked first",
    );
  });

  it("missing or unparseable dates fall back to the injected now (youtube Date.now() mirror)", () => {
    assert.equal(feedState.resolveEntryPublishedMs({ title: "no dates" }, NOW), NOW);
    assert.equal(feedState.resolveEntryPublishedMs({ pubDate: "not a date", isoDate: "nope" }, NOW), NOW);
    assert.equal(feedState.resolveEntryPublishedMs(null, NOW), NOW);
  });
});

describe("rss feedState — partitionEntries (first-poll window + seen-set)", () => {
  const feedEntry = (guid, ageMinutes) => ({
    guid,
    link: `https://example.com/${guid}`,
    pubDate: iso(NOW - ageMinutes * MIN),
  });

  it("first poll posts the last hour only: 59m posts, 60m and 61m seed silently", () => {
    const result = feedState.partitionEntries({
      entries: [feedEntry("fresh-59", 59), feedEntry("edge-60", 60), feedEntry("stale-61", 61)],
      seenKeys: [],
      lastChecked: null,
      now: NOW,
    });
    assert.deepEqual(result.toPost.map((i) => i.key), ["fresh-59"]);
    assert.deepEqual(
      result.toSeed.map((i) => i.key),
      ["stale-61", "edge-60"],
      "youtube's `published <= oneHourAgo → skip` mirror: exactly-one-hour seeds silently, and seeds sort oldest-first",
    );
    assert.equal(result.skippedSeen, 0);
    assert.equal(result.skippedUnkeyed, 0);
  });

  it("first poll: date-less entries count as fresh (mirrors youtube extractVideoInfo)", () => {
    const result = feedState.partitionEntries({
      entries: [{ guid: "no-date", link: "https://example.com/nd" }, feedEntry("stale-90", 90)],
      seenKeys: [],
      lastChecked: null,
      now: NOW,
    });
    assert.deepEqual(
      result.toPost.map((i) => i.key),
      ["no-date"],
      "SPEC CHOICE: a missing pubDate resolves to `now` (youtube fallback), so the entry posts once — the seen-set makes that safe",
    );
    assert.deepEqual(result.toSeed.map((i) => i.key), ["stale-90"]);
  });

  it("later polls gate on the watermark: newer posts, unseen-but-stale seeds", () => {
    const result = feedState.partitionEntries({
      entries: [
        feedEntry("after-wm", 5), // published after last_checked → post
        feedEntry("at-wm", 10), // published exactly AT last_checked → seed (`<=` mirror)
        feedEntry("before-wm", 20), // older than the watermark → seed
      ],
      seenKeys: [],
      lastChecked: NOW - 10 * MIN,
      now: NOW,
    });
    assert.deepEqual(result.toPost.map((i) => i.key), ["after-wm"]);
    assert.deepEqual(
      result.toSeed.map((i) => i.key),
      ["before-wm", "at-wm"],
      "stale-unseen entries seed oldest-first instead of posting",
    );
  });

  it("seen entries are never reposted, even when newer than the watermark", () => {
    const result = feedState.partitionEntries({
      entries: [feedEntry("already-announced", 2)],
      seenKeys: ["already-announced"],
      lastChecked: NOW - 30 * MIN,
      now: NOW,
    });
    assert.deepEqual(result.toPost, []);
    assert.deepEqual(result.toSeed, []);
    assert.equal(result.skippedSeen, 1, "the seen-set outranks the watermark");
  });

  it("a reordered feed announces nothing on the next poll", () => {
    const feed = [feedEntry("a-old", 90), feedEntry("b-new", 5), feedEntry("c-stale", 61)];
    const first = feedState.partitionEntries({
      entries: feed,
      seenKeys: [],
      lastChecked: null,
      now: NOW,
    });
    assert.deepEqual(first.toPost.map((i) => i.key), ["b-new"], "first poll posts the in-window item only");
    const seen = [...first.toPost, ...first.toSeed].map((i) => i.key);
    assert.equal(seen.length, 3, "everything else seeded into the seen-set");

    const shuffled = [feed[2], feed[0], feed[1]]; // same items, reordered
    const second = feedState.partitionEntries({
      entries: shuffled,
      seenKeys: seen,
      lastChecked: NOW,
      now: NOW + MIN,
    });
    assert.deepEqual(second.toPost, [], "reordering alone never re-announces");
    assert.deepEqual(second.toSeed, []);
    assert.equal(second.skippedSeen, 3);
  });

  it("duplicate items inside one fetch announce exactly once", () => {
    const result = feedState.partitionEntries({
      entries: [feedEntry("dup", 5), feedEntry("dup", 5)],
      seenKeys: [],
      lastChecked: null,
      now: NOW,
    });
    assert.equal(result.toPost.length, 1, "one post for two identical guids in one response");
    assert.equal(result.toSeed.length, 0);
  });

  it("unkeyable entries are counted and never posted", () => {
    const result = feedState.partitionEntries({
      entries: [{ title: "no ids at all" }, feedEntry("ok", 5)],
      seenKeys: [],
      lastChecked: null,
      now: NOW,
    });
    assert.equal(result.skippedUnkeyed, 1);
    assert.deepEqual(result.toPost.map((i) => i.key), ["ok"]);
  });

  it("toPost is oldest-first so the ticker can flood-cap off the newest end", () => {
    const result = feedState.partitionEntries({
      entries: [feedEntry("newest", 1), feedEntry("oldest", 55), feedEntry("middle", 30)],
      seenKeys: [],
      lastChecked: null,
      now: NOW,
    });
    assert.deepEqual(result.toPost.map((i) => i.key), ["oldest", "middle", "newest"]);
  });

  it("pruneNeeded signals the repository prune once the bounded set would overflow", () => {
    const feed = [feedEntry("n1", 5), feedEntry("n2", 10)];

    const overflowing = feedState.partitionEntries({
      entries: feed,
      seenKeys: ["s1", "s2"],
      lastChecked: NOW,
      now: NOW,
      seenCap: 3,
    });
    assert.equal(overflowing.toPost.length + overflowing.toSeed.length, 2, "both seed (older than the watermark)");
    assert.equal(overflowing.pruneNeeded, true, "2 seen + 2 new exceeds cap 3");

    const fitting = feedState.partitionEntries({
      entries: feed,
      seenKeys: ["s1"],
      lastChecked: NOW,
      now: NOW,
      seenCap: 3,
    });
    assert.equal(fitting.pruneNeeded, false, "1 seen + 2 new fits the cap");

    const idle = feedState.partitionEntries({
      entries: feed,
      seenKeys: ["n1", "n2"],
      lastChecked: NOW,
      now: NOW,
      seenCap: 100,
    });
    assert.equal(idle.pruneNeeded, false, "no new inserts → nothing to prune");
  });

  it("RSS_SEEN_CAP mirrors the repository bound (facade RSS_SEEN_CAP)", () => {
    assert.equal(feedState.RSS_SEEN_CAP, 100, "the repository section above pins the db side to the same 100");
    assert.equal(feedState.DEFAULT_RSS_POLL_INTERVAL_MINUTES, 15, "spec/schema default interval");
  });
});

describe("rss feedState — backoff math", () => {
  const back = (failureCount, opts = {}) =>
    feedState.rssBackoffIntervalMs({ intervalMinutes: 15, failureCount, ...opts });

  it("base × 2^failure_count, clamped at the 6h ceiling", () => {
    const base = 15 * MIN;
    assert.equal(back(0), base, "failure_count 0 (the success reset) is exactly one base interval");
    assert.equal(back(1), 2 * base);
    assert.equal(back(2), 4 * base);
    assert.equal(back(4), 4 * HOUR, "15m × 16 = 4h stays under the cap");
    assert.equal(back(5), 6 * HOUR, "15m × 32 = 8h clamps to 6h");
    assert.equal(back(1000), 6 * HOUR, "huge counters digest to the cap, never Infinity");
    assert.ok(Number.isFinite(back(100000)));
  });

  it("reset semantics ride the counter: the repo success path zeroes failure_count", () => {
    assert.ok(back(3) > back(0), "failures grow the window");
    assert.equal(
      back(0),
      feedState.rssBackoffIntervalMs({ intervalMinutes: 15 }),
      "after recordRssFeedSuccess resets the counter the feed polls at the plain interval again",
    );
  });

  it("garbage inputs degrade to base/15 instead of breaking the gate", () => {
    assert.equal(back(NaN), 15 * MIN);
    assert.equal(back(-3), 15 * MIN);
    assert.equal(
      feedState.rssBackoffIntervalMs({ failureCount: 1 }),
      2 * 15 * MIN,
      "missing interval → 15-minute default base",
    );
    assert.equal(feedState.rssBackoffIntervalMs({ intervalMinutes: "every minute pls", failureCount: 1 }), 30 * MIN);
    assert.equal(
      feedState.rssBackoffIntervalMs({ intervalMinutes: 0, failureCount: 1 }),
      30 * MIN,
      "0 is not a poll interval — the default base applies",
    );
  });

  it("custom maxBackoffMs is honored; invalid caps fall back to 6h", () => {
    assert.equal(back(5, { maxBackoffMs: HOUR }), HOUR);
    assert.equal(back(2, { maxBackoffMs: HOUR }), HOUR, "growth clamps at a tiny custom cap too");
    assert.equal(back(10, { maxBackoffMs: -1 }), 6 * HOUR, "garbage cap → spec default");
  });

  it("rssNextDueAtMs = last_checked + backoff window; never-checked is due now", () => {
    assert.equal(
      feedState.rssNextDueAtMs({ lastChecked: 1_000, intervalMinutes: 15, failureCount: 1, now: NOW }),
      1_000 + 30 * MIN,
    );
    assert.equal(feedState.rssNextDueAtMs({ lastChecked: null, intervalMinutes: 15, now: NOW }), NOW);
    assert.equal(
      feedState.rssNextDueAtMs({ lastChecked: 0, intervalMinutes: 15, now: NOW }),
      NOW,
      "0 reads as never-checked (youtube truthiness of last_checked)",
    );
  });
});

describe("rss feedState — interval gate (isRssPollDue)", () => {
  it("missing or unknown interval settings fall back to 15 minutes", () => {
    const fourteenMinutesAgo = NOW - 14 * MIN;
    assert.equal(feedState.isRssPollDue({ lastChecked: fourteenMinutesAgo, intervalMinutes: null, now: NOW }), false);
    assert.equal(
      feedState.isRssPollDue({ lastChecked: fourteenMinutesAgo, intervalMinutes: undefined, now: NOW }),
      false,
    );
    assert.equal(feedState.isRssPollDue({ lastChecked: fourteenMinutesAgo, intervalMinutes: "?", now: NOW }), false);
    assert.equal(
      feedState.isRssPollDue({ lastChecked: NOW - 15 * MIN, intervalMinutes: null, now: NOW }),
      true,
      "unknown setting still gates on the 15-minute default",
    );
  });

  it("due when last_checked + interval <= now — exactly-due ticks, one ms early does not", () => {
    const interval = 15 * MIN;
    assert.equal(
      feedState.isRssPollDue({ lastChecked: NOW - interval + 1, intervalMinutes: 15, now: NOW }),
      false,
      "one millisecond early is NOT due",
    );
    assert.equal(
      feedState.isRssPollDue({ lastChecked: NOW - interval, intervalMinutes: 15, now: NOW }),
      true,
      "exactly-due ticks post (youtube's strict `< interval` skip restated)",
    );
    assert.equal(feedState.isRssPollDue({ lastChecked: NOW - interval - 1, intervalMinutes: 15, now: NOW }), true);
  });

  it("explicit intervals are honored (30m), and a heavily skewed-past stamp is due", () => {
    assert.equal(feedState.isRssPollDue({ lastChecked: NOW - 29 * MIN, intervalMinutes: 30, now: NOW }), false);
    assert.equal(feedState.isRssPollDue({ lastChecked: NOW - 30 * MIN, intervalMinutes: 30, now: NOW }), true);
    assert.equal(
      feedState.isRssPollDue({ lastChecked: NOW - 7 * 24 * HOUR, intervalMinutes: 30, now: NOW }),
      true,
      "a row left unchecked for a week is past due",
    );
  });

  it("never-checked rows (NULL / absent last_checked) are always due", () => {
    assert.equal(feedState.isRssPollDue({ lastChecked: null, intervalMinutes: 60, now: NOW }), true);
    assert.equal(feedState.isRssPollDue({ intervalMinutes: 60, now: NOW }), true);
  });

  it("failure_count folds the backoff into the same gate (ticker consumption shape)", () => {
    const twentyMinutesAgo = NOW - 20 * MIN;
    assert.equal(
      feedState.isRssPollDue({ lastChecked: twentyMinutesAgo, intervalMinutes: 15, now: NOW }),
      true,
      "base gate: 20m >= 15m",
    );
    assert.equal(
      feedState.isRssPollDue({ lastChecked: twentyMinutesAgo, intervalMinutes: 15, failureCount: 1, now: NOW }),
      false,
      "one failure doubles the wait: 20m < 30m",
    );
    assert.equal(
      feedState.isRssPollDue({ lastChecked: NOW - 31 * MIN, intervalMinutes: 15, failureCount: 1, now: NOW }),
      true,
    );
    assert.equal(
      feedState.isRssPollDue({ lastChecked: NOW - 3 * HOUR, intervalMinutes: 15, failureCount: 4, now: NOW }),
      false,
      "4h backoff window (15m × 16) not elapsed at 3h",
    );
    assert.equal(
      feedState.isRssPollDue({ lastChecked: NOW - 7 * HOUR, intervalMinutes: 15, failureCount: 40, now: NOW }),
      true,
      "the cap-bound 6h window is what elapses, not the raw counter",
    );
  });
});

// ===========================================================================
// Pure notification-format unit (issue #305, subtask 05):
// src/features/rss/format.js — payload shape for outbound.sendChannel, the
// HTML/entity snippet pipeline with the ≤300 clamp, thumbnail duck shapes
// (rss-parser v3.13 native + raw passthroughs), the content line, and the
// #272 strict-allowedMentions table. NO DB involved: format.js requires
// nothing at all (pure module), so the file-load require below is
// test-env-guard safe, exactly like feedState above.
// ===========================================================================

const rssFormat = require("../src/features/rss/format");

// Invisible-character constants via String.fromCharCode: the test source
// stays pure ASCII while the module keeps its literal ZWSP/NBSP bytes —
// every assertion below is behavior-based, never byte-source-based.
const ZWSP = String.fromCharCode(0x200b);
const NBSP = String.fromCharCode(0xa0);

const RSS_ROLE_ID = "500000000000000002";
const RSS_CHANNEL_ID = "500000000000000001";

const rssFeed = () => ({
  community_id: 7,
  url: "https://blog.example.com/rss",
  display_name: "Example News",
  feed_title: "Example Blog",
  feed_link: "https://blog.example.com/",
});

const rssEntry = (overrides = {}) => ({
  title: "Ship the thing",
  link: "https://blog.example.com/posts/ship",
  guid: "ship-1",
  pubDate: "Wed, 22 Oct 2026 10:00:00 GMT",
  contentSnippet: "We shipped it.",
  enclosure: { url: "https://blog.example.com/img/ship.png", type: "image/png" },
  ...overrides,
});

describe("rss format — neutralizeRichText (html strip, entity decode, mention disarm)", () => {
  it("strips markup and decodes entities EXACTLY once", () => {
    assert.equal(
      rssFormat.neutralizeRichText("<p>Hello <b>world</b> &amp; friends</p>"),
      "Hello world & friends",
    );
    assert.equal(rssFormat.neutralizeRichText("a&mdash;b"), "a\u2014b");
    assert.equal(
      rssFormat.neutralizeRichText("&amp;lt;@1&amp;gt;"),
      "&lt;@1&gt;",
      "double-encoded markup decodes to LITERAL text once — never re-decoded into markup, and never into a mention token",
    );
  });

  it("block tags separate words instead of gluing them; inline tags splice tight", () => {
    assert.equal(rssFormat.neutralizeRichText("<div>one</div><div>two</div>"), "one two");
    assert.equal(rssFormat.neutralizeRichText("un<em>be</em>lievable"), "unbelievable");
  });

  it("drops every Discord mention token", () => {
    assert.equal(rssFormat.neutralizeRichText("ping <@123> <@!456> <@&789> <#101> done"), "ping done");
    assert.equal(rssFormat.neutralizeRichText("<@&500000000000000002>"), "");
    assert.equal(rssFormat.neutralizeRichText("<@not-a-snowflake>"), "", "residual sweep kills odd <@ markup too (bridge/mentions.js hard rule)");
  });

  it("defeats SINGLE-ENCODED mention smuggling (decode runs before the mention sweep)", () => {
    assert.equal(
      rssFormat.neutralizeRichText("&lt;@&amp;999999999999999999&gt; news"),
      "news",
      "an entity-encoded role token decodes into a real token and the post-decode sweep then strips it",
    );
    const defended = rssFormat.neutralizeRichText("&#64;here &#64;everyone");
    assert.ok(!defended.includes("@here"), "@here decoded from a numeric entity is still disarmed");
    assert.ok(!defended.includes("@everyone"), "@everyone decoded from a numeric entity is still disarmed");
    assert.ok(defended.includes(`@${ZWSP}here`), "the word stays readable, the ping token dies (bridge posture)");
  });

  it("collapses whitespace — including decoded NBSP and injected newlines — to single spaces", () => {
    assert.equal(rssFormat.neutralizeRichText(`a${NBSP}b&nbsp;c`), "a b c");
    assert.equal(rssFormat.neutralizeRichText("one\ntwo\r\nthree"), "one two three");
  });

  it("script/style ELEMENT bodies never leak into the text", () => {
    const out = rssFormat.neutralizeRichText('Hello <script>alert("x")</script>world <style>body{color:red}</style>!');
    assert.ok(!out.includes("alert"), "script bodies are removed whole, not just their tags");
    assert.ok(!out.includes("color:red"));
    assert.ok(out.includes("Hello") && out.includes("world"));
  });
});

describe("rss format — snippet sources and the ≤300 clamp boundary", () => {
  it("299 and 300 chars pass through verbatim; 301 truncates to EXACTLY 300 ending in the ellipsis", () => {
    const at299 = rssFormat.buildSnippet({ content: "a".repeat(299) });
    assert.equal(at299.length, 299, "299 stays verbatim");
    assert.ok(!at299.endsWith("\u2026"), "no marker on un-truncated text");

    const at300 = rssFormat.buildSnippet({ content: "a".repeat(300) });
    assert.equal(at300.length, 300, "exactly 300 is legal and NOT truncated (≤300 spec)");
    assert.ok(!at300.endsWith("\u2026"));

    const at301 = rssFormat.buildSnippet({ content: "a".repeat(301) });
    assert.equal(at301.length, 300, "the marker counts INSIDE the 300 budget");
    assert.ok(at301.endsWith("\u2026"));
    assert.equal(at301, "a".repeat(299) + "\u2026");
  });

  it("entity decoding happens BEFORE the clamp: length is measured on decoded text", () => {
    const decodesTo300 = rssFormat.buildSnippet({ content: "&amp;" + "x".repeat(299) });
    assert.equal(decodesTo300.length, 300, "raw 304 chars decode to exactly 300 → verbatim, no marker");
    assert.ok(!decodesTo300.endsWith("\u2026"));

    const decodesTo301 = rssFormat.buildSnippet({ content: "&amp;" + "x".repeat(300) });
    assert.equal(decodesTo301.length, 300, "decoded 301 clamps to 300");
    assert.ok(decodesTo301.endsWith("\u2026"));
    assert.ok(decodesTo301.startsWith("&xxx"));
  });

  it("source precedence: raw content → summary → contentSnippet → nested itunes body", () => {
    assert.equal(
      rssFormat.buildSnippet({ content: "<p>From content</p>", contentSnippet: "from snippet" }),
      "From content",
      "the RAW field wins so OUR strip/decode/clamp rules are what the reader sees",
    );
    assert.equal(rssFormat.buildSnippet({ summary: "atom summary" }), "atom summary");
    assert.equal(
      rssFormat.buildSnippet({ content: "   ", summary: " real body " }),
      "real body",
      "whitespace-only candidates are skipped, not preferred",
    );
    assert.equal(
      rssFormat.buildSnippet({ contentSnippet: "  snippet fallback  " }),
      "snippet fallback",
      "parser-provided contentSnippet (decoded but UN-truncated by rss-parser 3.13) still goes through our clamp",
    );
    assert.equal(
      rssFormat.buildSnippet({ itunes: { summary: "itunes summary" } }),
      "itunes summary",
    );
    assert.equal(rssFormat.buildSnippet({}), "");
    assert.equal(rssFormat.buildSnippet(null), "");
  });

  it("snippets carry no markup", () => {
    assert.equal(
      rssFormat.buildSnippet({ content: "<div>Line one</div><div>Line two</div>" }),
      "Line one Line two",
    );
  });
});

describe("rss format — buildNotification payload shape", () => {
  it("full payload is EXACTLY the plain-JSON sendChannel shape (one embed, no extra keys)", () => {
    const payload = rssFormat.buildNotification(rssEntry(), rssFeed(), {
      channelId: RSS_CHANNEL_ID,
      notifyRoleId: RSS_ROLE_ID,
    });
    assert.deepEqual(payload, {
      content: `<@&${RSS_ROLE_ID}> **Example News** \u2014 new post`,
      embeds: [
        {
          title: "Ship the thing",
          url: "https://blog.example.com/posts/ship",
          description: "We shipped it.",
          thumbnail: { url: "https://blog.example.com/img/ship.png" },
          footer: { text: "Example News \u00b7 Example Blog" },
          timestamp: "2026-10-22T10:00:00.000Z",
        },
      ],
      allowedMentions: { roles: [RSS_ROLE_ID] },
    });
    // The deepEqual above already pins every key; these restate the contract
    // the poller (subtask 08) composes against.
    assert.equal(payload.embeds.length, 1, "one message per new entry — no batching");
    assert.equal("parse" in payload.allowedMentions, false, "#272: roles arm carries NO parse key");
    assert.equal(typeof payload.embeds[0].toJSON, "undefined", "plain JSON already — toPlainEmbed is a pass-through");
  });

  it("enclosure entry fixture shape matches rss-parser native output (item.enclosure = attr object)", () => {
    const entry = rssEntry({
      contentSnippet: undefined,
      enclosure: { url: "https://blog.example.com/img/ship.png", type: "image/png", length: "1234" },
      content: "We <b>shipped</b> it.",
    });
    const payload = rssFormat.buildNotification(entry, rssFeed(), {});
    assert.equal(payload.embeds[0].thumbnail.url, "https://blog.example.com/img/ship.png");
    assert.equal(payload.embeds[0].description, "We shipped it.", "description comes from the stripped raw content");
  });

  it("link chain: entry.link wins; feed_link is the fallback; nothing → title stays plain", () => {
    assert.equal(
      rssFormat.buildNotification(rssEntry(), rssFeed(), {}).embeds[0].url,
      "https://blog.example.com/posts/ship",
    );
    const noEntryLink = rssFormat.buildNotification(rssEntry({ link: undefined }), rssFeed(), {});
    assert.equal(noEntryLink.embeds[0].url, "https://blog.example.com/", "feed_link fallback");

    const feedBare = { url: "https://blog.example.com/rss" };
    const unlinked = rssFormat.buildNotification({ title: "Plain headline" }, feedBare, {});
    assert.equal("url" in unlinked.embeds[0], false, "no http(s) URL anywhere → embed url key omitted entirely");
  });

  it("non-http(s) links are never linkified (javascript:/data: dropped)", () => {
    const sneaky = rssFormat.buildNotification(
      rssEntry({ link: "javascript:alert(1)" }),
      { url: "https://blog.example.com/rss" },
      {},
    );
    assert.equal("url" in sneaky.embeds[0], false, "javascript: link dropped (entry AND not replaced by anything bogus)");
    assert.equal(sneaky.embeds[0].title, "Ship the thing", "the entry stays postable — only the link is refused");
    const dataUri = rssFormat.buildNotification(
      rssEntry({ link: "data:text/html,<script>1</script>" }),
      { url: "https://blog.example.com/rss", feed_link: "data:evil" },
      {},
    );
    assert.equal("url" in dataUri.embeds[0], false);
  });

  it("headline rule: missing title falls back to the entry permalink; no permalink → null", () => {
    const linkHeaded = rssFormat.buildNotification(
      rssEntry({ title: undefined }),
      rssFeed(),
      { notifyRoleId: RSS_ROLE_ID },
    );
    assert.equal(linkHeaded.embeds[0].title, "https://blog.example.com/posts/ship");
    assert.equal(linkHeaded.embeds[0].url, "https://blog.example.com/posts/ship");

    assert.equal(
      rssFormat.buildNotification({ guid: "g", description: "no title, entry-less link only" }, rssFeed(), {}),
      null,
      "feed_link is NEVER a headline (feed home page != this post) → nothing postable",
    );
    assert.equal(
      rssFormat.buildNotification({ title: "<@&123>", guid: "g" }, rssFeed(), {}),
      null,
      "a title that neutralizes to empty with no permalink is not postable either",
    );
    assert.equal(rssFormat.buildNotification(null, rssFeed(), {}), null);
    assert.equal(rssFormat.buildNotification(undefined, rssFeed(), {}), null);
    assert.equal(rssFormat.buildNotification("nope", rssFeed(), {}), null);
  });

  it("snippet equal to the headline is dropped (feeds echo the title as the body)", () => {
    const payload = rssFormat.buildNotification(
      { title: "Only words", link: "https://blog.example.com/x", contentSnippet: "Only words" },
      rssFeed(),
      {},
    );
    assert.equal("description" in payload.embeds[0], false);
  });

  it("titles are neutralized and clamped to the 256-char embed-title cap", () => {
    const long = rssFormat.buildNotification(rssEntry({ title: "t".repeat(300) }), rssFeed(), {});
    assert.equal(long.embeds[0].title.length, 256);
    assert.ok(long.embeds[0].title.endsWith("\u2026"));

    const multiline = rssFormat.buildNotification(rssEntry({ title: "Line1\nLine2 <b>!</b>" }), rssFeed(), {});
    assert.equal(multiline.embeds[0].title, "Line1 Line2 !");
  });

  it("timestamp rides ONLY a real pubDate/isoDate — never a fabricated now", () => {
    const isoOnly = rssFormat.buildNotification(
      rssEntry({ pubDate: "not a date", isoDate: "2026-10-21T08:30:00.000Z" }),
      rssFeed(),
      {},
    );
    assert.equal(isoOnly.embeds[0].timestamp, "2026-10-21T08:30:00.000Z", "isoDate is the parser fallback");

    const pubWins = rssFormat.buildNotification(
      rssEntry({ pubDate: "Wed, 22 Oct 2026 10:00:00 GMT", isoDate: "2020-01-01T00:00:00.000Z" }),
      rssFeed(),
      {},
    );
    assert.equal(pubWins.embeds[0].timestamp, "2026-10-22T10:00:00.000Z", "pubDate checked first");

    const dateless = rssFormat.buildNotification(rssEntry({ pubDate: undefined, isoDate: undefined }), rssFeed(), {});
    assert.equal("timestamp" in dateless.embeds[0], false, "no real date → key omitted (embed timestamps claim WHEN)");
    const garbage = rssFormat.buildNotification(rssEntry({ pubDate: "yesterday-ish", isoDate: "" }), rssFeed(), {});
    assert.equal("timestamp" in garbage.embeds[0], false);
  });

  it("footer = display name · feed title, collapsing to a single label when there is nothing to add", () => {
    assert.equal(
      rssFormat.buildNotification(rssEntry(), rssFeed(), {}).embeds[0].footer.text,
      "Example News \u00b7 Example Blog",
    );
    const twins = rssFeed();
    twins.feed_title = twins.display_name;
    assert.equal(
      rssFormat.buildNotification(rssEntry(), twins, {}).embeds[0].footer.text,
      "Example News",
      "identical title is not echoed twice",
    );
    const titled = { url: "https://blog.example.com/rss", feed_title: "Example Blog" };
    assert.equal(
      rssFormat.buildNotification(rssEntry(), titled, {}).embeds[0].footer.text,
      "Example Blog",
      "no display name → feed_title IS the label, footer stays single",
    );
    const hostOnly = { url: "https://news.example.org/feed?x=1" };
    assert.equal(
      rssFormat.buildNotification(rssEntry(), hostOnly, {}).embeds[0].footer.text,
      "news.example.org",
      "hostname fallback for a name-less row",
    );
    const broken = { url: "not even a url" };
    assert.equal(
      rssFormat.buildNotification(rssEntry(), broken, {}).embeds[0].footer.text,
      rssFormat.FALLBACK_FEED_NAME,
    );
  });
});

describe("rss format — thumbnail duck shapes (rss-parser native + raw passthroughs)", () => {
  const THUMB = "https://img.example/thumb.png";

  it("media:thumbnail in every passthrough shape incl. media:group nesting", () => {
    assert.equal(rssFormat.resolveThumbnailUrl({ "media:thumbnail": { $: { url: THUMB } } }), THUMB);
    assert.equal(rssFormat.resolveThumbnailUrl({ "media:thumbnail": [{ $: { url: THUMB } }] }), THUMB);
    assert.equal(rssFormat.resolveThumbnailUrl({ "media:thumbnail": { url: THUMB } }), THUMB);
    assert.equal(
      rssFormat.resolveThumbnailUrl({ "media:group": [{ "media:thumbnail": [{ $: { url: THUMB } }] }] }),
      THUMB,
    );
  });

  it("mediaContent/media:content only count when claimed as an IMAGE", () => {
    assert.equal(rssFormat.resolveThumbnailUrl({ mediaContent: { url: THUMB, medium: "image" } }), THUMB);
    assert.equal(rssFormat.resolveThumbnailUrl({ mediaContent: { url: THUMB, type: "image/png" } }), THUMB);
    assert.equal(
      rssFormat.resolveThumbnailUrl({ mediaContent: { url: "https://vid.example/v.mp4", medium: "video" } }),
      null,
      "a video URL as thumbnail is always wrong — skipped",
    );
  });

  it("enclosure: image mime wins; audio/octet-stream refused; typeless needs an image-extension URL", () => {
    assert.equal(
      rssFormat.resolveThumbnailUrl({ enclosure: { url: THUMB, type: "image/jpeg" } }),
      THUMB,
    );
    assert.equal(
      rssFormat.resolveThumbnailUrl({ enclosure: { url: "https://cdn.example/ep3.mp3", type: "audio/mpeg" } }),
      null,
      "podcast audio enclosures never become pictures",
    );
    assert.equal(
      rssFormat.resolveThumbnailUrl({ enclosure: { url: "https://cdn.example/pics/photo.JPG" } }),
      "https://cdn.example/pics/photo.JPG",
      "typeless + image extension = accepted (extension check is case-insensitive)",
    );
    assert.equal(
      rssFormat.resolveThumbnailUrl({ enclosure: { url: "https://cdn.example/download", type: "application/octet-stream" } }),
      null,
    );
  });

  it("itunes image: native href string and raw passthrough forms", () => {
    assert.equal(rssFormat.resolveThumbnailUrl({ itunes: { image: THUMB } }), THUMB);
    assert.equal(rssFormat.resolveThumbnailUrl({ "itunes:image": [{ $: { href: THUMB } }] }), THUMB);
  });

  it("precedence: media:thumbnail > mediaContent > enclosure > itunes", () => {
    assert.equal(
      rssFormat.resolveThumbnailUrl({
        "media:thumbnail": { $: { url: THUMB } },
        mediaContent: { url: "https://img.example/content.png", medium: "image" },
        enclosure: { url: "https://img.example/enc.png", type: "image/png" },
        itunes: { image: "https://img.example/art.png" },
      }),
      THUMB,
    );
    assert.equal(
      rssFormat.resolveThumbnailUrl({
        enclosure: { url: "https://img.example/enc.png", type: "image/png" },
        itunes: { image: "https://img.example/art.png" },
      }),
      "https://img.example/enc.png",
      "enclosure outranks the podcast art",
    );
  });

  it("nothing image-shaped, or an unsafe URL, reads as no thumbnail key on the embed", () => {
    assert.equal(rssFormat.resolveThumbnailUrl({}), null);
    assert.equal(rssFormat.resolveThumbnailUrl({ "media:thumbnail": { url: "javascript:evil" } }), null);
    const payload = rssFormat.buildNotification({ title: "No art", link: "https://blog.example.com/x" }, rssFeed(), {});
    assert.equal("thumbnail" in payload.embeds[0], false);
  });
});

describe("rss format — content line and feed display name", () => {
  it("role set: exact `<@&ROLE> **Feed Name** — new post` one-liner", () => {
    const payload = rssFormat.buildNotification(rssEntry(), rssFeed(), {
      channelId: RSS_CHANNEL_ID,
      notifyRoleId: RSS_ROLE_ID,
    });
    assert.equal(payload.content, `<@&${RSS_ROLE_ID}> **Example News** \u2014 new post`);
    assert.match(payload.content, /^<@&[0-9]+> \*\*.+\*\* \u2014 new post$/, "bold label inside the bold, colon-dash tail per spec");
  });

  it("role unset: no prefix at all, still the bold-label line", () => {
    const payload = rssFormat.buildNotification(rssEntry(), rssFeed(), { channelId: RSS_CHANNEL_ID });
    assert.equal(payload.content, "**Example News** \u2014 new post");
    assert.ok(!payload.content.includes("<@&"), "no role → no mention markup of any kind");
  });

  it("the ONLY pinging token in content is the prefix built from the validated role id", () => {
    const smuggled = rssFeed();
    smuggled.display_name = "Evil <@&999999999999999999> @everyone \"news\"";
    smuggled.feed_title = "Pew\nnew";
    const payload = rssFormat.buildNotification(rssEntry(), smuggled, {
      channelId: RSS_CHANNEL_ID,
      notifyRoleId: RSS_ROLE_ID,
    });
    assert.ok(!payload.content.includes("<@&999999999999999999"), "role-token smuggling through the feed name is stripped");
    assert.ok(!payload.content.includes("@everyone"), "@everyone through the feed name is ZWSP-broken");
    assert.ok(!payload.content.includes("\n"), "content is ONE line even with a newline-poisoned feed title");
    assert.equal(payload.content.split("<@&").length - 1, 1, "exactly one mention token: our own prefix");
  });

  it("display name precedence: display_name || feed_title || hostname(url) || fallback", () => {
    assert.equal(rssFormat.resolveFeedDisplayName(rssFeed()), "Example News");
    assert.equal(
      rssFormat.resolveFeedDisplayName({ url: "https://blog.example.com/rss", feed_title: "Example Blog" }),
      "Example Blog",
    );
    assert.equal(
      rssFormat.resolveFeedDisplayName({ url: "https://news.example.org/rss" }),
      "news.example.org",
    );
    assert.equal(rssFormat.resolveFeedDisplayName({ url: "garbage" }), rssFormat.FALLBACK_FEED_NAME);
    assert.equal(rssFormat.resolveFeedDisplayName(null), rssFormat.FALLBACK_FEED_NAME);
    assert.equal(
      rssFormat.resolveFeedDisplayName({ display_name: "My &amp; Blog" }),
      "My & Blog",
      "stored names ride the same decode pipeline (titles resolved from hostile feeds are attacker text)",
    );
  });

  it("whitespace and non-snowflake stored role ids are treated as UNSET everywhere", () => {
    for (const junk of ["", "   ", null, undefined, "@everyone", "roles", "9".repeat(26)]) {
      const payload = rssFormat.buildNotification(rssEntry(), rssFeed(), { notifyRoleId: junk });
      assert.ok(!payload.content.includes("<@&"), `no prefix for notifyRoleId=${JSON.stringify(junk)}`);
      assert.deepEqual(payload.allowedMentions, { parse: [] });
    }
    const padded = rssFormat.buildNotification(rssEntry(), rssFeed(), { notifyRoleId: `  ${RSS_ROLE_ID}  ` });
    assert.equal(padded.content, `<@&${RSS_ROLE_ID}> **Example News** \u2014 new post`, "valid ids are trimmed, not rejected");
    const numeric = rssFormat.buildNotification(rssEntry(), rssFeed(), { notifyRoleId: 12345 });
    assert.deepEqual(numeric.allowedMentions, { roles: ["12345"] }, "numeric column reads coerce to the string form");
  });
});

describe("rss format — allowedMentions strictness table (#272)", () => {
  const table = [
    ["configured role → strict id arm", { notifyRoleId: RSS_ROLE_ID }, { roles: [RSS_ROLE_ID] }],
    ["numeric-string id coerced", { notifyRoleId: "42" }, { roles: ["42"] }],
    ["unset → parse-off arm", {}, { parse: [] }],
    ["null → parse-off arm", { notifyRoleId: null }, { parse: [] }],
    ["blank → parse-off arm", { notifyRoleId: "   " }, { parse: [] }],
    ["@everyone literal → parse-off arm", { notifyRoleId: "@everyone" }, { parse: [] }],
    ["role-name junk → parse-off arm", { notifyRoleId: "roles" }, { parse: [] }],
    ["oversized digits → parse-off arm", { notifyRoleId: "9".repeat(26) }, { parse: [] }],
    ["missing settings object → parse-off arm", undefined, { parse: [] }],
  ];

  for (const [label, settings, expected] of table) {
    it(label, () => {
      const am = rssFormat.toAllowedMentions(settings);
      assert.deepEqual(am, expected, "exact shape — no third arm, no merged form");
      const wire = JSON.stringify(am);
      assert.ok(!wire.includes("everyone"), "the payload can never mention everyone");
      assert.ok(!wire.includes('"roles"') || "roles" in expected, "the parse-off arm carries no roles key either way");
      if ("roles" in expected) {
        assert.equal("parse" in am, false, "#272: the strict arm is MUTUALLY EXCLUSIVE with parse — {parse:[...], roles:[...]} is a Discord validation error");
      } else {
        assert.equal("roles" in am, false);
      }
    });
  }

  it("buildNotification and the content prefix agree on the SAME single role id", () => {
    const payload = rssFormat.buildNotification(rssEntry(), rssFeed(), {
      channelId: RSS_CHANNEL_ID,
      notifyRoleId: RSS_ROLE_ID,
    });
    assert.deepEqual(payload.allowedMentions.roles, [RSS_ROLE_ID]);
    assert.ok(payload.content.startsWith(`<@&${payload.allowedMentions.roles[0]}> `), "the pinged role == the allow-listed role, always");
    const unset = rssFormat.buildNotification(rssEntry(), rssFeed(), {});
    assert.deepEqual(unset.allowedMentions, { parse: [] }, "the unset path can NEVER mention anything");
  });
});
