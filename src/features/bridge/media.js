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
 * with NO bot credential (plain fetch, https only, same-host redirects ≤ 3,
 * resolved loopback/link-local/RFC1918 refused, 30 s timeout) and writes bytes
 * SYNCHRONOUSLY to the generated index path. Per-attachment failures are
 * recorded as `skipReason` on the payload descriptor; text and already-spooled
 * files still cross (AGENTS.md partial-failure rule).
 *
 * This module imports neither discord.js nor the Fluxer SDK core package.
 */

const fs = require("fs");
const path = require("path");
const net = require("net");
const dns = require("node:dns");

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

/** Download timeout per file (ms) and the same-host redirect budget. */
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;

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

/**
 * @param {string} host
 * @returns {boolean} true for IPv4 literals.
 */
function isIPv4Literal(host) {
  return net.isIPv4(String(host).replace(/^\[|\]$/g, ""));
}

/**
 * Classify one address: true when the download target must be refused.
 * Refused classes (spec): loopback, link-local, RFC1918 — plus the IPv6
 * equivalents (unspecified, ULA) and IPv4-mapped IPv6 forms.
 * @param {string} address
 * @returns {boolean}
 */
function isDisallowedAddress(address) {
  const raw = String(address ?? "").trim();
  if (raw === "") return true;
  let ip = raw.replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:([0-9.]+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map((n) => Number(n));
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0 || a === 10) return true; // "this host" + RFC1918 10/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
    if (a === 192 && b === 168) return true; // RFC1918 192.168/16
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true; // unspecified + loopback
    if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true; // ULA fc00::/7
    if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true; // link-local fe80::/10
    const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(lower);
    if (v4) return isDisallowedAddress(v4[1]);
    return false;
  }
  // Unparseable address: refuse (a resolved name must yield a real address).
  return true;
}

/** Default resolver: dns.lookup(all) → address strings. */
async function defaultResolveHost(hostname) {
  const rows = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return (Array.isArray(rows) ? rows : []).map((r) => r.address).filter(Boolean);
}

/**
 * Resolve a hostname and refuse dangerous address classes. A name that fails
 * to resolve is refused too — the signed URL host must be real and public.
 * @returns {Promise<string|null>} a refusal reason, null when the host is OK.
 */
async function hostRefusalReason(hostname, resolveHost) {
  const strip = String(hostname ?? "").replace(/^\[|\]$/g, "");
  if (strip === "") return "empty hostname";
  if (isIPv4Literal(strip) || net.isIPv6(strip)) {
    return isDisallowedAddress(strip) ? `refused address range for ${strip}` : null;
  }
  if (!SPOOL_ID_RE.test(strip) && !/^[a-z0-9._-]+$/i.test(strip)) {
    return `unparseable hostname: ${strip}`;
  }
  let addresses;
  try {
    addresses = await resolveHost(strip);
  } catch (err) {
    return `dns lookup failed for ${strip}: ${String(err?.message || err)}`;
  }
  const list = Array.isArray(addresses) ? addresses.filter(Boolean) : [];
  if (list.length === 0) return `no address resolved for ${strip}`;
  for (const addr of list) {
    if (isDisallowedAddress(addr)) return `refused address range for ${addr}`;
  }
  return null;
}

/**
 * GET a signed media URL with NO bot credential.
 * https only; same-host redirects capped at MAX_REDIRECTS (cross-host
 * redirects are refused); every hop re-runs the address checks; a 30 s
 * (configurable) timeout aborts the request.
 *
 * @param {string} url
 * @param {{
 *   fetchImpl?: (url: string, init?: object) => Promise<any>,
 *   resolveHost?: (host: string) => Promise<string[]>,
 *   timeoutMs?: number,
 *   maxRedirects?: number,
 * }} [opts]
 * @returns {Promise<{ ok: true, bytes: Buffer }|{ ok: false, reason: string }>}
 */
async function downloadSignedUrl(url, opts = {}) {
  const fetchImpl =
    typeof opts.fetchImpl === "function"
      ? opts.fetchImpl
      : (u, init) => globalThis.fetch(u, init);
  const resolveHost = typeof opts.resolveHost === "function" ? opts.resolveHost : defaultResolveHost;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DOWNLOAD_TIMEOUT_MS;
  const maxRedirects = Number.isInteger(opts.maxRedirects) && opts.maxRedirects >= 0
    ? opts.maxRedirects
    : MAX_REDIRECTS;

  let current = String(url ?? "");
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      return { ok: false, reason: "invalid url" };
    }
    if (parsed.protocol !== "https:") {
      return { ok: false, reason: `non-https url (${parsed.protocol})` };
    }
    const refusal = await hostRefusalReason(parsed.hostname, resolveHost);
    if (refusal) return { ok: false, reason: refusal };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    let res;
    try {
      // No Authorization header, no bot credential: this is a plain fetch of
      // a pre-signed URL (spec §10.8). The credential never comes here.
      res = await fetchImpl(current, { redirect: "manual", signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      const text = String(err?.message || err);
      const reason = /abort/i.test(text) ? "download timed out" : `fetch failed: ${text}`;
      return { ok: false, reason };
    }
    clearTimeout(timer);

    const status = Number(res?.status);
    if (Number.isFinite(status) && status >= 300 && status < 400) {
      const location = typeof res.headers?.get === "function" ? res.headers.get("location") : null;
      if (!location) return { ok: false, reason: `redirect with no location (HTTP ${status})` };
      if (hop === maxRedirects) return { ok: false, reason: "too many redirects" };
      let next;
      try {
        next = new URL(location, current);
      } catch {
        return { ok: false, reason: "redirect to an unparseable url" };
      }
      const sameHost =
        next.protocol === parsed.protocol && next.hostname === parsed.hostname && next.port === parsed.port;
      if (!sameHost) return { ok: false, reason: "redirect left the original host" };
      current = next.toString();
      continue;
    }
    if (!res || res.ok !== true) {
      return { ok: false, reason: Number.isFinite(status) ? `HTTP ${status}` : "no HTTP status" };
    }
    try {
      const ab = await res.arrayBuffer();
      return { ok: true, bytes: Buffer.from(ab) };
    } catch (err) {
      return { ok: false, reason: `body read failed: ${String(err?.message || err)}` };
    }
  }
  return { ok: false, reason: "too many redirects" };
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
  const root = spoolRootDir();
  const removed = [];
  for (const entry of safeReaddir(root)) {
    const dir = path.join(root, entry);
    const keep = isSafeSpoolId(entry) && isKnown(entry);
    if (keep) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(entry);
      spoolUsage.byBridge.delete(entry);
      const scan = initSpoolAccountingScanOnce();
      spoolUsage.total = scan.totalBytes;
      spoolUsage.byBridge = scan.byBridge;
    } catch (err) {
      console.error(
        `[bridge] orphan spool cleanup: could not remove ${entry}: ${err?.message || err}`,
      );
    }
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
      });
    } catch (err) {
      // Defense in depth: downloadSignedUrl never throws; a seam that does
      // (tests passing a throwing fetch) is a fetch-failure, not a crash.
      dl = { ok: false, reason: `fetch failed: ${String(err?.message || err)}` };
    }
    if (!dl.ok) {
      if (reserve > 0) releaseSpoolBytes(publicId, reserve);
      finish(`fetch-failed: ${dl.reason}`);
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
