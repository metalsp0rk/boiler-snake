/**
 * Download Discord media into transcript asset dirs and rewrite URLs for local serving.
 *
 * Layout:
 *   {DATA_DIR}/ticket-transcripts/{guild_id}/{token}/assets/{nnn_filename}
 * Served as:
 *   GET /t/{token}/assets/{nnn_filename}
 */

const fs = require("fs");
const path = require("path");
const { dataDir } = require("../../db/connection");

/**
 * @param {string} guildId
 * @param {string} token
 * @returns {string}
 */
function absoluteAssetsDir(guildId, token) {
  return path.join(
    dataDir,
    "ticket-transcripts",
    String(guildId),
    String(token),
    "assets"
  );
}

/** Per-file size cap (bytes). Discord upload max varies; 50 MiB is a safe staff-archive default. */
const MAX_ASSET_BYTES = Number(process.env.TICKET_MAX_ASSET_BYTES) || 50 * 1024 * 1024;
/** Cap how many files we attempt per ticket. */
const MAX_ASSETS_PER_TICKET = Number(process.env.TICKET_MAX_ASSETS) || 100;

const IMAGE_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
  ".svg",
]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".mkv"]);
const AUDIO_EXT = new Set([".mp3", ".ogg", ".wav", ".m4a", ".flac"]);

/**
 * @param {string|null|undefined} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  let base = String(name || "file")
    .split(/[/\\]/)
    .pop();
  base = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "");
  if (!base || base === "_" || base === ".") base = "file";
  if (base.length > 120) {
    const ext = path.extname(base).slice(0, 20);
    base = `${base.slice(0, 120 - ext.length)}${ext}`;
  }
  return base;
}

/**
 * @param {string} filename
 * @param {string|null} [contentType]
 * @returns {"image"|"video"|"audio"|"file"}
 */
function mediaKind(filename, contentType) {
  const ct = (contentType || "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  const ext = path.extname(filename || "").toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return "file";
}

/**
 * Guess filename from URL path or Content-Disposition.
 * @param {string} url
 * @param {string|null} [hintName]
 * @returns {string}
 */
function filenameFromUrl(url, hintName) {
  if (hintName) return sanitizeFilename(hintName);
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last) return sanitizeFilename(decodeURIComponent(last.split("?")[0]));
  } catch {
    // ignore
  }
  return "file";
}

/**
 * Collect downloadable media URLs from a normalized message.
 * @param {object} message
 * @returns {{ url: string, name: string|null, contentType: string|null }[]}
 */
function collectMediaFromMessage(message) {
  const out = [];
  const seen = new Set();

  const push = (url, name, contentType) => {
    if (!url || typeof url !== "string") return;
    if (!/^https?:\/\//i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({
      url,
      name: name || null,
      contentType: contentType || null,
    });
  };

  const atts = parseAttachmentList(message.attachment_urls);
  for (const a of atts) {
    push(a.url || a.href, a.name, a.contentType);
  }

  // Embeds: image / thumbnail / video
  let embeds = [];
  if (message.embeds_json) {
    try {
      embeds =
        typeof message.embeds_json === "string"
          ? JSON.parse(message.embeds_json)
          : message.embeds_json;
    } catch {
      embeds = [];
    }
  }
  if (Array.isArray(embeds)) {
    for (const e of embeds) {
      if (e?.image?.url) push(e.image.url, null, "image/*");
      if (e?.thumbnail?.url) push(e.thumbnail.url, null, "image/*");
      if (e?.video?.url) push(e.video.url, null, "video/*");
    }
  }

  // Stickers (if stored as array of urls)
  if (Array.isArray(message.sticker_urls)) {
    for (const u of message.sticker_urls) push(u, null, "image/*");
  }

  return out;
}

/**
 * @param {string|object[]|null} raw
 * @returns {object[]}
 */
function parseAttachmentList(raw) {
  if (!raw) return [];
  let arr = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [{ url: raw, name: null, contentType: null }];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((a) => {
    if (typeof a === "string") {
      return { url: a, name: null, contentType: null, href: a };
    }
    return {
      url: a.url || a.href || null,
      name: a.name || null,
      contentType: a.contentType || a.content_type || null,
      href: a.href || a.url || null,
    };
  });
}

/**
 * Download a single URL to dest path. Throws on failure.
 * @param {string} url
 * @param {string} destPath
 * @returns {Promise<{ bytes: number, contentType: string|null }>}
 */
async function downloadUrlToFile(url, destPath) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      // Discord CDN is happier with a UA
      "User-Agent": "BoilerSnake-TicketArchive/1.0",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  const contentType = res.headers.get("content-type");
  const lenHeader = res.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_ASSET_BYTES) {
    throw new Error(`File too large (${lenHeader} bytes)`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ASSET_BYTES) {
    throw new Error(`File too large (${buf.length} bytes)`);
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return { bytes: buf.length, contentType };
}

/**
 * Download all media for a ticket archive and rewrite message attachment lists.
 *
 * @param {object[]} messages
 * @param {object} opts
 * @param {string} opts.guildId
 * @param {string} opts.token UUID transcript token
 * @returns {Promise<{
 *   messages: object[],
 *   downloaded: number,
 *   failed: number,
 *   assetsDir: string,
 *   warnings: string[],
 * }>}
 */
async function mirrorTicketAssets(messages, opts) {
  const { guildId, token } = opts;
  const assetsDir = absoluteAssetsDir(guildId, token);
  fs.mkdirSync(assetsDir, { recursive: true });

  /** @type {Map<string, { href: string, localName: string, contentType: string|null, kind: string }>} */
  const urlMap = new Map();
  const warnings = [];
  let downloaded = 0;
  let failed = 0;
  let index = 0;

  const allItems = [];
  for (const m of messages || []) {
    for (const item of collectMediaFromMessage(m)) {
      allItems.push(item);
    }
  }

  // Dedupe by URL preserving first name/type
  const unique = [];
  const seen = new Set();
  for (const item of allItems) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    unique.push(item);
  }

  const toFetch = unique.slice(0, MAX_ASSETS_PER_TICKET);
  if (unique.length > MAX_ASSETS_PER_TICKET) {
    warnings.push(
      `Asset cap: only first ${MAX_ASSETS_PER_TICKET} of ${unique.length} media files were downloaded.`
    );
  }

  for (const item of toFetch) {
    index += 1;
    const baseName = filenameFromUrl(item.url, item.name);
    const localName = `${String(index).padStart(3, "0")}_${baseName}`;
    const dest = path.join(assetsDir, localName);

    try {
      const { contentType } = await downloadUrlToFile(item.url, dest);
      const ct = contentType || item.contentType;
      const kind = mediaKind(localName, ct);
      urlMap.set(item.url, {
        href: `/t/${token}/assets/${encodeURIComponent(localName).replace(/%2F/g, "")}`,
        // encodeURIComponent encodes too much for path segments; localName is already safe
        localName,
        contentType: ct,
        kind,
      });
      // Prefer clean path without over-encoding safe names
      urlMap.get(item.url).href = `/t/${token}/assets/${localName}`;
      downloaded += 1;
    } catch (err) {
      failed += 1;
      console.warn(
        `[tickets] asset download failed (${item.url}):`,
        err?.message || err
      );
    }
  }

  const rewritten = (messages || []).map((m) => {
    const atts = parseAttachmentList(m.attachment_urls).map((a) => {
      const url = a.url || a.href;
      const mapped = url ? urlMap.get(url) : null;
      if (mapped) {
        return {
          url: mapped.href,
          href: mapped.href,
          name: a.name || mapped.localName,
          contentType: mapped.contentType || a.contentType,
          kind: mapped.kind,
          local: true,
          source_url: url,
        };
      }
      return {
        url,
        href: url,
        name: a.name,
        contentType: a.contentType,
        kind: mediaKind(a.name || url || "", a.contentType),
        local: false,
      };
    });

    // Rewrite embed media URLs in a copy of embeds_json
    let embedsJson = m.embeds_json;
    if (embedsJson) {
      try {
        const embeds =
          typeof embedsJson === "string" ? JSON.parse(embedsJson) : embedsJson;
        if (Array.isArray(embeds)) {
          const next = embeds.map((e) => {
            const copy = { ...e };
            if (copy.image?.url && urlMap.has(copy.image.url)) {
              copy.image = {
                ...copy.image,
                url: urlMap.get(copy.image.url).href,
              };
            }
            if (copy.thumbnail?.url && urlMap.has(copy.thumbnail.url)) {
              copy.thumbnail = {
                ...copy.thumbnail,
                url: urlMap.get(copy.thumbnail.url).href,
              };
            }
            if (copy.video?.url && urlMap.has(copy.video.url)) {
              copy.video = {
                ...copy.video,
                url: urlMap.get(copy.video.url).href,
              };
            }
            return copy;
          });
          embedsJson = JSON.stringify(next);
        }
      } catch {
        // leave embeds as-is
      }
    }

    return {
      ...m,
      attachment_urls: atts,
      embeds_json: embedsJson,
    };
  });

  return {
    messages: rewritten,
    downloaded,
    failed,
    assetsDir,
    warnings,
  };
}

/**
 * Resolve an asset file under a transcript token (path traversal safe).
 * @param {string} guildId
 * @param {string} token
 * @param {string} filename
 * @returns {string|null} absolute path if safe and exists
 */
function resolveAssetAbsolutePath(guildId, token, filename) {
  const safe = path.basename(String(filename || ""));
  if (!safe || safe === "." || safe === "..") return null;
  // Only allow our sanitized pattern
  if (!/^[a-zA-Z0-9._-]+$/.test(safe)) return null;

  const assetsDir = path.resolve(absoluteAssetsDir(guildId, token));
  const abs = path.resolve(path.join(assetsDir, safe));
  if (!abs.startsWith(assetsDir + path.sep) && abs !== assetsDir) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return abs;
}

/**
 * Basic content-type from extension.
 * @param {string} filename
 * @returns {string}
 */
function contentTypeForFilename(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json",
  };
  return map[ext] || "application/octet-stream";
}

module.exports = {
  MAX_ASSET_BYTES,
  MAX_ASSETS_PER_TICKET,
  sanitizeFilename,
  mediaKind,
  filenameFromUrl,
  collectMediaFromMessage,
  parseAttachmentList,
  downloadUrlToFile,
  mirrorTicketAssets,
  resolveAssetAbsolutePath,
  contentTypeForFilename,
};
