/**
 * gork budget GATE unit tests (roadmap/gork.md §7.17, decisions 30–37).
 *
 * Pure helpers (tri-state labels, category walk, scope labels) and the
 * hourly rejection throttle (fake clock) need no DB; checkGorkBudget /
 * recordGorkBudgetUsage run against a fresh temp SQLite via loadDb().
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

const {
  formatDailyLimit,
  categoryIdForChannel,
  channelScopeIdFor,
  scopeLabel,
  createBudgetRejectThrottle,
  checkGorkBudget,
  recordGorkBudgetUsage,
  formatBudgetLabel,
} = require("../src/features/gork/budget");

describe("formatDailyLimit (tri-state surface)", () => {
  it("renders -1 / 0 / cap", () => {
    assert.equal(formatDailyLimit(-1), "blocked");
    assert.equal(formatDailyLimit(0), "unlimited");
    assert.equal(formatDailyLimit(5), "5/day");
    assert.equal(formatDailyLimit("gork"), "unlimited");
  });
});

describe("categoryIdForChannel (duck-typed walk)", () => {
  it("direct parent category", () => {
    assert.equal(
      categoryIdForChannel({ id: "c1", parent: { id: "cat1", type: 4 } }),
      "cat1",
    );
  });

  it("thread: climb parent text channel to its category", () => {
    assert.equal(
      categoryIdForChannel({
        id: "t1",
        parent: { id: "c1", type: 0, parent: { id: "cat1", type: 4 } },
      }),
      "cat1",
    );
  });

  it("unfiled / missing / garbage → null", () => {
    assert.equal(categoryIdForChannel({ id: "c1" }), null);
    assert.equal(categoryIdForChannel({ id: "c1", parent: { id: "c0", type: 0 } }), null);
    assert.equal(categoryIdForChannel(null), null);
  });
});

describe("channelScopeIdFor (threads bind the PARENT channel)", () => {
  it("plain guild channel keeps its own id", () => {
    assert.equal(
      channelScopeIdFor({ id: "c1", parent: { id: "cat1", type: 4 } }),
      "c1",
    );
  });

  it("thread (duck-typed) resolves to the parent channel id", () => {
    assert.equal(
      channelScopeIdFor({
        id: "t1",
        type: 11,
        parent: { id: "c1", parent: { id: "cat1", type: 4 } },
      }),
      "c1",
    );
  });

  it("isThread() duck object wins even without a thread-looking type", () => {
    assert.equal(
      channelScopeIdFor({ id: "t2", isThread: () => true, parent: { id: "c1" } }),
      "c1",
    );
  });

  it("thread with no parent → own id; null/garbage-safe", () => {
    assert.equal(channelScopeIdFor({ id: "t3", type: 11 }), "t3");
    assert.equal(channelScopeIdFor(null), null);
    assert.equal(channelScopeIdFor(undefined), null);
  });
});

describe("scopeLabel (rejection wording names the effective scope)", () => {
  it("channel scope uses the channel name when it matches", () => {
    assert.equal(
      scopeLabel({ scopeKind: "channel", scopeId: "c1" }, { id: "c1", name: "general" }),
      "#general",
    );
    assert.equal(
      scopeLabel({ scopeKind: "channel", scopeId: "cX" }, { id: "c1", name: "general" }),
      "this channel",
    );
  });

  it("channel scope on a THREAD trigger names the parent channel", () => {
    assert.equal(
      scopeLabel(
        { scopeKind: "channel", scopeId: "c1" },
        { id: "t1", name: "thread", parent: { id: "c1", name: "general" } },
      ),
      "#general",
    );
  });

  it("category scope names the category via the channel's parent (incl. threads)", () => {
    assert.equal(
      scopeLabel(
        { scopeKind: "category", scopeId: "cat1" },
        { id: "c1", parent: { id: "cat1", name: "Support", type: 4 } },
      ),
      'category "Support"',
    );
    assert.equal(
      scopeLabel(
        { scopeKind: "category", scopeId: "cat1" },
        { id: "t1", parent: { id: "c1", parent: { id: "cat1", name: "Support" } } },
      ),
      'category "Support"',
    );
    assert.equal(
      scopeLabel({ scopeKind: "category", scopeId: "catX" }, null),
      "this category",
    );
  });

  it("guild scope reads as the server", () => {
    assert.equal(scopeLabel({ scopeKind: "guild", scopeId: "0" }, { id: "c1" }), "this server");
  });
});

describe("createBudgetRejectThrottle (decision 34: 1 reply / user / scope / hour)", () => {
  it("first send passes, repeats inside the hour bounce silently", () => {
    let nowMs = 1_000_000;
    const throttle = createBudgetRejectThrottle({ now: () => nowMs });
    const args = { guildId: "g1", userId: "u1", scopeKind: "channel", scopeId: "c1" };
    assert.equal(throttle.shouldSend(args), true);
    assert.equal(throttle.shouldSend(args), false);
    nowMs += 3_599_000;
    assert.equal(throttle.shouldSend(args), false, "still inside the window");
    nowMs += 2_000; // full hour elapsed since the FIRST reply
    assert.equal(throttle.shouldSend(args), true, "window rolled over");
  });

  it("keys are isolated per user, guild, and scope", () => {
    const throttle = createBudgetRejectThrottle({ now: () => 5 });
    const base = { guildId: "g1", userId: "u1", scopeKind: "channel", scopeId: "c1" };
    assert.equal(throttle.shouldSend(base), true);
    assert.equal(throttle.shouldSend({ ...base, userId: "u2" }), true, "other user");
    assert.equal(throttle.shouldSend({ ...base, guildId: "g2" }), true, "other guild");
    assert.equal(
      throttle.shouldSend({ ...base, scopeKind: "category", scopeId: "cat1" }),
      true,
      "other scope",
    );
    assert.equal(throttle.shouldSend(base), false, "own key stays deduped");
  });

  it("missing identity fails closed (no reply)", () => {
    const throttle = createBudgetRejectThrottle({ now: () => 5 });
    assert.equal(throttle.shouldSend(undefined), false);
    assert.equal(throttle.shouldSend({ guildId: "", userId: "u1" }), false);
  });
});

describe("checkGorkBudget + recordGorkBudgetUsage (real temp SQLite)", () => {
  let api;
  let cleanup;

  before(() => {
    // Contract: loadDb() before any src/ db access — fresh temp SQLite,
    // src require-cache reset, tracked cleanup.
    ({ api, cleanup } = loadDb());
  });

  after(() => cleanup?.());

  const channel = (id, parent = null) => ({ id, name: `ch-${id}`, parent });
  const today = () => new Date().toISOString().slice(0, 10);

  it("default 0 = unlimited: allowed, and counting is skipped entirely", () => {
    const g = "g-gate-off";
    const res = checkGorkBudget({ guildId: g, userId: "u1", channel: channel("c1"), day: today() });
    assert.equal(res.allowed, true);
    assert.equal(res.scope.limit, 0, "guild default 0 = unlimited");
    assert.equal(recordGorkBudgetUsage({ guildId: g, userId: "u1", scope: res.scope, day: today() }), null);
    assert.equal(
      api.db.prepare(`SELECT COUNT(*) AS n FROM gork_usage WHERE guild_id=?`).get(g).n,
      0,
      "unlimited scope must write no usage rows",
    );
  });

  it("guild default cap counts down and rejects at the cap", () => {
    const g = "g-gate-cap";
    api.updateGuildSettings(g, { gork_daily_limit: 1 });
    const day = today();
    const first = checkGorkBudget({ guildId: g, userId: "u1", channel: channel("c1"), day });
    assert.equal(first.allowed, true);
    assert.equal(first.scope.scopeKind, "guild");

    const used = recordGorkBudgetUsage({ guildId: g, userId: "u1", scope: first.scope, day });
    assert.equal(used, 1);

    const second = checkGorkBudget({ guildId: g, userId: "u1", channel: channel("c1"), day });
    assert.equal(second.allowed, false);
    assert.equal(second.kind, "over");
    assert.match(second.reply, /Daily gork budget reached in this server \(1\/day\)/);
    assert.match(second.reply, /resets 00:00 UTC\.$/);
  });

  it("blocked scope (-1) gets its own surface — channel, category, and guild", () => {
    const g = "g-gate-block";
    const day = today();

    api.upsertGorkBudgetRule(g, "channel", "c1", -1, null);
    let res = checkGorkBudget({ guildId: g, userId: "u1", channel: channel("c1"), day });
    assert.equal(res.allowed, false);
    assert.equal(res.kind, "blocked");
    assert.equal(res.reply, "gork isn't available in this channel.");

    api.upsertGorkBudgetRule(g, "category", "cat1", -1, null);
    res = checkGorkBudget({
      guildId: g,
      userId: "u1",
      channel: channel("c2", { id: "cat1", type: 4, name: "Support" }),
      day,
    });
    assert.equal(res.allowed, false);
    assert.equal(res.reply, "gork isn't available in this category.");

    api.updateGuildSettings(g, { gork_daily_limit: -1 });
    res = checkGorkBudget({ guildId: g, userId: "u1", channel: channel("c9"), day });
    assert.equal(res.allowed, false);
    assert.equal(res.reply, "gork isn't available in this server.");
  });

  it("most specific scope wins and owns the counter", () => {
    const g = "g-gate-scope";
    const day = today();
    api.updateGuildSettings(g, { gork_daily_limit: 9 });
    api.upsertGorkBudgetRule(g, "category", "cat1", 1, null);
    api.upsertGorkBudgetRule(g, "channel", "c1", 5, null);
    const ch1 = channel("c1", { id: "cat1", type: 4, name: "Support" });

    const inC1 = checkGorkBudget({ guildId: g, userId: "u1", channel: ch1, day });
    assert.equal(inC1.scope.scopeKind, "channel", "channel rule beats category");

    const inC2 = checkGorkBudget({
      guildId: g,
      userId: "u1",
      channel: channel("c2", { id: "cat1", type: 4, name: "Support" }),
      day,
    });
    assert.equal(inC2.scope.scopeKind, "category", "category rule beats guild");

    // Spend the CHANNEL counter: the category counter stays untouched.
    recordGorkBudgetUsage({ guildId: g, userId: "u1", scope: inC1.scope, day });
    assert.equal(api.getGorkUsage(g, "u1", "category", "cat1", day), 0);
    assert.equal(api.getGorkUsage(g, "u1", "channel", "c1", day), 1);

    // Drain the CATEGORY counter for a member channel: it blocks there…
    recordGorkBudgetUsage({ guildId: g, userId: "u1", scope: inC2.scope, day });
    const blocked = checkGorkBudget({
      guildId: g,
      userId: "u1",
      channel: channel("c2", { id: "cat1", type: 4, name: "Support" }),
      day,
    });
    assert.equal(blocked.allowed, false);
    // …while the channel-rule counter (1/5) still allows its own channel.
    assert.equal(
      checkGorkBudget({ guildId: g, userId: "u1", channel: ch1, day }).allowed,
      true,
    );
  });

  it("thread trigger obeys the PARENT channel's rule and shares its counter", () => {
    const g = "g-gate-thread";
    const day = today();
    api.updateGuildSettings(g, { gork_daily_limit: 9 });
    api.upsertGorkBudgetRule(g, "channel", "c1", 1, null);
    const thread = {
      id: "t1",
      name: "thread",
      type: 11,
      parent: { id: "c1", name: "general", parent: { id: "cat1", type: 4 } },
    };

    const first = checkGorkBudget({ guildId: g, userId: "u1", channel: thread, day });
    assert.equal(first.allowed, true);
    assert.equal(first.scope.scopeKind, "channel");
    assert.equal(first.scope.scopeId, "c1", "counter binds the PARENT channel id");
    recordGorkBudgetUsage({ guildId: g, userId: "u1", scope: first.scope, day });

    const second = checkGorkBudget({ guildId: g, userId: "u1", channel: thread, day });
    assert.equal(second.allowed, false);
    assert.match(
      second.reply,
      /Daily gork budget reached in #general \(1\/day\)/,
      "rejection names the parent channel, not the thread",
    );

    // Sibling thread shares the same counter — no thread escape hatch.
    const sibling = { ...thread, id: "t2", name: "sibling" };
    assert.equal(
      checkGorkBudget({ guildId: g, userId: "u1", channel: sibling, day }).allowed,
      false,
    );
  });

  it("blocked (-1) parent channel also kills its threads", () => {
    const g = "g-gate-thread-block";
    api.upsertGorkBudgetRule(g, "channel", "c1", -1, null);
    const thread = {
      id: "t1",
      name: "thread",
      type: 11,
      parent: { id: "c1", name: "general", parent: { id: "cat1", type: 4 } },
    };
    const res = checkGorkBudget({ guildId: g, userId: "u1", channel: thread, day: today() });
    assert.equal(res.allowed, false);
    assert.equal(res.kind, "blocked", "kill switch covers threads under the blocked channel");
  });

  it("formatBudgetLabel renders 'n/limit in scope' only for real caps", () => {
    const ch = { id: "c1", name: "general" };
    assert.equal(
      formatBudgetLabel({ scopeKind: "channel", scopeId: "c1", limit: 5 }, 3, ch),
      "3/5 in #general",
    );
    assert.equal(
      formatBudgetLabel({ scopeKind: "guild", scopeId: "0", limit: 0 }, 9, ch),
      undefined,
    );
    assert.equal(formatBudgetLabel(null, 9, ch), undefined);
  });
});
