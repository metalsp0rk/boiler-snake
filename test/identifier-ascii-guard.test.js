const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Non-ASCII identifier guard.
 *
 * Production bug (2026-10-01): src/platform/fluxer/client.js called
 * `buildRestFaçade` while the function is `buildRestFacade` — a `ç` snuck
 * into the identifier. JS parses it as a distinct (undefined) identifier, so
 * the ReferenceError only fired on the LIVE connect path, which no unit test
 * exercises (connect needs the SDK + network). Every code path after the typo
 * was dead: the Fluxer feature silently "degraded" with
 * `boot failed: buildRestFaçade is not defined`.
 *
 * This guard scans all of src/ for identifier-shaped tokens that start with
 * ASCII letters and then contain a Latin-1 Supplement / Latin Extended-A
 * letter — the exact shape of `buildRestFaçade`, `caféAuth`, etc. Comments
 * are stripped first (prose legitimately uses accented words), and fully
 * non-ASCII identifiers are out of scope (they'd be flagged by `node --check`
 * only in strict mode contexts — the ASCII-prefix shape is the one JS
 * ACCEPTS silently, which is what makes the bug invisible).
 */

const ACCENTED = "\u00C0-\u024F"; // Latin-1 Supplement + Latin Extended-A letters
const IDENT_RE = new RegExp(`[A-Za-z_$][A-Za-z0-9_$]*[${ACCENTED}][A-Za-z0-9_$]*`, "g");

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (incl. JSDoc)
    .replace(/^\s*\/\/.*$/gm, "") // full-line // comments
    .replace(/([^:"'])\/\/.*$/gm, "$1"); // trailing // comments (naive, guarded)
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith(".js") ? [full] : [];
  });
}

test("no identifier-shaped token in src/ mixes ASCII letters with accented letters", () => {
  const offenders = [];
  for (const file of sourceFiles(path.join(__dirname, "..", "src"))) {
    const stripped = stripComments(fs.readFileSync(file, "utf8"));
    for (const line of stripped.split("\n")) {
      const matches = line.match(IDENT_RE);
      if (matches) {
        for (const token of matches) {
          offenders.push(`${path.relative(path.join(__dirname, ".."), file)}: ${token}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `non-ASCII characters inside identifiers (e.g. "buildRestFaçade") create silent ReferenceErrors at runtime:\n${offenders.join("\n")}`,
  );
});
