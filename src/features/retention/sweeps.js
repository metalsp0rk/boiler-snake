/**
 * Retention sweeps (audit-2026-10 §2 / §6 P1, issue #192).
 *
 * Bounded, per-table pruning for the four unbounded tables:
 *  - `activity_log`                 — rows older than RETENTION_ACTIVITY_DAYS
 *    (uses idx_activity_created_at, the index whose 001 schema comment
 *    already justified it as aiding "pruning");
 *  - `admin_audit`                  — rows older than RETENTION_ADMIN_AUDIT_DAYS;
 *  - `user_channel_message_daily`   — UTC days before the
 *    RETENTION_DAILY_AGGREGATES_DAYS cutoff day;
 *  - `fluxer_oauth_transactions`    — rows past their own `expires_at`
 *    (the #192 bug fix: the only other DELETE, consumeOAuthTransaction,
 *    filters UNexpired rows, so expired ones used to live forever).
 *
 * No-lockup discipline: every delete runs as a LIMIT-batched loop capped at
 * `maxBatchesPerTable` batches per table per sweep (config.js), so even the
 * first sweep against the 64k-row prod table never holds the single SQLite
 * writer loop longer than a handful of small statements. Backlogs beyond
 * the cap finish on the next sweep; the batch loop's final partial pass
 * (deleted 0) keeps an idle sweep to exactly ONE cheap indexed statement
 * per table.
 *
 * Poisoned-table isolation (AGENTS.md error handling, #241 ticker
 * discipline): each table runs inside its own try/catch. A throwing table
 * logs `[retention] <table> sweep failed:` with its partial delete count
 * and the NEXT table still sweeps — one broken table can never kill the
 * others, and runRetentionSweeps itself NEVER throws (the scheduler tick
 * stays safe, same posture as linking's sweeper registration comment).
 *
 * Boundary semantics (locked by test/retention-sweeps.test.js): rows at
 * EXACTLY the cutoff instant/day SURVIVE (strict `<`); expired oauth rows at
 * exactly `at` die (`<=`, the exact complement of consumeOAuthTransaction's
 * `expires_at > at` filter — a row is never simultaneously sweeper-safe and
 * callback-live).
 *
 * `at` is injectable (fake-clock determinism on Node 22 + 24): all expiry
 * arithmetic is `at - days × DAY_MS`, never a hidden Date.now() mid-sweep.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// Lazy require (same cycle doctrine as the repositories): the db facade
// pulls the whole schema, and sweeps only ever touch it at run time. The
// call sites go through the facade OBJECT so tests can patch a poisoned
// table's primitive and observe the isolation.
const db = require("../../db");

// Pure UTC day-key helper from the daily-aggregates repository (no I/O).
const { utcDayKey } = require("../../db/repositories/userChannelActivity");

const { retentionConfig } = require("./config");
const fs = require("node:fs");
const path = require("node:path");
const { dataDir } = require("../../db/connection");

/** Table names in sweep order (the poison-isolation test iterates these). */
const RETENTION_TABLES = Object.freeze([
  "activity_log",
  "admin_audit",
  "user_channel_message_daily",
  "fluxer_oauth_transactions",
]);

/**
 * Per-table spec:
 *  - `daysKey`  config knob (null ⇒ table sweep disabled);
 *  - `cutoff`   "ms" (epoch-ms cutoff) | "day" (YYYY-MM-DD cutoff) |
 *               "expiry" (rows carry their own expiry — no days knob);
 *  - `remove(cutoffValue, limit)` — ONE bounded batch via the facade
 *               primitive (returns rows deleted).
 */
const TABLE_SWEEPS = Object.freeze([
  {
    table: "activity_log",
    daysKey: "activityDays",
    cutoff: "ms",
    remove: (cutoffMs, limit) => db.deleteActivityLogOlderThan(cutoffMs, limit),
  },
  {
    table: "admin_audit",
    daysKey: "adminAuditDays",
    cutoff: "ms",
    remove: (cutoffMs, limit) => db.deleteAdminAuditOlderThan(cutoffMs, limit),
  },
  {
    table: "user_channel_message_daily",
    daysKey: "dailyAggregatesDays",
    cutoff: "day",
    remove: (cutoffDay, limit) =>
      db.deleteDailyAggregatesBeforeDay(cutoffDay, limit),
  },
  {
    table: "fluxer_oauth_transactions",
    daysKey: null, // expiry comes from the rows themselves, not a days knob
    oauthKnob: true, // disabled via oauthTxSweepEnabled
    cutoff: "expiry",
    remove: (atMs, limit) => db.deleteExpiredOAuthTransactions(atMs, limit),
  },
]);

/**
 * Compute one table's cutoff value for `at`.
 * @param {object} spec TABLE_SWEEPS entry
 * @param {number} at sweep instant (ms epoch)
 * @param {number|null} days retention window (unused for "expiry")
 * @returns {number|string} cutoff for spec.remove
 */
function cutoffFor(spec, at, days) {
  if (spec.cutoff === "expiry") return at;
  if (spec.cutoff === "day") return utcDayKey(at - days * DAY_MS);
  return at - days * DAY_MS;
}

/**
 * Run ONE table's batched sweep. Never throws: delete-loop failures land in
 * the returned row with the partial count (caller logs with table name).
 *
 * @param {object} spec TABLE_SWEEPS entry
 * @param {number} at sweep instant (ms epoch)
 * @param {object} config retentionConfig() result
 * @param {object} opts {batchRows, maxBatchesPerTable}
 * @returns {{table: string, deleted: number, batches: number, capped: boolean,
 *            skipped: string|null, cutoff: number|string|null, error: string|null}}
 */
function sweepOneTable(spec, at, config, { batchRows, maxBatchesPerTable }) {
  const result = {
    table: spec.table,
    deleted: 0,
    batches: 0,
    capped: false,
    skipped: null,
    cutoff: null,
    error: null,
  };

  // Knob check — a disabled table is an honest, reported skip.
  if (spec.oauthKnob) {
    if (!config.oauthTxSweepEnabled) {
      result.skipped = "disabled";
      return result;
    }
  } else if (config[spec.daysKey] === null) {
    result.skipped = "disabled";
    return result;
  }

  let cutoff;
  try {
    cutoff = cutoffFor(spec, at, config[spec.daysKey]);
    result.cutoff = cutoff;
  } catch (err) {
    result.error = err?.message || String(err);
    console.error(`[retention] ${spec.table} cutoff computation failed:`, result.error);
    return result;
  }

  try {
    for (;;) {
      const changes = spec.remove(cutoff, batchRows);
      result.batches += 1;
      result.deleted += changes;
      if (changes < batchRows) break; // drained (idle sweep = exactly one batch)
      if (result.batches >= maxBatchesPerTable) {
        result.capped = true; // bounded on purpose — the rest dies next sweep
        break;
      }
    }
  } catch (err) {
    // Poisoned table: report the PARTIAL result with the specific cause.
    // runRetentionSweeps moves on to the next table (never rethrows).
    result.error = err?.message || String(err);
    console.error(
      `[retention] ${spec.table} sweep failed after ${result.deleted} row(s) in ` +
        `${result.batches} batch(es):`,
      result.error
    );
  }
  return result;
}

/**
 * Sweep all four tables. NEVER throws (safe as a scheduler `run` body).
 *
 * @param {object} [options]
 * @param {number} [options.at=Date.now()] sweep instant (ms epoch) — inject
 *   a fake clock in tests for exact boundary determinism.
 * @param {object} [options.overrides] config overrides (win over env),
 *   e.g. {activityDays: 0} to disable one table, {batchRows, maxBatchesPerTable}.
 * @returns {Array<{table: string, deleted: number, batches: number,
 *                  capped: boolean, skipped: string|null,
 *                  cutoff: number|string|null, error: string|null}>}
 *   one row per table, in RETENTION_TABLES order.
 */
/**
 * Transcript token shape: generateTranscriptToken() is crypto.randomUUID(),
 * so an entry name outside this shape is NOT ours to judge — left alone.
 */
const TRANSCRIPT_TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Sweep ORPHAN transcript entries under {DATA_DIR}/ticket-transcripts/
 * (#424, audit LT-10): `{token}/` dirs (nested transcript + assets) and
 * legacy `{token}.html` files whose token matches NO tickets row and whose
 * mtime is past the orphan window. Referenced tokens survive forever
 * (the DB is the reachability truth); young orphans survive (a run may be
 * in flight). This is the tree counterpart of the table sweeps — the
 * archive dirs had NO cleanup at all, so every crashed archive left a
 * permanent tenant on the DB volume.
 *
 * Never throws: one unreadable dir or stuck file logs and moves on
 * (per-entry isolation, same posture as the table sweeps).
 *
 * @param {number} at ms epoch (injected clock)
 * @param {{ticketTranscriptOrphanDays: number|null}} config
 * @param {object} [options]
 * @param {string} [options.root] tree root override (tests)
 * @param {Set<string>} [options.referencedTokens] override for the DB read (tests)
 * @returns {{table: string, deleted: number, batches: number, capped: boolean,
 *   skipped: string|null, cutoff: number|null, error: string|null}}
 */
function sweepOrphanTicketTranscripts(at, config, options = {}) {
  const row = {
    table: "ticket-transcripts",
    deleted: 0,
    batches: 0,
    capped: false,
    skipped: null,
    cutoff: null,
    error: null,
  };
  const days = config?.ticketTranscriptOrphanDays;
  if (days === null || days === undefined) {
    row.skipped = "disabled";
    return row;
  }
  const root = options.root ?? path.join(dataDir, "ticket-transcripts");
  let referenced;
  try {
    referenced =
      options.referencedTokens instanceof Set
        ? options.referencedTokens
        : new Set(db.listTicketTranscriptTokens());
  } catch (err) {
    row.error = err?.message || String(err);
    console.error("[retention] ticket-transcripts: token read failed:", row.error);
    return row;
  }
  const cutoff = at - days * DAY_MS;
  row.cutoff = cutoff;

  let communityDirs;
  try {
    if (!fs.existsSync(root)) return row;
    communityDirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    row.error = err?.message || String(err);
    console.error("[retention] ticket-transcripts: tree walk failed:", row.error);
    return row;
  }

  for (const cidDir of communityDirs) {
    const cdir = path.join(root, cidDir);
    let entries;
    try {
      entries = fs.readdirSync(cdir, { withFileTypes: true });
    } catch (err) {
      console.error(
        `[retention] ticket-transcripts: cannot read ${cdir}:`,
        err?.message || err
      );
      continue;
    }
    for (const ent of entries) {
      let token = null;
      if (ent.isDirectory() && TRANSCRIPT_TOKEN_RE.test(ent.name)) {
        token = ent.name;
      } else if (
        ent.isFile() &&
        ent.name.endsWith(".html") &&
        TRANSCRIPT_TOKEN_RE.test(ent.name.slice(0, -".html".length))
      ) {
        token = ent.name.slice(0, -".html".length);
      }
      if (!token) continue; // not ours (foreign files survive)
      if (referenced.has(token)) continue; // reachable — permanent
      const target = path.join(cdir, ent.name);
      try {
        // Boundary rule mirrors the table sweeps: an entry AT exactly the
        // cutoff instant SURVIVES (strict aging-out only past it).
        if (fs.statSync(target).mtimeMs >= cutoff) continue; // in-flight window
        fs.rmSync(target, { recursive: true, force: true });
        row.deleted += 1;
      } catch (err) {
        console.error(
          `[retention] ticket-transcripts: could not remove ${target}:`,
          err?.message || err
        );
        if (!row.error) row.error = err?.message || String(err);
      }
    }
  }

  if (row.deleted > 0) {
    console.log(
      `[retention] ticket-transcripts: swept ${row.deleted} orphan entr(ies) older than ${days} day(s)`
    );
  }
  return row;
}

function runRetentionSweeps(options = {}) {
  const at = options.at ?? Date.now();
  if (!Number.isSafeInteger(at)) {
    const error = `runRetentionSweeps: at must be an integer ms epoch, got ${String(options.at)}`;
    console.error("[retention] sweep aborted:", error);
    return TABLE_SWEEPS.map((table) => ({
      table,
      deleted: 0,
      batches: 0,
      capped: false,
      skipped: "invalid-at",
      cutoff: null,
      error,
    }));
  }

  const config = retentionConfig(options.overrides || {});

  const results = [];
  for (const spec of TABLE_SWEEPS) {
    try {
      const row = sweepOneTable(spec, at, config, config);
      results.push(row);
      if (row.deleted > 0) {
        console.log(
          `[retention] ${row.table}: pruned ${row.deleted} row(s) in ${row.batches} ` +
            `batch(es)${row.capped ? " — capped, more remain for the next sweep" : ""}`
        );
      } else if (row.error) {
        // Logged inside sweepOneTable with the partial count; nothing more here.
      }
    } catch (err) {
      // Last-resort guard (sweepOneTable already catches the delete loop):
      // a throwing console/config path on ONE table must still let the
      // remaining tables sweep (AGENTS.md ticker isolation, #241).
      const message = err?.message || String(err);
      console.error(`[retention] ${spec.table} sweep failed:`, message);
      results.push({
        table: spec.table,
        deleted: 0,
        batches: 0,
        capped: false,
        skipped: null,
        cutoff: null,
        error: message,
      });
    }
  }

  // #424 (audit LT-10): the transcript TREE beside the DB had no sweep at
  // all — orphan dirs from failed archives lived forever on the DB volume.
  // Own row in the results (tests find() by table name), own never-throw
  // guard (the tree must not be able to kill the ticker, #241 posture).
  try {
    results.push(
      sweepOrphanTicketTranscripts(at, config, options.treeSweep || {})
    );
  } catch (err) {
    const message = err?.message || String(err);
    console.error("[retention] ticket-transcripts sweep failed:", message);
    results.push({
      table: "ticket-transcripts",
      deleted: 0,
      batches: 0,
      capped: false,
      skipped: null,
      cutoff: null,
      error: message,
    });
  }
  return results;
}

module.exports = {
  DAY_MS,
  RETENTION_TABLES,
  cutoffFor,
  sweepOneTable,
  runRetentionSweeps,
  sweepOrphanTicketTranscripts,
  TRANSCRIPT_TOKEN_RE,
};
