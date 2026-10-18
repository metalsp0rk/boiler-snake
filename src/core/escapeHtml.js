"use strict";

/**
 * The ONE HTML escaper in this repo (#452, audit H1-5).
 *
 * Escapes all FIVE significant characters — including `'`. The drifted
 * private copies this replaced were 3 implementations across 5 files, two of
 * them missing `&#39;` entirely: harmless while embedded only in text
 * contexts, an attribute-injection foothold the day someone pastes their
 * value into a single-quoted attribute (the exact "reuse the local function"
 * edit). Do not define escapeHtml anywhere else — import this one.
 *
 * Chain of literal replaces, no regex/class tricks to get wrong, `&` first
 * so its own escape is not double-encoded. Nullish input renders as the
 * empty string (the tickets/transcript shape — an HTML page printing the
 * literal word "undefined" is a bug, not content).
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = { escapeHtml };
