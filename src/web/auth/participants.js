/**
 * Ticket transcript access resolution (roadmap/web-admin.md §8.4, locked
 * decision §8.1-4; subtask 12 — Phase 0c "staff tier OR participant").
 *
 * Viewer may open `/t/{uuid}` (and its assets) when EITHER:
 *  1. staff tier for the ticket's GUILD — decided by the SAME
 *     auth/guildAccess.js resolver that gates /g/* (guild id taken from the
 *     TICKET ROW, never the URL, so no request parameter can widen access);
 *  2. participant of that ticket, resolved from the existing tables —
 *     `tickets.creator_user_id` ∪ `ticket_members` ∪ `ticket_staff` ∪
 *     `ticket_messages.author_id` (§8.4 rule list; check is per ticket ROW:
 *     UUID knowledge alone never suffices without a session).
 *
 * The decision logic is split the same way guildAccess.js splits its math:
 *  - {@link isTicketParticipant} — PURE decision over injected lookups, so
 *    the participant matrix runs offline without SQLite;
 *  - {@link createTicketAccessResolver} — composition layer: staff check via
 *    the guildAccess resolver, participant fallback via the db facade.
 *    Every guildAccess failure that is not "ok" DENIES staff (the resolver
 *    already fails closed per §8.3); only the explicit re-auth/anon statuses
 *    survive as re-auth signals for the route layer (login redirect), while
 *    ordinary denies fall through to the participant check — a member who
 *    LEFT the guild keeps their §8.4 read right.
 *
 * Sensitive tickets are this module's non-problem: they are never content-
 * archived (`closeTicketSensitive` clears the transcript token and leaves
 * archived=0), so the route's existing lookup/archive gate 404s them before
 * any access decision (§8.4 "still 404, unchanged").
 */

const {
  hasTicketMember,
  hasTicketStaff,
  hasTicketMessageAuthor,
} = require("../../db");

/**
 * The db-facade participant lookups, injectable for pure unit tests.
 * All three are indexed per-ticket EXISTS probes (§8.6 query budget).
 */
const DEFAULT_PARTICIPANT_LOOKUPS = Object.freeze({
  hasTicketMember,
  hasTicketStaff,
  hasTicketMessageAuthor,
});

/**
 * Pure §8.4 participant decision: creator ∪ ticket_members ∪ ticket_staff ∪
 * ticket_messages.author_id. Same inputs ⇒ same answer, no I/O of its own
 * (all data access arrives through `lookups`).
 *
 * @param {object|null|undefined} ticketRow the tickets row (needs id +
 *   creator_user_id) — the ROUTE supplies the row it fetched by the
 *   transcript token; this function never trusts a guild from the request
 * @param {string|null|undefined} userId viewer's Discord id (session)
 * @param {{hasTicketMember: Function, hasTicketStaff: Function, hasTicketMessageAuthor: Function}} [lookups]
 * @returns {boolean}
 */
function isTicketParticipant(ticketRow, userId, lookups = DEFAULT_PARTICIPANT_LOOKUPS) {
  if (!ticketRow || typeof ticketRow !== "object") return false;
  if (typeof userId !== "string" || userId.length === 0) return false;

  // 1. creator (cheapest check first — no query needed)
  if (
    ticketRow.creator_user_id != null &&
    String(ticketRow.creator_user_id) === userId
  ) {
    return true;
  }

  const ticketId = Number(ticketRow.id);
  if (!Number.isFinite(ticketId)) return false;

  // 2-4. the three tables (§8.4), short-circuiting on the first hit
  if (lookups.hasTicketMember(ticketId, userId)) return true;
  if (lookups.hasTicketStaff(ticketId, userId)) return true;
  if (lookups.hasTicketMessageAuthor(ticketId, userId)) return true;
  return false;
}

/**
 * Compose guildAccess staff-tier resolution with the participant fallback
 * into the single §8.4 decision the ticket routes consume.
 *
 * @param {object} options
 * @param {{resolve: Function}} options.guildAccess
 *   createGuildAccessResolver() instance — the SAME gate as /g/* (§8.3),
 *   so the web panel and the slash gates stay provably equivalent here too
 * @param {typeof DEFAULT_PARTICIPANT_LOOKUPS} [options.lookups] participant
 *   lookups override (tests)
 * @returns {{
 *   resolveTicketAccess: (
 *     session: {id: string, userId: string}|null,
 *     ticketRow: object,
 *   ) => Promise<{
 *     allowed: boolean,
 *     via: "staff"|"participant"|null,
 *     staffStatus: "ok"|"anon"|"reauth"|"deny"|"error"|"no_ticket",
 *     tier?: string,
 *   }>,
 * }}
 */
function createTicketAccessResolver({ guildAccess, lookups = DEFAULT_PARTICIPANT_LOOKUPS } = {}) {
  if (!guildAccess || typeof guildAccess.resolve !== "function") {
    throw new TypeError("createTicketAccessResolver: guildAccess with resolve() is required");
  }

  /**
   * §8.4 decision for ONE ticket row. Never throws: a resolver blow-up is a
   * staff deny that still falls through to the participant check, and a
   * participant-lookup blow-up fails closed (no access) — the route layer
   * turns any non-allow into the generic 404 (§8.6, never 403).
   * @param {{id: string, userId: string}|null} session req.webSession
   * @param {object} ticketRow the tickets row (guild_id decides the staff
   *   check; id/creator drive the participant check)
   */
  async function resolveTicketAccess(session, ticketRow) {
    if (!ticketRow || typeof ticketRow !== "object") {
      return { allowed: false, via: null, staffStatus: "no_ticket" };
    }
    if (!session || !session.id || !session.userId) {
      return { allowed: false, via: null, staffStatus: "anon" };
    }

    // Guild comes from the ROW (§8.4 rule 3) — the route never passes a URL
    // guild into this decision.
    let staff = { status: "error" };
    try {
      staff = await guildAccess.resolve(session, String(ticketRow.guild_id ?? ""));
    } catch (err) {
      console.warn(
        "[web] ticketAccess: guild resolution failed closed:",
        err?.code || err?.message || err
      );
    }

    if (staff?.status === "ok") {
      return { allowed: true, via: "staff", staffStatus: "ok", tier: staff.tier };
    }
    // Live-but-unusable / missing session: the viewer must re-login for ANY
    // transcript (participant rights included — §8.1-3 login-mandatory).
    if (staff?.status === "reauth" || staff?.status === "anon") {
      return { allowed: false, via: null, staffStatus: staff.status };
    }

    // Ordinary staff deny (not_in_access_list / no_tier / bad_guild_id /
    // member_left / error…) — §8.4 alternative 2 still applies: participants
    // keep the right to read the transcript about them even after leaving
    // the guild.
    let participant = false;
    try {
      participant = isTicketParticipant(ticketRow, session.userId, lookups);
    } catch (err) {
      // Fail closed (§8.7): a lookup outage never mints access; the viewer
      // sees the same generic 404 as a stranger.
      console.warn(
        "[web] ticketAccess: participant lookup failed closed:",
        err?.code || err?.message || err
      );
    }
    if (participant) return { allowed: true, via: "participant", staffStatus: staff?.status || "error" };
    return { allowed: false, via: null, staffStatus: staff?.status || "error" };
  }

  return { resolveTicketAccess };
}

module.exports = {
  DEFAULT_PARTICIPANT_LOOKUPS,
  isTicketParticipant,
  createTicketAccessResolver,
};
