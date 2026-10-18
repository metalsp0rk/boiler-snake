/**
 * Retention-sweep configuration (audit-2026-10 §2 / §6 P1, issue #192).
 *
 * The three largest tables (`activity_log`, `admin_audit`,
 * `user_channel_message_daily`) had ZERO retention — every mutating action
 * and every daily aggregate lived forever — and expired
 * `fluxer_oauth_transactions` rows could never be deleted at all. This
 * module owns the ONE knob per table plus the batch bounds every sweep
 * shares; the sweeps themselves are src/features/retention/sweeps.js.
 *
 * Env knobs are re-read PER SWEEP (same "apply without a restart" idiom as
 * interactionLogConfig()/ticketSummaryTimeoutMs()), so an operator can
 * disable one table's sweep mid-run. Parsing rules per knob:
 *  - unset/empty      → the documented default (sweep enabled);
 *  - "0" or "off"     → sweep DISABLED for that table (rows kept forever,
 *                       exactly the pre-#192 behaviour, now a choice);
 *  - positive number  → that many days (floored);
 *  - anything else    → the default (garbage never silently disables).
 *
 * Default rationale (documented in docs/configuration.md):
 *  - RETENTION_ACTIVITY_DAYS=90: activity_log feeds XP/decay window checks
 *    (countMessagesInWindow) — all decay windows are ≤ 30 days, so 90 days
 *    is a 3× safety margin; older rows no feature reads.
 *  - RETENTION_ADMIN_AUDIT_DAYS=365: admin_audit IS the durable trail
 *    (§8.1-7). Audit-trail expectations outlast activity hygiene — one year
 *    keeps "when did staff change this?" answerable across a full annual
 *    cycle while bounding a per-mutation table.
 *  - RETENTION_DAILY_AGGREGATES_DAYS=400: 400 days ≥ 13 full UTC calendar
 *    months, so monthly rollups stay continuous for a year-plus of staff
 *    activity summaries; the dashboard's windowed reads are 30 days.
 *  - RETENTION_OAUTH_TX_SWEEP=1: expired login transactions die on their
 *    own `expires_at` (≤10 min old); this knob only exists to let an
 *    operator freeze the sweep while debugging a stuck flow. "0"/"off"
 *    disables it — note the create-path lazy prune
 *    (fluxerOAuthTransactions.js) still bounds rows created AFTER the
 *    disable; that path is the security-shaped growth control and stays
 *    unconditional.
 */

/** Default activity_log retention (days; decay windows are ≤30d). */
const DEFAULT_ACTIVITY_DAYS = 90;
/** Default admin_audit retention (days; full annual audit cycle). */
const DEFAULT_ADMIN_AUDIT_DAYS = 365;
/** Default daily-aggregate retention (days; 13 months of rollups). */
const DEFAULT_DAILY_AGGREGATES_DAYS = 400;
/**
 * Default age before an UNREFERENCED transcript entry under
 * {DATA_DIR}/ticket-transcripts/ is swept (#424, audit LT-10). A healthy
 * archive run takes minutes; 7 days is a >1000x margin over any in-flight
 * run, so a dir with NO tickets row older than this is only ever
 * crash/failure garbage. REFERENCED transcripts (any tickets row) are
 * permanent — the sweep never touches them.
 */
const DEFAULT_TICKET_TRANSCRIPT_ORPHAN_DAYS = 7;

/**
 * Rows per delete batch. A sweep deletes in LIMIT-batched passes so one
 * huge backlog never holds the SQLite writer loop long enough to stall XP
 * writes (audit verification: "batch limits, no-lockup").
 */
const DEFAULT_BATCH_ROWS = 500;
/**
 * Max batches per table PER SWEEP. Together with batch rows this bounds a
 * sweep at DEFAULT_BATCH_ROWS × DEFAULT_MAX_BATCHES_PER_TABLE = 20 000 rows
 * per table; a larger backlog simply finishes on the next sweep.
 */
const DEFAULT_MAX_BATCHES_PER_TABLE = 40;

/** Env names owned by this feature (read PER SWEEP, never cached). */
const ENV_KEYS = Object.freeze([
  "RETENTION_ACTIVITY_DAYS",
  "RETENTION_ADMIN_AUDIT_DAYS",
  "RETENTION_DAILY_AGGREGATES_DAYS",
  "RETENTION_OAUTH_TX_SWEEP",
  "RETENTION_TICKET_TRANSCRIPT_ORPHAN_DAYS",
]);

/** config field ← env name (the mapping pick() needs to stay honest). */
const ENV_BY_FIELD = Object.freeze({
  activityDays: "RETENTION_ACTIVITY_DAYS",
  adminAuditDays: "RETENTION_ADMIN_AUDIT_DAYS",
  dailyAggregatesDays: "RETENTION_DAILY_AGGREGATES_DAYS",
  oauthTxSweepEnabled: "RETENTION_OAUTH_TX_SWEEP",
  ticketTranscriptOrphanDays: "RETENTION_TICKET_TRANSCRIPT_ORPHAN_DAYS",
});

/**
 * Parse one days-knob value.
 * @param {unknown} raw env value (string) / override (string|number)
 * @param {number} fallback default when unset or garbage
 * @returns {number|null} days, or null when the sweep is DISABLED
 *  ("0"/"off" — the only way to keep rows forever)
 */
function parseDaysKnob(raw, fallback) {
  const text = String(raw ?? "").trim().toLowerCase();
  if (text === "") return fallback;
  if (text === "0" || text === "off" || text === "disabled") return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return fallback; // garbage ⇒ default
  return Math.floor(n);
}

/**
 * Effective sweep configuration: env knobs (read NOW) merged with explicit
 * `overrides` (tests / callers win over env). Always returns a complete
 * object — never throws on garbage input.
 *
 * @param {object} [overrides] e.g. {activityDays: 0, batchRows: 100}
 * @returns {{
 *   activityDays: number|null,
 *   adminAuditDays: number|null,
 *   dailyAggregatesDays: number|null,
 *   oauthTxSweepEnabled: boolean,
 *   batchRows: number,
 *   maxBatchesPerTable: number,
 * }}
 */
function retentionConfig(overrides = {}) {
  const pick = (field, fn) => {
    const envName = ENV_BY_FIELD[field];
    if (!envName) throw new Error(`retentionConfig: unknown config field ${field}`);
    return overrides[field] !== undefined
      ? fn(overrides[field])
      : fn(process.env[envName]);
  };

  const batchRows = Math.max(
    1,
    Math.floor(Number(overrides.batchRows) || DEFAULT_BATCH_ROWS)
  );
  const maxBatchesPerTable = Math.max(
    1,
    Math.floor(Number(overrides.maxBatchesPerTable) || DEFAULT_MAX_BATCHES_PER_TABLE)
  );

  return {
    activityDays: pick("activityDays", (v) => parseDaysKnob(v, DEFAULT_ACTIVITY_DAYS)),
    adminAuditDays: pick("adminAuditDays", (v) => parseDaysKnob(v, DEFAULT_ADMIN_AUDIT_DAYS)),
    dailyAggregatesDays: pick(
      "dailyAggregatesDays",
      (v) => parseDaysKnob(v, DEFAULT_DAILY_AGGREGATES_DAYS)
    ),
    oauthTxSweepEnabled:
      pick("oauthTxSweepEnabled", (v) => {
        const text = String(v ?? "").trim().toLowerCase();
        if (text === "") return true;
        return !(text === "0" || text === "off" || text === "false" || text === "disabled");
      }) !== false,
    // #424: orphan transcript-tree sweep age (null = sweep disabled —
    // garbage dirs then survive forever, the explicit pre-fix behaviour).
    ticketTranscriptOrphanDays: pick(
      "ticketTranscriptOrphanDays",
      (v) => parseDaysKnob(v, DEFAULT_TICKET_TRANSCRIPT_ORPHAN_DAYS)
    ),
    batchRows,
    maxBatchesPerTable,
  };
}

module.exports = {
  DEFAULT_ACTIVITY_DAYS,
  DEFAULT_TICKET_TRANSCRIPT_ORPHAN_DAYS,
  DEFAULT_ADMIN_AUDIT_DAYS,
  DEFAULT_DAILY_AGGREGATES_DAYS,
  DEFAULT_BATCH_ROWS,
  DEFAULT_MAX_BATCHES_PER_TABLE,
  ENV_KEYS,
  parseDaysKnob,
  retentionConfig,
};
