/**
 * Ban appeals (#773).
 *
 * One row per appealable ban cycle; the schema truth lives in migration 075.
 * This repository is storage law only — no Discord calls, no replies, no
 * policy guards (the feature layer runs the intake battery: guild setting,
 * record active, presser identity; the UNIQUE ban_record_id from 075 is the
 * race-proof one-appeal-per-cycle belt the schema enforces regardless).
 *
 * Claim idiom (locked, banRecords/tickets/automodCases law): the outcome
 * claim is a first-decision-wins single-winner UPDATE — `WHERE status=
 * 'open'`. A losing claimer gets `{ ok: true, won: false }` plus the LIVE
 * row and mutates NOTHING (the caller reads what actually happened — clemency
 * vs deny vs plain-close — instead of guessing).
 *
 * Error contract (AGENTS.md rule 6, banRecords posture): write paths return
 * `{ ok: false, error }` with a specific message and never throw at runtime;
 * a non-integer community id stays a PROGRAMMER error through the lazy
 * assertCommunityId (same as every community-scoped repository). The id-
 * keyed claim/stamp primitives are appeal-scoped — the row carries its
 * community through the 075 FK, and the scoped entry points above are where
 * assertCommunityId runs.
 *
 * Cursor law: one persisted (message id, timestamp) pair PER DIRECTION
 * (`user` = last relayed user→ticket message, `ticket` = last relayed
 * ticket→user message). Saves are last-write-wins (the relay is single-flow
 * per direction — CAS there would only add a wedge); a save always writes
 * the pair, never half of it. Pause is ferry-only state with NO status
 * coupling: silencing the relay never decides anything, deciding always
 * stops the relay (via the status guard in the feature).
 */

const { db, now } = require("../connection");

// src/platform/community.js requires the db facade (src/db/index.js), so a
// top-level require here would be a load-time cycle (partial exports). The
// lazy require resolves after boot; assertCommunityId stays single-source
// (same law as banRecords.js).
const assertCommunityId = (id) =>
  require("../../platform/community").assertCommunityId(id);

/**
 * Status vocabulary — the SINGLE code-side source, mirroring the ban_appeals
 * `status` CHECK in migration 075 (append-only machine: an extension lands
 * as a NEW migration widening the CHECK plus one entry appended HERE).
 *
 *   filed    intake landed (statement stored), staff ticket not yet created
 *   open     ticket channel attached, ferry relay live
 *   granted  clemency: ban lifted early via the appeal outcome claim
 *   denied   staff refused the appeal (denial_reason may carry the why)
 *   closed   plain-closed without a decision (neutral-notice path)
 */
const BAN_APPEAL_STATUSES = Object.freeze([
  "filed",
  "open",
  "granted",
  "denied",
  "closed",
]);

/**
 * Statuses the outcome claim may move an OPEN appeal to — the three decided
 * endings. `filed`/`open` are states you leave or pass through, never claim
 * destinations (mirrors banRecords' UNBAN_OUTCOMES posture: CLOSED domain,
 * refusal message teaches the domain).
 */
const APPEAL_OUTCOMES = Object.freeze(["granted", "denied", "closed"]);

/** Ferry relay directions (075's cursor columns key on exactly these). */
const FERRY_DIRECTIONS = Object.freeze(["user", "ticket"]);

/**
 * Appeal statement cap: the Discord MODAL text-input hard limit. The intake
 * modal clamps first; the repository re-checks so no caller can store an
 * over-cap statement (a cap the platform can never present is a cap that
 * never refuses a real appellant).
 */
const MAX_APPEAL_STATEMENT = 4000;

/**
 * Denial reason cap. Sibling-consistent: MAX_BAN_REASON = MAX_WARN_REASON =
 * 1000 are the "explanation attached to a case" caps. The modal clamps
 * first; the repository re-checks.
 */
const MAX_DENIAL_REASON = 1000;

/** Direction → 075 cursor columns (closed set — never a user-supplied identifier). */
const CURSOR_COLUMNS = Object.freeze({
  user: Object.freeze({ msgColumn: "ferry_user_msg_id", tsColumn: "ferry_user_ts" }),
  ticket: Object.freeze({ msgColumn: "ferry_ticket_msg_id", tsColumn: "ferry_ticket_ts" }),
});

/** Trim-to-null for the optional id/text fields ("" is absent, never stored). */
function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/** Positive-integer appeal id guard (programmer-shape, not user input). */
function appealIdOrError(appealId) {
  const id = Number(appealId);
  if (!Number.isInteger(id) || id < 1) {
    return { id: null, error: "No such ban appeal." };
  }
  return { id, error: null };
}

/** Positive-integer ban-record id guard, intake wording. */
function banRecordIdOrError(banRecordId) {
  const id = Number(banRecordId);
  if (!Number.isInteger(id) || id < 1) {
    return { id: null, error: "A ban appeal needs the ban record id." };
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
 * Strict on/off normalizer for the ferry-pause toggle: null means
 * "unrecognized — refuse". Unlike the ban-notice flags there is no
 * default-ON posture to fall back to: a misread here either silences the
 * relay or leaves it running, so a garbage value must be named, never
 * guessed.
 */
function toPausedFlag(value) {
  if (value === false || value === 0 || value === "0" || value === "off") return 0;
  if (value === true || value === 1 || value === "1" || value === "on") return 1;
  return null;
}

/**
 * Appeal a ban cycle. The caller (intake) has already run the validation
 * battery (presser identity, record active, guild setting ON, one modal
 * submission per press); this repository only stores — plus the honest
 * existence/membership read so a forged or stale customId gets a NAMED
 * refusal instead of an FK crash. The 075 UNIQUE on ban_record_id makes a
 * second appeal for the same cycle impossible even if two presses raced —
 * that surfaces as an `ok:false` result carrying code APPEAL_EXISTS.
 *
 * @param {object} opts
 * @param {number} opts.communityId
 * @param {number|string} opts.banRecordId stable ban_records id (the `appeal:<id>` seam)
 * @param {string} opts.appealStatement required, ≤ MAX_APPEAL_STATEMENT
 * @param {number} [opts.createdAt] ms epoch (default now)
 * @returns {{ ok: true, appeal: object } | { ok: false, error: string, code?: string }}
 */
function fileAppeal(opts = {}) {
  const { communityId, banRecordId, appealStatement, createdAt } = opts || {};
  assertCommunityId(communityId);

  const { id: recordId, error: recordErr } = banRecordIdOrError(banRecordId);
  if (!recordId) return { ok: false, error: recordErr };

  const statement = optionalText(appealStatement);
  if (!statement) {
    return { ok: false, error: "An appeal needs a written statement to review." };
  }
  if (statement.length > MAX_APPEAL_STATEMENT) {
    return {
      ok: false,
      error: `Your appeal is too long (max ${MAX_APPEAL_STATEMENT} characters).`,
    };
  }

  // Storage-integrity law (not feature policy): the row must bind to a REAL
  // record in THIS community — a cross-community linkage would sail through
  // the FK and haunt every community-scoped read.
  const record = db
    .prepare(`SELECT community_id FROM ban_records WHERE id=?`)
    .get(recordId);
  if (!record) {
    return { ok: false, error: "No such ban record to appeal." };
  }
  if (Number(record.community_id) !== Number(communityId)) {
    return { ok: false, error: "That ban record belongs to another community." };
  }

  const t = timestampOr(createdAt, now());
  try {
    const info = db
      .prepare(
        `INSERT INTO ban_appeals (
           community_id, ban_record_id, status, appeal_statement,
           ferry_paused, created_at, updated_at
         ) VALUES (?, ?, 'filed', ?, 0, ?, ?)`,
      )
      .run(communityId, recordId, statement, t, t);
    return { ok: true, appeal: getAppealById(info.lastInsertRowid) };
  } catch (err) {
    // Constraint failures are SPECIFIC, never a generic "database error"
    // (AGENTS.md rule 3): the 075 belt names its own column. Codes are
    // ASSIGNED, never written as `code: "..."` object literals — the colon
    // form trips the env-parity SCREAMING-literal scan.
    const message = String(err?.message || err);
    if (message.includes("ban_appeals.ban_record_id")) {
      const dup = {
        ok: false,
        error: "This ban already has an appeal — one appeal per ban cycle.",
      };
      dup.code = "APPEAL_EXISTS";
      return dup;
    }
    if (message.includes("FOREIGN KEY")) {
      return {
        ok: false,
        error: "The ban record behind this appeal no longer exists — nothing was filed.",
      };
    }
    return { ok: false, error: `Could not save the ban appeal: ${message}` };
  }
}

/**
 * Appeal by primary key (the id the in-ticket `ap:*` customIds carry).
 * @param {number|string} id
 * @returns {object|null}
 */
function getAppealById(id) {
  const num = Number(id);
  if (!Number.isInteger(num) || num < 1) return null;
  return db.prepare(`SELECT * FROM ban_appeals WHERE id=?`).get(num) || null;
}

/**
 * The appeal bound to a staff ticket channel (ferry routing + plain-close
 * detection). Community-scoped by design: every caller resolves its
 * community at the event edge first.
 * @param {number} communityId
 * @param {string} ticketChannelId
 * @returns {object|null}
 */
function getAppealByTicketChannel(communityId, ticketChannelId) {
  assertCommunityId(communityId);
  const channel = optionalText(ticketChannelId);
  if (!channel) return null;
  return (
    db
      .prepare(
        `SELECT * FROM ban_appeals
          WHERE community_id=? AND ticket_channel_id=?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(communityId, channel) || null
  );
}

/**
 * The appeal bound to a ban cycle (intake ALREADY_FILED read, #773 §1: one
 * appeal per cycle means AT MOST one row — the UNIQUE(ban_record_id) belt
 * from 075 is the schema truth this read rides). Community-scoped by design
 * like getAppealByTicketChannel: every caller resolves its community first
 * (the guildless intake resolves it through the ban record).
 *
 * @param {number} communityId
 * @param {number|string} banRecordId stable ban_records id
 * @returns {object|null}
 */
function getAppealByBanRecord(communityId, banRecordId) {
  assertCommunityId(communityId);
  const { id } = banRecordIdOrError(banRecordId);
  if (!id) return null;
  return (
    db
      .prepare(
        `SELECT * FROM ban_appeals WHERE community_id=? AND ban_record_id=?`,
      )
      .get(communityId, id) || null
  );
}

/** Hard ceiling for the scan reads below (a LIST_LIMIT can never ask for
 * the whole table; the live open-appeal population is tiny — this is the
 * abuse guard, not a feature knob). */
const LIST_SCAN_MAX = 500;
const LIST_SCAN_DEFAULT = 200;

/**
 * OPEN appeals whose ban belongs to a user — the DM ferry lane. A banned
 * user's DM carries no guild, so community scoping is impossible THERE;
 * what scopes it is the person: the user id is globally unique, so every
 * open appeal whose ban record belongs to that user is a lane the user is
 * legitimately typing into (each row still relays only into ITS OWN
 * ticket — the engine never merges communities). Cross-community by
 * construction, documented in #773. Only `open` rows: `filed` rows have no
 * ticket to relay into (the engine's structural guard would skip them), and
 * decided statuses ended their relay.
 *
 * @param {string} userId the DM author's snowflake
 * @param {number} [limit] scan bound (default 200, clamped to the 500 ceiling)
 * @returns {object[]} open appeal rows (possibly empty; never null)
 */
function listOpenAppealsByUser(userId, limit = LIST_SCAN_DEFAULT) {
  const user = optionalText(userId);
  if (!user) return [];
  const max = Math.min(
    LIST_SCAN_MAX,
    Math.max(1, Math.trunc(Number(limit)) || LIST_SCAN_DEFAULT),
  );
  return db
    .prepare(
      `SELECT a.* FROM ban_appeals a
        JOIN ban_records r ON r.id = a.ban_record_id
        WHERE r.user_id=? AND a.status='open'
        ORDER BY a.id ASC LIMIT ?`,
    )
    .all(user, max);
}

/**
 * OPEN appeals for the boot ferry catch-up (#773 §3 durability): the
 * bounded scan `start()` replays per-direction history for. Ordered by id
 * (stable walk), bounded — a deployment with thousands of stalled open
 * appeals processes the OLDEST first and the rest await the next boot;
 * cursors stay truthful either way (nothing is claimed relayed that was
 * not). `filed` rows are deliberately NOT listed: they have no ticket,
 * so there is nothing to catch up.
 *
 * @param {number} [limit] scan bound (default 200, clamped to the 500 ceiling)
 * @returns {object[]} open appeal rows (possibly empty; never null)
 */
function listOpenAppeals(limit = LIST_SCAN_DEFAULT) {
  const max = Math.min(
    LIST_SCAN_MAX,
    Math.max(1, Math.trunc(Number(limit)) || LIST_SCAN_DEFAULT),
  );
  return db
    .prepare(
      `SELECT * FROM ban_appeals WHERE status='open' ORDER BY id ASC LIMIT ?`,
    )
    .all(max);
}

/**
 * Attach the staff ticket channel (first attach wins — an appeal gets
 * exactly one ticket; a racing second attach reads `won:false` plus the LIVE
 * row and keeps the channel that is actually on the record).
 *
 * @param {number} appealId
 * @param {string} ticketChannelId
 * @returns {{ ok: true, won: boolean, appeal: object|null } | { ok: false, error: string }}
 */
function attachAppealTicketChannel(appealId, ticketChannelId) {
  const { id, error } = appealIdOrError(appealId);
  if (!id) return { ok: false, error };
  const channel = optionalText(ticketChannelId);
  if (!channel) {
    return { ok: false, error: "Attaching a ticket needs the ticket channel id." };
  }
  try {
    const res = db
      .prepare(
        `UPDATE ban_appeals SET ticket_channel_id=?, updated_at=?
          WHERE id=? AND ticket_channel_id IS NULL`,
      )
      .run(channel, now(), id);
    return { ok: true, won: res.changes === 1, appeal: getAppealById(id) };
  } catch (err) {
    return {
      ok: false,
      error: `Could not attach the appeal ticket: ${err?.message || err}`,
    };
  }
}

/**
 * `filed → open` (the ticket exists and the header landed — the relay may
 * start). CAS on status; the loser reads the LIVE row.
 *
 * @param {number} appealId
 * @returns {{ ok: true, won: boolean, appeal: object|null } | { ok: false, error: string }}
 */
function openAppeal(appealId) {
  const { id, error } = appealIdOrError(appealId);
  if (!id) return { ok: false, error };
  try {
    const res = db
      .prepare(
        `UPDATE ban_appeals SET status='open', updated_at=?
          WHERE id=? AND status='filed'`,
      )
      .run(now(), id);
    return { ok: true, won: res.changes === 1, appeal: getAppealById(id) };
  } catch (err) {
    return { ok: false, error: `Could not open the ban appeal: ${err?.message || err}` };
  }
}

/**
 * Claim the appeal's ONE decision (first-decision-wins, the resolveAutomodCase/
 * claimUnban law): clemency, deny, or plain-close all flow through this exact
 * UPDATE — `WHERE status='open'` makes simultaneous buttons impossible to
 * double-decide. The winner performs its outbound work (unban+invite / deny
 * DM / neutral DM) OUTSIDE this transaction and re-reads nothing from the
 * row afterwards except for reporting; the loser gets `{ ok:true, won:false }`
 * plus the LIVE row and must surface THAT truth (issue §4).
 *
 * `denial_reason` is written straight (not COALESCE'd): first-decision-wins
 * means exactly one writer ever touches it, so the value at claim time IS
 * the record (clemency/close claims carry null and correctly clear nothing).
 *
 * @param {number} appealId
 * @param {object} opts
 * @param {string} opts.status one of APPEAL_OUTCOMES ('granted'|'denied'|'closed')
 * @param {string|null} [opts.decidedBy] acting staff user id (NULL for the
 *   attribution-free plain-close path)
 * @param {string|null} [opts.denialReason] ≤ MAX_DENIAL_REASON (deny path)
 * @param {number} [opts.nowMs] ms epoch (injectable clock)
 * @returns {{ ok: true, won: boolean, appeal: object|null } | { ok: false, error: string }}
 */
function claimAppealOutcome(appealId, opts = {}) {
  const { id, error } = appealIdOrError(appealId);
  if (!id) return { ok: false, error };
  const { status, decidedBy, denialReason, nowMs } = opts || {};
  if (!APPEAL_OUTCOMES.includes(status)) {
    return {
      ok: false,
      error: `Unknown appeal outcome \`${status}\` — choose one of: ${APPEAL_OUTCOMES.join(", ")}.`,
    };
  }
  const decider = optionalText(decidedBy);
  const denial = optionalText(denialReason);
  if (denial && denial.length > MAX_DENIAL_REASON) {
    return {
      ok: false,
      error: `The denial reason is too long (max ${MAX_DENIAL_REASON} characters).`,
    };
  }
  const ts = timestampOr(nowMs, now());
  try {
    const res = db
      .prepare(
        `UPDATE ban_appeals
            SET status=?, decided_by=?, decided_at=?, denial_reason=?, updated_at=?
          WHERE id=? AND status='open'`,
      )
      .run(status, decider, ts, denial, ts, id);
    return { ok: true, won: res.changes === 1, appeal: getAppealById(id) };
  } catch (err) {
    return {
      ok: false,
      error: `Could not claim the appeal outcome: ${err?.message || err}`,
    };
  }
}

/**
 * #811: who decides an auto-close. `decided_by` is a free-text attribution
 * column (staff ids ride it on the decided outcomes); the system marker
 * names the mechanism, never a fake user id.
 */
const APPEAL_BAN_END_DECIDER = "system:ban-ended";

/**
 * #811: the ban behind this appeal ENDED (expired auto-unban, external lift,
 * reconciliation) — close any appeal still awaiting a staff decision. Unlike
 * the DECISION claim (open-only: a decision needs the ticket context the
 * filed row never got), this CAS admits BOTH pending shapes:
 *
 *   filed → closed  the dead-pending row (ticket never opened) must stop
 *                   reading as "already filed" to a user whose ban is over
 *   open  → closed  the live ferry lane — closing it STRUCTURALLY stops
 *                   the DM relay (listOpenAppealsByUser filters open rows)
 *                   and the ticket's buttons die on the next click with the
 *                   honest "already decided" copy (the CAS is the truth).
 *
 * Already-decided or closed rows are untouched (won:false + live row). One
 * winner by the same WHERE-status CAS law as claimAppealOutcome: a staff
 * decision landing between the ban-end read and this write simply wins.
 *
 * @param {number} appealId
 * @param {{ reason?: string|null, nowMs?: number }} [opts] `reason` rides
 *   denial_reason (capped like every other outcome note) so the ticket and
 *   any later read show WHY the close happened in human words.
 * @returns {{ ok: true, won: boolean, appeal: object|null } | { ok: false, error: string }}
 */
function closeAppealOnBanEnd(appealId, { reason = null, nowMs } = {}) {
  const { id, error } = appealIdOrError(appealId);
  if (!id) return { ok: false, error };
  const note = optionalText(reason);
  if (note && note.length > MAX_DENIAL_REASON) {
    return {
      ok: false,
      error: `The ban-ended close reason is too long (max ${MAX_DENIAL_REASON} characters).`,
    };
  }
  const ts = timestampOr(nowMs, now());
  try {
    const res = db
      .prepare(
        `UPDATE ban_appeals
            SET status='closed', decided_by=?, decided_at=?, denial_reason=?, updated_at=?
          WHERE id=? AND status IN ('filed','open')`,
      )
      .run(APPEAL_BAN_END_DECIDER, ts, note, ts, id);
    return { ok: true, won: res.changes === 1, appeal: getAppealById(id) };
  } catch (err) {
    return {
      ok: false,
      error: `Could not close the appeal on ban end: ${err?.message || err}`,
    };
  }
}

/**
 * Persist the relay cursor for ONE direction (last-write-wins — the relay
 * is single-flow per direction; see the header law). Always writes the PAIR
 * (message id + timestamp): half a cursor is a resume-time lie.
 *
 * `won` here reports row EXISTENCE (the row was updated), not a claim:
 * `won:false` means the appeal is gone and the save silently no-op'd.
 *
 * @param {number} appealId
 * @param {string} direction 'user' | 'ticket'
 * @param {object} cursor
 * @param {string} cursor.messageId
 * @param {number} cursor.timestampMs ms epoch
 * @returns {{ ok: true, won: boolean, appeal: object|null } | { ok: false, error: string }}
 */
function saveAppealCursor(appealId, direction, cursor = {}) {
  const { id, error } = appealIdOrError(appealId);
  if (!id) return { ok: false, error };
  const cols = CURSOR_COLUMNS[direction];
  if (!cols) {
    return {
      ok: false,
      error: `Unknown ferry direction \`${direction}\` — choose one of: ${FERRY_DIRECTIONS.join(", ")}.`,
    };
  }
  const messageId = optionalText(cursor.messageId);
  const ts = Number(cursor.timestampMs);
  if (!messageId || !Number.isFinite(ts) || ts <= 0) {
    return {
      ok: false,
      error: "A ferry cursor needs both the message id and a positive timestamp.",
    };
  }
  try {
    const res = db
      .prepare(
        `UPDATE ban_appeals
            SET ${cols.msgColumn}=?, ${cols.tsColumn}=?, updated_at=?
          WHERE id=?`,
      )
      .run(messageId, Math.floor(ts), now(), id);
    return { ok: true, won: res.changes === 1, appeal: getAppealById(id) };
  } catch (err) {
    return { ok: false, error: `Could not save the ferry cursor: ${err?.message || err}` };
  }
}

/**
 * Read the relay cursor for ONE direction (boot catch-up resume point).
 * @param {number} appealId
 * @param {string} direction 'user' | 'ticket'
 * @returns {{ ok: true, cursor: { messageId: string, timestampMs: number }|null } | { ok: false, error: string }}
 */
function loadAppealCursor(appealId, direction) {
  const { id, error } = appealIdOrError(appealId);
  if (!id) return { ok: false, error };
  const cols = CURSOR_COLUMNS[direction];
  if (!cols) {
    return {
      ok: false,
      error: `Unknown ferry direction \`${direction}\` — choose one of: ${FERRY_DIRECTIONS.join(", ")}.`,
    };
  }
  try {
    const row = db
      .prepare(`SELECT ${cols.msgColumn} AS msgId, ${cols.tsColumn} AS ts FROM ban_appeals WHERE id=?`)
      .get(id);
    if (!row || row.msgId == null || row.ts == null) return { ok: true, cursor: null };
    return { ok: true, cursor: { messageId: String(row.msgId), timestampMs: Number(row.ts) } };
  } catch (err) {
    return { ok: false, error: `Could not read the ferry cursor: ${err?.message || err}` };
  }
}

/**
 * Silence or un-silence the ferry relay. The pause flag stops the WHOLE
 * relay both ways (issue §3) — and does NOT touch status. Deliberately
 * status-free: a mod pausing mid-thread never decides the appeal, and the
 * decided statuses stop the relay by their own guards (the pause is purely
 * the "staff needs quiet time" knob).
 *
 * @param {number} appealId
 * @param {boolean|number|string} paused strict on/off (see toPausedFlag)
 * @returns {{ ok: true, won: boolean, appeal: object|null } | { ok: false, error: string }}
 */
function setAppealFerryPaused(appealId, paused) {
  const { id, error } = appealIdOrError(appealId);
  if (!id) return { ok: false, error };
  const flag = toPausedFlag(paused);
  if (flag === null) {
    return {
      ok: false,
      error: `Unknown pause value \`${String(paused)}\` — choose on or off.`,
    };
  }
  try {
    const res = db
      .prepare(`UPDATE ban_appeals SET ferry_paused=?, updated_at=? WHERE id=?`)
      .run(flag, now(), id);
    return { ok: true, won: res.changes === 1, appeal: getAppealById(id) };
  } catch (err) {
    return {
      ok: false,
      error: `Could not update the ferry pause state: ${err?.message || err}`,
    };
  }
}

module.exports = {
  BAN_APPEAL_STATUSES,
  APPEAL_OUTCOMES,
  FERRY_DIRECTIONS,
  MAX_APPEAL_STATEMENT,
  MAX_DENIAL_REASON,
  fileAppeal,
  getAppealById,
  getAppealByBanRecord,
  getAppealByTicketChannel,
  listOpenAppeals,
  listOpenAppealsByUser,
  attachAppealTicketChannel,
  openAppeal,
  claimAppealOutcome,
  closeAppealOnBanEnd,
  APPEAL_BAN_END_DECIDER,
  saveAppealCursor,
  loadAppealCursor,
  setAppealFerryPaused,
};
