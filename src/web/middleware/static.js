/**
 * /static/* file serving for the shell assets (src/web/public/: vendored
 * htmx, styles.css, app.js — roadmap/web-admin.md §8.2/§8.7).
 *
 * Hand-rolled instead of express.static on purpose:
 *  - the whole app answers through raw `res.writeHead()/res.end()` only
 *    (Phase 0a byte-parity doctrine) — no send()/ETag/Last-Modified/
 *    redirect machinery touching responses;
 *  - the cache policy is deliberately aggressive (immutable) and uniform:
 *    these files are content-pinned by path (htmx is version-stamped;
 *    styles/app upgrades ride a redeploy), never per-user;
 *  - the gate is a few lines we can pin in tests: dotfile segments
 *    (anything starting with ".", incl. "." / "..") are ignored → 404, the
 *    resolved path must stay inside the public root, only regular files
 *    are served.
 *
 * Unknown/invalid paths answer the SAME generic plain 404 as the app
 * catch-all — static probes learn nothing.
 */

const fs = require("fs");
const path = require("path");

/** Public asset root: src/web/public. */
const PUBLIC_ROOT = path.join(__dirname, "..", "public");

/** Extension → Content-Type. Text kinds get an explicit charset. */
const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
});

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** Long-life + immutable: filenames are the cache-buster (§8.7 static rule). */
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/**
 * Is every path segment safe AND non-hidden? Rejects "" segments, "." /
 * "..", and ANY segment starting with "." (dotfiles ignore, express-style),
 * plus NUL bytes. Absolute paths can't occur: the leading slash of the
 * request remainder is stripped before splitting, and path.resolve() below
 * keeps everything under root even for weird inputs (belt AND suspenders).
 * @param {string} rel
 * @returns {boolean}
 */
function isSafeRelative(rel) {
  if (!rel || rel.includes("\0")) return false;
  const segments = rel.split("/");
  return segments.every(
    (seg) => seg.length > 0 && !seg.startsWith(".")
  );
}

/**
 * Resolve a request-relative path to an in-root regular file, or null.
 * @param {string} root
 * @param {string} rel
 * @returns {{ abs: string, stat: fs.Stats }|null}
 */
function resolvePublicFile(root, rel) {
  if (!isSafeRelative(rel)) return null;
  const rootResolved = path.resolve(root);
  const abs = path.resolve(rootResolved, rel);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    return null; // never escape the public root
  }
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null; // missing / unreadable: nothing to say about which
  }
  if (!stat.isFile()) return null; // directories/symlink targets: not served
  return { abs, stat };
}

/**
 * GET/HEAD handler for /static/* (mount: app.use("/static", ...)). The
 * methodGate in app.js already rejected other methods before routing.
 *
 * @param {object} [options]
 * @param {string} [options.root] asset root override (tests)
 * @param {(req: any, res: import("http").ServerResponse) => void} [options.notFound]
 * @returns {(req: any, res: import("http").ServerResponse) => void}
 */
function createStaticMiddleware({ root = PUBLIC_ROOT, notFound } = {}) {
  const send404 =
    notFound ||
    ((req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    });

  return function staticMiddleware(req, res) {
    // req.url under an app.use mount is the stripped remainder ("/app.js").
    const rawPath = String(req.url || "").split("?")[0];
    let rel;
    try {
      rel = decodeURIComponent(rawPath.replace(/^\/+/, ""));
    } catch {
      return send404(req, res); // malformed % sequence: same generic 404
    }

    const found = resolvePublicFile(root, rel);
    if (!found) return send404(req, res);

    const type =
      CONTENT_TYPES[path.extname(found.abs).toLowerCase()] ||
      DEFAULT_CONTENT_TYPE;
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": IMMUTABLE_CACHE,
      "X-Content-Type-Options": "nosniff",
      "Content-Length": found.stat.size,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(fs.readFileSync(found.abs));
  };
}

module.exports = {
  createStaticMiddleware,
  resolvePublicFile,
  isSafeRelative,
  PUBLIC_ROOT,
  IMMUTABLE_CACHE,
  CONTENT_TYPES,
};
