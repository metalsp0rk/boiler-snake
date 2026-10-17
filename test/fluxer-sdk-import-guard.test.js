/**
 * Guard test (PR 6 bundle, K6; extended for the REST package in #381): each
 * SDK package name string may appear in EXACTLY ONE production file —
 * src/platform/fluxer/client.js — which loads them via a dynamic await
 * import() inside an async factory. Feature modules, every other src/**
 * file, and ALL of test/** must never reference a package name: `npm test`
 * has to stay green with the SDK not installed (roadmap/fluxer.md § Tests:
 * "The default test run must not import or require that package").
 *
 * Each needle is assembled from fragments so this file never contains the
 * contiguous string it hunts for.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const NEEDLES = [
  // Core SDK (PR 6 law) and the REST module (#381, audit G2-2: the multipart
  // contract tests need the REAL serialization module behind one guarded
  // load site — the same K6 rule applies to its package name).
  { needle: "@fluxer" + "js" + "/core", importConst: "SDK_PACKAGE_NAME" },
  { needle: "@fluxer" + "js" + "/rest", importConst: "REST_PACKAGE_NAME" },
];
const ALLOWED_REL = path.join("src", "platform", "fluxer", "client.js");

/**
 * Recursively collect every .js file under a directory (regular files only;
 * symlinks are skipped so a linked tree can never smuggle a reference in).
 *
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]} absolute file paths, sorted
 */
function collectJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

test("no file under src/ or test/ references the SDK packages except the client factory", () => {
  const files = [
    ...collectJsFiles(path.join(ROOT, "src")),
    ...collectJsFiles(path.join(ROOT, "test")),
  ];
  // Sanity: the tree really was scanned (this repo has hundreds of .js files;
  // an accidental zero-file scan must never pass silently).
  assert.ok(
    files.length > 50,
    `expected to scan a substantial source tree, found ${files.length} .js files`,
  );

  const offenders = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (rel === ALLOWED_REL) continue;
    // Streamed read of the full file; .js sources are small.
    const content = fs.readFileSync(file, "utf8");
    for (const { needle } of NEEDLES) {
      if (content.includes(needle)) {
        offenders.push(`${rel} → ${needle}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `SDK package name found outside src/platform/fluxer/client.js: ${offenders.join(", ")}`,
  );
});

test("the allowed file contains each package name and loads it dynamically", () => {
  const allowed = path.join(ROOT, "src", "platform", "fluxer", "client.js");
  assert.ok(fs.existsSync(allowed), "src/platform/fluxer/client.js must exist");
  const content = fs.readFileSync(allowed, "utf8");
  for (const { needle, importConst } of NEEDLES) {
    const occurrences = content.split(needle).length - 1;
    assert.ok(
      occurrences >= 1,
      `the allowed file must reference ${needle} at its import site`,
    );
    // And it must be a DYNAMIC import (the K6 load-safety contract), never a
    // top-level require.
    assert.ok(
      content.includes(`await import(${importConst})`),
      `${needle} must be loaded via await import() through the single constant`,
    );
    assert.equal(content.includes('require("' + needle + '")'), false);
    assert.equal(content.includes("require('" + needle + "')"), false);
  }
});
