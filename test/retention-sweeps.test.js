const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");

/**
 * Retention sweeps (audit-2026-10 #192): batched, knob-controlled pruning of
 * activity_log / admin_audit / user_channel_message_daily / expired
 * fluxer_oauth_transactions. Sweep-unit scope: boundaries, batch limits,
 * no-lockup cap, idle-sweep cheapness, disabled knobs, poisoned-table
 * isolation, create-path opportunistic prune, scheduler arming.
 * The end-to-end story (real pre-auth login path → fake clock → sweep)
 * lives in test/integration/retention-sweeps.test.js.
 *
 * CONTRACT: loadDb() runs before every `src/` require (private temp DB —
 * the project-root default is racy under parallel node --test).
 */
const loaded = loadDb();
const api = loaded.api;

const {
  parseDaysKnob,
  retentionConfig,
  DEFAULT_ACTIVITY_DAYS,
  DEFAULT_ADMIN_AUDIT_DAYS,
  DEFAULT_DAILY_AGGREGATES_DAYS,
  DEFAULT_BATCH_ROWS,
  DEFAULT_MAX_BATCHES_PER_TABLE,
  ENV_KEYS,
} = require("../src/features/retention/config");
const { runRetentionSweeps, RETENTION_TABLES } = require("../src/features/retention/sweeps");
const retention = require("../src/features/retention");
const scheduler = require("../src/core/scheduler");
const { utcDayKey } = require("../src/db/repositories/userChannelActivity");

const DAY = 24 * 60 * 60 * 1000;
/** Fixed sweep instant — every boundary assertion is exact fake-clock math. */
const T = 1_791_000_000_000; // 2026-10-03T06:40:00Z-ish; exactness is arithmetic, not calendar

/** Suite env: ALL knobs off so nothing sweeps implicitly — every sweep that
 * must do work runs with explicit `overrides`. The scheduler-arming test's
 * runImmediately/`job.run()` sweeps therefore hit disabled skips only. */
const savedEnv = {};

before(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    process.env[key] = "off";
  }
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  // Stop the armed job + close the temp DB (loadDb cleanup closes handles).
  scheduler.stop(retention.SWEEP_JOB);
  loaded.cleanup();
});

let cid;
before(() => {
  cid = communityKey("123456789012345678");
});

/** Count helper per table. */
function count(table) {
  return api.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}

function clearAll() {
  for (const table of RETENTION_TABLES) api.db.prepare(`DELETE FROM ${table}`).run();
}

function seedActivity(createdAgoMs, n = 1) {
  const ins = api.db.prepare(
    `INSERT INTO activity_log (community_id, user_id, kind, amount, created_at)
     VALUES (?, ?, 'message', 1, ?)`
  );
  for (let i = 0; i < n; i += 1) ins.run(cid, "u-ret", T - createdAgoMs + i);
}

function seedAudit(createdAt) {
  api.db
    .prepare(
      `INSERT INTO admin_audit (community_id, origin, action, created_at)
       VALUES (?, 'system', 'retention.test', ?)`
    )
    .run(cid, createdAt);
}

function seedDaily(day) {
  api.db
    .prepare(
      `INSERT OR REPLACE INTO user_channel_message_daily
         (community_id, user_id, channel_id, day, count) VALUES (?, 'u-ret', 'ch-ret', ?, 1)`
    )
    .run(cid, day);
}

function seedOauth(nonceHex, expiresAt) {
  api.db
    .prepare(
      `INSERT OR REPLACE INTO fluxer_oauth_transactions (nonce, code_verifier, instance_key, expires_at)
       VALUES (?, 'verifier-material', 'flx.test', ?)`
    )
    .run(nonceHex, expiresAt);
}

/** Capture console noise around a call; forwards the call's return value. */
function captureConsole(fnr) {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  console.error = (...a) => errors.push(a.map(String).join(" "));
  let value;
  try {
    value = fnr();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { logs, errors, value };
}

describe("retention config parsing (env knobs, one per table)", () => {
  it("parseDaysKnob: empty ⇒ default, 0/off ⇒ disabled(null), numbers floor, garbage ⇒ default", () => {
    assert.equal(parseDaysKnob("", 90), 90);
    assert.equal(parseDaysKnob(undefined, 90), 90);
    assert.equal(parseDaysKnob("0", 90), null);
    assert.equal(parseDaysKnob("off", 90), null);
    assert.equal(parseDaysKnob("OFF", 90), null);
    assert.equal(parseDaysKnob("45", 90), 45);
    assert.equal(parseDaysKnob(30.7, 90), 30);
    assert.equal(parseDaysKnob("banana", 90), 90, "garbage never silently disables");
    assert.equal(parseDaysKnob("-3", 90), 90, "negative never means delete-everything");
  });

  it("retentionConfig: documented defaults when env is unset; batch bounds are sane", () => {
    const saved = ENV_KEYS.map((k) => [k, process.env[k]]);
    for (const k of ENV_KEYS) delete process.env[k];
    try {
      const cfg = retentionConfig();
      assert.equal(cfg.activityDays, DEFAULT_ACTIVITY_DAYS);
      assert.equal(DEFAULT_ACTIVITY_DAYS, 90);
      assert.equal(DEFAULT_ADMIN_AUDIT_DAYS, 365);
      assert.equal(cfg.adminAuditDays, DEFAULT_ADMIN_AUDIT_DAYS);
      assert.equal(cfg.dailyAggregatesDays, DEFAULT_DAILY_AGGREGATES_DAYS);
      assert.equal(DEFAULT_DAILY_AGGREGATES_DAYS, 400);
      assert.equal(cfg.oauthTxSweepEnabled, true);
      assert.equal(cfg.batchRows, DEFAULT_BATCH_ROWS);
      assert.equal(DEFAULT_BATCH_ROWS, 500);
      assert.equal(cfg.maxBatchesPerTable, DEFAULT_MAX_BATCHES_PER_TABLE);
      assert.equal(DEFAULT_MAX_BATCHES_PER_TABLE, 40);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("env knobs are re-read per call; explicit overrides win over env", () => {
    process.env.RETENTION_ACTIVITY_DAYS = "120";
    try {
      assert.equal(retentionConfig().activityDays, 120);
      assert.equal(retentionConfig({ activityDays: 7 }).activityDays, 7);
      assert.equal(retentionConfig({ activityDays: 0 }).activityDays, null);
    } finally {
      process.env.RETENTION_ACTIVITY_DAYS = "off"; // suite baseline
    }
  });

  it("oauth knob: 0/off/false disables, anything else (incl. garbage) stays enabled", () => {
    for (const off of ["0", "off", "false", "disabled"]) {
      process.env.RETENTION_OAUTH_TX_SWEEP = off;
      assert.equal(retentionConfig().oauthTxSweepEnabled, false, `env ${off} disables`);
    }
    for (const on of ["", "1", "yes", "nonsense"]) {
      process.env.RETENTION_OAUTH_TX_SWEEP = on;
      assert.equal(retentionConfig().oauthTxSweepEnabled, true, `env "${on}" stays enabled`);
    }
    process.env.RETENTION_OAUTH_TX_SWEEP = "off"; // suite baseline
  });
});

describe("activity_log sweep (90-day default window, ms cutoff)", () => {
  before(clearAll);

  it("rows strictly older than the cutoff die; rows AT the cutoff instant survive", () => {
    clearAll();
    const cutoff = T - 90 * DAY;
    seedActivity(90 * DAY + 1); // cutoff - 1   → dies
    seedActivity(90 * DAY); //     cutoff       → survives (strict <)
    seedActivity(90 * DAY - 1000); // newer     → survives
    const [row] = runRetentionSweeps({ at: T, overrides: { activityDays: 90 } });
    assert.equal(row.table, "activity_log");
    assert.equal(row.deleted, 1, "only the strictly-older row dies");
    assert.equal(row.batches, 1);
    assert.equal(row.error, null);
    assert.equal(count("activity_log"), 2);
  });

  it("250-row backlog with batch 100 drains in exactly 3 passes", () => {
    clearAll();
    seedActivity(91 * DAY, 250);
    seedActivity(1 * DAY, 3); // survivors
    const [row] = runRetentionSweeps({
      at: T,
      overrides: { activityDays: 90, batchRows: 100 },
    });
    assert.equal(row.deleted, 250);
    assert.equal(row.batches, 3, "100 + 100 + 50");
    assert.equal(row.capped, false);
    assert.equal(count("activity_log"), 3);
  });

  it("max-batches bound stops the sweep (no lockup) and the next sweep drains the rest", () => {
    clearAll();
    seedActivity(91 * DAY, 250);
    const first = runRetentionSweeps({
      at: T,
      overrides: { activityDays: 90, batchRows: 100, maxBatchesPerTable: 2 },
    })[0];
    assert.equal(first.deleted, 200, "bounded at batchRows × maxBatches");
    assert.equal(first.batches, 2);
    assert.equal(first.capped, true);
    assert.equal(count("activity_log"), 50);

    const second = runRetentionSweeps({
      at: T,
      overrides: { activityDays: 90, batchRows: 100, maxBatchesPerTable: 2 },
    })[0];
    assert.equal(second.deleted, 50);
    assert.equal(second.capped, false);
    assert.equal(count("activity_log"), 0);
  });

  it("idle sweep is idempotent and cheap: exactly one batch, zero rows, no log", () => {
    clearAll();
    const { logs } = captureConsole(() => {
      const [row] = runRetentionSweeps({ at: T, overrides: { activityDays: 90 } });
      assert.equal(row.deleted, 0);
      assert.equal(row.batches, 1, "one indexed statement when nothing qualifies");
      assert.equal(row.error, null);
    });
    assert.equal(
      logs.filter((l) => l.includes("[retention] activity_log")).length,
      0,
      "nothing pruned ⇒ nothing logged"
    );
  });

  it("garbage env value falls back to the DEFAULT window instead of disabling", () => {
    clearAll();
    seedActivity(91 * DAY);
    process.env.RETENTION_ACTIVITY_DAYS = "banana";
    try {
      const [row] = runRetentionSweeps({ at: T });
      assert.equal(row.deleted, 1, "default 90d window applied despite garbage");
    } finally {
      process.env.RETENTION_ACTIVITY_DAYS = "off"; // suite baseline
    }
    assert.equal(count("activity_log"), 0);
  });
});

describe("admin_audit sweep (365-day default window)", () => {
  before(clearAll);

  it("rows at exactly the cutoff instant survive; cutoff-1 dies", () => {
    clearAll();
    const cutoff = T - 365 * DAY;
    seedAudit(cutoff - 1); // dies
    seedAudit(cutoff); // survives
    seedAudit(cutoff + 5000); // survives
    const results = runRetentionSweeps({ at: T, overrides: { adminAuditDays: 365 } });
    const row = results.find((r) => r.table === "admin_audit");
    assert.equal(row.deleted, 1);
    assert.equal(row.error, null);
    assert.equal(count("admin_audit"), 2);
  });

  it("batch loop drains a >1-batch backlog (batch 100 → 3 passes over 250 rows)", () => {
    clearAll();
    const old = T - 400 * DAY;
    for (let i = 0; i < 250; i += 1) seedAudit(old + i);
    const row = runRetentionSweeps({
      at: T,
      overrides: { adminAuditDays: 365, batchRows: 100 },
    }).find((r) => r.table === "admin_audit");
    assert.equal(row.deleted, 250);
    assert.equal(row.batches, 3);
    assert.equal(count("admin_audit"), 0);
  });
});

describe("user_channel_message_daily sweep (UTC day-key cutoff)", () => {
  before(clearAll);

  it("rows on the cutoff DAY survive; the day before dies", () => {
    clearAll();
    const cutoffDay = utcDayKey(T - 400 * DAY);
    const dayBefore = utcDayKey(T - 400 * DAY - DAY);
    seedDaily(dayBefore); // dies (day < cutoffDay)
    seedDaily(cutoffDay); // survives (strict <)
    seedDaily(utcDayKey(T)); // newest — survives
    const row = runRetentionSweeps({
      at: T,
      overrides: { dailyAggregatesDays: 400 },
    }).find((r) => r.table === "user_channel_message_daily");
    assert.equal(row.cutoff, cutoffDay, "cutoff is the UTC day key, not epoch ms");
    assert.equal(row.deleted, 1);
    assert.equal(row.error, null);
    assert.equal(count("user_channel_message_daily"), 2);
  });
});

describe("fluxer_oauth_transactions sweep (the #192 bug fix)", () => {
  before(clearAll);

  it("EXPIRED rows die — including one expiring at exactly `at` (consume-filter complement)", () => {
    clearAll();
    seedOauth("a1".padEnd(32, "0"), T - 1); // expired     → dies
    seedOauth("a2".padEnd(32, "0"), T); // expires at at  → dies (expires_at <= at)
    seedOauth("a3".padEnd(32, "0"), T + 1); // live        → survives
    // Consume would refuse row a2 at exactly `at` (needs expires_at > at),
    // so sweeping `<= at` can never race a live callback:
    assert.equal(
      api.consumeOAuthTransaction("a2".padEnd(32, "0"), T),
      null,
      "row expiring exactly at `at` is already unconsumable — sweeping it races nothing"
    );
    const row = runRetentionSweeps({ at: T, overrides: { oauthTxSweepEnabled: true } }).find(
      (r) => r.table === "fluxer_oauth_transactions"
    );
    assert.equal(row.deleted, 2);
    assert.equal(row.error, null);
    assert.equal(count("fluxer_oauth_transactions"), 1);
    // The live row still consumes normally at `at`:
    assert.ok(api.consumeOAuthTransaction("a3".padEnd(32, "0"), T));
  });

  it("batch bound applies here too (batch 100, 250 expired → 3 passes)", () => {
    clearAll();
    for (let i = 0; i < 250; i += 1) {
      // Fixed-width index: padEnd on "b"+i would collide (b2 ↔ b20) and the
      // OR-REPLACE insert would silently drop rows.
      seedOauth(("b" + String(i).padStart(4, "0")).padEnd(32, "0"), T - 1000 - i);
    }
    assert.equal(count("fluxer_oauth_transactions"), 250, "fixture is 250 distinct rows");
    const row = runRetentionSweeps({
      at: T,
      overrides: { batchRows: 100, oauthTxSweepEnabled: true },
    }).find((r) => r.table === "fluxer_oauth_transactions");
    assert.equal(row.deleted, 250);
    assert.equal(row.batches, 3);
    assert.equal(count("fluxer_oauth_transactions"), 0);
  });

  it("createOAuthTransaction opportunistically prunes expired rows (pre-auth growth bound)", () => {
    clearAll();
    // Seed via RAW SQL: an insert through createOAuthTransaction would itself
    // lazy-prune — this simulates rows left by abandoned logins since boot.
    seedOauth("c1".padEnd(32, "0"), Date.now() - 5_000); // expired
    seedOauth("c2".padEnd(32, "0"), Date.now() + 600_000); // live
    const liveNonce = "d1".padEnd(32, "0");
    api.createOAuthTransaction({
      nonce: liveNonce,
      codeVerifier: "v".repeat(43),
      instanceKey: "flx.test",
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    assert.equal(
      api.db
        .prepare(`SELECT COUNT(*) c FROM fluxer_oauth_transactions WHERE nonce=?`)
        .get("c1".padEnd(32, "0")).c,
      0,
      "expired row died on the CREATE path — no sweeper needed"
    );
    assert.ok(
      api.db
        .prepare(`SELECT COUNT(*) c FROM fluxer_oauth_transactions WHERE nonce=?`)
        .get("c2".padEnd(32, "0")),
      "live row untouched"
    );
    assert.ok(
      api.db
        .prepare(`SELECT COUNT(*) c FROM fluxer_oauth_transactions WHERE nonce=?`)
        .get(liveNonce),
      "freshly created row survives its own create-path prune"
    );
    clearAll();
  });
});

describe("disabled knobs + poisoned-table isolation", () => {
  before(clearAll);

  it("override 0 and env off/disable both SKIP the sweep and keep rows forever", () => {
    clearAll();
    seedActivity(400 * DAY); // ancient by any standard
    seedAudit(T - 400 * DAY);
    seedDaily("2000-01-01");
    seedOauth("e1".padEnd(32, "0"), T - 60_000);

    process.env.RETENTION_ADMIN_AUDIT_DAYS = "off";
    process.env.RETENTION_DAILY_AGGREGATES_DAYS = "0";
    process.env.RETENTION_OAUTH_TX_SWEEP = "off";
    try {
      const results = runRetentionSweeps({ at: T, overrides: { activityDays: 0 } });
      for (const row of results) {
        assert.equal(row.skipped, "disabled", `${row.table} skipped`);
        assert.equal(row.deleted, 0);
      }
    } finally {
      process.env.RETENTION_ADMIN_AUDIT_DAYS = "off"; // keep baseline off
      process.env.RETENTION_DAILY_AGGREGATES_DAYS = "off";
      process.env.RETENTION_OAUTH_TX_SWEEP = "off";
    }
    assert.equal(count("activity_log"), 1);
    assert.equal(count("admin_audit"), 1);
    assert.equal(count("user_channel_message_daily"), 1);
    assert.equal(count("fluxer_oauth_transactions"), 1);
  });

  it("ONE poisoned table cannot kill the others ([retention] <table> … failed)", () => {
    clearAll();
    seedActivity(400 * DAY);
    seedAudit(T - 400 * DAY);
    seedDaily("2001-01-01");
    seedOauth("f1".padEnd(32, "0"), T - 60_000);

    const original = api.deleteAdminAuditOlderThan;
    api.deleteAdminAuditOlderThan = () => {
      throw new Error("simulated poison: disk on fire");
    };
    let captured;
    try {
      captured = captureConsole(() =>
        runRetentionSweeps({
          at: T,
          overrides: {
            activityDays: 90,
            adminAuditDays: 365,
            dailyAggregatesDays: 400,
            oauthTxSweepEnabled: true,
          },
        })
      );
    } finally {
      api.deleteAdminAuditOlderThan = original;
    }
    const results = captured.value;
    assert.ok(
      captured.errors.some((l) => l.includes("[retention] admin_audit sweep failed after 0 row(s)")),
      `expected a [retention] admin_audit failure log, got: ${captured.errors.join(" | ")}`
    );
    const rows = Object.fromEntries(results.map((r) => [r.table, r]));
    assert.match(rows.admin_audit.error, /simulated poison/);
    assert.equal(rows.admin_audit.deleted, 0);
    assert.equal(rows.activity_log.deleted, 1, "next tables still sweep");
    assert.equal(rows.user_channel_message_daily.deleted, 1, "previous tables already swept");
    assert.equal(rows.fluxer_oauth_transactions.deleted, 1, "following tables still sweep");
    assert.equal(count("activity_log"), 0);
    assert.equal(count("admin_audit"), 1, "poisoned table keeps its rows (honest partial)");
    assert.equal(count("fluxer_oauth_transactions"), 0);
  });

  it("invalid `at` aborts loudly instead of sweeping on a broken clock", () => {
    clearAll();
    seedActivity(400 * DAY);
    const captured = captureConsole(() =>
      runRetentionSweeps({ at: "not-a-clock", overrides: { activityDays: 90 } })
    );
    assert.ok(
      captured.errors.some((l) => l.includes("[retention] sweep aborted:")),
      `expected the abort log, got: ${captured.errors.join(" | ")}`
    );
    assert.equal(count("activity_log"), 1, "nothing swept on an invalid instant");
    for (const row of captured.value) assert.equal(row.skipped, "invalid-at");
  });
});

describe("retention feature boot wiring", () => {
  it("arms the retentionSweeps job once on the shared scheduler and never throws", () => {
    assert.equal(retention.name, "retention");
    assert.equal(scheduler.getJob(retention.SWEEP_JOB), null, "not armed yet");
    assert.equal(retention.armSweeper(), true, "first arm registers");
    const job = scheduler.getJob(retention.SWEEP_JOB);
    assert.ok(job, "job registered on the shared scheduler");
    assert.equal(job.intervalMs, retention.SWEEP_INTERVAL_MS);
    assert.equal(retention.SWEEP_INTERVAL_MS, 60 * 60 * 1000, "hourly cadence");
    assert.equal(retention.armSweeper(), false, "idempotent — never double-arms");

    // Boot hooks must never throw (load.js wraps them, but the guard holds anyway).
    assert.equal(retention.start(null, {}), undefined);
    assert.equal(retention.registerEvents(null, {}), undefined);
    // Suite env keeps every knob off, so a real tick is four honest skips.
    assert.doesNotThrow(() => job.run());
  });
});
