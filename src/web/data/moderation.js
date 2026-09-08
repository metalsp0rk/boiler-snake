/**
 * Read-model for the web moderation lists (roadmap/web-admin.md §8.6
 * "Moderation: warnings list/issue/void, notes | Staff | Staff |
 * 1 read · 3 write" — subtask 17, Phase 1 READ-ONLY half).
 *
 * Query-budget contract (§8.6, review-blocking):
 *  - every read is guild-scoped by construction: the first positional arg
 *    of both builders is guildId, taken ONLY from req.guildAccess.guildId;
 *  - page size defaults to 25 and is hard-clamped to ≤100 rows (the §8.6
 *    list cap); offsets clamp to MAX_OFFSET (1000, the shared web bound —
 *    a hostile `?o=999999999` never reaches SQLite as-is);
 *  - warnings guild-wide list/count go through the repository pair
 *    listGuildWarnings/countGuildWarnings (ORDER BY warning_number DESC —
 *    served by UNIQUE(guild_id, warning_number), no sort step, no full
 *    scan); notes reuse the EXISTING helpers: listStaffNotes (per-user)
 *    / listRecentStaffNotes (guild-wide, idx_staff_notes_guild_recent) /
 *    countStaffNotes — zero new SQL for the notes surface;
 *  - NO cross-table scans: the warning row's related_note_id renders as a
 *    raw id ref (the row already carries it); no per-row note lookups,
 *    which the slash /warn list itself never does either.
 *
 * Slash parity (src/features/warnings/index.js handleList + src/features/
 * staffNotes/index.js handleList):
 *  - default hides voided warnings / soft-deleted notes (slash defaults),
 *    the "all" state reveals them BADGED (never hidden-and-unmarked),
 *    matching the `~~voided~~` / `~~deleted~~` list markers;
 *  - the web adds the guild-wide warnings view (/warn list REQUIRES a user;
 *    /note list without user is the shipped guild-wide precedent this page
 *    mirrors) plus a web-only state="voided" (voided-only) filter.
 */

const {
  listGuildWarnings,
  countGuildWarnings,
  listStaffNotes,
  listRecentStaffNotes,
  countStaffNotes,
} = require("../../db");
// Shared web-layer snowflake gate + offset clamp (userProfile.js is the
// single definition; moderation must not fork a divergent validation).
const { USER_ID_RE, readOffset } = require("./userProfile");

/** §8.6 list budget: default page 25, hard cap 100 (both lists). */
const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;

/** Void-state options for the warnings page (normalized by the repo too). */
const WARN_STATES = Object.freeze(["active", "voided", "all"]);
/** Note states mirror slash `include_deleted` (active default, all reveals). */
const NOTE_STATES = Object.freeze(["active", "all"]);

/**
 * Normalize the page-size query (`?n=`) to [1, 100]. Junk → default.
 * @param {string|null|undefined} raw
 * @returns {number}
 */
function readPageSize(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return PAGE_SIZE_DEFAULT;
  return Math.min(Math.floor(n), PAGE_SIZE_MAX);
}

/**
 * Parse the optional subject filter (`?u=`). INVALID values are reported
 * (rendered as an escaped notice, filter IGNORED) rather than 404ing the
 * whole list — mirrors how the users search page degrades junk queries
 * instead of pretending the page doesn't exist. Empty/absent → no filter.
 * @param {string|null|undefined} raw
 * @returns {{ userId: string|null, invalid: boolean }}
 */
function readUserFilter(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { userId: null, invalid: false };
  if (!USER_ID_RE.test(s)) return { userId: null, invalid: true };
  return { userId: s, invalid: false };
}

/**
 * Warnings state filter — whitelist, junk falls to "active" (the slash
 * default of hiding voided). Never echoed raw.
 * @param {string|null|undefined} raw
 */
function readWarnState(raw) {
  const s = String(raw ?? "active").trim().toLowerCase();
  return WARN_STATES.includes(s) ? s : "active";
}

/**
 * Notes state filter — "all" == slash include_deleted:true; anything else
 * (incl. the warnings-only "voided" token) falls to "active".
 * @param {string|null|undefined} raw
 */
function readNoteState(raw) {
  const s = String(raw ?? "active").trim().toLowerCase();
  return NOTE_STATES.includes(s) ? s : "active";
}

/**
 * One bounded warnings page. `state` semantics mirror slash: "active"
 * hides voided (default), "all" shows them badged, "voided" is the
 * web-only voided-only view.
 *
 * @param {string} guildId MUST be req.guildAccess.guildId
 * @param {{ u?: string|null, state?: string|null, o?: string|null, n?: string|null }} query RAW query values
 * @returns {{ rows: object[], total: number, offset: number, pageSize: number,
 *            userId: string|null, invalidUser: boolean, state: string }}
 */
function buildWarningsPage(guildId, query = {}) {
  const { userId, invalid } = readUserFilter(query.u);
  const state = readWarnState(query.state);
  const pageSize = readPageSize(query.n);
  const offset = readOffset(query.o);

  const filter = { userId, state, limit: pageSize, offset };
  return {
    rows: listGuildWarnings(guildId, filter),
    total: countGuildWarnings(guildId, filter),
    offset,
    pageSize,
    userId,
    invalidUser: invalid,
    state,
  };
}

/**
 * One bounded staff-notes page. includeDeleted ("all") reveals soft-
 * deleted rows BADGED exactly like slash /note list include_deleted:true;
 * default matches the slash default (hidden).
 *
 * @param {string} guildId MUST be req.guildAccess.guildId
 * @param {{ u?: string|null, state?: string|null, o?: string|null, n?: string|null }} query RAW query values
 * @returns {{ rows: object[], total: number, offset: number, pageSize: number,
 *            userId: string|null, invalidUser: boolean, state: string }}
 */
function buildNotesPage(guildId, query = {}) {
  const { userId, invalid } = readUserFilter(query.u);
  const state = readNoteState(query.state);
  const pageSize = readPageSize(query.n);
  const offset = readOffset(query.o);
  const includeDeleted = state === "all";

  const listOpts = { includeDeleted, limit: pageSize, offset };
  const rows = userId
    ? listStaffNotes(guildId, userId, listOpts)
    : listRecentStaffNotes(guildId, listOpts);
  return {
    rows,
    total: countStaffNotes(guildId, userId, { includeDeleted }),
    offset,
    pageSize,
    userId,
    invalidUser: invalid,
    state,
  };
}

module.exports = {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  WARN_STATES,
  NOTE_STATES,
  USER_ID_RE,
  readPageSize,
  readUserFilter,
  readWarnState,
  readNoteState,
  buildWarningsPage,
  buildNotesPage,
};
