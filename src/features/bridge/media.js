/**
 * Bridge media spool (roadmap/bridge.md §10.8) — spool-at-enqueue, ceilings,
 * spoiler mapping, skip lines, and the latched-notice mechanism.
 *
 * Layout: {DATA_DIR}/bridge-spool/{publicId}/{srcMessageId}/{index}
 * (index 0..n, generated). Remote filenames are NEVER path segments: the
 * original filename lives in payload_json and is sent as the multipart
 * `filename` after a 120-char cap. Both id segments must match
 * ^[A-Za-z0-9_-]+$ and the resolved path must stay inside the message's spool
 * directory (same containment shape as resolveAssetAbsolutePath in
 * src/features/tickets/assets.js). Nothing here ever writes under
 * ticket-transcripts/ — the spool root is a sibling tree.
 *
 * Enqueue does not send traffic: spoolAttachments DOWNLOADS each signed URL
 * with NO bot credential through the SHARED SSRF guard
 * (src/core/ssrfGuard.js — plain fetch, https only, same-host redirects ≤ 3,
 * resolved loopback/link-local/RFC1918 refused per hop, 30 s timeout) and
 * writes bytes SYNCHRONOUSLY to the generated index path. Per-attachment failures are
 * recorded as `skipReason` on the payload descriptor; text and already-spooled
 * files still cross (AGENTS.md partial-failure rule).
 *
 * This module imports neither discord.js nor the Fluxer SDK core package.
 */

const fs = require("fs");
const path = require("path");
const {
  DOWNLOAD_TIMEOUT_MS,
  MAX_REDIRECTS,
  isDisallowedAddress,
  hostRefusalReason,
  downloadGuarded,
} = require("../../core/ssrfGuard");

// ---------------------------------------------------------------------------
// Ceilings (spec §10.8 table; spike B11 re-verifies the Fluxer clamp)
// ---------------------------------------------------------------------------

/** Per-file upload ceiling by destination platform, in bytes. */
const FILE_SIZE_LIMITS = Object.freeze({
  fluxer: 50 * 1024 * 1024, // 52,428,800 — documented bot clamp
  discord: 20 * 1024 * 1024, // 20,971,520 — every end (no boost table hard-coded)
});

/** Files per webhook execute. Overflow = more executes, same FIFO slot. */
const MAX_FILES_PER_EXECUTE = 10;

/** Spool caps: 500 MiB per bridge, 2 GiB process-wide (spec §10.8). */
const BRIDGE_SPOOL_CAP_BYTES = 500 * 1024 * 1024;
const PROCESS_SPOOL_CAP_BYTES = 2 * 1024 * 1024 * 1024;

// Download timeout per file (ms) and the same-host redirect budget come from
// the shared SSRF guard (src/core/ssrfGuard.js) — imported above.

/** Multipart filename cap (same spirit as tickets' sanitizeFilename). */
const FILENAME_MAX_LEN = 120;

/** Spool directory tree name under DATA_DIR (never under ticket-transcripts/). */
const SPOOL_ROOT_NAME = "bridge-spool";

/** Spool path segments (publicId, srcMessageId) must match this exactly. */
const SPOOL_ID_RE = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Paths and containment
// ---------------------------------------------------------------------------

/**
 * DATA_DIR at call time (tests point it at a temp dir via test/helpers/env.js).
 * @returns {string}
 */
function dataDir() {
  // Lazy require: the db connection is (re)bound by tests via loadDb().
  return require("../../db/connection").dataDir;
}

/** @returns {string} absolute, resolved spool root. */
function spoolRootDir() {
  return path.resolve(dataDir(), SPOOL_ROOT_NAME);
}

/**
 * @param {unknown} value
 * @returns {boolean} true when the value is a safe single path segment.
 */
function isSafeSpoolId(value) {
  return typeof value === "string" && SPOOL_ID_RE.test(value);
}

/**
 * Resolve the spool directory for one source message, containment-checked.
 * @returns {string|null} absolute path, null when the ids are refused.
 */
function spoolDirFor(publicId, srcMessageId) {
  if (!isSafeSpoolId(publicId) || !isSafeSpoolId(srcMessageId)) return null;
  const root = spoolRootDir();
  const dir = path.resolve(root, publicId, srcMessageId);
  if (dir !== root && !dir.startsWith(root + path.sep)) return null;
  return dir;
}

/**
 * Resolve ONE spool file path (index 0..n). File names are GENERATED here —
 * remote filenames never reach the filesystem as path segments.
 * @returns {string|null} absolute path, null when the ids/index are refused.
 */
function spoolFilePath(publicId, srcMessageId, index) {
  if (!Number.isInteger(index) || index < 0) return null;
  const dir = spoolDirFor(publicId, srcMessageId);
  if (!dir) return null;
  const file = path.resolve(dir, String(index));
  if (!file.startsWith(dir + path.sep)) return null;
  return file;
}

/**
 * Sanitize a remote filename for use as the multipart `filename` (the original
 * stays in payload_json). Mirrors tickets' sanitizeFilename: any directory
 * part is dropped, the character set is whitelisted, and the result is capped
 * at 120 characters (extension preserved, same spirit as the tickets helper).
 * @param {unknown} name
 * @returns {string} never empty, never contains a path separator.
 */
function sanitizeOutboundFilename(name) {
  let base = String(name == null ? "file" : name)
    .split(/[/\\]/)
    .pop();
  base = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "");
  if (!base || base === "_" || base === ".") base = "file";
  if (base.length > FILENAME_MAX_LEN) {
    const ext = path.extname(base).slice(0, 20);
    base = `${base.slice(0, FILENAME_MAX_LEN - ext.length)}${ext}`;
  }
  return base;
}

/**
 * Coerce a source filename to a canonical UTF-8 form. Unicode normalization
 * can grow a string (NFC is not length-preserving for every input), so the
 * 120-char cap is applied LAST — the stored name can never exceed it.
 * @param {unknown} name
 * @returns {string}
 */
function sanitizeRemoteFilename(name) {
  const base = typeof name === "string" ? name : "file";
  return sanitizeOutboundFilename(base.normalize("NFC")).slice(0, FILENAME_MAX_LEN);
}

// ---------------------------------------------------------------------------
// Named skip lines (spec §10.8 — verbatim copy)
// ---------------------------------------------------------------------------

/**
 * `Attachment not copied: {filename} ({bytes} bytes) is over the destination
 *  limit of {limit} bytes.`
 */
function buildOverCapLine(filename, bytes, limit) {
  return `Attachment not copied: ${filename} (${bytes} bytes) is over the destination limit of ${limit} bytes.`;
}

/**
 * Any other per-file failure:
 * `Attachment not copied: {filename}: {reason}.`
 */
function buildSkipLine(filename, reason) {
  return `Attachment not copied: ${filename}: ${reason}.`;
}

/**
 * The spool-full latched notice (spec §10.8 — verbatim copy).
 * `Bridge {publicId} is not copying files in this direction: the spool is
 *  full ({detail}). Messages' text continues to copy; files that arrive while
 *  it is full are not copied. This notice will not repeat until the spool is
 *  under the cap again.`
 */
function buildSpoolFullNotice(publicId, detail) {
  return (
    `Bridge ${publicId} is not copying files in this direction: the spool is full (${detail}). ` +
    "Messages' text continues to copy; files that arrive while it is full are not copied. " +
    "This notice will not repeat until the spool is under the cap again."
  );
}

// ---------------------------------------------------------------------------
// Spoiler mapping (spec §10.8 Spoilers)
// ---------------------------------------------------------------------------

/**
 * Map the spoiler signal to the destination's representation.
 *  - Discord → Fluxer: strip the `SPOILER_` prefix (the payload's
 *    `spoiler: true` descriptor carries the flag; the worker sets attachment
 *    flag 1<<3 at execute time — the multipart API has no per-file flag field).
 *  - Fluxer → Discord: set the `SPOILER_` prefix from the flag.
 * Text `||spoilers||` pass through untouched (they ride the body text).
 *
 * @param {string} filename already-sanitized outbound filename
 * @param {boolean} spoiler the descriptor's spoiler flag
 * @param {string} destPlatform "discord" | "fluxer"
 * @returns {string}
 */
function applySpoilerForDestination(filename, spoiler, destPlatform) {
  const base = String(filename ?? "file");
  if (destPlatform === "discord") {
    return spoiler && !base.startsWith("SPOILER_") ? `SPOILER_${base}` : base;
  }
  return base.startsWith("SPOILER_") ? base.slice("SPOILER_".length) : base;
}

// ---------------------------------------------------------------------------
// Download security (SSRF posture, spec §10.8 "Security of downloads")
// ---------------------------------------------------------------------------

// The guard itself is SHARED (audit C5 / §6 P0.7): src/core/ssrfGuard.js,
// used verbatim by bridge spooling, gork vision downloads, and the
// ticket-archive asset mirror. isDisallowedAddress / hostRefusalReason are
// re-exported below; downloadSignedUrl below only adapts the result shape.

/**
 * GET a signed media URL with NO bot credential through the shared SSRF
 * guard: https only; same-host redirects capped at MAX_REDIRECTS (cross-host
 * redirects are refused); every hop re-runs the address checks; a 30 s
 * (configurable) timeout aborts the request. Never throws.
 *
 * @param {string} url
 * @param {{
 *   fetchImpl?: (url: string, init?: object) => Promise<any>,
 *   resolveHost?: (host: string) => Promise<string[]>,
 *   timeoutMs?: number,
 *   maxRedirects?: number,
 *   maxBytes?: number,  // #414: streamed cap — over-cap bytes are never
 *                       // fully buffered before the refusal
 * }} [opts]
 * @returns {Promise<{ ok: true, bytes: Buffer }|{ ok: false, reason: string }>}
 */
async function downloadSignedUrl(url, opts = {}) {
  const res = await downloadGuarded(url, opts);
  if (!res.ok) return { ok: false, reason: res.reason };
  return { ok: true, bytes: res.bytes };
}

// ---------------------------------------------------------------------------
// Spool accounting (process-wide counter + per-bridge sums; persist nothing)
// ---------------------------------------------------------------------------

const spoolUsage = { total: 0, byBridge: new Map() };

/** Latched-notice set: "publicId|direction|kind" → armed. Generic mechanism
 * (spec §10.8: spool_full lands here; queue_full + paused land with the
 * worker/PR 7 on the same keys). */
const noticeLatches = new Set();

/**
 * Arm a notice key. Returns true ONLY on the first call per key — the notice
 * fires once per incident, and `releaseNoticeLatch` re-arms it when the
 * condition clears (spool back under cap).
 */
function fireNoticeLatchOnce(publicId, direction, kind) {
  const key = `${publicId}|${direction}|${kind}`;
  if (noticeLatches.has(key)) return false;
  noticeLatches.add(key);
  return true;
}

/** Disarm a notice key (the "under the cap again" edge). */
function releaseNoticeLatch(publicId, direction, kind) {
  return noticeLatches.delete(`${publicId}|${direction}|${kind}`);
}

/** Test/restart helper: drop every armed latch. */
function resetNoticeLatches() {
  noticeLatches.clear();
}

/**
 * Reserve spool bytes (per-bridge AND process-wide). Reserving BEFORE the
 * download bounds concurrent enqueues; callers release on any failure path.
 * @returns {boolean} true when the reservation succeeded.
 */
function reserveSpoolBytes(publicId, bytes, caps) {
  const bridgeCap = Number.isFinite(caps?.bridge) ? caps.bridge : BRIDGE_SPOOL_CAP_BYTES;
  const processCap = Number.isFinite(caps?.process) ? caps.process : PROCESS_SPOOL_CAP_BYTES;
  const used = spoolUsage.byBridge.get(publicId) ?? 0;
  if (used + bytes > bridgeCap) return false;
  if (spoolUsage.total + bytes > processCap) return false;
  spoolUsage.byBridge.set(publicId, used + bytes);
  spoolUsage.total += bytes;
  return true;
}

/** Give reservation bytes back (releaseSpoolDir / failed writes). */
function releaseSpoolBytes(publicId, bytes) {
  const used = spoolUsage.byBridge.get(publicId) ?? 0;
  const next = Math.max(0, used - bytes);
  spoolUsage.total = Math.max(0, spoolUsage.total - Math.min(bytes, used));
  if (next === 0) spoolUsage.byBridge.delete(publicId);
  else spoolUsage.byBridge.set(publicId, next);
}

/** Current accounting snapshot (status surfaces spoolBytes; tests assert). */
function spoolUsageSnapshot(publicId) {
  return {
    totalBytes: spoolUsage.total,
    bridgeBytes: publicId == null ? null : spoolUsage.byBridge.get(publicId) ?? 0,
  };
}

/** Zero all counters (tests; production restarts in a fresh process). */
function resetSpoolAccounting() {
  spoolUsage.total = 0;
  spoolUsage.byBridge.clear();
}

/**
 * Rebuild counters from the on-disk spool (restart: bytes spooled by a
 * previous process count against the caps again).
 * @returns {{ files: number, bytes: number }}
 */
function initSpoolAccounting() {
  resetSpoolAccounting();
  let files = 0;
  const root = spoolRootDir();
  for (const publicId of listSpoolPublicIds()) {
    const bridgeDir = path.join(root, publicId);
    let size = 0;
    for (const msgDir of safeReaddir(bridgeDir)) {
      const msgPath = path.join(bridgeDir, msgDir);
      for (const file of safeReaddir(msgPath)) {
        try {
          size += fs.statSync(path.join(msgPath, file)).size;
          files += 1;
        } catch {
          // vanished mid-scan: a deleted file is unspooled bytes, not an error
        }
      }
    }
    if (size > 0) {
      spoolUsage.byBridge.set(publicId, size);
      spoolUsage.total += size;
    }
  }
  return { files, bytes: spoolUsage.total };
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Public ids that currently have a spool directory. */
function listSpoolPublicIds() {
  return safeReaddir(spoolRootDir());
}

/**
 * Start-time orphan pass (spec §10.10 Restart / Data Model): delete spool
 * directories whose publicId has no bridges row. Directories that are not
 * even a legal public id are removed too (garbage from a manual edit).
 * @param {{ isKnownPublicId: (publicId: string) => boolean }} [opts]
 * @returns {{ removed: string[] }}
 */
function sweepOrphanSpools(opts = {}) {
  const isKnown =
    typeof opts.isKnownPublicId === "function" ? opts.isKnownPublicId : () => true;
  // #412 (BRG-6) second leg: PER-MESSAGE reclaim for KNOWN bridges whose
  // outbox rows for that source message are all terminal. A parked
  // (failed) row never reads its spool again, yet the dir pinned the
  // per-bridge AND process caps — across restarts, since the boot scan
  // re-counted it. Live work (pending/sending) keeps the dir; the
  // default (no predicate) keeps everything, preserving the pass's
  // original publicId-only contract.
  const hasLiveOutbox =
    typeof opts.hasLiveOutbox === "function" ? opts.hasLiveOutbox : () => true;
  const root = spoolRootDir();
  const removed = [];
  let removedAny = false;
  for (const entry of safeReaddir(root)) {
    const dir = path.join(root, entry);
    const keep = isSafeSpoolId(entry) && isKnown(entry);
    if (keep) {
      for (const msgDir of safeReaddir(dir)) {
        if (hasLiveOutbox(entry, msgDir)) continue;
        try {
          fs.rmSync(path.join(dir, msgDir), { recursive: true, force: true });
          removed.push(`${entry}/${msgDir}`);
          removedAny = true;
        } catch (err) {
          console.error(
            `[bridge] terminal-spool cleanup: could not remove ${entry}/${msgDir}: ${err?.message || err}`,
          );
        }
      }
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(entry);
      spoolUsage.byBridge.delete(entry);
      removedAny = true;
    } catch (err) {
      console.error(
        `[bridge] orphan spool cleanup: could not remove ${entry}: ${err?.message || err}`,
      );
    }
  }
  if (removedAny) {
    const scan = initSpoolAccountingScanOnce();
    spoolUsage.total = scan.totalBytes;
    spoolUsage.byBridge = scan.byBridge;
  }
  return { removed };
}

/** Re-scan helper used by the orphan pass (kept private; full reset+scan). */
function initSpoolAccountingScanOnce() {
  resetSpoolAccounting();
  const root = spoolRootDir();
  for (const publicId of listSpoolPublicIds()) {
    const bridgeDir = path.join(root, publicId);
    let size = 0;
    for (const msgDir of safeReaddir(bridgeDir)) {
      const msgPath = path.join(bridgeDir, msgDir);
      for (const file of safeReaddir(msgPath)) {
        try {
          size += fs.statSync(path.join(msgPath, file)).size;
        } catch {
          // ignore
        }
      }
    }
    if (size > 0) {
      spoolUsage.byBridge.set(publicId, size);
      spoolUsage.total += size;
    }
  }
  return { totalBytes: spoolUsage.total, byBridge: spoolUsage.byBridge };
}

// ---------------------------------------------------------------------------
// Spooling at enqueue
// ---------------------------------------------------------------------------

/**
 * Spool every attachment of one source message (spec §10.8).
 *
 * Per attachment, in order: filename sanitization (120 cap; the original stays
 * in the descriptor), the per-file destination ceiling (over-cap files are NOT
 * downloaded), the spool caps (reserved before download, released on every
 * failure), the timed download, and the SYNCHRONOUS write to the generated
 * index path. Cap-forgone files add one spool_full notice to `notices` — the
 * latch guarantees one per (publicId, direction, spool_full) incident.
 *
 * @param {object} args
 * @param {string} args.publicId bridge handle (validated)
 * @param {string} args.srcMessageId source message id (validated)
 * @param {Array<object>} args.attachments payload-shaped descriptors
 *   ({ sourceAttachmentId, filename, contentType, spoiler, bytes, skipReason }
 *   — fields media fills in are added here)
 * @param {string} args.destinationPlatform "fluxer" | "discord"
 * @param {string} args.direction "a_to_b" | "b_to_a" (notice latch key)
 * @param {object} [args.opts] media seams: { fetchImpl, resolveHost,
 *   downloadTimeoutMs, bridgeSpoolCapBytes, processSpoolCapBytes }
 * @returns {Promise<{ descriptors: object[], notices: Array<{kind: string, detail: string}> }>}
 */
async function spoolAttachments(args = {}) {
  const publicId = String(args.publicId ?? "");
  const srcMessageId = String(args.srcMessageId ?? "");
  const attachments = Array.isArray(args.attachments) ? args.attachments : [];
  const destPlatform = args.destinationPlatform === "discord" ? "discord" : "fluxer";
  const direction = args.direction;
  const opts = args.opts ?? {};
  const caps = {
    bridge: Number.isFinite(opts.bridgeSpoolCapBytes) ? opts.bridgeSpoolCapBytes : BRIDGE_SPOOL_CAP_BYTES,
    process: Number.isFinite(opts.processSpoolCapBytes) ? opts.processSpoolCapBytes : PROCESS_SPOOL_CAP_BYTES,
  };
  const notices = [];

  const dirOk = spoolDirFor(publicId, srcMessageId) !== null;
  const perFileCap = FILE_SIZE_LIMITS[destPlatform];

  const descriptors = [];
  let index = 0;

  for (const a of attachments) {
    // Normalized source attachments use `name` (spec §10.3); payload-shaped
    // descriptors use `filename`. Accept either; the wire name is sanitized.
    const filename = sanitizeRemoteFilename(a?.filename ?? a?.name);
    const declaredBytes = Number.isFinite(Number(a?.size)) ? Math.max(0, Math.trunc(Number(a.size))) : null;
    const descriptor = {
      sourceAttachmentId: a?.id != null ? String(a.id) : null,
      filename,
      contentType: a?.contentType ?? null,
      spoiler: (Number(a?.flags ?? 0) & 8) === 8,
      explicitMedia: (Number(a?.flags ?? 0) & 16) === 16,
      bytes: null,
      // The source-declared size (metadata only) — the over-cap skip line
      // names it verbatim, and it is the value the ceiling pre-check used.
      declaredBytes,
      skipReason: null,
      spoolIndex: index,
    };
    descriptors.push(descriptor);
    index += 1;

    const finish = (skipReason) => {
      descriptor.skipReason = skipReason;
    };

    // Unsafe path segments: the file is refused (spec: ids that do not match
    // the regex are refused), the text still crosses.
    if (!dirOk) {
      finish("refused: unsafe spool id");
      continue;
    }

    // Per-file ceiling — pre-checked against the declared size BEFORE any
    // byte moves (spec: "pre-check at enqueue, before writing bytes").
    if (declaredBytes != null && declaredBytes > perFileCap) {
      finish("over-cap");
      continue;
    }

    if (!a?.url || typeof a.url !== "string" || a.url.trim() === "") {
      finish("no source url on the attachment");
      continue;
    }

    // Spool caps: reserve the declared size BEFORE the download (spec
    // "pre-check at enqueue, before writing bytes"). Unknown sizes reserve
    // the actual bytes after the download, below.
    let reserve = declaredBytes == null ? 0 : declaredBytes;
    if (reserve > 0 && !reserveSpoolBytes(publicId, reserve, caps)) {
      finish("spool-full");
      const detail =
        (spoolUsage.byBridge.get(publicId) ?? 0) + reserve > caps.bridge
          ? `bridge cap ${caps.bridge} bytes`
          : `process cap ${caps.process} bytes`;
      notices.push({ kind: "spool_full", detail });
      continue;
    }

    let dl;
    try {
      dl = await downloadSignedUrl(a.url, {
        fetchImpl: opts.fetchImpl,
        resolveHost: opts.resolveHost,
        timeoutMs: opts.downloadTimeoutMs,
        // #414 (BRG-8): the transport stops AT the per-file ceiling. Before
        // this, a lying attachment `size` defeated the declared-size
        // reservation AND the whole oversized body was buffered in RAM
        // before the post-hoc `actual > perFileCap` check rejected it.
        maxBytes: perFileCap,
      });
    } catch (err) {
      // Defense in depth: downloadSignedUrl never throws; a seam that does
      // (tests passing a throwing fetch) is a fetch-failure, not a crash.
      dl = { ok: false, reason: `fetch failed: ${String(err?.message || err)}` };
    }
    if (!dl.ok) {
      if (reserve > 0) releaseSpoolBytes(publicId, reserve);
      // #414: the transport stopping AT the per-file ceiling mid-stream is
      // the spec's over-cap outcome (the fake that ignores maxBytes still
      // lands on the post-download `actual > perFileCap` check below).
      if (/^file too large/.test(String(dl.reason))) finish("over-cap");
      else finish(`fetch-failed: ${dl.reason}`);
      continue;
    }

    const actual = dl.bytes.length;
    if (actual > perFileCap) {
      if (reserve > 0) releaseSpoolBytes(publicId, reserve);
      finish("over-cap");
      continue;
    }
    // Unknown declared size: reserve the actual bytes before the write.
    if (declaredBytes == null && actual > 0) {
      if (!reserveSpoolBytes(publicId, actual, caps)) {
        finish("spool-full");
        const detail =
          (spoolUsage.byBridge.get(publicId) ?? 0) + actual > caps.bridge
            ? `bridge cap ${caps.bridge} bytes`
            : `process cap ${caps.process} bytes`;
        notices.push({ kind: "spool_full", detail });
        continue;
      }
      reserve = actual;
    }

    const filePath = spoolFilePath(publicId, srcMessageId, descriptor.spoolIndex);
    try {
      if (!filePath) throw new Error("unsafe spool path");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // Synchronous local write inside the pipeline (spec §10.8): the bytes
      // are durable before the outbox row's payload is updated.
      fs.writeFileSync(filePath, dl.bytes);
      // The descriptor records the source-DECLARED size when the source gave
      // one (that is the number the §10.8 named lines and status report); a
      // source with no declared size records the spooled byte count.
      descriptor.bytes = declaredBytes == null ? actual : declaredBytes;
    } catch (err) {
      releaseSpoolBytes(publicId, reserve);
      finish(`spool-write-failed: ${String(err?.message || err)}`);
      continue;
    }

    // A spool-full incident ends when usage drops back under the cap: re-arm
    // the latch so the next incident can notify again (spec §10.8).
    if (
      (spoolUsage.byBridge.get(publicId) ?? 0) < caps.bridge &&
      spoolUsage.total < caps.process
    ) {
      releaseNoticeLatch(publicId, direction, "spool_full");
    }
  }

  // Latch: keep ONE notice per kind per incident. The worker sends it (enqueue
  // does no network); the payload carries it to the worker.
  const kinds = new Set();
  const keptNotices = [];
  for (const n of notices) {
    if (kinds.has(n.kind)) continue;
    if (!fireNoticeLatchOnce(publicId, direction, n.kind)) continue;
    kinds.add(n.kind);
    keptNotices.push(n);
  }

  return { descriptors, notices: keptNotices };
}

// ---------------------------------------------------------------------------
// Reading and removing spooled bytes
// ---------------------------------------------------------------------------

/**
 * Read one spooled file. Returns null for a missing/unreadable file — the
 * worker's fetchSourceMessage re-sign fallback owns that case.
 */
function readSpooledFile(publicId, srcMessageId, index) {
  const file = spoolFilePath(publicId, srcMessageId, index);
  if (!file) return null;
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/**
 * Delete a WHOLE bridge's spool directory (disconnect; audit #195 item 4).
 * Every per-message spool dir of a disconnected bridge is stranded data:
 * the outbox rows that referenced it are cascade-deleted with the bridge,
 * so nothing can ever read those bytes. The start-time orphan pass is the
 * backstop, but a long-running process would hold the bytes (and the
 * process-wide spool cap) until restart — disconnect must remove them now.
 *
 * Accounting is refreshed from the surviving files (same rules as
 * deleteSpoolDir), so a full-spool latch releases on the way down.
 *
 * @param {string} publicId bridge handle (path-segment-checked)
 * @returns {{existed: boolean, error: string|null}} — existed is true when
 *   the directory was there (removed or not); error names the failure when
 *   removal failed (already logged).
 */
function deleteSpoolPublicDir(publicId) {
  if (!isSafeSpoolId(publicId)) {
    return { existed: false, error: "refused: publicId is not a safe spool path segment" };
  }
  const root = spoolRootDir();
  const dir = path.resolve(root, publicId);
  if (dir === root || !dir.startsWith(root + path.sep)) {
    return { existed: false, error: "refused: spool path escaped the spool root" };
  }
  if (!fs.existsSync(dir)) return { existed: false, error: null };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error(
      `[bridge] disconnect spool cleanup failed for ${publicId}: ${err?.message || err}`,
    );
    return { existed: true, error: String(err?.message || err) };
  }
  const scan = initSpoolAccountingScanOnce();
  spoolUsage.total = scan.totalBytes;
  spoolUsage.byBridge = scan.byBridge;
  return { existed: true, error: null };
}

/**
 * Delete one source message's spool directory (ack-then-delete, supersession,
 * disconnect). Returns true when the directory existed. Accounting is
 * refreshed from the surviving files so the spool-full latch releases on the
 * way down.
 */
function deleteSpoolDir(publicId, srcMessageId) {
  const dir = spoolDirFor(publicId, srcMessageId);
  if (!dir) return false;
  let existed = true;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error(
      `[bridge] spool cleanup failed for ${publicId}/${srcMessageId}: ${err?.message || err}`,
    );
    return false;
  }
  // Refresh accounting from disk (best effort, same rules as the scan).
  const scan = initSpoolAccountingScanOnce();
  spoolUsage.total = scan.totalBytes;
  spoolUsage.byBridge = scan.byBridge;
  return existed;
}

module.exports = {
  // ceilings and constants
  FILE_SIZE_LIMITS,
  MAX_FILES_PER_EXECUTE,
  BRIDGE_SPOOL_CAP_BYTES,
  PROCESS_SPOOL_CAP_BYTES,
  DOWNLOAD_TIMEOUT_MS,
  MAX_REDIRECTS,
  FILENAME_MAX_LEN,
  SPOOL_ROOT_NAME,
  SPOOL_ID_RE,
  // paths + names
  spoolRootDir,
  isSafeSpoolId,
  spoolDirFor,
  spoolFilePath,
  sanitizeOutboundFilename,
  sanitizeRemoteFilename,
  // copy (verbatim-sentence builders)
  buildOverCapLine,
  buildSkipLine,
  buildSpoolFullNotice,
  // spoilers
  applySpoilerForDestination,
  // downloads
  isDisallowedAddress,
  hostRefusalReason,
  downloadSignedUrl,
  // spooling
  spoolAttachments,
  readSpooledFile,
  deleteSpoolDir,
  deleteSpoolPublicDir,
  // accounting + notices
  initSpoolAccounting,
  resetSpoolAccounting,
  spoolUsageSnapshot,
  fireNoticeLatchOnce,
  releaseNoticeLatch,
  resetNoticeLatches,
  // lifecycle
  listSpoolPublicIds,
  sweepOrphanSpools,
};
