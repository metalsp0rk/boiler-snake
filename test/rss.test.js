const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");

/**
 * Repository section for RSS feed notifications (issue #305, subtask 02):
 * src/db/repositories/rss.js against a real migrated SQLite, plus the
 * guildSettings whitelist trio from migration 064. Feature-layer behavior
 * (SSRF validation, ticker gating, embed shapes) lives in the sibling test
 * files — this file is DB layer only.
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
