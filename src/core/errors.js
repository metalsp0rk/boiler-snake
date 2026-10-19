/**
 * One-line error descriptions for user-facing copy (#470 H1-7).
 *
 * githubReleases/github.js and twitch/helix.js carried byte-identical copies;
 * a cause-chain fix landed in whichever feature tripped, never both. This is
 * the display formatter: Name[(code)]: message [| cause: …] — one line, safe
 * to embed in a Discord reply.
 *
 * NOT to be confused with core/lifecycle.js's same-named local formatter,
 * which produces STACKS for logs — different contract, different home.
 */

/**
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  if (!err) return String(err);
  const name = err.name || "Error";
  const message = err.message || String(err);
  const ownCode = err.code && !message.includes(err.code) ? ` (${err.code})` : "";
  let text = `${name}${ownCode}: ${message}`;
  const cause = err.cause;
  if (cause) {
    let causeText = cause.message || "";
    if (cause.code && !causeText.includes(cause.code)) {
      causeText = `${cause.code} ${causeText}`.trim();
    }
    text += ` | cause: ${causeText || String(cause)}`;
  }
  return text;
}

module.exports = { describeError };
