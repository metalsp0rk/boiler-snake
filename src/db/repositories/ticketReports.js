/**
 * Ticket reports (#745) — one structured side record per context-menu
 * "Report Post" / "Report User" ticket. Written once at report time; read by
 * the duplicate-report nudge and by ticket detail surfaces.
 *
 * Error contract (AGENTS.md rule 6): every write path returns
 * { ok:false, error } on bad input or a constraint failure — never throws;
 * read helpers return null for nothing-found / junk lookup keys. The one
 * exception mirrors the sibling repositories exactly: a community-id that is
 * not an integer is a PROGRAMMER error and goes through assertCommunityId
 * (src/platform/community.js), same as every tickets.js community read.
 */

const { db, now } = require("../connection");

// src/platform/community.js requires the db facade (src/db/index.js), so a
// top-level require here would be a load-time cycle (partial exports). The
// lazy require resolves after boot; assertCommunityId stays single-source.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/** Locked report kinds (migration 066 CHECK): message = Report Post, user = Report User. */
const REPORT_KINDS = ["message", "user"];

/**
 * Record one report beside an EXISTING ticket (created by the caller — this
 * repository never opens channels). created_at stamps from now(), matching
 * the timestamps repositories/tickets.js uses.
 *
 * @param {object} opts
 * @param {number} opts.communityId the CALLER's community — #838 (C2-6):
 *   this insert took a raw ticketId with no community parameter at all, so
 *   any caller holding any ticket id could file a report into ANOTHER
 *   tenant's ticket. The ticket's ownership is now asserted up front.
 * @param {number} opts.ticketId tickets.id the report belongs to
 * @param {"message"|"user"} opts.kind
 * @param {string} opts.subjectUserId reported member's snowflake
 * @param {string|null} [opts.reportedMessageId] required for kind="message"
 * @param {string|null} [opts.sourceChannelId] channel the reported post lived in
 * @param {boolean|number} [opts.messageDeleted=false] 1 when the flow deleted the original
 * @param {string|null} [opts.snapshotNote] reporter's modal context text
 * @returns {{ ok: true, report: object } | { ok: false, error: string }}
 */
function insertTicketReport(opts = {}) {
  const {
    communityId,
    ticketId,
    kind,
    subjectUserId,
    reportedMessageId = null,
    sourceChannelId = null,
    messageDeleted = false,
    snapshotNote = null,
  } = opts || {};

  const tid = Number(ticketId);
  if (!Number.isInteger(tid) || tid < 1) {
    return { ok: false, error: "ticketId must be a positive integer." };
  }
  if (!REPORT_KINDS.includes(kind)) {
    return {
      ok: false,
      error: `Unknown report kind ${JSON.stringify(kind ?? null)} — expected "message" or "user".`,
    };
  }
  const subject = String(subjectUserId ?? "").trim();
  if (!subject) {
    return { ok: false, error: "subjectUserId is required." };
  }
  // Empty string after trim is "absent", never a stored "" id.
  const messageId =
    reportedMessageId == null ? null : String(reportedMessageId).trim() || null;
  const channelId =
    sourceChannelId == null ? null : String(sourceChannelId).trim() || null;
  if (kind === "message" && !messageId) {
    return { ok: false, error: "A message report needs the reported message id." };
  }
  const note =
    snapshotNote == null || String(snapshotNote).trim() === ""
      ? null
      : String(snapshotNote).trim();

  // Friendly pre-check so a stale/foreign ticket id reads as "Ticket not
  // found." instead of a raw FK dump; the FK itself still guards the race
  // between this read and the insert (caught below). #838 (C2-6): the read
  // is community-bound — a foreign ticket answers exactly like a missing
  // one, and the communityId is a hard requirement (programmer-error
  // posture, same as every writer in this file family).
  assertCommunityId(communityId);
  const owner = db.prepare(`SELECT community_id FROM tickets WHERE id=?`).get(tid);
  if (!owner || Number(owner.community_id) !== Number(communityId)) {
    return { ok: false, error: "Ticket not found." };
  }

  try {
    db.prepare(
      `
      INSERT INTO ticket_reports (
        ticket_id, kind, subject_user_id, reported_message_id,
        source_channel_id, message_deleted, snapshot_note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      tid,
      kind,
      subject,
      messageId,
      channelId,
      messageDeleted ? 1 : 0,
      note,
      now(),
    );
  } catch (err) {
    // Constraint failure (ticket deleted concurrently, duplicate report for
    // the same ticket, CHECK bypass): specific, never a silent drop.
    return {
      ok: false,
      error: `Could not save the ticket report: ${err?.message || err}`,
    };
  }
  return { ok: true, report: getTicketReport(tid) };
}

/**
 * The report row for one ticket (ticket_reports PK).
 * @param {number|string} ticketId
 * @returns {object|null}
 */
function getTicketReport(ticketId) {
  const tid = Number(ticketId);
  if (!Number.isInteger(tid) || tid < 1) return null;
  return (
    db.prepare(`SELECT * FROM ticket_reports WHERE ticket_id=?`).get(tid) || null
  );
}

/**
 * Duplicate-report nudge (#745 decision 12): the OLDEST still-open report
 * for the same reported message inside one community. Scoping mirrors
 * repositories/tickets.js verbatim — tickets are community-scoped through
 * the integer community_id column (migration 034), so the nudge joins to
 * tickets and filters t.community_id=? AND t.status='open'. A closed ticket
 * with the same message id must NOT suppress a fresh report.
 *
 * @param {number} communityId
 * @param {string|null|undefined} messageId
 * @returns {object|null} report row plus ticket_number / ticket_channel_id
 *   for the "already reported in #N" note
 */
function findOpenReportForMessage(communityId, messageId) {
  assertCommunityId(communityId);
  const msg = messageId == null ? "" : String(messageId).trim();
  if (!msg) return null;
  return (
    db
      .prepare(
        `
      SELECT r.*, t.ticket_number, t.channel_id AS ticket_channel_id
      FROM ticket_reports r
      JOIN tickets t ON t.id = r.ticket_id
      WHERE t.community_id=? AND t.status='open' AND r.reported_message_id=?
      ORDER BY r.created_at ASC, r.ticket_id ASC
      LIMIT 1
    `,
      )
      // ticket_channel_id is the LIVE ticket channel — the nudge links there.
      .get(communityId, msg) || null
  );
}

/**
 * #822 (audit r3, A2-9/C2-4): retention primitive — report snapshots older
 * than the cutoff are erased by AGE. ticket_reports has no lifecycle (the
 * snapshot is intake-time prose: snapshot_note + the subject/message
 * identity); its only structural delete path was CASCADE from tickets, and
 * no code ever deletes tickets, so the CASCADE was dormant (verified: zero
 * ticket deletes) — this is the family's only real erasure path. Accepted,
 * documented trades past the window: the "already reported on this message"
 * dedupe can re-accept a very old message, and the staff note minted at
 * close lives on independently in staff_notes (own knobs since F2-11).
 * Opt-in via RETENTION_TICKET_REPORTS_DAYS.
 * @param {number} cutoffMs deleted strictly before (epoch ms)
 * @param {number} [limit]
 * @returns {number} rows deleted
 */
function deleteTicketReportsOlderThan(cutoffMs, limit = 500) {
  if (!Number.isSafeInteger(cutoffMs)) {
    throw new TypeError(
      `deleteTicketReportsOlderThan: cutoffMs must be an integer ms epoch, got ${String(cutoffMs)}`
    );
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError(
      `deleteTicketReportsOlderThan: limit must be a positive integer, got ${String(limit)}`
    );
  }
  return db
    .prepare(`DELETE FROM ticket_reports WHERE created_at < ? LIMIT ?`)
    .run(cutoffMs, limit).changes;
}


module.exports = {
  deleteTicketReportsOlderThan,
  REPORT_KINDS,
  insertTicketReport,
  getTicketReport,
  findOpenReportForMessage,
};
