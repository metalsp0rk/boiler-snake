"use strict";

/**
 * Forge asset stamp (#710). The build writes dist/forge-stamp.json. Boot
 * recomputes the source hash and refuses to listen when the stamp is missing,
 * stale, or names a file that is not in dist/web — a half-styled console
 * never comes up.
 *
 * The hash covers src/web/assets plus the pinned package versions in
 * package.json. It does not read node_modules, so the production image
 * (devDependencies omitted) can still verify the stamp.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const ASSET_DIR = __dirname;
const DIST_DIR = path.join(REPO_ROOT, "dist", "web");
const STAMP_PATH = path.join(REPO_ROOT, "dist", "forge-stamp.json");

const PINNED_PACKAGES = Object.freeze([
  "@shoelace-style/shoelace",
  "@fontsource/inter",
  "@fontsource/jetbrains-mono",
  "vite",
]);

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walkFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(abs));
    else if (ent.isFile()) out.push(abs);
  }
  return out;
}

/**
 * @param {string} [assetDir]
 * @returns {string} sha256 hex
 */
function hashInputs(assetDir = ASSET_DIR) {
  const hash = crypto.createHash("sha256");
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const pins = PINNED_PACKAGES.map((name) => {
    const spec =
      (pkg.devDependencies && pkg.devDependencies[name]) ||
      (pkg.dependencies && pkg.dependencies[name]) ||
      "";
    return `${name}@${spec}`;
  }).join("\n");
  hash.update(pins);
  hash.update("\0");
  const files = walkFiles(assetDir).sort();
  for (const abs of files) {
    const rel = path.relative(assetDir, abs).split(path.sep).join("/");
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(abs));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * @param {string} [stampPath]
 * @returns {object|null}
 */
function readStamp(stampPath = STAMP_PATH) {
  try {
    return JSON.parse(fs.readFileSync(stampPath, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * @param {string} distDir
 * @param {string} rel
 * @returns {string|null} absolute file path, or null when it escapes distDir
 */
function resolveOutput(distDir, rel) {
  if (!rel || typeof rel !== "string" || rel.includes("\0")) return null;
  const root = path.resolve(distDir);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/**
 * @param {object} [options]
 * @param {string} [options.stampPath]
 * @param {string} [options.distDir]
 * @param {() => string} [options.hashInputs]
 * @returns {object} the stamp
 */
function assertForgeAssets(options = {}) {
  const stampPath = options.stampPath || STAMP_PATH;
  const distDir = options.distDir || DIST_DIR;
  const compute = options.hashInputs || hashInputs;
  const stamp = readStamp(stampPath);
  if (!stamp || typeof stamp.inputsHash !== "string" || !Array.isArray(stamp.outputs)) {
    const err = new Error(
      "[web] forge assets missing: run `npm run assets:build` before starting the console. Refusing to serve a half-styled page."
    );
    err.code = "FORGE_ASSETS_MISSING";
    throw err;
  }
  const now = compute();
  if (now !== stamp.inputsHash) {
    const err = new Error(
      "[web] forge assets are stale: source no longer matches the build stamp. Run `npm run assets:build`. Refusing to serve a half-styled page."
    );
    err.code = "FORGE_ASSETS_STALE";
    throw err;
  }
  for (const rel of stamp.outputs) {
    const abs = resolveOutput(distDir, rel);
    if (!abs) {
      const err = new Error(
        `[web] forge stamp lists a path outside the build directory (${rel}). Run \`npm run assets:build\`.`
      );
      err.code = "FORGE_ASSETS_MISSING";
      throw err;
    }
    let stat = null;
    try {
      stat = fs.statSync(abs);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) {
      const err = new Error(
        `[web] forge assets incomplete: ${rel} is not in the build output. Run \`npm run assets:build\`. Refusing to serve a half-styled page.`
      );
      err.code = "FORGE_ASSETS_MISSING";
      throw err;
    }
  }
  return stamp;
}

/**
 * @param {string} [distDir]
 * @returns {object}
 */
function readBuildManifest(distDir = DIST_DIR) {
  // Vite 5.4 writes the manifest under .vite/, not the outDir root.
  return JSON.parse(fs.readFileSync(path.join(distDir, ".vite", "manifest.json"), "utf8"));
}

/**
 * @param {object} manifest Vite build manifest
 * @returns {{js:string, css:string[]}}
 */
function forgePublicPaths(manifest) {
  const entry = Object.values(manifest).find((item) => item && item.isEntry);
  if (!entry || !entry.file) {
    throw new Error("[web] forge manifest has no entry chunk. Run `npm run assets:build`.");
  }
  // Vite 5.4 lists the extracted stylesheet as its own manifest record
  // (style.css) rather than on the entry's css array.
  const css = new Set(entry.css || []);
  for (const item of Object.values(manifest)) {
    if (item && typeof item.file === "string" && item.file.endsWith(".css")) css.add(item.file);
  }
  return {
    js: `/static/forge/${entry.file}`,
    css: [...css].map((file) => `/static/forge/${file}`),
  };
}

/**
 * Relative file list under distDir, posix, sorted. Skips nothing: the stamp
 * checks every emitted file, including icons copied in after Vite.
 * @param {string} distDir
 * @returns {string[]}
 */
function listOutputs(distDir) {
  return walkFiles(distDir)
    .map((abs) => path.relative(distDir, abs).split(path.sep).join("/"))
    .sort();
}

module.exports = {
  REPO_ROOT,
  ASSET_DIR,
  DIST_DIR,
  STAMP_PATH,
  PINNED_PACKAGES,
  hashInputs,
  readStamp,
  assertForgeAssets,
  readBuildManifest,
  forgePublicPaths,
  listOutputs,
  resolveOutput,
};
