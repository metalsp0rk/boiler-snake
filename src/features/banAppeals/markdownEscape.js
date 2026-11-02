/**
 * Display-name markdown escape (#773 issue §6 + §2, the #745 convention).
 *
 * The appeal ferry prints WHO said each relayed line in a channel/DM the
 * speaker cannot control (`**<username · id>:** text`). A planted display
 * name must never render as a ping, role mention, channel link or markdown
 * — escaped name + id, no ping leakage.
 *
 * Reuse, not reinvent: tickets/reportEvidence.js `inlineEscape` is the
 * shipped, test-proven escaper for exactly this job (backslash before every
 * Discord markdown/mention marker: `\ ` ` * _ ~ | < > @ # [ ] ( )`;
 * newlines collapse to spaces). It imports nothing from banAppeals (the
 * tickets feature never reaches into this direction), so a top-level import
 * is cycle-free; this module wraps it and adds the display-name cap instead
 * of forking a second copy of the escape law.
 */

const { inlineEscape } = require("../tickets/reportEvidence");
const { sliceSafe } = require("../../core/text");

/** Display names are short metadata lines; generous belt cap (#745 posture). */
const DISPLAY_NAME_MAX_CHARS = 120;

/**
 * Escaped passthrough of the shipped escaper (exposed so ferry/header code
 * quotes ONE escape law; semantics pinned by reportEvidence's own tests).
 * @param {unknown} value
 * @returns {string}
 */
function escapeInline(value) {
  return inlineEscape(value);
}

/**
 * Escaped single-line display name for relay headers and the appeal card —
 * `@everyone` / `@here` / `<@id>` / `<#id>` / role & markdown syntax all
 * render as inert visible text. Empty/absent input degrades to "" (the
 * caller decides the fallback label, this never invents a name).
 *
 * @param {unknown} value raw display name / username
 * @param {number} [maxChars] cap (default 120, surrogate-safe)
 * @returns {string}
 */
function escapeDisplayName(value, maxChars = DISPLAY_NAME_MAX_CHARS) {
  return sliceSafe(inlineEscape(value), maxChars);
}

module.exports = {
  escapeInline,
  escapeDisplayName,
  DISPLAY_NAME_MAX_CHARS,
};
