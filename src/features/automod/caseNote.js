/**
 * Auto-moderation CASE-NOTE discovery law (#733, epic #723) — the ONE place
 * the "(automod case A-n)" convention is defined for READERS of the staff
 * note layer (the harness/card/executor writers own the body grammar —
 * `harness.assembleAutomodNoteBody`).
 *
 * The harness writes exactly ONE note per considered subject per case
 * (#731's one-note law). Everyone who needs to find THAT row — the card's
 * N-n refs, the card's Approve/Dismiss outcome updates, the two-phase
 * commit's note pre-pass (#733, so a warn can carry `relatedNoteId`), and
 * the executor's approve-replay fallback — goes through `findCaseNoteRow`
 * here. It was `card.js`'s private helper; sharing it keeps card and
 * executor under ONE discovery law (author = bot id or the "automod"
 * fallback + the content suffix; a foreign author never matches).
 *
 * Read-only by design: this module never writes (the card's
 * `updateNoteOutcome` and the harness reconciler own every write path).
 * Lives under src/features/automod/ on purpose — it is automod law over
 * the shared staff-notes repository, not a repository change.
 */

const { listStaffNotes } = require("../../db");

/**
 * Find the case's ONE automod note for a user.
 *
 * The harness writes ONE note per considered user per case with the content
 * suffix `(automod case A-n)` and the bot as author
 * (`harness.commitRunIntents` — author = bot user id, fallback label
 * "automod"). The scan replays that convention; a note whose author is
 * neither is FOREIGN (a human note quoting the case ref) and is skipped —
 * the outcome never lands in someone else's record.
 *
 * @param {object} input
 * @param {number} input.communityId
 * @param {string} input.userId
 * @param {number|string} input.caseNumber
 * @param {string|null} [input.botUserId]
 * @param {object} [input.deps] ({ listNotes })
 * @returns {object|null} the note row, newest match first
 */
function findCaseNoteRow({ communityId, userId, caseNumber, botUserId = null, deps = {} } = {}) {
  const needle = `(automod case A-${caseNumber})`;
  try {
    const notes = (deps.listNotes ?? listStaffNotes)(communityId, String(userId), { limit: 100 }) ?? [];
    for (const note of notes) {
      if (!String(note?.content ?? "").includes(needle)) continue;
      const author = note.author_id == null ? null : String(note.author_id);
      if (author != null && author !== "automod" &&
          (botUserId == null || author !== String(botUserId))) {
        continue; // foreign author — never write into a human's note
      }
      return note; // listStaffNotes is newest-first: the live harness note wins
    }
  } catch (err) {
    console.error(
      `[automod] case-note scan failed (community ${communityId} user ${userId} case A-${caseNumber}):`,
      err?.message || err,
    );
  }
  return null;
}

/**
 * The referred message's Discord jump link — the note's evidence line, the
 * warn tool's default `evidenceMessageUrl` (#733: "the referred message when
 * the warning is about that message"), and the card's suggested-row evidence
 * link all share this ONE shape. Missing anchor piece → null (no link).
 *
 * @param {string|null} guildId external Discord snowflake
 * @param {object|null} caseRow the automod_cases row (channel_id/message_id)
 * @returns {string|null}
 */
function anchorJumpLink(guildId, caseRow) {
  const optional = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
  };
  const gid = optional(guildId);
  const cid = optional(caseRow?.channel_id);
  const mid = optional(caseRow?.message_id);
  return gid && cid && mid
    ? `https://discord.com/channels/${gid}/${cid}/${mid}`
    : null;
}

module.exports = {
  findCaseNoteRow,
  anchorJumpLink,
};
