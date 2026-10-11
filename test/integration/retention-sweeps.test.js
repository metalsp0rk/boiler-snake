const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("../helpers/env");

/**
 * Integration: retention sweeps end-to-end (audit-2026-10 #192).
 *
 * Proves the two audit claims die in the FULL stack, not just repo calls:
 *  1. `fluxer_oauth_transactions` expired rows ACTUALLY get deleted — driven
 *     through the real pre-auth Fluxer web-login START path (real handler,
 *     real state HMAC, real repository write), aged with a stubbed Date.now
 *     (fake clock ⇒ deterministic on Node 22 + 24), then swept. Includes the
 *     CREATE-path opportunistic prune (unauthenticated growth bound).
 *  2. A disabled knob (RETENTION_OAUTH_TX_SWEEP=0) is respected — rows live.
 *  3. The other three tables sweep end-to-end through their REAL writers
 *     (logActivity / insertAdminAudit / incrementDaily), aged via SQL UPDATE
 *     fake-clock arithmetic, with DEFAULT knobs (no overrides anywhere).
 *  4. Boot wiring: `retention` is in the feature list and start() arms the
 *     scheduler job, whose tick completes without error.
 *
 * CONTRACT: loadDb() above every src/ require (temp DB, cache reset).
 */
const loaded = loadDb();
const api = loaded.api;

const { runRetentionSweeps } = require("../../src/features/retention/sweeps");
const retention = require("../../src/features/retention");
const scheduler = require("../../src/core/scheduler");
const loginMod = require("../../src/web/auth/login");
const { fluxerInstanceSlug } = require("../../src/web/auth/fluxerApi");
const { utcDayKey, utcDayKeyDaysAgo } = require("../../src/db/repositories/userChannelActivity");

const DAY = 24 * 60 * 60 * 1000;
const TX_LIFETIME_MS = 10 * 60 * 1000; // mirrors FLUXER_TX_LIFETIME_MS in login.js

// Clearly-fake placeholders only (AGENTS.md).
const FAKE_STATE_SECRET = "test-r…tion";
const INSTANCE_KEY = "https://flx.retro.test";

const ENV_KEYS = [
  "RETENTION_ACTIVITY_DAYS",
  "RETENTION_ADMIN_AUDIT_DAYS",
  "RETENTION_DAILY_AGGREGATES_DAYS",
  "RETENTION_OAUTH_TX_SWEEP",
  "PUBLIC_BASE_URL",
  "OAUTH_STATE_SECRET",
  "CLIENT_SECRET",
];

let savedEnv;
let cid;
let slug;
let authorizeArgs;

function oauthRows() {
  return api.db
    .prepare(`SELECT nonce, expires_at FROM fluxer_oauth_transactions ORDER BY expires_at`)
    .all();
}

function clearAll() {
  for (const t of [
    "activity_log",
    "admin_audit",
    "user_channel_message_daily",
    "fluxer_oauth_transactions",
  ]) {
    api.db.prepare(`DELETE FROM ${t}`).run();
  }
}

/** Drive the REAL login-start handler with a captured response. */
function driveLoginStart() {
  const out = { statusCode: null, headers: {}, body: "" };
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      out.statusCode = status;
      Object.assign(out.headers, headers || {});
      res.headersSent = true;
    },
    end(body) {
      out.body = body == null ? "" : String(body);
    },
  };
  loginMod
    .createFluxerLoginHandlers({
      fluxerInstances: () => [
        {
          instanceKey: INSTANCE_KEY,
          label: "Retro Fluxer",
          clientId: "retro-client-id",
          clientSecret: "retro-client-secret",
          apiBase: "https://flx.retro.test/v1",
        },
      ],
      // Pure URL builder — every SECURITY surface that matters (signed state,
      // SQLite verifier row via the REAL store) stays real.
      apiFactory: () => ({
        buildAuthorizeUrl: (args) => {
          authorizeArgs = args;
          return `https://flx.retro.test/oauth2/authorize?state=${encodeURIComponent(args.state)}`;
        },
      }),
    })
    .startFluxerLogin({ url: `/auth/fluxer/${slug}/login`, params: { slug } }, res);
  return out;
}

/**
 * Run `fn` with Date.now rewound `msIntoPast` (fake clock ⇒ the handler
 * itself computes a transaction row that is ALREADY expired against the
 * real wall clock).
 */
function withClockOffset(msIntoPast, fn) {
  const realNow = Date.now;
  Date.now = () => realNow() - msIntoPast;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

before(() => {
  savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
  process.env.PUBLIC_BASE_URL = "https://bot.retro.test";
  process.env.OAUTH_STATE_SECRET = FAKE_STATE_SECRET;
  delete process.env.CLIENT_SECRET;
  for (const k of ["RETENTION_ACTIVITY_DAYS", "RETENTION_ADMIN_AUDIT_DAYS", "RETENTION_DAILY_AGGREGATES_DAYS", "RETENTION_OAUTH_TX_SWEEP"]) {
    delete process.env[k]; // ⇒ DEFAULT knobs for the e2e sweeps
  }
  cid = communityKey("990000000000000001");
  slug = fluxerInstanceSlug(INSTANCE_KEY);
});

after(() => {
  scheduler.stop(retention.SWEEP_JOB);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  loaded.cleanup();
});

describe("fluxer_oauth_transactions dies end-to-end (the #192 bug)", () => {
  before(clearAll);

  it("pre-auth login start → fake-clock age → sweep → gone (live row survives)", () => {
    // Live login (real clock): row valid for ~10 minutes.
    const liveRes = driveLoginStart();
    assert.equal(liveRes.statusCode, 302, "login start works (pre-auth!)");
    assert.equal(oauthRows().length, 1, "the pre-auth path wrote the verifier row");

    // Aged login: Date.now rewound past the 10-min transaction lifetime.
    withClockOffset(TX_LIFETIME_MS + 60_000, driveLoginStart);
    const rows = oauthRows();
    assert.equal(rows.length, 2);
    const aged = rows.find((r) => r.expires_at <= Date.now());
    const live = rows.find((r) => r.expires_at > Date.now());
    assert.ok(aged, "fake clock produced an already-expired row");
    assert.ok(live, "real-clock login still live");
    assert.equal(
      api.consumeOAuthTransaction(aged.nonce),
      null,
      "the aged row is already dead to callbacks — exactly the rows that used to live forever"
    );

    const results = runRetentionSweeps(); // DEFAULT knobs, real clock
    const row = results.find((r) => r.table === "fluxer_oauth_transactions");
    assert.equal(row.error, null);
    assert.equal(row.skipped, null);
    assert.equal(row.deleted, 1, "the expired row died to the sweep");

    const left = oauthRows();
    assert.equal(left.length, 1);
    assert.equal(left[0].nonce, live.nonce, "live row untouched");
    assert.ok(authorizeArgs?.codeChallenge, "login really minted PKCE (sanity: real handler ran)");
    assert.match(authorizeArgs.state, /\./, "signed state blob on the redirect");
  });

  it("a NEW login start opportunistically kills expired rows (unbounded-growth bound)", () => {
    clearAll();
    // Drop an expired row in via the pre-auth path (fake clock)…
    withClockOffset(TX_LIFETIME_MS + 60_000, driveLoginStart);
    assert.equal(oauthRows().length, 1);
    // …then start ANOTHER login at the real clock. NO sweeper involved:
    const res = driveLoginStart();
    assert.equal(res.statusCode, 302);
    const rows = oauthRows();
    assert.equal(rows.length, 1, "the create-path lazy prune deleted the expired row");
    assert.ok(rows[0].expires_at > Date.now(), "the survivor is the fresh live row");
    clearAll();
  });

  it("disabled knob: RETENTION_OAUTH_TX_SWEEP=0 respects the operator and keeps rows", () => {
    clearAll();
    process.env.RETENTION_OAUTH_TX_SWEEP = "0";
    try {
      withClockOffset(TX_LIFETIME_MS + 60_000, driveLoginStart);
      assert.equal(oauthRows().length, 1, "expired row seeded via the pre-auth path");
      const results = runRetentionSweeps();
      const row = results.find((r) => r.table === "fluxer_oauth_transactions");
      assert.equal(row.skipped, "disabled");
      assert.equal(row.deleted, 0);
      assert.equal(oauthRows().length, 1, "row survives while the knob is off");
    } finally {
      delete process.env.RETENTION_OAUTH_TX_SWEEP;
    }
    // Re-enabled (default): the very next sweep deletes it.
    const results = runRetentionSweeps();
    assert.equal(
      results.find((r) => r.table === "fluxer_oauth_transactions").deleted,
      1
    );
    clearAll();
  });
});

describe("activity_log / admin_audit / daily aggregates via real writers (default knobs)", () => {
  before(clearAll);

  it("old rows die, recent rows survive — all three tables, no overrides", () => {
    // REAL writers first, then fake-clock age via SQL (what an old row looks like).
    api.logActivity(cid, "u-e2e", "message", 5); // real insert path
    api.logActivity(cid, "u-e2e", "message", 5);
    api.db
      .prepare(
        `UPDATE activity_log SET created_at = created_at - ? WHERE rowid =
         (SELECT MIN(rowid) FROM activity_log WHERE community_id = ?)`
      )
      .run(91 * DAY, cid); // aged past the 90-day default

    api.insertAdminAudit({ communityId: cid, origin: "system", action: "retention.e2e" });
    api.insertAdminAudit({ communityId: cid, origin: "system", action: "retention.e2e" });
    api.db
      .prepare(
        `UPDATE admin_audit SET created_at = created_at - ? WHERE id =
         (SELECT MIN(id) FROM admin_audit WHERE community_id = ?)`
      )
      .run(366 * DAY, cid); // aged past the 365-day default

    api.incrementDaily(cid, "u-e2e", "ch-e2e", utcDayKeyDaysAgo(401)); // beyond 400d
    api.incrementDaily(cid, "u-e2e", "ch-e2e", utcDayKey()); // today

    const results = runRetentionSweeps();
    for (const row of results) {
      assert.equal(row.error, null, `${row.table} swept clean`);
      assert.equal(row.skipped, null, `${row.table} enabled by default`);
    }
    assert.ok(
      results.find((r) => r.table === "activity_log").deleted >= 1
    );
    assert.equal(api.db.prepare(`SELECT COUNT(*) c FROM activity_log`).get().c, 1);
    assert.equal(
      api.db.prepare(`SELECT COUNT(*) c FROM admin_audit WHERE community_id=?`).get(cid).c,
      1
    );
    const days = api.db
      .prepare(
        `SELECT day FROM user_channel_message_daily WHERE community_id=? ORDER BY day`
      )
      .all(cid)
      .map((r) => r.day);
    assert.deepEqual(days, [utcDayKey()], "only the 401-day-old aggregate died");
  });
});

describe("boot wiring", () => {
  it("retention is a registered feature and start() arms the scheduler job", () => {
    const features = require("../../src/features");
    assert.ok(
      features.some((f) => f.name === "retention"),
      "src/features/index.js must boot the retention feature"
    );

    // Freeze all knobs so the immediate/job ticks below are honest skips —
    // this test proves WIRING, not deletion (the sweeps have their own tests).
    for (const k of ["RETENTION_ACTIVITY_DAYS", "RETENTION_ADMIN_AUDIT_DAYS", "RETENTION_DAILY_AGGREGATES_DAYS", "RETENTION_OAUTH_TX_SWEEP"]) {
      process.env[k] = "off";
    }

    assert.equal(scheduler.getJob(retention.SWEEP_JOB), null, "not armed before start()");
    assert.equal(retention.start(null, {}), undefined);
    const job = scheduler.getJob(retention.SWEEP_JOB);
    assert.ok(job, "job armed on the shared core scheduler");
    assert.equal(job.intervalMs, retention.SWEEP_INTERVAL_MS);

    // One full scheduler tick: the run body must settle without error.
    scheduler.runNow(retention.SWEEP_JOB);
    return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
      assert.equal(scheduler.getJob(retention.SWEEP_JOB).lastError, null);
    });
  });
});
