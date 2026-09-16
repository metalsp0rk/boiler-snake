/**
 * Warn list presentation.
 */
const { Color } = require("../../core/theme");

/** Default page size for /warn list */
const LIST_PAGE_SIZE = 10;
/** Snippet length in list embeds */
const SNIPPET_LEN = 80;

const COLOR_ISSUE = Color.danger;
const COLOR_VOID = Color.muted;
const COLOR_INFO = Color.caution;

module.exports = {
  LIST_PAGE_SIZE,
  SNIPPET_LEN,
  COLOR_ISSUE,
  COLOR_VOID,
  COLOR_INFO,
};
