/**
 * SSRF-guarded RSS/Atom feed fetch unit (issue #305).
 *
 * ONE transport path for BOTH feed-URL moments — add-time validation
 * (`/rss add` via validateFeedUrl) and every ticker poll (via
 * guardedFetchForFeed) — so a URL that was safe when it was subscribed
 * can never be fetched blindly after its DNS record moves. The guard
 * rules (spec § Ticker):
 *
 *  - http(s) scheme only; userinfo tricks and IP-literal hosts refused;
 *  - EVERY hop's hostname is re-resolved and ALL returned addresses are
 *    class-checked by the SHARED guard (src/core/ssrfGuard.js): loopback,
 *    RFC1918, link-local incl. the 169.254.169.254 metadata IP, CGNAT,
 *    IANA/TEST-NET classes, ::1, fc00::/7, fe80::/10, IPv4-mapped IPv6 —
 *    NOTHING here re-implements (or re-lists) a range table;
 *  - DNS-rebind defense (#415/BRG-9 semantics): the addresses checkHost
 *    just cleared are PINNED into the request (defaultGuardedFetch →
 *    pinnedCoreFetch), so the checked resolution and the connected socket
 *    are ONE lookup — a record flipping public→private between validation
 *    and connect has no window to slip through;
 *  - redirects are followed MANUALLY, capped at the guard's MAX_REDIRECTS,
 *    and the FULL policy (scheme, userinfo, IP literal, address classes)
 *    RE-RUNS on every hop — the spec's "re-validated or capped+rejected",
 *    with both halves enforced.
 *
 * Deliberate divergences from ssrfGuard.downloadGuarded (which stays
 * untouched for its media consumers):
 *  - scheme: media downloads are https-only; RSS explicitly allows http(s),
 *    so this unit accepts both (plain http is still class-checked + pinned).
 *  - redirects: downloadGuarded pins the ORIGINAL host (media mirrors keep
 *    their CDN). Feed URLs legitimately move hosts (feed→CDN, http→https
 *    upgrades change the port), so cross-host redirects are ALLOWED here
 *    but every hop is re-parsed, re-resolved and re-class-checked — the
 *    per-hop validation, not host pinning, is the control.
 *  - IP-literal hosts: downloadGuarded permits public literals (pre-signed
 *    CDN URLs are machine-produced); a human-subscribed feed URL has no
 *    such case, so this unit rejects ALL IP-literal hosts (the stricter
 *    URL-consumer posture — the very reason isIpLiteralHost is exported
 *    "so URL-reading callers classify hostnames through THIS module").
 *
 * Transport policy lives here COMPLETELY (timeout, byte cap, headers,
 * redirects): rss-parser is only ever handed the text this unit already
 * fetched ("fetch-then-parseFromString"). Wiring rss-parser's own
 * requester instead would put a second transport inside the box that the
 * SSRF guard must own — a default-requester fetch would re-resolve DNS,
 * ignore the pins and stream unbounded bytes. rss-parser's custom
 * requester contract (Promise<{ headers, body }>) is satisfiable from the
 * result shape below if a consumer ever wants it, but the poller is
 * expected to call parseFromString(text) instead.
 *
 * RSS-specific knobs (spec): 10 s per-attempt timeout; ≤ 1 MiB response
 * cap enforced WHILE streaming (a lying Content-Length or chunked drip
 * never buffers whole); conditional GET (If-None-Match / If-Modified-Since
 * out, 304 = free poll with the validators echoed back); a STABLE
 * User-Agent with an optional RSS_USER_AGENT env override re-read per
 * call (operators can flip a hostile feed host's block without a restart).
 *
 * Never throws (AGENTS.md error law #6): every failure is
 * { ok:false, reason } with a specific, human-readable cause naming the
 * host/address/status; callers decide how to surface it.
 */

const {
  MAX_REDIRECTS,
  isIpLiteralHost,
  checkHost,
  defaultResolveHost,
  defaultGuardedFetch,
} = require("../../core/ssrfGuard");

/** Per-attempt fetch deadline (spec: 10 s). Armed through the BODY read
 * (the #414 lesson: clearing it when headers arrive lets a slow-drip host
 * outlive the promise). */
const RSS_FETCH_TIMEOUT_MS = 10_000;

/** Response cap (spec: 1 MiB). Enforced as a content-length pre-check AND
 * as a hard budget on the streamed read — over-cap bytes are never fully
 * buffered before the refusal. */
const MAX_FEED_BYTES = 1024 * 1024;

/** Stable, contact-addressable UA. Feeds are polled 24/7; a per-instance
 * random UA looks like an attack to a feed host and gets the community
 * blocked. RSS_USER_AGENT overrides it per deployment. */
const DEFAULT_FEED_USER_AGENT =
  "BoilerSnakeRSS/1.0 (+https://github.com/metalsp0rk/boiler-snake)";

/** What a polite RSS client says it wants (feeds happily serve it). */
const FEED_ACCEPT =
  "application/rss+xml, application/atom+xml, application/xml;q=0.9, " +
  "text/xml;q=0.8, */*;q=0.5";

/**
 * Effective User-Agent. Read PER CALL (repo knob idiom: gork/twitch re-read
 * their env knobs per job — an operator editing .env + restarting is the
 * heavy path, an override for one angry feed host should be light).
 * The env source is injectable for tests; the `env.RSS_USER_AGENT` read
 * site is what test/env-parity.test.js pins.
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
function feedUserAgent(env = process.env) {
  const raw = String(env.RSS_USER_AGENT ?? "").trim();
  return raw || DEFAULT_FEED_USER_AGENT;
}

/**
 * Printable-ASCII-only header value check. etag/last-modified ride to the
 * network in request headers but originate from a STORED response — a
 * CR/LF-carrying value from a hostile or broken feed host must never turn
 * into request/header injection on the next poll. Invalid values are
 * DROPPED (the poll degrades to an unconditional GET), never sent.
 * @param {unknown} value
 * @returns {boolean}
 */
function isSafeHeaderValue(value) {
  return typeof value === "string" && value.length > 0 && /^[ -~]+$/.test(value);
}

/**
 * Feed-URL policy that does NOT need DNS: scheme, parseability, userinfo
 * tricks, IP-literal posture. Shared by validateFeedUrl (add-time) and
 * guardedFetchForFeed (every poll AND every redirect hop) so the two can
 * never drift apart.
 * @param {string} rawUrl
 * @returns {{ parsed: URL } | { refusal: string }}
 */
function parseFeedUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    return { refusal: "invalid url (empty)" };
  }
  let parsed;
  try {
    parsed = new URL(String(rawUrl).trim());
  } catch {
    return { refusal: "invalid url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { refusal: `non-http(s) url (${parsed.protocol})` };
  }
  // https://feeds.example.com@evil.example/ is an evil.example request with
  // a decoy label — URL parsing already connects to evil.example, but a
  // subscription URL carrying credentials is never legitimate: refuse with
  // a reason the staff member can act on.
  if (parsed.username !== "" || parsed.password !== "") {
    return { refusal: "url contains userinfo (possible host spoof)" };
  }
  if (isIpLiteralHost(parsed.hostname)) {
    return {
      refusal: `ip-literal hostnames not allowed (${parsed.hostname.replace(/^\[|\]$/g, "")})`,
    };
  }
  return { parsed };
}

/**
 * ADD-TIME feed URL validation: scheme + shape + one full guard resolution
 * (every resolved address class-checked by the shared guard). This is the
 * `/rss add` gate; it is NOT a warrant for later polls —
 * guardedFetchForFeed re-runs the whole thing on every fetch anyway.
 *
 * @param {string} rawUrl
 * @param {{ resolveHost?: (host: string) => Promise<string[]> }} [opts]
 * @returns {Promise<{ ok: true, url: string, hostname: string }
 *   | { ok: false, reason: string }>}
 */
async function validateFeedUrl(rawUrl, opts = {}) {
  try {
    const shape = parseFeedUrl(rawUrl);
    if (shape.refusal) return { ok: false, reason: shape.refusal };
    const resolveHost =
      typeof opts.resolveHost === "function" ? opts.resolveHost : defaultResolveHost;
    const check = await checkHost(shape.parsed.hostname, resolveHost);
    if (check.refusal) return { ok: false, reason: check.refusal };
    return {
      ok: true,
      url: shape.parsed.toString(),
      hostname: shape.parsed.hostname,
    };
  } catch (err) {
    // Never throw (error law #6): a resolver seam that explodes is a
    // refusal with the cause, not an exception the command must catch.
    return { ok: false, reason: `feed url validation failed: ${String(err?.message || err)}` };
  }
}

/**
 * Stream the response WITHIN the byte cap (#414 shape from the guard):
 * reads stop the moment the STREAM crosses the cap and the transfer is
 * cancelled — over-cap bytes are never buffered whole. Transports without
 * a body stream (older fakes) fall back to the buffered read + post-read
 * size check with the same refusal shape.
 * @param {object} res fetch-shaped response
 * @param {number} maxBytes
 * @returns {Promise<{ bytes: Buffer } | { tooLarge: true, actualBytes: number }>}
 */
async function readFeedBody(res, maxBytes) {
  const stream = res && res.body;
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const chunks = [];
    let received = 0;
    try {
      while (received <= maxBytes) {
        const { done, value } = await reader.read();
        if (done) return { bytes: Buffer.concat(chunks) };
        if (value) {
          chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
          received += value.length ?? value.byteLength ?? 0;
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }
    return { tooLarge: true, actualBytes: received };
  }
  // No streaming body — test fakes / exotic transports only (production
  // undici ALWAYS exposes body.getReader, so the cap above is the real
  // one). This branch necessarily buffers before measuring: the caller's
  // declared-Content-Length refusal already ran, and the post-measure
  // refusal below pins the reported size; an absent lying header could
  // only buffer up to whatever the host actually sends. Commented rather
  // than pretends-guarded (review N3).
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) return { tooLarge: true, actualBytes: bytes.length };
  return { bytes };
}

/** Abort-shaped errors are THE TIMER (the only thing that aborts mid-read);
 * everything else carries the phase label (rule 3: the reason must let the
 * operator act — "timed out" and "fetch failed: <cause>" read differently). */
function classifyFeedFetchError(err, phaseLabel) {
  const text = String(err?.message || err);
  return /abort/i.test(text) ? "feed fetch timed out" : `${phaseLabel}: ${text}`;
}

/**
 * Fetch a feed through the shared SSRF guard with conditional GET.
 *
 * SECURITY CONTRACT (what makes this safe to call on EVERY poll):
 *  - parseFeedUrl policy runs on the URL and on EVERY redirect target;
 *  - checkHost RE-RESOLVES the hostname per hop and re-classifies every
 *    address — a host that resolved public at add time but points at
 *    127.0.0.1 / 169.254.169.254 / fc00::/7 NOW is refused NOW;
 *  - the validated addresses ride to the transport (defaultGuardedFetch
 *    PINS the socket to them — pinnedCoreFetch keeps SNI/Host on the
 *    original name), so nothing rebinds between check and connect;
 *  - redirects capped at MAX_REDIRECTS.
 *
 * @param {string} rawUrl
 * @param {{
 *   etag?: string|null,           // stored If-None-Match value (conditional GET)
 *   lastModified?: string|null,   // stored If-Modified-Since value
 *   fetchImpl?: (url: string, init?: object, addresses?: string[]) => Promise<any>,
 *   resolveHost?: (host: string) => Promise<string[]>,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   maxRedirects?: number,
 *   userAgent?: string,           // overrides the env/default UA (tests, one-offs)
 *   env?: Record<string,string|undefined>, // env source for the UA read (tests)
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 * }} [opts]
 * @returns {Promise<
 *   | { ok: false, reason: string }
 *   | { ok: true, status: number, notModified: true,  etag: string|null, lastModified: string|null }
 *   | { ok: true, status: number, notModified: false, text: string,
 *       contentType: string|null, etag: string|null, lastModified: string|null }
 * >}
 */
async function guardedFetchForFeed(rawUrl, opts = {}) {
  try {
    return await guardedFetchForFeedInner(rawUrl, opts);
  } catch (err) {
    // Defense in depth (the bridge downloadSignedUrl idiom): the contract
    // is never-throw — even a THROWING seam lands as a specific refusal.
    return { ok: false, reason: `feed fetch failed: ${String(err?.message || err)}` };
  }
}

async function guardedFetchForFeedInner(rawUrl, opts) {
  const fetchImpl =
    typeof opts.fetchImpl === "function" ? opts.fetchImpl : defaultGuardedFetch;
  const resolveHost =
    typeof opts.resolveHost === "function" ? opts.resolveHost : defaultResolveHost;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : RSS_FETCH_TIMEOUT_MS;
  const maxBytes =
    Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : MAX_FEED_BYTES;
  const maxRedirects =
    Number.isInteger(opts.maxRedirects) && opts.maxRedirects >= 0
      ? opts.maxRedirects
      : MAX_REDIRECTS;
  const userAgent =
    typeof opts.userAgent === "string" && opts.userAgent.trim() !== ""
      ? opts.userAgent.trim()
      : feedUserAgent(opts.env);
  // Timer seams mirror the guard's (tests fire the abort themselves; the
  // production timeout is unref'd on purpose and must never be awaited).
  const setTimer =
    typeof opts.setTimer === "function" ? opts.setTimer : (fn, ms) => setTimeout(fn, ms);
  const clearTimer =
    typeof opts.clearTimer === "function" ? opts.clearTimer : (h) => clearTimeout(h);

  // Conditional-GET request headers. Stored validators come from a past
  // response on SOME host; isSafeHeaderValue keeps a poisoned DB value
  // (CRLF) from becoming header injection on the wire. Invalid = skipped,
  // so the poll degrades to an unconditional GET instead of failing.
  const conditional = {};
  if (isSafeHeaderValue(opts.etag)) conditional["If-None-Match"] = opts.etag;
  if (isSafeHeaderValue(opts.lastModified)) {
    conditional["If-Modified-Since"] = opts.lastModified;
  }

  let current = String(rawUrl ?? "");
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const shape = parseFeedUrl(current);
    if (shape.refusal) return { ok: false, reason: shape.refusal };

    // PER-HOP guard resolution + class check (the add-time answer is
    // worthless here — this is the DNS-rebind line of defense).
    const check = await checkHost(shape.parsed.hostname, resolveHost);
    if (check.refusal) return { ok: false, reason: check.refusal };

    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    try {
      let res;
      try {
        res = await fetchImpl(
          current,
          {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              "User-Agent": userAgent,
              Accept: FEED_ACCEPT,
              ...conditional,
            },
          },
          check.addresses, // pin list rides to the transport (#415 semantics)
        );
      } catch (err) {
        return { ok: false, reason: classifyFeedFetchError(err, "fetch failed") };
      }

      const status = Number(res?.status);
      if (!Number.isFinite(status)) return { ok: false, reason: "no HTTP status" };

      // 304 = free poll (spec): advance last_checked only. Response
      // validators win; when a 304 omits them, the RFC says the stored
      // values stay current — echo what we SENT so the poller just stores
      // whatever comes back (poller never re-derives).
      if (status === 304) {
        return {
          ok: true,
          status,
          notModified: true,
          etag: pickValidator(res, "etag", opts.etag),
          lastModified: pickValidator(res, "last-modified", opts.lastModified),
        };
      }

      if (status >= 300 && status < 400) {
        const location =
          typeof res.headers?.get === "function" ? res.headers.get("location") : null;
        if (!location) return { ok: false, reason: `redirect with no location (HTTP ${status})` };
        if (hop === maxRedirects) return { ok: false, reason: "too many redirects" };
        let next;
        try {
          next = new URL(location, current);
        } catch {
          return { ok: false, reason: "redirect to an unparseable url" };
        }
        // Cross-host allowed BY DESIGN (see module header) — but the FULL
        // policy + guard resolution re-runs on the next hop, so "redirect
        // chain lands on a private/reserved address" is refused there,
        // BEFORE that hop is ever connected to.
        // Review fix N4: conditional-GET validators belong to the host that
        // ISSUED them (RFC 9110 §8.4.1 origin scope) — a cross-host hop
        // loses the stored If-None-Match/If-Modified-Since instead of
        // leaking host A's validators to host B.
        if (next.hostname.toLowerCase() !== new URL(current).hostname.toLowerCase()) {
          delete conditional["If-None-Match"];
          delete conditional["If-Modified-Since"];
        }
        current = next.toString();
        continue;
      }

      if (status < 200 || status >= 300) {
        return { ok: false, reason: `HTTP ${status}` };
      }

      const contentType =
        typeof res.headers?.get === "function" ? res.headers.get("content-type") : null;

      // Lying declared size: refuse BEFORE touching the body (guard shape).
      const lenHeader =
        typeof res.headers?.get === "function" ? res.headers.get("content-length") : null;
      const declared = Number(lenHeader);
      if (Number.isFinite(declared) && declared > maxBytes) {
        return { ok: false, reason: `feed response too large (${declared} bytes)` };
      }

      let body;
      try {
        body = await readFeedBody(res, maxBytes);
      } catch (err) {
        return { ok: false, reason: classifyFeedFetchError(err, "body read failed") };
      }
      if (body.tooLarge) {
        return { ok: false, reason: `feed response too large (${body.actualBytes} bytes)` };
      }

      return {
        ok: true,
        status,
        notModified: false,
        text: body.bytes.toString("utf8"),
        contentType,
        etag: pickValidator(res, "etag", opts.etag),
        lastModified: pickValidator(res, "last-modified", opts.lastModified),
      };
    } finally {
      // Armed through the body read (#414); cleared on EVERY exit.
      clearTimer(timer);
    }
  }
  return { ok: false, reason: "too many redirects" };
}

/**
 * Response validator header with the SENT value as fallback (304s and many
 * 204-style hosts omit validators that stay in force — RFC 7232 §4.1/§3.3).
 * Values destined for storage or wire re-sending pass the same CRLF gate.
 */
function pickValidator(res, name, fallback) {
  const fromRes =
    typeof res?.headers?.get === "function" ? res.headers.get(name) : null;
  if (isSafeHeaderValue(fromRes)) return fromRes;
  return isSafeHeaderValue(fallback) ? fallback : null;
}

module.exports = {
  DEFAULT_FEED_USER_AGENT,
  RSS_FETCH_TIMEOUT_MS,
  MAX_FEED_BYTES,
  MAX_FEED_REDIRECTS: MAX_REDIRECTS,
  feedUserAgent,
  validateFeedUrl,
  guardedFetchForFeed,
};
