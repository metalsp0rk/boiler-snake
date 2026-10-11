/**
 * Shared SSRF guard for every download of a URL the bot did not choose itself
 * (audit-2026-10 C5 / §6 P0.7).
 *
 * Extracted VERBATIM from src/features/bridge/media.js (roadmap/bridge.md
 * §10.8 "Security of downloads") so bridge spooling, gork vision downloads,
 * and ticket-archive asset mirroring all share ONE guard instead of forking
 * copies:
 *
 *  - https-only (no file:, no data:, no http:);
 *  - every hop's hostname is RESOLVED (dns.lookup, injectable) and every
 *    returned address is class-checked: loopback, "this host" (0/8), RFC1918,
 *    link-local (169.254.0.0/16 — cloud metadata), and the IPv6 equivalents
 *    (::/0 unspecified, ::1 loopback, fc00::/7 ULA, fe80::/10 link-local),
 *    including IPv4-mapped IPv6 forms;
 *  - redirects are followed MANUALLY, capped, same-host only, and the full
 *    address check RE-RUNS on every hop (a DNS record that flips to a private
 *    address mid-chain is caught on the hop where it is used);
 *  - a per-attempt timeout aborts the request via AbortController.
 *
 * Seams (fetchImpl / resolveHost) make the guard testable with no sockets.
 * This module never throws: callers get { ok: false, reason } with a specific,
 * human-readable refusal naming the host/address, per the AGENTS.md
 * error-reporting rules.
 *
 * Optional `headers` (e.g. a CDN User-Agent) and `maxBytes` (content-length
 * pre-check + post-read size cap) exist for the ticket-asset mirror; callers
 * that omit them (bridge relay, gork vision) get byte-identical behavior to
 * the original media.js implementation.
 */

const net = require("net");
const dns = require("node:dns");

/** Download timeout per attempt (ms) and the same-host redirect budget. */
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;

/** Hostnames the guard will resolve (plain DNS names, nothing exotic). */
const HOSTNAME_RE = /^[a-z0-9._-]+$/i;

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
  if (!HOSTNAME_RE.test(strip)) {
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
 * GET a media URL with NO bot credential.
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
 *   headers?: Record<string, string>,
 *   maxBytes?: number,
 * }} [opts]
 * @returns {Promise<{ ok: true, bytes: Buffer, contentType: string|null }
 *   | { ok: false, reason: string }>}
 */
async function downloadGuarded(url, opts = {}) {
  const fetchImpl =
    typeof opts.fetchImpl === "function"
      ? opts.fetchImpl
      : (u, init) => globalThis.fetch(u, init);
  const resolveHost = typeof opts.resolveHost === "function" ? opts.resolveHost : defaultResolveHost;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DOWNLOAD_TIMEOUT_MS;
  const maxRedirects = Number.isInteger(opts.maxRedirects) && opts.maxRedirects >= 0
    ? opts.maxRedirects
    : MAX_REDIRECTS;
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : null;

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
      const init = { redirect: "manual", signal: controller.signal };
      if (opts.headers && Object.keys(opts.headers).length > 0) {
        init.headers = { ...opts.headers };
      }
      res = await fetchImpl(current, init);
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
    const contentType =
      typeof res.headers?.get === "function" ? res.headers.get("content-type") : null;
    if (maxBytes != null) {
      const lenHeader =
        typeof res.headers?.get === "function" ? res.headers.get("content-length") : null;
      const declared = Number(lenHeader);
      if (Number.isFinite(declared) && declared > maxBytes) {
        return { ok: false, reason: `file too large (${declared} bytes)` };
      }
    }
    try {
      const ab = await res.arrayBuffer();
      const bytes = Buffer.from(ab);
      if (maxBytes != null && bytes.length > maxBytes) {
        return { ok: false, reason: `file too large (${bytes.length} bytes)` };
      }
      return { ok: true, bytes, contentType };
    } catch (err) {
      return { ok: false, reason: `body read failed: ${String(err?.message || err)}` };
    }
  }
  return { ok: false, reason: "too many redirects" };
}

module.exports = {
  DOWNLOAD_TIMEOUT_MS,
  MAX_REDIRECTS,
  isIPv4Literal,
  isDisallowedAddress,
  defaultResolveHost,
  hostRefusalReason,
  downloadGuarded,
};
