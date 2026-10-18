const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { loadDb, communityKey } = require("./helpers/env");

describe("userActivity math & ids", () => {
  let weeksSinceJoin;
  let weeksForWindow;
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
      weeksForWindow,
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

  it("weeksForWindow uses fixed length for 7/30/90 and join age for all-time", () => {
    const now = Date.UTC(2026, 0, 15);
    const tenWeeksAgo = now - 10 * 7 * 86400000;
    assert.equal(weeksForWindow("7", tenWeeksAgo, now), 1);
    assert.ok(Math.abs(weeksForWindow("30", tenWeeksAgo, now) - 30 / 7) < 1e-9);
    assert.ok(Math.abs(weeksForWindow("90", tenWeeksAgo, now) - 90 / 7) < 1e-9);
    assert.ok(Math.abs(weeksForWindow("a", tenWeeksAgo, now) - 10) < 0.01);
  });

  it("weeklyRate and format", () => {
    assert.equal(weeklyRate(14, 2), 7);
    assert.equal(formatWeeklyRate(7), "7.0/wk");
    assert.equal(formatWeeklyRate(120), "120/wk");
  });

  it("normalizeWindow and sinceDay", () => {
    assert.equal(normalizeWindow("7"), "7");
    assert.equal(normalizeWindow("90"), "90");
    assert.equal(normalizeWindow("nope"), "a");
    assert.equal(sinceDayForWindow("a"), null);
    assert.match(sinceDayForWindow("7"), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(sinceDayForWindow("90"), /^\d{4}-\d{2}-\d{2}$/);
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
    assert.deepEqual(parseActivityButtonCustomId("ui:aw:90:ca:99"), {
      view: "c",
      userId: "99",
      win: "90",
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
    assert.equal(
      activityButtonCustomId("aw", "1", { win: "90", page: "ca" }),
      "ui:aw:90:ca:1"
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
      for (const win of ["a", "7", "30", "90"]) {
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
        // 4 window buttons present
        assert.ok(ids.some((id) => id.includes(":90:")), "90d control present");
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
    db.ensureGuildActivitySettings(communityKey(g));
    db.incrementDaily(communityKey(g), u, ch, "2026-01-01", 3);
    db.incrementDaily(communityKey(g), u, ch, "2026-01-01", 2);
    db.incrementDaily(communityKey(g), u, ch, "2026-02-01", 4);
    db.incrementDaily(communityKey(g), u, "ch2", "2026-02-01", 1);

    const all = db.sumByChannel(communityKey(g), u, {});
    assert.equal(all.find((r) => r.channel_id === ch).count, 9);
    assert.equal(db.totalPosts(communityKey(g), u, {}), 10);

    const since = db.sumByChannel(communityKey(g), u, { sinceDay: "2026-02-01" });
    assert.equal(
      since.reduce((s, r) => s + r.count, 0),
      5
    );
    assert.equal(db.earliestTrackedDay(communityKey(g), u), "2026-01-01");
  });

  it("ignore list channel and category", () => {
    const g = "g-ign";
    assert.equal(db.addActivityIgnore(communityKey(g), "c1", "channel"), true);
    assert.equal(db.addActivityIgnore(communityKey(g), "c1", "channel"), false);
    assert.equal(db.addActivityIgnore(communityKey(g), "cat1", "category"), true);
    assert.equal(db.isActivityIgnored(communityKey(g), "c1"), true);
    const sets = db.getActivityIgnoreSets(communityKey(g));
    assert.equal(sets.channels.has("c1"), true);
    assert.equal(sets.categories.has("cat1"), true);
    assert.equal(db.removeActivityIgnore(communityKey(g), "c1"), true);
    assert.equal(db.isActivityIgnored(communityKey(g), "c1"), false);
  });

  it("shouldSkipChannel respects ignore and honeypot", () => {
    const g = "g-skip";
    db.addActivityIgnore(communityKey(g), "noise", "channel");
    db.addActivityIgnore(communityKey(g), "cat-x", "category");
    db.addHoneypotChannel(communityKey(g), "hp");
    assert.equal(shouldSkipChannel(communityKey(g), "noise", null), true);
    assert.equal(shouldSkipChannel(communityKey(g), "ok", "cat-x"), true);
    assert.equal(shouldSkipChannel(communityKey(g), "hp", null), true);
    assert.equal(shouldSkipChannel(communityKey(g), "ok", "other"), false);
  });

  it("buildChannelRanking ranks and applies window-aware weekly rate", () => {
    const g = "g-rank";
    const u = "u-rank";
    db.ensureGuildActivitySettings(communityKey(g));
    db.incrementDaily(communityKey(g), u, "alpha", "2020-01-01", 100);
    db.incrementDaily(communityKey(g), u, "alpha", db.utcDayKey(), 10);
    db.incrementDaily(communityKey(g), u, "beta", db.utcDayKey(), 5);

    const joinedMs = Date.now() - 10 * 7 * 86400000; // 10 weeks
    const ranking = buildChannelRanking({
      communityId: communityKey(g),
      userId: u,
      guild: null,
      window: "a",
      joinedMs,
    });
    assert.equal(ranking.windowTotal, 115);
    assert.equal(ranking.ranked[0].id, "alpha");
    assert.ok(ranking.ranked[0].weekly > ranking.ranked[1].weekly);
    // All-time: 115 posts / 10 weeks
    assert.ok(Math.abs(ranking.windowWeekly - 11.5) < 0.01);
    assert.ok(Math.abs(ranking.ranked[0].weekly - 11) < 0.01); // 110/10

    const week = buildChannelRanking({
      communityId: communityKey(g),
      userId: u,
      guild: null,
      window: "7",
      joinedMs,
    });
    assert.equal(week.windowTotal, 15);
    // 7d: window posts / 1 week (not lifetime / join weeks)
    assert.ok(Math.abs(week.windowWeekly - 15) < 0.01);
    assert.ok(Math.abs(week.ranked.find((r) => r.id === "alpha").weekly - 10) < 0.01);
    assert.ok(Math.abs(week.ranked.find((r) => r.id === "beta").weekly - 5) < 0.01);
    // Lifetime rate still reflects all-time
    assert.ok(Math.abs(week.lifetimeWeekly - 11.5) < 0.01);

    const ninety = buildChannelRanking({
      communityId: communityKey(g),
      userId: u,
      guild: null,
      window: "90",
      joinedMs,
    });
    // Recent posts fall in 90d; historical 2020-01-01 does not
    assert.equal(ninety.windowTotal, 15);
    assert.ok(Math.abs(ninety.windowWeekly - 15 / (90 / 7)) < 0.01);
  });

  it("buildCategoryRanking rolls up uncategorized without guild cache", () => {
    const g = "g-cat";
    const u = "u-cat";
    db.incrementDaily(communityKey(g), u, "x", db.utcDayKey(), 3);
    db.incrementDaily(communityKey(g), u, "y", db.utcDayKey(), 1);
    const ranking = buildCategoryRanking({
      communityId: communityKey(g),
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
    const s = db.ensureGuildActivitySettings(communityKey(g));
    assert.ok(s.collect_from_ms >= before - 1000);
    const again = db.ensureGuildActivitySettings(communityKey(g));
    assert.equal(again.collect_from_ms, s.collect_from_ms);
  });
});

describe("guildDailyMessageTotals (bounded guild×day aggregation)", () => {
  const DAY = 86_400_000;
  /** Fixed UTC YYYY-MM-DD for deterministic window math. */
  function fixedDay(offsetDays) {
    const d = new Date(Date.UTC(2026, 0, 1) + offsetDays * DAY);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
      d.getUTCDate()
    ).padStart(2, "0")}`;
  }

  let db;
  before(() => {
    db = loadDb().api; // fresh temp SQLite; facade re-export must exist
  });

  it("sums users+channels per day, ASC, guild-scoped, sinceDay-bounded", () => {
    const g = "g-gdt";
    const other = "g-gdt-other";
    const d0 = fixedDay(0);
    const d1 = fixedDay(1);
    const d2 = fixedDay(2);

    db.incrementDaily(communityKey(g), "u1", "c1", d2, 2);
    db.incrementDaily(communityKey(g), "u2", "c1", d2, 3); // same day, other user
    db.incrementDaily(communityKey(g), "u1", "c2", d1, 4); // same user, other channel
    db.incrementDaily(communityKey(g), "u1", "c1", d0, 5);
    db.incrementDaily(communityKey(g), "u1", "c1", "2020-01-01", 999); // outside window
    db.incrementDaily(communityKey(other), "u1", "c1", d2, 7); // other guild

    const rows = db.guildDailyMessageTotals(communityKey(g), { sinceDay: d0 });
    assert.deepEqual(rows, [
      { day: d0, total: 5 },
      { day: d1, total: 4 },
      { day: d2, total: 5 }, // 2 + 3, cross-user/channel roll-up
    ]);
    assert.ok(!rows.some((r) => r.day === "2020-01-01"), "sinceDay excludes old days");
    assert.ok(!rows.some((r) => r.total === 7 || r.total === 12), "guild-scoped (§8.2)");

    assert.deepEqual(db.guildDailyMessageTotals(communityKey("g-gdt-none"), { sinceDay: d0 }), [],
      "guild with no rows ⇒ empty, not an error");
  });

  it("hard row cap: LIMIT clamps to 31 NEWEST days even for greedy callers", () => {
    const repo = require("../src/db/repositories/userChannelActivity");
    assert.equal(repo.GUILD_DAILY_TOTALS_MAX_DAYS, 31, "§8.6: day-granular reads cap at 31 rows");

    const g = "g-gdt-cap";
    for (let i = 0; i < 35; i += 1) {
      db.incrementDaily(communityKey(g), "u1", "c1", fixedDay(i), 1);
    }
    // Greedy caller: sinceDay covers all 35 days, limitDays unclamped →
    // must return the NEWEST 31 days, still ASCENDING.
    const rows = db.guildDailyMessageTotals(communityKey(g), { sinceDay: fixedDay(0), limitDays: 999 });
    assert.equal(rows.length, 31);
    assert.equal(rows[0].day, fixedDay(4), "oldest days drop first (newest kept)");
    assert.equal(rows[rows.length - 1].day, fixedDay(34));
    for (let i = 1; i < rows.length; i += 1) {
      assert.ok(rows[i - 1].day < rows[i].day, "ascending order");
    }

    const tiny = db.guildDailyMessageTotals(communityKey(g), { sinceDay: fixedDay(0), limitDays: 3 });
    assert.deepEqual(tiny.map((r) => r.day), [fixedDay(32), fixedDay(33), fixedDay(34)]);
  });

  it("bad input fails loudly, never silently", () => {
    assert.throws(() => db.guildDailyMessageTotals(communityKey("g-gdt"), {}), /sinceDay/);
    assert.throws(() => db.guildDailyMessageTotals(communityKey("g-gdt"), { sinceDay: 20260101 }), /sinceDay/);
  });
});

/**
 * Issue #200 (audit §6 P2): recordUserChannelMessage (the message pipeline's
 * step 9) duck-typed `message.guild`/`message.author` and re-resolved the
 * community through the DISCORD platform — so every normalized Fluxer
 * message was silently skipped and the audit's "channel activity row" never
 * existed for the new platform. Reads are contract-first now (integer
 * communityId, authorId, createdAt) with the raw discord path unchanged.
 */
describe("recordUserChannelMessage — platform-neutral live counting (#200)", () => {
  let recordUserChannelMessage;
  let dbApi;
  before(() => {
    const { api } = loadDb();
    dbApi = api;
    ({ recordUserChannelMessage } = require("../src/features/userActivity/service"));
  });

  it("counts a normalized Fluxer message against its integer community id", () => {
    const cid = communityKey("1554590611015729555", "fluxer", "https://ua200.test");
    const msg = {
      platform: "fluxer",
      instanceKey: "https://ua200.test",
      communityId: cid,
      id: "m-1",
      channelId: "700",
      authorId: "u-1",
      authorBot: false,
      content: "hi",
      createdAt: new Date(),
    };
    assert.equal(recordUserChannelMessage(msg), true, "fluxer messages reach the daily counters now");
    const rows = dbApi.db
      .prepare("SELECT community_id, channel_id, count FROM user_channel_message_daily WHERE community_id = ?")
      .all(cid);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].community_id), cid);
    assert.equal(rows[0].count, 1);
  });

  it("fails closed when the Fluxer community resolve failed (communityId null, no guild duck)", () => {
    assert.equal(
      recordUserChannelMessage({
        platform: "fluxer",
        instanceKey: "x",
        communityId: null,
        id: "m-2",
        channelId: "700",
        authorId: "u-2",
        authorBot: false,
        createdAt: new Date(),
      }),
      false,
      "a failed community resolve is NOT re-resolved here — it fails closed",
    );
  });

  it("skips bots and keeps the raw Discord path counting through the guild resolve", () => {
    const cid = communityKey("900000000000000222");
    assert.equal(
      recordUserChannelMessage({
        platform: "fluxer",
        communityId: cid,
        channelId: "700",
        authorId: "u-3",
        authorBot: true,
        createdAt: new Date(),
      }),
      false,
    );
    assert.equal(
      recordUserChannelMessage({
        guild: { id: "900000000000000222" },
        author: { id: "u-4", bot: false },
        channelId: "900",
        createdTimestamp: Date.now(),
      }),
      true,
    );
    const total = dbApi.db
      .prepare("SELECT COALESCE(SUM(count), 0) AS c FROM user_channel_message_daily WHERE community_id = ?")
      .get(cid).c;
    assert.equal(Number(total), 1);
  });

  // ── #437 (audit F2-1): system lines are excluded on BOTH paths ──────────

  it("isSystemMessageType keeps human non-zero types, excludes system ones (#437)", () => {
    const { isSystemMessageType } = require("../src/platform/normalizedMessageContract");
    // Default + human-authored non-zero types stay counted:
    for (const t of [null, undefined, 0, 18, 19, 20, 21, 23]) {
      assert.equal(isSystemMessageType(t), false, `type ${t} is human content`);
    }
    // Auto-generated lines (author = the celebrated human) are excluded:
    for (const t of [6, 7, 8, 12, 22, 24, 25, 46]) {
      assert.equal(isSystemMessageType(t), true, `type ${t} is a system line`);
    }
    // Unknown future types fail toward the documented exclusion:
    assert.equal(isSystemMessageType(999), true);
  });

  it("live ingest skips a human-authored system line (#437)", () => {
    const cid = communityKey("900000000000000437");
    assert.equal(
      recordUserChannelMessage({
        guild: { id: "900000000000000437" },
        author: { id: "u-joiner", bot: false },
        channelId: "940",
        type: 7, // UserJoin (GuildMemberJoin) — author IS the joiner
        createdTimestamp: Date.now(),
      }),
      false,
      "a join notification must not count as the new member posting (RED: old gate read a field nothing set)",
    );
    assert.equal(
      recordUserChannelMessage({
        guild: { id: "900000000000000437" },
        author: { id: "u-replyer", bot: false },
        channelId: "940",
        type: 19, // Reply — real human content stays counted
        createdTimestamp: Date.now(),
      }),
      true,
    );
    const rows = dbApi.db
      .prepare("SELECT user_id, count FROM user_channel_message_daily WHERE community_id = ?")
      .all(cid);
    assert.deepEqual(
      rows.map((r) => [r.user_id, Number(r.count)]).sort(),
      [["u-replyer", 1]],
      "only the human reply reached the daily table",
    );
  });

  it("backfill skips the same system lines — one truth for live and history (#437)", async () => {
    const { backfillChannel } = require("../src/features/userActivity/backfill");
    const { ensureCommunity } = require("../src/platform/community");
    const gid = "990000000000000437";
    const day = Date.UTC(2026, 0, 10);
    const mk = (id, type, userId) => ({
      id: String(id),
      type,
      author: { id: userId, bot: false },
      createdTimestamp: day + Number(id),
    });
    const all = [
      mk(50, 0, "a"), // chatter — counted
      mk(49, 7, "b"), // join notice — EXCLUDED (author = joiner)
      mk(48, 19, "a"), // reply — counted
      mk(47, 6, "c"), // pin notification — EXCLUDED
    ];
    const channel = {
      id: "ch-welcome-437",
      guildId: gid,
      messages: {
        fetch: async (opts = {}) => {
          const picked = all.filter((m) => !opts.before || Number(m.id) < Number(opts.before));
          return new Map(picked.map((m) => [m.id, m]));
        },
      },
    };

    const res = await backfillChannel(channel, null, day + 1000);
    assert.equal(res.counted, 2, "two human lines, two system lines skipped (RED: old counted 4)");

    const cid = ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId: gid,
    });
    const rows = dbApi.db
      .prepare("SELECT user_id, count FROM user_channel_message_daily WHERE community_id = ? ORDER BY user_id")
      .all(cid);
    assert.deepEqual(
      rows.map((r) => [r.user_id, Number(r.count)]),
      [["a", 2]],
      "no phantom rows for the celebrated users b/c (RED: old inflated both)",
    );
  });
});
