const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { loadDb } = require("./helpers/env");

describe("userActivity math & ids", () => {
  let weeksSinceJoin;
  let weeklyRate;
  let formatWeeklyRate;
  let normalizeWindow;
  let sinceDayForWindow;
  let parseActivityButtonCustomId;
  let activityButtonCustomId;
  let normalizeMaxPagesPerChannel;
  let MAX_PAGES_PER_CHANNEL;
  let ABS_MAX_PAGES_PER_CHANNEL;

  before(() => {
    // Fresh DB + rebind src modules before requiring feature code
    loadDb();
    ({
      weeksSinceJoin,
      weeklyRate,
      formatWeeklyRate,
      normalizeWindow,
      sinceDayForWindow,
    } = require("../src/features/userActivity/service"));
    ({
      parseActivityButtonCustomId,
      activityButtonCustomId,
    } = require("../src/features/userActivity/render"));
    ({
      normalizeMaxPagesPerChannel,
      MAX_PAGES_PER_CHANNEL,
      ABS_MAX_PAGES_PER_CHANNEL,
    } = require("../src/features/userActivity/backfill"));
  });

  it("weeksSinceJoin floors at 1", () => {
    const now = Date.UTC(2026, 0, 15);
    assert.equal(weeksSinceJoin(now, now), 1);
    assert.equal(weeksSinceJoin(null, now), 1);
    const twoWeeksAgo = now - 14 * 86400000;
    assert.ok(Math.abs(weeksSinceJoin(twoWeeksAgo, now) - 2) < 0.01);
  });

  it("weeklyRate and format", () => {
    assert.equal(weeklyRate(14, 2), 7);
    assert.equal(formatWeeklyRate(7), "7.0/wk");
    assert.equal(formatWeeklyRate(120), "120/wk");
  });

  it("normalizeWindow and sinceDay", () => {
    assert.equal(normalizeWindow("7"), "7");
    assert.equal(normalizeWindow("nope"), "a");
    assert.equal(sinceDayForWindow("a"), null);
    assert.match(sinceDayForWindow("7"), /^\d{4}-\d{2}-\d{2}$/);
  });

  it("parses activity button custom ids", () => {
    assert.deepEqual(parseActivityButtonCustomId("ui:n:123"), {
      view: "n",
      userId: "123",
    });
    assert.deepEqual(parseActivityButtonCustomId("ui:a:99"), {
      view: "a",
      userId: "99",
      win: "a",
    });
    assert.deepEqual(parseActivityButtonCustomId("ui:aw:7:ch:99"), {
      view: "a",
      userId: "99",
      win: "7",
    });
    assert.deepEqual(parseActivityButtonCustomId("ui:ap:ca:30:99"), {
      view: "c",
      userId: "99",
      win: "30",
    });
    assert.deepEqual(parseActivityButtonCustomId("ui:b:99"), {
      view: "b",
      userId: "99",
    });
    // legacy
    assert.deepEqual(parseActivityButtonCustomId("ui:a:99:7"), {
      view: "a",
      userId: "99",
      win: "7",
    });
    assert.equal(parseActivityButtonCustomId("nope"), null);
    assert.equal(activityButtonCustomId("a", "1"), "ui:a:1");
    assert.equal(
      activityButtonCustomId("aw", "1", { win: "30", page: "ch" }),
      "ui:aw:30:ch:1"
    );
  });

  it("normalizeMaxPagesPerChannel clamps and defaults", () => {
    assert.equal(normalizeMaxPagesPerChannel(null), MAX_PAGES_PER_CHANNEL);
    assert.equal(normalizeMaxPagesPerChannel(undefined), MAX_PAGES_PER_CHANNEL);
    assert.equal(normalizeMaxPagesPerChannel(100), 100);
    assert.equal(normalizeMaxPagesPerChannel(0), 1);
    assert.equal(normalizeMaxPagesPerChannel(-5), 1);
    assert.equal(
      normalizeMaxPagesPerChannel(9999),
      ABS_MAX_PAGES_PER_CHANNEL
    );
    assert.equal(normalizeMaxPagesPerChannel(50.9), 50);
  });

  it("activity component custom ids are unique across rows", () => {
    const {
      buildPrimaryButtons,
      buildActivityControlRows,
      collectCustomIds,
    } = require("../src/features/userActivity/render");
    const counts = {
      notesActive: 0,
      notesTotal: 0,
      warnsActive: 0,
      warnsTotal: 0,
    };
    for (const page of ["a", "c"]) {
      for (const win of ["a", "7", "30"]) {
        const rows = [
          buildPrimaryButtons(counts, page, "user-1", win),
          ...buildActivityControlRows("user-1", win, page, null),
        ];
        const ids = collectCustomIds(rows);
        assert.equal(
          ids.length,
          new Set(ids).size,
          `duplicate ids for page=${page} win=${win}: ${ids.join(", ")}`
        );
      }
    }
  });
});

describe("userActivity db counters", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let db;
  let shouldSkipChannel;
  let buildChannelRanking;
  let buildCategoryRanking;

  before(() => {
    db = loadDb().api;
    ({
      shouldSkipChannel,
      buildChannelRanking,
      buildCategoryRanking,
    } = require("../src/features/userActivity/service"));
  });

  it("upserts daily counters and sums by window", () => {
    const g = "g-act";
    const u = "u1";
    const ch = "ch1";
    db.ensureGuildActivitySettings(g);
    db.incrementDaily(g, u, ch, "2026-01-01", 3);
    db.incrementDaily(g, u, ch, "2026-01-01", 2);
    db.incrementDaily(g, u, ch, "2026-02-01", 4);
    db.incrementDaily(g, u, "ch2", "2026-02-01", 1);

    const all = db.sumByChannel(g, u, {});
    assert.equal(all.find((r) => r.channel_id === ch).count, 9);
    assert.equal(db.totalPosts(g, u, {}), 10);

    const since = db.sumByChannel(g, u, { sinceDay: "2026-02-01" });
    assert.equal(
      since.reduce((s, r) => s + r.count, 0),
      5
    );
    assert.equal(db.earliestTrackedDay(g, u), "2026-01-01");
  });

  it("ignore list channel and category", () => {
    const g = "g-ign";
    assert.equal(db.addActivityIgnore(g, "c1", "channel"), true);
    assert.equal(db.addActivityIgnore(g, "c1", "channel"), false);
    assert.equal(db.addActivityIgnore(g, "cat1", "category"), true);
    assert.equal(db.isActivityIgnored(g, "c1"), true);
    const sets = db.getActivityIgnoreSets(g);
    assert.equal(sets.channels.has("c1"), true);
    assert.equal(sets.categories.has("cat1"), true);
    assert.equal(db.removeActivityIgnore(g, "c1"), true);
    assert.equal(db.isActivityIgnored(g, "c1"), false);
  });

  it("shouldSkipChannel respects ignore and honeypot", () => {
    const g = "g-skip";
    db.addActivityIgnore(g, "noise", "channel");
    db.addActivityIgnore(g, "cat-x", "category");
    db.addHoneypotChannel(g, "hp");
    assert.equal(shouldSkipChannel(g, "noise", null), true);
    assert.equal(shouldSkipChannel(g, "ok", "cat-x"), true);
    assert.equal(shouldSkipChannel(g, "hp", null), true);
    assert.equal(shouldSkipChannel(g, "ok", "other"), false);
  });

  it("buildChannelRanking ranks and applies lifetime weekly rate", () => {
    const g = "g-rank";
    const u = "u-rank";
    db.ensureGuildActivitySettings(g);
    db.incrementDaily(g, u, "alpha", "2020-01-01", 100);
    db.incrementDaily(g, u, "alpha", db.utcDayKey(), 10);
    db.incrementDaily(g, u, "beta", db.utcDayKey(), 5);

    const joinedMs = Date.now() - 10 * 7 * 86400000; // 10 weeks
    const ranking = buildChannelRanking({
      guildId: g,
      userId: u,
      guild: null,
      window: "a",
      joinedMs,
    });
    assert.equal(ranking.windowTotal, 115);
    assert.equal(ranking.ranked[0].id, "alpha");
    assert.ok(ranking.ranked[0].weekly > ranking.ranked[1].weekly);

    const week = buildChannelRanking({
      guildId: g,
      userId: u,
      guild: null,
      window: "7",
      joinedMs,
    });
    assert.equal(week.windowTotal, 15);
  });

  it("buildCategoryRanking rolls up uncategorized without guild cache", () => {
    const g = "g-cat";
    const u = "u-cat";
    db.incrementDaily(g, u, "x", db.utcDayKey(), 3);
    db.incrementDaily(g, u, "y", db.utcDayKey(), 1);
    const ranking = buildCategoryRanking({
      guildId: g,
      userId: u,
      guild: null,
      window: "a",
      joinedMs: Date.now() - 86400000,
    });
    assert.equal(ranking.ranked.length, 1);
    assert.equal(ranking.ranked[0].label, "Uncategorized");
    assert.equal(ranking.ranked[0].count, 4);
  });

  it("watermark: live collect_from is set on ensure", () => {
    const g = "g-wm";
    const before = Date.now();
    const s = db.ensureGuildActivitySettings(g);
    assert.ok(s.collect_from_ms >= before - 1000);
    const again = db.ensureGuildActivitySettings(g);
    assert.equal(again.collect_from_ms, s.collect_from_ms);
  });
});
