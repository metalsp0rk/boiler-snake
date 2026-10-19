/**
 * Gork vision: image attachment filtering, download, and downscaling
 * (issue #227).
 *
 * Every image that reaches the LLM is downscaled to fit a 1280×1280 box
 * first (aspect ratio preserved, NEVER upscaled; an image already within
 * the box rides to the provider as-is, no re-encode). Images ride as
 * base64 data URLs in the multimodal user message: the configured
 * provider may be self-hosted (`AI_BASE_URL`, e.g. vLLM) and cannot fetch
 * Discord CDN links, the links can expire, and the downscale/re-encode
 * has to happen locally anyway.
 *
 * Boundaries (issue #227 "bounded constants", env-overridable like every
 * other gork knob — the trigger re-reads them per job):
 * - count cap per LLM request (`GORK_VISION_MAX_IMAGES`, 0 disables),
 * - per-attachment download ceiling (`GORK_VISION_MAX_IMAGE_BYTES`),
 * - total re-encoded bytes cap per request (`GORK_VISION_MAX_TOTAL_BYTES`).
 * Non-image attachments are skipped silently (they keep the text
 * treatment); GIFs decode to their FIRST frame (napi-rs/canvas) or are
 * skipped when decoding fails.
 *
 * Per-attachment degradation (AGENTS.md error rules): a failed
 * download / oversize / decode / encode NEVER kills the reply. Each
 * failure logs `[gork] vision …` with guild/user/message ids and a
 * specific reason, and the caller surfaces per-attachment note lines in
 * the text part instead (the "partial results" pattern).
 *
 * Downloads reuse the bridge media SSRF posture (src/features/bridge/
 * media.js — https only, every hop re-runs the resolved-address checks,
 * loopback/link-local/RFC1918 refused, same-host redirects ≤ 3, timed
 * abort). `fetchImpl` / `resolveHost` are injectable seams like
 * gork/tools/readPage.js.
 *
 * Resize core is pure buffer-in / buffer-out (`downscaleImageBuffer`) —
 * unit-testable without Discord or network.
 */

const { downloadSignedUrl } = require("../bridge/media");
const { envPositiveInt } = require("../../core/env"); // #470 (H1-7): shared copy

// ---------------------------------------------------------------------------
// Bounded constants (env-overridable; re-read per job by the trigger)
// ---------------------------------------------------------------------------


/**
 * Non-negative-integer env knob (0 is a valid, meaningful value —
 * `GORK_VISION_MAX_IMAGES=0` turns vision off).
 *
 * @param {string} name env var name
 * @param {number} fallback default for unset/invalid values
 * @returns {number}
 */
function envNonNegInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * LOCKED (issue #227 hard requirement): max output edge, in pixels. An
 * image is downscaled to fit a MAX_IMAGE_DIMENSION × MAX_IMAGE_DIMENSION
 * box, aspect ratio preserved, never upscaled.
 */
const MAX_IMAGE_DIMENSION = 1280;

/** Default max images per LLM request. 0 (env) fully disables vision. */
const DEFAULT_VISION_MAX_IMAGES = 4;
/** Default per-attachment download ceiling (15 MiB). */
const DEFAULT_VISION_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
/** Default total re-encoded (pre-base64) bytes cap per request (12 MiB). */
const DEFAULT_VISION_MAX_TOTAL_BYTES = 12 * 1024 * 1024;
/** Default per-image download timeout (10 s). */
const DEFAULT_VISION_DOWNLOAD_TIMEOUT_MS = 10_000;

/**
 * MIME allow-list for images that may ride to the provider. Anything else
 * (svg = script surface, tiff/heic = provider roulette, non-image) is
 * skipped. GIF decodes to its first frame (napi-rs/canvas).
 */
const VISION_MIME_ALLOWLIST = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

/**
 * Filename-extension fallback: normalized platform messages (Fluxer) may
 * carry only `{ name, url }`, so when the attachment ships no
 * content-type the extension decides.
 */
const VISION_EXT_ALLOWLIST = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/**
 * Filename-extension (lowercase, no dot) of an attachment name, "" when
 * there is none.
 *
 * @param {unknown} name
 * @returns {string}
 */
function extensionOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || "").trim());
  return m ? m[1].toLowerCase() : "";
}

/**
 * Effective content type: `contentType` when present (Discord), else a
 * guess from the filename extension (Fluxer's normalized {name,url}
 * shape, where it is the only signal).
 *
 * @param {{name?: string, contentType?: string|null}} att
 * @returns {string} lowercased, "" when unknown
 */
function effectiveContentType(att) {
  const ct = String(att?.contentType || "").toLowerCase().trim();
  if (ct) return ct;
  const ext = extensionOf(att?.name);
  if (!ext) return "";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return `image/${ext}`;
}

/**
 * Whether a filename extension names a supported image type.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
function isSupportedImageName(name) {
  return VISION_EXT_ALLOWLIST.has(extensionOf(name));
}

/**
 * Whether one attachment may ride as an IMAGE part. A known
 * content-type decides alone (an explicit `video/mp4` named `.gif` is
 * refused); attachments WITHOUT any content-type fall back to the
 * filename extension.
 *
 * @param {unknown} att
 * @returns {boolean}
 */
function isImageAttachment(att) {
  if (!att || typeof att !== "object") return false;
  const ct = String(att.contentType || "").toLowerCase().trim();
  if (ct) return VISION_MIME_ALLOWLIST.has(ct);
  return isSupportedImageName(att.name);
}

/**
 * Normalize the platform attachment shapes into a plain array:
 * discord.js Collection (has .values()), plain Map/array (both
 * iterable), or anything else → empty.
 *
 * @param {unknown} attachments
 * @returns {object[]}
 */
function iterAttachments(attachments) {
  if (!attachments) return [];
  // Arrays FIRST: arrays also carry .values() (Array.prototype.values), so
  // checking values() first would silently route them through the
  // Collection branch and strand the array branch as dead code.
  if (Array.isArray(attachments)) return attachments;
  if (typeof attachments.values === "function") return [...attachments.values()];
  if (typeof attachments[Symbol.iterator] === "function") return [...attachments];
  return [];
}

/**
 * Whether one message (discord.js Message or the duck/Fluxer shapes)
 * carries at least one supported image attachment.
 *
 * @param {unknown} message
 * @returns {boolean}
 */
function messageHasImage(message) {
  return iterAttachments(message?.attachments).some(isImageAttachment);
}

// ---------------------------------------------------------------------------
// Resize math (pure)
// ---------------------------------------------------------------------------

/**
 * Output dimensions for the 1280-box rule (issue #227): fractional
 * pixels round DOWN, minimum 1; an image already inside the box returns
 * null = send as-is, NEVER upscale.
 *
 * @param {number} width source width (px)
 * @param {number} height source height (px)
 * @param {number} [max] box edge (px)
 * @returns {{width: number, height: number}|null} null when no resize needed
 */
function resolveTargetSize(width, height, max = MAX_IMAGE_DIMENSION) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return null;
  if (w <= max && h <= max) return null;
  const scale = max / Math.max(w, h);
  return {
    width: Math.max(1, Math.floor(w * scale)),
    height: Math.max(1, Math.floor(h * scale)),
  };
}

/**
 * Re-encode format for RESIZED pixels: png/webp keep their alpha channel
 * (screenshots and stickers), everything else — including GIF's first
 * frame and unknown types — ships as JPEG so downscaled photos stay
 * small inside the data URL.
 *
 * @param {string} contentType effective content type of the source
 * @returns {"image/png"|"image/webp"|"image/jpeg"}
 */
function outputMimeFor(contentType) {
  const ct = String(contentType || "").toLowerCase().trim();
  if (ct === "image/png") return "image/png";
  if (ct === "image/webp") return "image/webp";
  return "image/jpeg";
}

// ---------------------------------------------------------------------------
// Resize core (buffer-in / buffer-out; the ONLY @napi-rs/canvas user)
// ---------------------------------------------------------------------------

/**
 * Decode → downscale-to-box → re-encode. A pure transformation (no
 * network, no platform objects): a source already inside the box returns
 * the ORIGINAL bytes untouched (`resized: false` — no re-encode, the
 * issue's "sent as-is" rule). Decodes via @napi-rs/canvas (lazy, like
 * src/render/leaderboard.js), so GIFs land as their first frame.
 *
 * @param {Buffer} buffer raw attachment bytes
 * @param {{maxDimension?: number, mediaType?: string}} [opts]
 *   mediaType = re-encode target for resized output (default jpeg)
 * @returns {Promise<{buffer: Buffer, mediaType: string, resized: boolean, width: number, height: number}>}
 *   `mediaType` is the caller's requested type; on passthrough the
 *   caller should prefer the SOURCE content type for the data URL
 * @throws when the bytes are not a decodable image
 */
async function downscaleImageBuffer(buffer, opts = {}) {
  const max = Number.isFinite(opts.maxDimension)
    ? Math.max(16, Math.floor(opts.maxDimension))
    : MAX_IMAGE_DIMENSION;
  const mediaType =
    opts.mediaType === "image/png" || opts.mediaType === "image/webp"
      ? opts.mediaType
      : "image/jpeg";
  // Lazy require: keep the canvas native module off the boot/unit-test
  // path for every consumer that never touches pixels.
  const { loadImage, createCanvas } = require("@napi-rs/canvas");
  const image = await loadImage(buffer);
  const target = resolveTargetSize(image.width, image.height, max);
  if (!target) {
    return {
      buffer,
      mediaType,
      resized: false,
      width: image.width,
      height: image.height,
    };
  }
  const canvas = createCanvas(target.width, target.height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, target.width, target.height);
  return {
    buffer: canvas.toBuffer(mediaType),
    mediaType,
    resized: true,
    width: target.width,
    height: target.height,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Env-derived vision limits, re-read per call (like llmParams()):
 * `{ maxImages, maxImageBytes, maxTotalBytes, downloadTimeoutMs }`.
 * `maxImages: 0` = vision fully off.
 *
 * @returns {{maxImages: number, maxImageBytes: number, maxTotalBytes: number, downloadTimeoutMs: number}}
 */
function visionLimits() {
  return {
    maxImages: envNonNegInt("GORK_VISION_MAX_IMAGES", DEFAULT_VISION_MAX_IMAGES),
    maxImageBytes: envPositiveInt(
      "GORK_VISION_MAX_IMAGE_BYTES",
      DEFAULT_VISION_MAX_IMAGE_BYTES,
    ),
    maxTotalBytes: envPositiveInt(
      "GORK_VISION_MAX_TOTAL_BYTES",
      DEFAULT_VISION_MAX_TOTAL_BYTES,
    ),
    downloadTimeoutMs: envPositiveInt(
      "GORK_VISION_DOWNLOAD_TIMEOUT_MS",
      DEFAULT_VISION_DOWNLOAD_TIMEOUT_MS,
    ),
  };
}

/**
 * Flatten candidate attachments — trigger message FIRST, then the
 * context messages (oldest → newest) — into `{url, name, contentType,
 * size, origin}` records: image-typed only, deduped by url.
 *
 * @param {object|undefined} triggerMessage discord.js Message (or duck shape)
 * @param {object[]} [contextMessages] context builder messages (oldest → newest)
 * @returns {object[]}
 */
function collectImageCandidates(triggerMessage, contextMessages = []) {
  const out = [];
  const seen = new Set();
  const push = (att, origin) => {
    if (!isImageAttachment(att)) return;
    const url = typeof att.url === "string" ? att.url.trim() : "";
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({
      url,
      name: typeof att.name === "string" && att.name.trim() ? att.name.trim() : "image",
      contentType: effectiveContentType(att),
      size: Number.isFinite(Number(att.size)) ? Number(att.size) : null,
      origin,
    });
  };
  for (const att of iterAttachments(triggerMessage?.attachments)) push(att, "trigger");
  for (const m of Array.isArray(contextMessages) ? contextMessages : []) {
    for (const att of iterAttachments(m?.attachments)) push(att, "context");
  }
  return out;
}

/**
 * Download → downscale → data URL the candidates (parallel; results keep
 * candidate order so the deterministic total-bytes budget walk below is
 * stable). NEVER throws and NEVER rejects: every per-attachment failure
 * (oversize, refused host, fetch, decode, encode, budget overflow) logs
 * a specific `[gork] vision …` line with guild/user/message ids and
 * lands in `notes` — the answer never dies on a broken image.
 *
 * @param {object[]} candidates collectImageCandidates() output
 * @param {object} [opts]
 * @param {object} [opts.limits] visionLimits() override (tests)
 * @param {Function} [opts.fetchImpl] fetch seam
 * @param {Function} [opts.resolveHost] dns seam
 * @param {{guildId?: string, userId?: string, messageId?: string}} [opts.ids]
 *   ids for the degradation logs
 * @returns {Promise<{
 *   parts: Array<{type: "image_url", image_url: {url: string}}>,
 *   notes: string[],
 *   sent: number,
 *   skipped: number,
 *   bytes: number
 * }>}
 */
async function prepareVisionImages(candidates, opts = {}) {
  const all = Array.isArray(candidates) ? candidates : [];
  const limits = { ...visionLimits(), ...(opts.limits || {}) };
  const ids = opts.ids || {};
  const log = (what, why) =>
    console.error(
      `[gork] vision image skipped guild=${ids.guildId ?? "?"} user=${ids.userId ?? "?"} msg=${ids.messageId ?? "?"}: ${what}: ${why}`,
    );
  const list = all.slice(0, Math.max(0, limits.maxImages));
  const droppedByCap = all.length - list.length;

  const settled = await Promise.all(
    list.map(async (att) => {
      if (!att?.url || typeof att.url !== "string") {
        return { att, fail: "attachment has no url" };
      }
      if (att.size != null && att.size > limits.maxImageBytes) {
        return {
          att,
          fail: `declared size ${att.size} exceeds the ${limits.maxImageBytes}-byte download cap`,
        };
      }
      let dl;
      try {
        dl = await downloadSignedUrl(att.url, {
          fetchImpl: opts.fetchImpl,
          resolveHost: opts.resolveHost,
          timeoutMs: limits.downloadTimeoutMs,
          // #414 (LT-7): stream-stop at the image cap — a lying declared
          // size used to buffer the whole body before the post-read check.
          maxBytes: limits.maxImageBytes,
        });
      } catch (err) {
        // Defense in depth: downloadSignedUrl never throws; a throwing
        // seam (test fetch) is a fetch failure, not a crash.
        dl = { ok: false, reason: `fetch failed: ${String(err?.message || err)}` };
      }
      if (!dl.ok) {
        // #414: the transport now stops AT the cap mid-stream — map that
        // refusal to the same cap-naming copy the post-buffer check used,
        // so the vision note keeps pointing at the limit (rule 3).
        if (/^file too large/.test(String(dl.reason))) {
          return {
            att,
            fail: `downloaded bytes exceed the ${limits.maxImageBytes}-byte cap (stopped mid-stream)`,
          };
        }
        return { att, fail: `download failed (${dl.reason})` };
      }
      if (dl.bytes.length > limits.maxImageBytes) {
        return {
          att,
          fail: `downloaded ${dl.bytes.length} bytes exceed the ${limits.maxImageBytes}-byte cap`,
        };
      }
      const mediaType = outputMimeFor(att.contentType);
      try {
        const resize = await downscaleImageBuffer(dl.bytes, {
          maxDimension: MAX_IMAGE_DIMENSION,
          mediaType,
        });
        // A REAL resize re-encoded to `mediaType`; a passthrough keeps
        // the original bytes, so the SOURCE content type names them.
        const url = `data:${resize.resized ? resize.mediaType : att.contentType || resize.mediaType};base64,${resize.buffer.toString("base64")}`;
        return { att, dataUrl: url, bytes: resize.buffer.length };
      } catch (err) {
        return { att, fail: `image decode/resize failed (${String(err?.message || err)})` };
      }
    }),
  );

  // Assemble in candidate order applying the TOTAL bytes cap
  // deterministically (a later image never races ahead of an earlier one
  // for the remaining budget).
  const parts = [];
  const notes = [];
  let bytes = 0;
  let skipped = 0;
  for (const r of settled) {
    if (r.fail) {
      log(`${r.att?.name ?? "image"} [${r.att?.origin ?? "?"}]`, r.fail);
      notes.push(`image "${r.att?.name ?? "image"}" could not be included: ${r.fail}`);
      skipped += 1;
      continue;
    }
    if (bytes + r.bytes > limits.maxTotalBytes) {
      log(
        `${r.att?.name ?? "image"} [${r.att?.origin ?? "?"}]`,
        `per-request image budget exhausted (${limits.maxTotalBytes} bytes)`,
      );
      skipped += 1;
      continue;
    }
    bytes += r.bytes;
    parts.push({ type: "image_url", image_url: { url: r.dataUrl } });
  }
  if (droppedByCap > 0) {
    notes.push(
      `${droppedByCap} more image attachment(s) were not included (cap: ${limits.maxImages} per request)`,
    );
    skipped += droppedByCap;
  }
  return { parts, notes, sent: parts.length, skipped, bytes };
}

module.exports = {
  // constants
  MAX_IMAGE_DIMENSION,
  DEFAULT_VISION_MAX_IMAGES,
  DEFAULT_VISION_MAX_IMAGE_BYTES,
  DEFAULT_VISION_MAX_TOTAL_BYTES,
  DEFAULT_VISION_DOWNLOAD_TIMEOUT_MS,
  VISION_MIME_ALLOWLIST,
  VISION_EXT_ALLOWLIST,
  // pure helpers
  extensionOf,
  effectiveContentType,
  isSupportedImageName,
  isImageAttachment,
  iterAttachments,
  messageHasImage,
  resolveTargetSize,
  outputMimeFor,
  // io (seams: fetchImpl / resolveHost on downloadSignedUrl)
  downscaleImageBuffer,
  visionLimits,
  collectImageCandidates,
  prepareVisionImages,
};
