#!/usr/bin/env node
"use strict";

/**
 * `npm run assets:build` / the `npm start` preflight (#710).
 * Vite writes dist/web. A second build then emits the self-contained
 * transcript stylesheet (#713) into the same directory without emptying it.
 * This script copies Shoelace's icon SVGs (they are fetched at runtime, not
 * imported) and writes dist/forge-stamp.json. A current stamp skips Vite.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  REPO_ROOT,
  DIST_DIR,
  STAMP_PATH,
  hashInputs,
  readStamp,
  assertForgeAssets,
  listOutputs,
} = require("../src/web/assets/stamp");

const SHOELACE_ASSETS = path.join(
  REPO_ROOT,
  "node_modules/@shoelace-style/shoelace/dist/assets"
);

function outputsPresent(stamp) {
  if (!stamp || !Array.isArray(stamp.outputs) || !stamp.outputs.length) return false;
  return stamp.outputs.every((rel) => {
    const abs = path.resolve(DIST_DIR, rel);
    const root = path.resolve(DIST_DIR);
    if (abs !== root && !abs.startsWith(root + path.sep)) return false;
    try {
      return fs.statSync(abs).isFile();
    } catch {
      return false;
    }
  });
}

function copyIcons() {
  if (!fs.existsSync(SHOELACE_ASSETS)) {
    throw new Error(
      `[assets] Shoelace assets missing at ${SHOELACE_ASSETS}. Run npm ci.`
    );
  }
  fs.cpSync(SHOELACE_ASSETS, path.join(DIST_DIR, "assets"), { recursive: true });
}

function writeStamp() {
  const stamp = {
    inputsHash: hashInputs(),
    builtAt: new Date().toISOString(),
    outputs: listOutputs(DIST_DIR),
  };
  fs.mkdirSync(path.dirname(STAMP_PATH), { recursive: true });
  fs.writeFileSync(STAMP_PATH, `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

function runVite(configFile) {
  const viteBin = path.join(REPO_ROOT, "node_modules/vite/bin/vite.js");
  if (!fs.existsSync(viteBin)) {
    console.error("[assets] vite is not installed. Run npm ci.");
    process.exit(1);
  }
  const result = spawnSync(
    process.execPath,
    [viteBin, "build", "--config", configFile],
    { cwd: REPO_ROOT, stdio: "inherit" }
  );
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function build() {
  const hash = hashInputs();
  const existing = readStamp();
  if (existing && existing.inputsHash === hash && outputsPresent(existing)) {
    console.log("[assets] forge build is current");
    return;
  }
  // The console build empties dist/web. The export build must follow it,
  // or emptyOutDir deletes transcript-export.css before the stamp is written.
  runVite("vite.web.config.mjs");
  runVite("vite.export.config.mjs");
  const exportCss = path.join(DIST_DIR, "transcript-export.css");
  if (!fs.existsSync(exportCss)) {
    throw new Error(
      "[assets] vite export build did not write dist/web/transcript-export.css"
    );
  }
  copyIcons();
  const stamp = writeStamp();
  console.log(
    `[assets] forge build wrote ${stamp.outputs.length} files and ${path.relative(REPO_ROOT, STAMP_PATH)}`
  );
}

function check() {
  require("dotenv").config();
  const port = process.env.PUBLIC_HTTP_PORT || process.env.TICKET_HTTP_PORT;
  if (!port) {
    console.log("[assets] public HTTP is off; forge asset check skipped");
    return;
  }
  try {
    assertForgeAssets();
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

const cmd = process.argv[2] || "build";
if (cmd === "build") {
  try {
    build();
  } catch (err) {
    console.error("[assets] forge build failed:", err?.message || err);
    process.exit(1);
  }
} else if (cmd === "check") {
  check();
} else {
  console.error("usage: node scripts/forge-assets.js build|check");
  process.exit(1);
}
