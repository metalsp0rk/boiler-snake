/**
 * #725 (epic #723): auto-mod settings service + repository unit tests.
 *
 * Covers the epic-default posture (master off, modes suggest, staff notes
 * without a flag), the validation messages (specific, never generic), the
 * tri-state daily budget with the day-rollover counter on an INJECTABLE
 * clock (the semantics #726/#728 consume), and the persisted breaker pause.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

const service = require("../src/features/automod/settings");
const repo = require("../src/db/repositories/automodSettings");

after(() => cleanup());

const DAY_MS = 86_400_000;
const DAY1 = Date.UTC(2026, 9, 20, 12, 0, 0); // a fixed UTC "today"

/** Fresh community per test — settings rows never bleed across cases. */
let seq = 0;
const freshCommunity = () => communityKey(`automod-725-${++seq}`);

describe("automod settings — migration 067 defaults", () => {
  it("matches the epic: master off, every mode suggest, note tool has NO flag", () => {
    const cid = freshCommunity();
    const s = db.getGuildSettings(cid);
    assert.equal(Number(s.automod_enabled), 0, "master switch defaults off");
    assert.equal(s.automod_channel_id, null);
    assert.equal(s.automod_rules, null);
    for (const action of repo.AUTOMOD_ACTIONS) {
      assert.equal(
        s[`automod_mode_${action}`],
        "suggest",
        `mode ${action} defaults to suggest`,
      );
    }
    assert.equal(s.automod_timeout_cap, 3600);
    assert.equal(s.automod_daily_case_limit, 50);
    assert.equal(Number(s.automod_cases_today), 0);
    assert.equal(s.automod_cases_day, null);
    assert.equal(s.automod_paused_at, null);
    assert.equal(s.automod_pause_reason, null);

    // Locked decision 4: the staff-note tool is always on — there must be
    // NO mode column for it anywhere on guild_settings.
    const names = db.db
      .prepare("PRAGMA table_info(guild_settings)")
      .all()
      .map((c) => c.name);
    assert.ok(
      !names.includes("automod_mode_note") &&
        !names.some((n) => /note/.test(n)),
      "no notes mode flag exists",
    );
  });

  it("the migration is idempotent (full replay on the already-migrated DB)", () => {
    const { runMigrations } = require("../src/db/migrate");
    db.db.pragma("user_version = 0");
    assert.doesNotThrow(() => runMigrations());
    const cid = freshCommunity();
    assert.equal(db.getGuildSettings(cid).automod_timeout_cap, 3600);
  });
});

describe("automod settings service — validation returns {ok:false,error}", () => {
  it("rules cap: rejects over-length with the offending count, trims otherwise", () => {
    const cid = freshCommunity();
    const tooLong = "x".repeat(repo.AUTOMOD_RULES_MAX_LEN + 1);
    const over = service.setRules(cid, tooLong);
    assert.equal(over.ok, false);
    assert.match(over.error, /4001 characters/);
    assert.match(over.error, /cap is 4000/);

    const blank = service.setRules(cid, "   ");
    assert.equal(blank.ok, false);
    assert.match(blank.error, /Rules text is required/);

    const ok = service.setRules(cid, "  No spam, no hate.  ");
    assert.equal(ok.ok, true);
    assert.equal(ok.rules, "No spam, no hate.");
    assert.equal(db.getGuildSettings(cid).automod_rules, "No spam, no hate.");

    const cleared = service.clearRules(cid);
    assert.equal(cleared.ok, true);
    assert.equal(db.getGuildSettings(cid).automod_rules, null);
  });

  it("timeout cap: names the offending value; never silently clamps", () => {
    const cid = freshCommunity();
    const low = service.setTimeoutCap(cid, 59);
    assert.equal(low.ok, false);
    assert.match(low.error, /got `59`/);
    assert.match(low.error, /60 \(1 minute\)/);
    assert.match(low.error, /2419200 .*28 days/);

    const high = service.setTimeoutCap(cid, 2_419_201);
    assert.equal(high.ok, false);
    assert.match(high.error, /got `2419201`/);

    const nonInt = service.setTimeoutCap(cid, 3600.5);
    assert.equal(nonInt.ok, false);

    // Untouched by the refusals, persisted on success.
    assert.equal(db.getGuildSettings(cid).automod_timeout_cap, 3600);
    assert.equal(service.setTimeoutCap(cid, 2_419_200).ok, true);
    assert.equal(db.getGuildSettings(cid).automod_timeout_cap, 2_419_200);
    assert.equal(service.setTimeoutCap(cid, 60).ok, true);
    assert.equal(db.getGuildSettings(cid).automod_timeout_cap, 60);
  });

  it("budget tri-state: -1 blocked, 0 unlimited, 1..100000; out of range refuses", () => {
    const cid = freshCommunity();
    assert.equal(service.setDailyBudget(cid, -2).ok, false);
    assert.match(service.setDailyBudget(cid, 100_001).error, /got `100001`/);
    assert.equal(service.setDailyBudget(cid, -1).ok, true);
    assert.equal(db.getGuildSettings(cid).automod_daily_case_limit, -1);
    assert.equal(service.setDailyBudget(cid, 0).ok, true);
    assert.equal(db.getGuildSettings(cid).automod_daily_case_limit, 0);
  });

  it("mode: unknown action/mode refused specifically; valid mode persists", () => {
    const cid = freshCommunity();
    const badAction = service.setMode(cid, "note", "auto");
    assert.equal(badAction.ok, false);
    assert.match(badAction.error, /Unknown action `note`/);
    assert.match(badAction.error, /Staff notes are always on/);

    const badMode = service.setMode(cid, "warn", "yolo");
    assert.equal(badMode.ok, false);
    assert.match(badMode.error, /Unknown mode `yolo`/);

    assert.equal(service.setMode(cid, "kick", "auto").ok, true);
    assert.equal(db.getGuildSettings(cid).automod_mode_kick, "auto");
    assert.equal(service.setMode(cid, "delete_message", "off").ok, true);
    assert.equal(db.getGuildSettings(cid).automod_mode_delete_message, "off");
  });

  it("enable + channel: booleans persist, clears are allowed while ENABLED", () => {
    const cid = freshCommunity();
    assert.equal(service.setEnabled(cid, true).ok, true);
    assert.equal(Number(db.getGuildSettings(cid).automod_enabled), 1);
    assert.equal(service.setEnabled(cid, "maybe").ok, false);

    assert.equal(service.setChannel(cid, "1234567890123456789").ok, true);
    assert.equal(
      db.getGuildSettings(cid).automod_channel_id,
      "1234567890123456789",
    );
    assert.equal(service.setChannel(cid, "  ").ok, false);

    // Clearing while enabled is ALLOWED (referral-side refusal is #726).
    assert.equal(service.clearChannel(cid).ok, true);
    assert.equal(db.getGuildSettings(cid).automod_channel_id, null);
    assert.equal(Number(db.getGuildSettings(cid).automod_enabled), 1);
  });

  it("readSettings normalizes the row for status + gates", () => {
    const cid = freshCommunity();
    const read = service.readSettings(cid, DAY1);
    assert.equal(read.ok, true);
    const s = read.settings;
    assert.equal(s.enabled, false);
    assert.equal(typeof s.modes.no_action, "string");
    assert.equal(s.channelId, null);
    assert.equal(s.rulesChars, 0);
    assert.equal(s.casesRemaining, 50);
    assert.equal(s.paused, false);
  });
});

describe("automod daily case budget — day-rollover counter (injectable clock)", () => {
  it("counts up to the limit, then refuses WITHOUT incrementing", () => {
    const cid = freshCommunity();
    for (let i = 1; i <= 50; i += 1) {
      const res = repo.consumeAutomodCase(cid, { nowMs: DAY1 });
      assert.equal(res.ok, true, `case ${i} accepted`);
      assert.equal(res.used, i);
      assert.equal(res.remaining, 50 - i);
    }
    const denied = repo.consumeAutomodCase(cid, { nowMs: DAY1 });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, "exhausted");
    assert.equal(denied.used, 50, "refusal never increments the counter");
    assert.equal(db.getGuildSettings(cid).automod_cases_today, 50);
    assert.equal(db.getAutomodBudget(cid, DAY1).remaining, 0);
  });

  it("rolls the counter at the UTC day boundary", () => {
    const cid = freshCommunity();
    repo.consumeAutomodCase(cid, { nowMs: DAY1 });
    assert.equal(db.getAutomodBudget(cid, DAY1).used, 1);

    const nextDay = repo.getAutomodBudget(cid, DAY1 + DAY_MS);
    assert.equal(nextDay.used, 0, "yesterday's cases are gone");
    assert.equal(nextDay.remaining, 50);

    // Status reads roll too, and the store reflects the new day.
    const row = db.getGuildSettings(cid);
    assert.equal(Number(row.automod_cases_today), 0);
    assert.equal(row.automod_cases_day, "2026-10-21");

    const accepted = repo.consumeAutomodCase(cid, { nowMs: DAY1 + DAY_MS });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.used, 1, "fresh day restarts from zero");
  });

  it("-1 blocks every case; 0 is unlimited; garbage never blocks", () => {
    const blocked = freshCommunity();
    service.setDailyBudget(blocked, -1);
    const b = repo.getAutomodBudget(blocked, DAY1);
    assert.equal(b.remaining, -1, "-1 is the blocked sentinel");
    const denied = repo.consumeAutomodCase(blocked, { nowMs: DAY1 });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, "blocked");
    assert.equal(Number(db.getGuildSettings(blocked).automod_cases_today), 0);

    const open = freshCommunity();
    service.setDailyBudget(open, 0);
    assert.equal(repo.getAutomodBudget(open, DAY1).remaining, null, "null = unlimited");
    for (let i = 0; i < 60; i += 1) {
      assert.equal(repo.consumeAutomodCase(open, { nowMs: DAY1 }).ok, true);
    }

    // Storage-side belt: a garbage write never lands a silent block.
    const belt = freshCommunity();
    db.updateGuildSettings(belt, { automod_daily_case_limit: "banana" });
    assert.equal(db.getGuildSettings(belt).automod_daily_case_limit, 50);
    db.updateGuildSettings(belt, { automod_daily_case_limit: -999 });
    assert.equal(db.getGuildSettings(belt).automod_daily_case_limit, -1, "clamped to the floor");
    db.updateGuildSettings(belt, { automod_timeout_cap: 1 });
    assert.equal(db.getGuildSettings(belt).automod_timeout_cap, 60, "cap floor belt");
    db.updateGuildSettings(belt, { automod_mode_warn: "banana" });
    assert.equal(
      db.getGuildSettings(belt).automod_mode_warn,
      "suggest",
      "invalid mode keeps the prior value",
    );
  });
});

describe("automod breaker pause columns + safety resume", () => {
  it("persist → read → resume clears BOTH fields; resume-while-active refuses", () => {
    const cid = freshCommunity();
    assert.deepEqual(repo.isAutomodPaused(cid), {
      paused: false,
      pausedAt: null,
      reason: null,
    });

    repo.setAutomodPause(cid, { pausedAt: DAY1, reason: "auto-ban burst (6 in 10m)" });
    const paused = repo.isAutomodPaused(cid);
    assert.equal(paused.paused, true);
    assert.equal(paused.pausedAt, DAY1);
    assert.equal(paused.reason, "auto-ban burst (6 in 10m)");

    const read = service.readSettings(cid);
    assert.equal(read.settings.paused, true);
    assert.equal(read.settings.pauseReason, "auto-ban burst (6 in 10m)");

    const refused = service.resumeSafety(freshCommunity());
    assert.equal(refused.ok, false);
    assert.match(refused.error, /not paused/);

    const resumed = service.resumeSafety(cid);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.wasPausedAt, DAY1);
    assert.equal(resumed.wasReason, "auto-ban burst (6 in 10m)");
    const row = db.getGuildSettings(cid);
    assert.equal(row.automod_paused_at, null);
    assert.equal(row.automod_pause_reason, null, "resume clears BOTH fields");
  });
});

describe("db facade surface for later automod issues (#726/#728)", () => {
  it("exports the budget/breaker accessors used by referral + harness", () => {
    for (const name of [
      "getAutomodBudget",
      "consumeAutomodCase",
      "setAutomodPause",
      "clearAutomodPause",
      "isAutomodPaused",
      "automodModeColumn",
      "normalizeAutomodMode",
    ]) {
      assert.equal(typeof db[name], "function", `src/db must export ${name}`);
    }
    assert.deepEqual(
      [...db.AUTOMOD_ACTIONS],
      ["no_action", "warn", "delete_message", "ticket", "timeout", "kick", "ban"],
    );
    assert.deepEqual([...db.AUTOMOD_MODES], ["off", "suggest", "auto"]);
    assert.equal(db.automodModeColumn("ban"), "automod_mode_ban");
    assert.equal(db.automodModeColumn("note"), null);
    assert.equal(db.normalizeAutomodMode("AUTO"), "auto");
    assert.equal(db.normalizeAutomodMode("nope"), null);
  });
});
