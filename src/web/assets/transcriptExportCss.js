"use strict";

/**
 * Read the minified export stylesheet emitted by `npm run assets:build`.
 * Transcript HTML inlines this string. It is not fetched from /static.
 */

const fs = require("fs");
const path = require("path");
const { DIST_DIR } = require("./stamp");

const EXPORT_CSS_PATH = path.join(DIST_DIR, "transcript-export.css");

let cached = null;

/**
 * @param {string} [filePath] defaults to the build output. Tests pass a temp file.
 * @returns {string} minified CSS, safe to place inside a style element
 */
function loadTranscriptExportCss(filePath = EXPORT_CSS_PATH) {
  let css;
  try {
    css = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      const missing = new Error(
        `[tickets] transcript export CSS missing at ${filePath}. Run \`npm run assets:build\` before archiving. Refusing to write an unstyled transcript.`
      );
      missing.code = "TRANSCRIPT_EXPORT_CSS_MISSING";
      throw missing;
    }
    throw err;
  }
  if (!css.includes("#101318") || !css.includes("#29a8bd")) {
    const bad = new Error(
      "[tickets] transcript export CSS is not the forge token bundle. Run `npm run assets:build`. Refusing to write an unstyled transcript."
    );
    bad.code = "TRANSCRIPT_EXPORT_CSS_MISSING";
    throw bad;
  }
  if (/url\(\s*['"]?(?:https?:|\/|\.\.)/i.test(css)) {
    const external = new Error(
      "[tickets] transcript export CSS still points at an external file. The export build must inline its fonts. Refusing to write it."
    );
    external.code = "TRANSCRIPT_EXPORT_CSS_MISSING";
    throw external;
  }
  return css.replace(/<\/style/gi, "<\\/style");
}

/** Cached for the process. The file is immutable until the next build. */
function transcriptExportCss() {
  if (cached == null) cached = loadTranscriptExportCss();
  return cached;
}

module.exports = {
  EXPORT_CSS_PATH,
  loadTranscriptExportCss,
  transcriptExportCss,
};
