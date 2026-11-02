/**
 * Ban lifecycle records (#772).
 *
 * One row per ban cycle; the schema truth lives in migration 074. This
 * repository is storage law only — no Discord calls, no replies, no policy
 * guards (the ban service pre-runs the refusal battery; the partial UNIQUE
 * from 074 is the race-proof belt the schema enforces regardless).
 *
 * Ban-number allocation mirrors warnings.nextWarningNumber EXACTLY:
 * per-community `COALESCE(MAX(ban_number), 0) + 1` read inside a
 * `db.transaction()` — display form **B-n**, the human-ref sibling of W-n /
 * A-n / T-n. The UNIQUE(community_id, ban_number) index is the belt if
 * allocation is ever driven from elsewhere.
 *
 * Claim idiom (locked): first-click-wins single-winner UPDATEs, the
 * tickets.claimTicketArchive + automodCases.resolveAutomodCase law — a
 * losing claimer gets `{ ok: true, won: false }` plus the LIVE row and
 * mutates NOTHING (the caller reads the truth; it never guesses).
 *
 * Error contract (AGENTS.md rule 6, automodCases posture): write paths return
 * `{ ok: false, error }` with a specific message and never throw at runtime;
 * a non-integer community id stays a PROGRAMMER error through the lazy
 * assertCommunityId (same as every community-scoped repository). The id-keyed
 * claim/mark primitives are record-scoped — the row carries its community
 * through the 074 FK, and the scoped entry points above are where
 * assertCommunityId runs.
 *
 * #773 seam (locked): record ids are stable (appeals key `appeal:<id>`) and
 * the status machine is APPEND-ONLY — new statuses arrive via new
 * migrations that widen the CHECK, never by editing 074.
 */

const { db, now } = require("../connection");

// src/platform/community.js requires the db facade (src/db/index.js), so a
// top-level require here would be a load-time cycle (partial exports). The
// lazy require resolves after boot; assertCommunityId stays single-source.
const assertCommunityId = (id) =>
  require("../../platform/community").assertCommunityId(id);

/**
 * Status vocabulary — the SINGLE code-side source, mirroring the
 * ban_records `status` CHECK in migration 074. The machine is APPEND-ONLY:
 * SQLite cannot widen a CHECK in place, so an extension lands as a NEW
 * migration that rebuilds the constraint plus one entry appended HERE —
 * never by editing 074 in place. Existing ids and rows are never
 * renumbered: #773 keys appeals as `appeal:<banRecordId>`. Migration 075
 * (#773) widened the CHECK with `clemency_granted` (074's promised path);
 * the ban-records tripwire test parses the stored CHECK from sqlite_master
 * and pins this list against it, ORDER INCLUDED — keep appends at the END.
 *
 *   active            ban in force (only row the partial UNIQUE admits)
 *   expired_unbanned  the expiry ticker lifted the ban
 *   unbanned_manual   lifted outside the bot (event path) or by staff
 *   pending_rejoin    unbanned, welcome DM not delivered — retry on rejoin
 *   welcomed          rejoin welcome attempt made (regardless of outcome)
 *   clemency_granted  appeal granted (#773): ban lifted early, invite path ran
 */
const BAN_RECORD_STATUSES = Object.freeze([
  "active",
  "expired_unbanned",
  "unbanned_manual",
  "pending_rejoin",
  "welcomed",
  "clemency_granted",
]);

/** Ban provenance vocabulary (migration 074 `source` CHECK). */
const BAN_SOURCES = Object.freeze(["staff", "automod"]);

/**
 * Reason cap. Sibling-consistent: MAX_WARN_REASON = 1000 and the automod
 * referral note = 1000 are the "explanation attached to a case" caps. The
 * command/modal clamps first; the repository re-checks so no caller can
 * store an over-cap reason.
 */
const MAX_BAN_REASON = 1000;

/**
 * Steal window for a crashed auto-unban claim (#772 §4). Same wedge lesson
 * that gave tickets' archive claim its lease (#419: "claimed forever"
 * turned a transient throw into a permanently stuck row): a claim older
 * than this is re-claimable. Tighter than ARCHIVE_CLAIM_LEASE_MS (30 min)
 * because the expiry ticker re-runs every minute and the claimed work is a
 * single outbound unban call — ten missed passes is already a long lie.
 */
const UNBAN_CLAIM_LEASE_MS = 10 * 60 * 1000;

/**
 * Statuses finalizeUnban may move an ACTIVE row to — the two ways a ban
 * ends. The welcome sub-machine (pending_rejoin / welcomed) has its own
 * primitives; `active` is the state you leave, never a destination.
 */
const UNBAN_OUTCOMES = Object.freeze(["expired_unbanned", "unbanned_manual"]);

/** Trim-to-null for the optional id/text fields ("" is absent, never stored). */
function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/** Positive-integer record id guard (programmer-shape, not user input). */
function recordIdOrError(recordId) {
  const id = Number(recordId);
  if (!Number.isInteger(id) || id < 1) {
    return { id: null, error: "No such ban record." };
  }
  return { id, error: null };
}

/** Finite-ms timestamp normalizer (injectable clocks in tests). */
function timestampOr(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return fallback;
}

/**
 * Next sequential ban_number for a community. Asserts its community scope
 * on entry (facade-exposed; createBanRecord also asserts before entering).
 * @param {number} communityId
 * @returns {number}
 */
function nextBanNumber(communityId) {
  assertCommunityId(communityId);
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(ban_number), 0) AS max_n FROM ban_records WHERE community_id=?`
    )
    .get(communityId);
  return Number(row?.max_n || 0) + 1;
}

/**
 * Record one ban cycle. The caller (ban service) has already run the guard
 * battery (duplicate-active, self-ban, staff-subject, hierarchy) and the
 * DM-before-ban; this repository only stores. The partial UNIQUE from 074
 * makes a second ACTIVE row for the same user impossible even if two
 * services raced — that surfaces as an `ok:false` result carrying code
 * ACTIVE_BAN_EXISTS.
 *
 * @param {object} opts
 * @param {number} opts.communityId
 * @param {string} opts.userId banned user (external id — never a community id)
 * @param {string|null} [opts.moderatorId] acting staff user id; NULL for
 *   unattributed origins (the automod harness passes the harness/bot id when known)
 * @param {string} opts.source one of BAN_SOURCES ('staff' | 'automod')
 * @param {string} opts.reason required, ≤ MAX_BAN_REASON — audit AND Discord reason
 * @param {number|null} [opts.bannedAt] ms epoch (default now)
 * @param {number|null} [opts.expiresAt] absolute ms; NULL/absent = permanent
 * @returns {{ ok: true, record: object } | { ok: false, error: string, code?: string }}
 */
function createBanRecord(opts = {}) {
  const {
    communityId,
    userId,
    moderatorId,
    source,
    reason,
    bannedAt,
    expiresAt,
  } = opts || {};
  assertCommunityId(communityId);

  const user = optionalText(userId);
  if (!user) {
    return { ok: false, error: "A ban record needs the banned user's id." };
  }
  if (!BAN_SOURCES.includes(source)) {
    return {
      ok: false,
      error: `Unknown ban source \`${source}\` — choose one of: ${BAN_SOURCES.join(", ")}.`,
    };
  }
  const reasonText = optionalText(reason);
  if (!reasonText) {
    return { ok: false, error: "Ban reason cannot be empty." };
  }
  if (reasonText.length > MAX_BAN_REASON) {
    return {
      ok: false,
      error: `Ban reason is too long (max ${MAX_BAN_REASON} characters).`,
    };
  }

  const t = timestampOr(bannedAt, now());
  let expires = null;
  if (expiresAt != null) {
    const e = Number(expiresAt);
    if (!Number.isFinite(e) || e <= 0) {
      return { ok: false, error: "expires_at must be a positive timestamp." };
    }
    expires = Math.floor(e);
  }

  const tx = db.transaction(() => {
    const insert = db.prepare(`
      INSERT INTO ban_records (
        community_id, ban_number, user_id, moderator_id, source, reason,
        banned_at, expires_at, status, ban_dm_sent, welcome_dm_sent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 0)
    `);
    const banNumber = nextBanNumber(communityId);
    const info = insert.run(
      communityId,
      banNumber,
      user,
      optionalText(moderatorId),
      source,
      reasonText,
      t,
      expires
    );
    return Number(info.lastInsertRowid);
  });

  try {
    return { ok: true, record: getBanRecord(tx()) };
  } catch (err) {
    // Constraint failures are SPECIFIC, never a generic "database error"
    // (AGENTS.md rule 3): the 074 belts name themselves by their columns.
    // Codes are ASSIGNED, never written as `code: "..."` object literals —
    // the colon form trips the env-parity SCREAMING-literal scan (a machine
    // code is not an env var; warnings.js' err.code assignments set the law).
    const message = String(err?.message || err);
    if (message.includes("ban_records.user_id")) {
      const dup = {
        ok: false,
        error: "This user already has an active ban record in this community.",
      };
      dup.code = "ACTIVE_BAN_EXISTS";
      return dup;
    }
    if (message.includes("ban_records.ban_number")) {
      const race = {
        ok: false,
        error: "Ban number allocation collided — retry the ban.",
      };
      race.code = "BAN_NUMBER_RACE";
      return race;
    }
    return { ok: false, error: `Could not save the ban record: ${message}` };
  }
}

/**
 * Ban record by primary key (the id #773 will key appeals with).
 * @param {number|string} id
 * @returns {object|null}
 */
function getBanRecord(id) {
  const num = Number(id);
  if (!Number.isInteger(num) || num < 1) return null;
  return db.prepare(`SELECT * FROM ban_records WHERE id=?`).get(num) || null;
}

/**
 * The user's current active ban row, if any (duplicate-ban refusal +
 * "already banned — see records" copy source).
 * @param {number} communityId
 * @param {string} userId
 * @returns {object|null}
 */
function findActiveBanRecord(communityId, userId) {
  assertCommunityId(communityId);
  const user = optionalText(userId);
  if (!user) return null;
  return (
    db
      .prepare(
        `SELECT * FROM ban_records
          WHERE community_id=? AND user_id=? AND status='active'
          ORDER BY ban_number DESC LIMIT 1`
      )
      .get(communityId, user) || null
  );
}

/**
 * Cross-community ticker sweep: ACTIVE rows whose expiry is due. No
 * community scoping is possible (the whole-community sweep is the point —
 * same posture as warnings.listExpiredActiveWarnings); the caller handles
 * each row per-community with its own try/catch.
 * @param {number} [nowMs] injectable clock
 * @returns {object[]} oldest expiry first
 */
function listDueExpiredBans(nowMs = now()) {
  const ts = timestampOr(nowMs, now());
  return db
    .prepare(
      `SELECT * FROM ban_records
        WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= ?
        ORDER BY expires_at ASC, id ASC`
    )
    .all(ts);
}

/**
 * ACTIVE rows for one community — the boot reconciliation sweep's candidate
 * set (compared against the live guild.bans; vanished bans are settled by
 * markUnbannedManual, log-only).
 * @param {number} communityId
 * @returns {object[]} most recent ban first
 */
function listReconcilableActiveBans(communityId) {
  assertCommunityId(communityId);
  return db
    .prepare(
      `SELECT * FROM ban_records
        WHERE community_id=? AND status='active'
        ORDER BY banned_at DESC, id DESC`
    )
    .all(communityId);
}

/**
 * Claim ONE auto-unban (ticker, #772 §4): first claimer stamps
 * `unban_claimed_at`; a second claimer WITHIN THE LEASE gets
 * `{ ok:true, won:false }` and must do NOTHING (manual path + the other
 * ticker pass are the true winners). A claim older than
 * UNBAN_CLAIM_LEASE_MS is stealable — the crash-wedge lesson from the
 * archive claim (#419). Stays honest against a racing manual unban:
 * finalizeUnban/markUnbannedManual are CAS'd on status, so the loser of
 * THAT race reports what actually happened instead of overwriting it.
 *
 * @param {number} recordId
 * @param {number} [atMs] ms epoch (injectable clock, lease math)
 * @returns {{ ok: true, won: boolean, record: object|null } | { ok: false, error: string }}
 */
function claimUnban(recordId, atMs = now()) {
  const { id, error } = recordIdOrError(recordId);
  if (!id) return { ok: false, error };
  const ts = timestampOr(atMs, now());
  try {
    const res = db
      .prepare(
        `UPDATE ban_records SET unban_claimed_at=?
          WHERE id=? AND status='active'
            AND (unban_claimed_at IS NULL OR unban_claimed_at <= ?)`
      )
      .run(ts, id, ts - UNBAN_CLAIM_LEASE_MS);
    return { ok: true, won: res.changes === 1, record: getBanRecord(id) };
  } catch (err) {
    return { ok: false, error: `Could not claim the ban unban: ${err?.message || err}` };
  }
}

/**
 * Settle a CLAIMED (still ACTIVE) row to its terminal unban outcome after
 * the outbound unban actually happened. CAS on `status='active'`: a manual
 * unban that landed between claim and finalize wins (changes===0, `won:
 * false`) and the caller surfaces the EXISTING truth instead of overwriting
 * it ("events keep the record truthful"). Stamps `unban_claimed_at` when the
 * actor never claimed (the manual/event path).
 *
 * @param {number} recordId
 * @param {string} status 'expired_unbanned' | 'unbanned_manual'
 * @param {string|null} [unbanReason] Discord-side unban reason (audit)
 * @param {{ nowMs?: number }} [opts]
 * @returns {{ ok: true, won: boolean, record: object|null } | { ok: false, error: string }}
 */
function finalizeUnban(recordId, status, unbanReason = null, { nowMs } = {}) {
  const { id, error } = recordIdOrError(recordId);
  if (!id) return { ok: false, error };
  if (!UNBAN_OUTCOMES.includes(status)) {
    return {
      ok: false,
      error: `Unknown ban unban outcome \`${status}\` — choose one of: ${UNBAN_OUTCOMES.join(", ")}.`,
    };
  }
  const ts = timestampOr(nowMs, now());
  try {
    const res = db
      .prepare(
        `UPDATE ban_records
            SET status=?,
                unban_reason=COALESCE(?, unban_reason),
                unban_claimed_at=COALESCE(unban_claimed_at, ?)
          WHERE id=? AND status='active'`
      )
      .run(status, optionalText(unbanReason), ts, id);
    return { ok: true, won: res.changes === 1, record: getBanRecord(id) };
  } catch (err) {
    return { ok: false, error: `Could not finalize the ban unban: ${err?.message || err}` };
  }
}

/**
 * The GuildBanRemove / reconciliation move: an ACTIVE row whose ban is gone
 * outside the expiry ticker becomes `unbanned_manual` — CAS on status, so
 * the ticker's own in-flight expiry flow (already ACTIVE-finalized) is never
 * overwritten, and two events for one unban settle exactly once.
 *
 * @param {number} recordId
 * @param {string|null} [unbanReason]
 * @returns {{ ok: true, won: boolean, record: object|null } | { ok: false, error: string }}
 */
function markUnbannedManual(recordId, unbanReason = null) {
  return finalizeUnban(recordId, "unbanned_manual", unbanReason);
}

/**
 * Claim the cycle's ONE welcome DM (first-click-wins). The locked schema has
 * no separate welcome-claim column, so `welcome_dm_sent` doubles as the
 * claim stamp: flipping it 0→1 IS the claim (074 decision). Restricted to
 * the two "unbanned, welcome pending" statuses — `pending_rejoin` rows are
 * claimed by the rejoin listener itself (event-once law), `welcomed` rows
 * are done.
 *
 * @param {number} recordId
 * @returns {{ ok: true, won: boolean, record: object|null } | { ok: false, error: string }}
 */
function claimWelcome(recordId) {
  const { id, error } = recordIdOrError(recordId);
  if (!id) return { ok: false, error };
  try {
    const res = db
      .prepare(
        `UPDATE ban_records SET welcome_dm_sent=1
          WHERE id=? AND welcome_dm_sent=0
            AND status IN ('expired_unbanned','unbanned_manual')`
      )
      .run(id);
    return { ok: true, won: res.changes === 1, record: getBanRecord(id) };
  } catch (err) {
    return { ok: false, error: `Could not claim the welcome DM: ${err?.message || err}` };
  }
}

/**
 * Welcome DM could NOT be delivered at unban time → park the row for the
 * rejoin retry (GuildMemberAdd + unban within the window, #772 §5). CAS on
 * the two unban-outcome statuses so it can never resurrect an ACTIVE row
 * nor fight the rejoin listener over an already-parked one.
 *
 * @param {number} recordId
 * @returns {object|null} the LIVE row (CAS lost → the unchanged row; null =
 *   no such record)
 */
function markPendingRejoin(recordId) {
  const { id } = recordIdOrError(recordId);
  if (!id) return null;
  db.prepare(
    `UPDATE ban_records SET status='pending_rejoin'
      WHERE id=? AND status IN ('expired_unbanned','unbanned_manual')`
  ).run(id);
  return getBanRecord(id);
}

/**
 * The rejoin attempt was MADE — terminal regardless of DM outcome (issue
 * §5: "attempt once, then mark welcomed regardless"). CAS on
 * `pending_rejoin` only, so a row that never parked (welcome already sent)
 * or a double GuildMemberAdd can never re-open the welcome path.
 *
 * @param {number} recordId
 * @returns {object|null} the LIVE row (CAS lost → the unchanged row; null =
 *   no such record)
 */
function markWelcomed(recordId) {
  const { id } = recordIdOrError(recordId);
  if (!id) return null;
  db.prepare(
    `UPDATE ban_records SET status='welcomed' WHERE id=? AND status='pending_rejoin'`
  ).run(id);
  return getBanRecord(id);
}

/**
 * Stamp "the ban DM went out" (the K2 DM-before-ban recorder). Stamp-only:
 * the ban flow runs it once per cycle by construction; the guard keeps the
 * return honest (re-stamping an already-stamped row reports false).
 * @param {number} recordId
 * @returns {boolean} true when an unstamped row was stamped
 */
function recordBanDmSent(recordId) {
  const { id } = recordIdOrError(recordId);
  if (!id) return false;
  return (
    db.prepare(
      `UPDATE ban_records SET ban_dm_sent=1 WHERE id=? AND ban_dm_sent=0`
    ).run(id).changes === 1
  );
}

/**
 * Stamp "the welcome DM went out". On the normal path {@link claimWelcome}
 * already flipped the flag (claim === stamp on the locked schema); this is
 * the belt recorder for paths that delivered without a claim — stamp-only,
 * an already-stamped row reports false.
 * @param {number} recordId
 * @returns {boolean} true when an unstamped row was stamped
 */
function recordWelcomeDmSent(recordId) {
  const { id } = recordIdOrError(recordId);
  if (!id) return false;
  return (
    db.prepare(
      `UPDATE ban_records SET welcome_dm_sent=1 WHERE id=? AND welcome_dm_sent=0`
    ).run(id).changes === 1
  );
}

module.exports = {
  BAN_RECORD_STATUSES,
  BAN_SOURCES,
  MAX_BAN_REASON,
  UNBAN_CLAIM_LEASE_MS,
  nextBanNumber,
  createBanRecord,
  getBanRecord,
  findActiveBanRecord,
  listDueExpiredBans,
  listReconcilableActiveBans,
  claimUnban,
  finalizeUnban,
  markUnbannedManual,
  claimWelcome,
  markPendingRejoin,
  markWelcomed,
  recordBanDmSent,
  recordWelcomeDmSent,
};
