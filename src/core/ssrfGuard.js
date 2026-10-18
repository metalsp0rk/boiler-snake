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
 *    link-local (169.254.0.0/16 — cloud metadata), CGNAT (100.64/10),
 *    IANA special-purpose/TEST-NET/benchmarking, multicast and reserved
 *    (224/4 + 240/4) — plus the IPv6 equivalents (::/0 unspecified, ::1
 *    loopback, fc00::/7 ULA, fe80::/10 link-local, the unassigned c000::/2
 *    block incl. ff00::/8 multicast) and ALL IPv4-mapped IPv6 forms
 *    (dotted AND hex, e.g. ::ffff:7f00:1 == 127.0.0.1). The widened list is
 *    the #273 union with gork's locked read-page policy — shared so every
 *    download surface gets the strictest posture ("share it, don't fork");
 *  - redirects are followed MANUALLY, capped, same-host only, and the full
 *    address check RE-RUNS on every hop;
 *  - THE SOCKET IS THE CHECK (#415/BRG-9): the addresses cleared by
 *    checkHost are PINNED into the request itself (pinnedCoreFetch connects
 *    to the validated IP; SNI/Host stay the original name), so the checked
 *    resolution and the fetched connection are ONE lookup, not two —
 *    DNS-rebinding windows (0-TTL records flipping public→private between
 *    validation and connect) are closed per hop;
 *  - a per-attempt timeout aborts the request via AbortController.
 *
 * Seams (fetchImpl / resolveHost / setTimer / clearTimer) make the guard
 * testable with no sockets and no real timers — the production timeout is
 * unref'd on purpose, so tests MUST drive the abort via the timer seams
 * (Node 22's test runner fails a test whose only pending work is an unref'd
 * timer; Node 24+ keeps the loop ref'd — the injected timer sidesteps both).
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
 * Whether a (bracket-stripped) hostname is an IPv4 or IPv6 literal. Exported
 * so URL-reading callers classify hostnames through THIS module instead of
 * consulting `net` themselves (#273 — one place owns the address grammar).
 * @param {string} host
 * @returns {boolean}
 */
function isIpLiteralHost(host) {
  const s = String(host ?? "").replace(/^\[|\]$/g, "");
  return net.isIPv4(s) || net.isIPv6(s);
}

/**
 * Refused IPv4 prefix ranges. This is the UNION of the bridge/ticket spec
 * (loopback, this-host, RFC1918, link-local) and gork's locked read-page
 * policy (#273): CGNAT, IANA special-purpose, TEST-NETs, benchmarking,
 * multicast and reserved — nothing routable to a real public host lives
 * here, so sharing the stricter list cannot legitimately deny a CDN or
 * instance origin, while every one of these classes is a plausible
 * SSRF-reachable target (metadata services, carrier-NAT pivots).
 */
const BLOCKED_V4_PREFIXES = [
  ["0.0.0.0", 8], // "this host on this network"
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT (RFC 6598)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata)
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IANA special-purpose
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved (+ broadcast)
].map(([baseText, bits]) => {
  const bp = String(baseText).split(".").map(Number);
  return {
    base: (((bp[0] << 24) | (bp[1] << 16) | (bp[2] << 8) | bp[3]) >>> 0),
    mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0,
  };
});

/**
 * Classify one address: true when the download target must be refused.
 * Refused classes (spec + the #273 union): every BLOCKED_V4_PREFIXES range;
 * IPv6 unspecified/loopback/ULA/link-local plus the unassigned c000::/2
 * block (covers ff00::/8 multicast); IPv4-mapped IPv6 forms — dotted AND
 * hex (e.g. ::ffff:7f00:1 == 127.0.0.1: a literal the pre-#273 guard let
 * through).
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
    const long = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
    return BLOCKED_V4_PREFIXES.some(({ base, mask }) => (long & mask) === (base & mask));
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true; // unspecified + loopback
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(lower);
    if (hexMapped) {
      // IPv4-mapped IPv6 in hex hextet form (::ffff:7f00:1) — unwrap to the
      // dotted quad and re-classify, so no mapped notation reaches a decision.
      const hi = parseInt(hexMapped[1], 16);
      const lo = parseInt(hexMapped[2], 16);
      return isDisallowedAddress(
        `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`,
      );
    }
    if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true; // ULA fc00::/7
    if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true; // link-local fe80::/10
    const first = /^([0-9a-f]{1,4}):/.exec(lower);
    if (first && (parseInt(first[1], 16) & 0xc000) === 0xc000) return true; // c000::/2 (unassigned; incl. ff00::/8 multicast)
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
 *
 * BRG-9 (#415): returns the VALIDATED ADDRESSES alongside the verdict so the
 * transport can PIN the socket to exactly what was just checked. Returning
 * only a yes/no (the old shape) left the check and the connection as two
 * separate DNS lookups — a 0-TTL record flipping public→private between them
 * (classic rebinding) sailed through the gap.
 *
 * @param {string} hostname
 * @param {(host: string) => Promise<string[]>} resolveHost
 * @returns {Promise<{ refusal: string|null, addresses: string[] }>}
 *   `addresses` is the validated list for DNS names, [] for IP literals
 *   (a literal involves no lookup at all — nothing to rebind on).
 */
async function checkHost(hostname, resolveHost) {
  const strip = String(hostname ?? "").replace(/^\[|\]$/g, "");
  if (strip === "") return { refusal: "empty hostname", addresses: [] };
  if (isIPv4Literal(strip) || net.isIPv6(strip)) {
    return {
      refusal: isDisallowedAddress(strip) ? `refused address range for ${strip}` : null,
      addresses: [],
    };
  }
  if (!HOSTNAME_RE.test(strip)) {
    return { refusal: `unparseable hostname: ${strip}`, addresses: [] };
  }
  let addresses;
  try {
    addresses = await resolveHost(strip);
  } catch (err) {
    return {
      refusal: `dns lookup failed for ${strip}: ${String(err?.message || err)}`,
      addresses: [],
    };
  }
  const list = Array.isArray(addresses) ? addresses.filter(Boolean) : [];
  if (list.length === 0) return { refusal: `no address resolved for ${strip}`, addresses: [] };
  for (const addr of list) {
    if (isDisallowedAddress(addr)) {
      return { refusal: `refused address range for ${addr}`, addresses: [] };
    }
  }
  return { refusal: null, addresses: list };
}

/**
 * Back-compat wrapper (bridge media pre-check, gork read-page classification):
 * the refusal string only. New callers that also fetch should use
 * {@link checkHost} and pin the returned addresses.
 * @returns {Promise<string|null>}
 */
async function hostRefusalReason(hostname, resolveHost) {
  return (await checkHost(hostname, resolveHost)).refusal;
}

/**
 * THE PINNED TRANSPORT (BRG-9 #415): fetches a validated URL by connecting
 * DIRECTLY to one of the addresses checkHost just cleared. No `lookup`, no
 * resolver, no system DNS on this request at all — the socket target IS the
 * checked value, so there is no second resolution to rebind into.
 *
 * TLS identity is NOT weakened: `servername` stays the ORIGINAL hostname, so
 * SNI and certificate verification are against the name the URL carried
 * (verified against a live node:https pair: SNI + Host header carry the name,
 * the socket lands on the pinned IP).
 *
 * Node's global fetch cannot do this: the dispatcher/Agent route requires the
 * SAME undici copy as the fetch implementation, and a userland undici Agent
 * handed to the built-in fetch fails cross-copy ("invalid onError method",
 * verified on Node 26; the 6.x/7.x split makes any pinned npm-undici version
 * wrong for one of the supported Node lines). The core http/https modules
 * can, dependency-free.
 *
 * @param {string} url
 * @param {{ headers?: object, signal?: AbortSignal }} [init]
 * @param {string[]} addresses validated addresses from checkHost (non-empty)
 * @param {{ httpImpl?: object, httpsImpl?: object }} [seams] module stubs
 *   (tests prove the request options offline; production uses node core)
 * @returns {Promise<object>} a fetch-shaped Response-lite
 */
function pinnedCoreFetch(url, init = {}, addresses = [], seams = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      reject(new Error("pinned fetch: invalid url"));
      return;
    }
    const secure = parsed.protocol === "https:";
    if (!secure && parsed.protocol !== "http:") {
      reject(new Error(`pinned fetch: unsupported protocol (${parsed.protocol})`));
      return;
    }
    const list = (Array.isArray(addresses) ? addresses : []).filter(
      (a) => net.isIPv4(a) || net.isIPv6(a),
    );
    if (list.length === 0) {
      reject(new Error("pinned fetch: no validated address to pin to"));
      return;
    }
    // Deterministic pick: prefer IPv4 (bidi-routing reality), else the first
    // validated v6. Never anything but a CHECKED address.
    const target = list.find((a) => net.isIPv4(a)) ?? list[0];
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    const hostHeader = hostname.includes(":") ? `[${hostname}]` : hostname;

    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) {
      if (/^host$/i.test(k)) continue; // the Host header is ours to own
      headers[k] = v;
    }
    headers.host = parsed.port ? `${hostHeader}:${parsed.port}` : hostHeader;

    const httpMod = seams.httpImpl || require("node:http");
    const httpsMod = seams.httpsImpl || require("node:https");
    const transport = secure ? httpsMod : httpMod;
    const options = {
      host: target, // ← THE PIN: a literal validated IP, never a name
      port: Number(parsed.port) || (secure ? 443 : 80),
      path: parsed.pathname + parsed.search || "/",
      method: "GET",
      headers,
      // SNI + cert verification stay on the ORIGINAL name (https only).
      ...(secure ? { servername: hostname } : {}),
    };

    const signal = init && init.signal;
    if (signal && signal.aborted) {
      // Aborted BEFORE any socket work — never build the request at all.
      reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      return;
    }
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      fn(arg);
    };
    const req = transport.request(options, (coreRes) => {
      finish(resolve, makeCoreResponse(coreRes, req));
    });
    function onAbort() {
      req.destroy(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
    }
    req.on("error", (err) => finish(reject, err));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}

/**
 * fetch-shaped adapter over a node-core ClientResponse. Only the surface the
 * guard and read-page actually consume: ok/status, headers.get, arrayBuffer,
 * text, and a cancellable body reader (read-page's byte budget depends on
 * cancel() actually stopping the transfer — it destroys the request).
 */
function makeCoreResponse(coreRes, req) {
  const status = Number(coreRes.statusCode);
  const raw = coreRes.headers || {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const v = raw[String(name).toLowerCase()];
        if (v === undefined) return null;
        return Array.isArray(v) ? v.join(", ") : String(v);
      },
    },
    body: {
      getReader() {
        const it = coreRes[Symbol.asyncIterator]();
        return {
          async read() {
            const r = await it.next();
            return r.done ? { done: true, value: undefined } : { done: false, value: r.value };
          },
          async cancel() {
            try {
              await it.return?.();
            } catch {
              /* already closed */
            }
            try {
              req.destroy();
            } catch {
              /* already destroyed */
            }
          },
        };
      },
    },
    async arrayBuffer() {
      const chunks = [];
      for await (const chunk of coreRes) chunks.push(chunk);
      return Buffer.concat(chunks);
    },
    async text() {
      return (await this.arrayBuffer()).toString("utf8");
    },
  };
}

/**
 * The guard's DEFAULT transport. Name-based hops (attacker-chosen hosts —
 * the ONLY ones with a second DNS lookup to rebind) go through the pinned
 * core fetch; IP-literal hops (addresses.length === 0: no DNS anywhere in
 * the request, so no TOCTOU can exist) keep globalThis.fetch.
 *
 * @param {string} url
 * @param {object} [init]
 * @param {string[]} [addresses] what checkHost validated for THIS hop
 * @param {{ httpImpl?: object, httpsImpl?: object }} [seams] core-module
 *   stubs (tests); production omits them
 */
async function defaultGuardedFetch(url, init, addresses, seams = {}) {
  if (Array.isArray(addresses) && addresses.length > 0) {
    return pinnedCoreFetch(url, init, addresses, seams);
  }
  return globalThis.fetch(url, init);
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
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 * }} [opts]
 * @returns {Promise<{ ok: true, bytes: Buffer, contentType: string|null }
 *   | { ok: false, reason: string }>}
 */
async function downloadGuarded(url, opts = {}) {
  const fetchImpl =
    typeof opts.fetchImpl === "function" ? opts.fetchImpl : defaultGuardedFetch;
  const resolveHost = typeof opts.resolveHost === "function" ? opts.resolveHost : defaultResolveHost;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DOWNLOAD_TIMEOUT_MS;
  const maxRedirects = Number.isInteger(opts.maxRedirects) && opts.maxRedirects >= 0
    ? opts.maxRedirects
    : MAX_REDIRECTS;
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : null;
  // Timer seams (tests inject a fake and fire the abort callback themselves —
  // the production timeout is unref'd on purpose, so a test awaiting it would
  // depend on the runner's event-loop-ref semantics, which differ between
  // Node 22 and 24+). Defaults are the real global timers.
  const setTimer =
    typeof opts.setTimer === "function"
      ? opts.setTimer
      : (fn, ms) => setTimeout(fn, ms);
  const clearTimer =
    typeof opts.clearTimer === "function"
      ? opts.clearTimer
      : (handle) => clearTimeout(handle);

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
    const check = await checkHost(parsed.hostname, resolveHost);
    if (check.refusal) return { ok: false, reason: check.refusal };

    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    let res;
    try {
      // No Authorization header, no bot credential: this is a plain fetch of
      // a pre-signed URL (spec §10.8). The credential never comes here.
      const init = { redirect: "manual", signal: controller.signal };
      if (opts.headers && Object.keys(opts.headers).length > 0) {
        init.headers = { ...opts.headers };
      }
      // #415: the validated addresses ride to the transport — the default
      // (defaultGuardedFetch) PINS the socket to them; injected fakes get
      // them as an extra argument and stay free to ignore it.
      res = await fetchImpl(current, init, check.addresses);
    } catch (err) {
      clearTimer(timer);
      const text = String(err?.message || err);
      const reason = /abort/i.test(text) ? "download timed out" : `fetch failed: ${text}`;
      return { ok: false, reason };
    }
    clearTimer(timer);

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
  isIpLiteralHost,
  isDisallowedAddress,
  defaultResolveHost,
  checkHost,
  hostRefusalReason,
  pinnedCoreFetch,
  defaultGuardedFetch,
  downloadGuarded,
};
