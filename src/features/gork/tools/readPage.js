/**
 * Gork `read_page` tool: SSRF-guarded URL reader → clean Markdown.
 *
 * Extends the locked web-search spec (roadmap/gork.md §7.5; session
 * 2026-09-07-gork-read-page): gork exposes a second OpenAI-compatible
 * function tool `read_page({ urls: string[] })`. Up to 3 URLs are fetched
 * concurrently; each page's main content is extracted with
 * @mozilla/readability (jsdom), with a body-fallback for non-article
 * pages, and converted to Markdown with turndown. Results come back in
 * input order as one combined text block for the model.
 *
 * Security (all guards live here, every one is DI-testable):
 * - http/https only, hostname required — everything else fails closed.
 * - SSRF: the hostname is resolved with `dns.promises.lookup(host,
 *   { all: true, verbatim: true })` (injectable `resolver`) and EVERY
 *   resolved address must pass `isPublicAddress()` (loopback, RFC1918,
 *   CGNAT, link-local, reserved/broadcast ranges, IPv6 ::/::1/fc00::/7/
 *   fe80::/10/ff00::/2, IPv4-mapped IPv6). `localhost` and the
 *   `.local`/`.internal`/`.localhost` suffixes are blocked pre-DNS.
 *   Known limitation: DNS-rebinding between validation and fetch is not
 *   mitigated beyond the redirect re-validation below.
 * - Fetch uses `redirect: "manual"` with at most 2 redirects, and each
 *   hop's URL is fully re-validated (protocol + host + DNS) before it is
 *   fetched.
 * - content-type must start with `text/html` or `text/plain`; bodies are
 *   capped at MAX_BYTES (declared length checked up front, slice after
 *   read).
 *
 * Like webSearch.js, this module NEVER throws: every per-page failure
 * resolves to an inline `Could not read: <reason>` block (reasons:
 * "blocked address", "redirect limit", "timeout", "http <status>",
 * "unreadable content-type", "fetch failed", "empty content") so the AI
 * tool loop always continues. jsdom/readability/turndown are required
 * lazily inside the extraction path so bot startup stays light.
 *
 * Dependencies are injectable for tests: `options.resolver` (default
 * `dns.promises.lookup`), `options.fetchImpl` (default global fetch),
 * `options.timeoutMs` (default DEFAULT_TIMEOUT_MS, per page).
 */

const { promises: dnsPromises } = require("node:dns");

/** Abort one page (whole redirect chain) after this many ms (spec: 10s). */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Model-facing URL cap per call; overflow is reported inline as skipped. */
const MAX_URLS = 3;
/** Per-page Markdown cap; overflow is cut and marked with the marker. */
const MAX_PAGE_CHARS = 4000;
/** Combined output cap; whole pages beyond the budget are dropped. */
const MAX_TOTAL_CHARS = 10_000;
/** Max response body bytes (declared + post-read slice cap). */
const MAX_BYTES = 1_000_000;
/** Max redirect hops under `redirect: "manual"` (≤2 → ≤3 fetches). */
const MAX_REDIRECTS = 2;
/** Readability article threshold + the minimum text length we accept. */
const READ_CHAR_THRESHOLD = 200;
const MIN_ARTICLE_CHARS = 200;
/** Appended when a page is cut at MAX_PAGE_CHARS (locked marker). */
const TRUNCATION_MARKER = "\n…[truncated]";
/** Elements stripped before the body-fallback serialization. */
const FALLBACK_STRIP_SELECTOR =
  "script,style,noscript,svg,nav,header,footer,aside,form,iframe";
/** Tags turndown drops outright (locked list). */
const REMOVED_TAGS = ["script", "style", "noscript", "svg"];
/** Hostnames/sub-names blocked without any DNS round trip. */
const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".localhost"];
/** Statuses treated as redirects (revalidated before the next fetch). */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/* Locked failure reasons (inline per-page, never thrown). */
const REASON_BLOCKED = "blocked address";
const REASON_REDIRECT_LIMIT = "redirect limit";
const REASON_TIMEOUT = "timeout";
const REASON_CONTENT_TYPE = "unreadable content-type";
const REASON_FETCH_FAILED = "fetch failed";
const REASON_EMPTY = "empty content";

/**
 * OpenAI-compatible function tool definition for `read_page`.
 * Pass as `tools: [WEB_SEARCH_TOOL, READ_PAGE_TOOL]` to chatWithTools.
 * @type {{ type: "function", function: { name: string, description: string, parameters: object } }}
 */
const READ_PAGE_TOOL = Object.freeze({
  type: "function",
  function: Object.freeze({
    name: "read_page",
    description:
      "Read the full page content (clean Markdown) of up to 3 URLs. Use " +
      "when a search snippet or the conversation context clearly points " +
      "to a page but does not contain the full answer. Prefer fewer URLs.",
    parameters: Object.freeze({
      type: "object",
      properties: Object.freeze({
        urls: Object.freeze({
          type: "array",
          items: Object.freeze({ type: "string" }),
          description:
            "URLs to read (http/https). At most 3 are fetched; any extra URLs are skipped.",
        }),
      }),
      required: Object.freeze(["urls"]),
    }),
  }),
});

/* ------------------------- SSRF address checks ------------------------- */

/**
 * Parse a dotted-quad IPv4 string into an unsigned 32-bit long.
 * Anything else (octets > 255, hex, partial addresses) → null.
 * @param {string} text
 * @returns {number|null}
 */
function parseIPv4Long(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(
    String(text).trim(),
  );
  if (!m) return null;
  let long = 0;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(m[i]);
    if (octet > 255 || (m[i].length > 1 && m[i].startsWith("0"))) return null;
    long = long * 256 + octet;
  }
  return long >>> 0;
}

/**
 * Expand an IPv6 string (compression + embedded IPv4 + zone tolerated)
 * into exactly 8 numeric hextets, or null when malformed.
 * @param {string} text
 * @returns {number[]|null}
 */
function parseIPv6Groups(text) {
  const raw = String(text).trim().toLowerCase().split("%")[0];
  if (!raw || !raw.includes(":")) return null;
  const sides = raw.split("::");
  if (sides.length > 2) return null;

  const parseSide = (side) => {
    if (!side) return [];
    const out = [];
    for (const item of side.split(":")) {
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(item)) {
        const v4 = parseIPv4Long(item);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
      out.push(parseInt(item, 16));
    }
    return out;
  };

  const head = parseSide(sides[0]);
  const tail = parseSide(sides[1] || "");
  if (head === null || tail === null) return null;
  if (sides.length === 2) {
    const gap = 8 - head.length - tail.length;
    if (gap < 1) return null; // `::` must stand for at least one zero group
    return [...head, ...Array(gap).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

/**
 * IPv4 ranges blocked by policy, locked list: 0/8, 10/8, 100.64/10
 * (CGNAT), 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24,
 * 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24,
 * 224/4 (multicast), 240/4 (reserved).
 * @type {{ long: number, mask: number }[]}
 */
const BLOCKED_V4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
].map(([base, bits]) => ({
  long: parseIPv4Long(base),
  mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0,
}));

/** @param {number} long @returns {boolean} */
function isPublicIPv4Long(long) {
  return !BLOCKED_V4_CIDRS.some(
    ({ long: base, mask }) => (long & mask) >>> 0 === (base & mask) >>> 0,
  );
}

/**
 * Whether an IP literal is publicly routable under the locked policy.
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d` / `::ffff:h:h`) is unwrapped and
 * re-checked as IPv4. Anything malformed fails closed (false).
 * @param {unknown} ip
 * @returns {boolean}
 */
function isPublicAddress(ip) {
  const text = typeof ip === "string" ? ip.trim() : "";
  if (!text) return false;

  const v4 = parseIPv4Long(text);
  if (v4 !== null) return isPublicIPv4Long(v4);

  const groups = parseIPv6Groups(text);
  if (!groups) return false;

  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:h:h) → unwrap and re-check.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return isPublicIPv4Long(((groups[6] << 16) | groups[7]) >>> 0);
  }

  const allZero = groups.every((g) => g === 0); // ::
  const loopback =
    groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1; // ::1
  if (allZero || loopback) return false;
  if ((groups[0] & 0xfe00) === 0xfc00) return false; // fc00::/7
  if ((groups[0] & 0xffc0) === 0xfe80) return false; // fe80::/10
  if ((groups[0] & 0xc000) === 0xc000) return false; // ff00::/2
  return true;
}

/**
 * Whether a hostname must be blocked without any DNS lookup: the literal
 * `localhost` and the `.local` / `.internal` / `.localhost` suffixes.
 * An empty/absent hostname fails closed too.
 * @param {unknown} hostname
 * @returns {boolean}
 */
function isBlockedHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost") return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** URL hostnames are bracketed for IPv6 ([::1]); zones use %. */
function stripHostBrackets(hostname) {
  return String(hostname).replace(/^\[+/, "").replace(/[\]%].*$/, "");
}

/** @param {string} host @returns {boolean} */
function isIpLiteral(host) {
  return parseIPv4Long(host) !== null || parseIPv6Groups(host) !== null;
}

/**
 * @param {unknown} records resolver result; tolerates arrays of {address}
 *   objects or bare strings (test stubs).
 * @returns {string[]}
 */
function extractAddresses(records) {
  const list = Array.isArray(records) ? records : [records];
  return list
    .map((r) => (typeof r === "string" ? r : r?.address))
    .filter((a) => typeof a === "string" && a.trim());
}

/* --------------------------- URL validation ---------------------------- */

/**
 * Full safety gate for one URL: parse → http(s) → hostname → (IP literal
 * or DNS) → every address public. Redirect hops reuse this verbatim.
 * @param {string} rawUrl
 * @param {(host: string, opts: object) => Promise<unknown>} resolver
 * @returns {Promise<{ ok: true, url: URL } | { ok: false, reason: string }>}
 */
async function validateTargetUrl(rawUrl, resolver) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl).trim());
  } catch {
    return { ok: false, reason: REASON_BLOCKED };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: REASON_BLOCKED };
  }
  const host = stripHostBrackets(parsed.hostname).toLowerCase();
  if (!host) return { ok: false, reason: REASON_BLOCKED };

  if (isIpLiteral(host)) {
    return isPublicAddress(host)
      ? { ok: true, url: parsed }
      : { ok: false, reason: REASON_BLOCKED };
  }
  if (isBlockedHostname(host)) {
    return { ok: false, reason: REASON_BLOCKED };
  }

  let records;
  try {
    records = await resolver(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: REASON_FETCH_FAILED };
  }
  const addresses = extractAddresses(records);
  if (!addresses.length) return { ok: false, reason: REASON_FETCH_FAILED };
  if (!addresses.every(isPublicAddress)) {
    return { ok: false, reason: REASON_BLOCKED };
  }
  return { ok: true, url: parsed };
}

/* ------------------------------- fetching ------------------------------ */

/** @param {string} contentType lowercased content-type value */
function isReadableContentType(contentType) {
  return contentType.startsWith("text/html") || contentType.startsWith("text/plain");
}

/**
 * Fetch one URL chain under the manual-redirect policy: initial +
 * revalidated hops, aborting the whole chain after `timeoutMs`.
 * @param {string} startUrl
 * @param {{ fetchImpl: Function, resolver: Function, timeoutMs: number }} deps
 * @returns {Promise<{ ok: true, finalUrl: string, contentType: string, body: string }
 *   | { ok: false, reason: string }>}
 */
async function fetchReadablePage(startUrl, deps) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const first = await validateTargetUrl(startUrl, deps.resolver);
    if (!first.ok) return first;
    let current = first.url;

    for (let hops = 0; ; hops += 1) {
      const res = await deps.fetchImpl(current.href, {
        redirect: "manual",
        signal: controller.signal,
      });

      const status = Number(res?.status);
      const location = REDIRECT_STATUSES.has(status)
        ? String(res?.headers?.get?.("location") || "")
        : "";
      if (location) {
        if (hops >= MAX_REDIRECTS) {
          return { ok: false, reason: REASON_REDIRECT_LIMIT };
        }
        let nextHref;
        try {
          nextHref = new URL(location, current).href;
        } catch {
          return { ok: false, reason: REASON_FETCH_FAILED };
        }
        const next = await validateTargetUrl(nextHref, deps.resolver);
        if (!next.ok) return next;
        current = next.url;
        continue;
      }

      if (!res?.ok) return { ok: false, reason: `http ${status}` };

      const contentType = String(
        res?.headers?.get?.("content-type") || "",
      )
        .toLowerCase()
        .trim();
      if (!isReadableContentType(contentType)) {
        return { ok: false, reason: REASON_CONTENT_TYPE };
      }
      const declared = Number(res?.headers?.get?.("content-length"));
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        return { ok: false, reason: REASON_FETCH_FAILED };
      }

      const body = String(await res.text()).slice(0, MAX_BYTES);
      return { ok: true, finalUrl: current.href, contentType, body };
    }
  } catch {
    return {
      ok: false,
      reason: controller.signal.aborted ? REASON_TIMEOUT : REASON_FETCH_FAILED,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------- extraction ------------------------------ */

/** Body-fallback: strip chrome/junk from the UNTOUCHED doc, serialize it. */
function fallbackBodyHtml(doc) {
  for (const el of doc.querySelectorAll(FALLBACK_STRIP_SELECTOR)) {
    el.remove();
  }
  const root = doc.body || doc.documentElement;
  return root ? root.outerHTML : "";
}

/**
 * HTML → { title, markdown }: Readability on a CLONE (parse() mutates
 * the DOM), body-fallback when the article is missing or thin, then
 * turndown. jsdom has scripts/resource loading disabled by default — we
 * keep it that way (never executes fetched content).
 * @param {string} html
 * @param {string} finalUrl final post-redirect URL (link resolution)
 * @returns {{ title: string, markdown: string }}
 */
function htmlToMarkdown(html, finalUrl) {
  // Lazy require: jsdom is heavy; loading it at bot startup is not ok.
  const { JSDOM } = require("jsdom");
  const { Readability } = require("@mozilla/readability");
  const TurndownService = require("turndown");

  const dom = new JSDOM(html, { url: finalUrl });
  try {
    const doc = dom.window.document;
    const pageTitle = (doc.title || "").trim();

    let article = null;
    try {
      article = new Readability(doc.cloneNode(true), {
        charThreshold: READ_CHAR_THRESHOLD,
      }).parse();
    } catch {
      article = null; // hostile/malformed markup → fall back to body
    }

    const articleText = article?.textContent
      ? String(article.textContent).trim()
      : "";
    const useArticle = Boolean(
      article && article.content && articleText.length >= MIN_ARTICLE_CHARS,
    );
    const bodyHtml = useArticle ? article.content : fallbackBodyHtml(doc);

    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    turndown.remove(REMOVED_TAGS);

    const title =
      String((useArticle ? article.title : "") || "").trim() || pageTitle;
    return { title, markdown: String(turndown.turndown(bodyHtml) || "") };
  } finally {
    try {
      dom.window?.close?.();
    } catch {
      /* best effort cleanup */
    }
  }
}

/* ------------------------- formatting & caps --------------------------- */

/** Collapse 3+ newlines to a blank line and trim (shared by both paths). */
function tidyMarkdown(markdown) {
  return String(markdown).replace(/\n{3,}/g, "\n\n").trim();
}

/** @param {string} markdown @returns {string} capped to MAX_PAGE_CHARS */
function capPage(markdown) {
  return markdown.length > MAX_PAGE_CHARS
    ? markdown.slice(0, MAX_PAGE_CHARS) + TRUNCATION_MARKER
    : markdown;
}

/** Locked block shapes (ok / per-page failure / inline skip reports). */
function okBlock({ title, url, hostname, markdown }) {
  return [`### ${title || hostname}`, `Source: ${url}`, markdown].join("\n");
}
function failBlock(url, reason) {
  return `### ${url}\nCould not read: ${reason}`;
}
function overflowBlock(url) {
  return `### ${url}\nSkipped: read_page reads at most ${MAX_URLS} URLs per call.`;
}

/**
 * Join page blocks in input order under the combined output cap; whole
 * pages that no longer fit are dropped and reported in one inline line.
 * @param {string[]} blocks @param {string[]} overflowBlocks
 * @returns {string}
 */
function assembleBlocks(blocks, overflowBlocks) {
  const included = [];
  let used = 0;
  let dropped = 0;
  for (const block of [...blocks, ...overflowBlocks]) {
    const next = used === 0 ? block.length : used + 2 + block.length;
    if (next <= MAX_TOTAL_CHARS) {
      included.push(block);
      used = next;
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) {
    included.push(
      `Skipped: ${dropped} page${dropped === 1 ? "" : "s"} dropped to stay within the ${MAX_TOTAL_CHARS}-character combined output limit.`,
    );
  }
  return included.join("\n\n");
}

/* ----------------------------- url coercion ---------------------------- */

/**
 * Coerce raw tool args to a URL list (model quirks tolerated): accepts
 * an array, a bare string, or an args object with `urls` (array|string)
 * or singular `url`; trims, drops non-strings/empties, dedupes (first
 * occurrence wins), splits into the first MAX_URLS + overflow `skipped`.
 * Pure. @param {unknown} raw
 * @returns {{ urls: string[], skipped: string[] }}
 */
function normalizeUrls(raw) {
  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "string") {
    list = [raw];
  } else if (raw && typeof raw === "object") {
    const inner = Array.isArray(raw.urls)
      ? raw.urls
      : typeof raw.urls === "string"
        ? [raw.urls]
        : typeof raw.url === "string"
          ? [raw.url]
          : [];
    list = inner;
  }

  const seen = new Set();
  const urls = [];
  const skipped = [];
  for (const item of list) {
    const url = typeof item === "string" ? item.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    (urls.length < MAX_URLS ? urls : skipped).push(url);
  }
  return { urls, skipped };
}

/* ------------------------------ per page ------------------------------- */

function hostnameOf(rawUrl) {
  try {
    return new URL(String(rawUrl).trim()).hostname;
  } catch {
    return String(rawUrl);
  }
}

/**
 * Read one URL end-to-end and render its block. Never throws: any
 * failure (validation, fetch, or an extraction crash on hostile markup)
 * becomes the inline failure block.
 * @param {string} rawUrl @param {{ fetchImpl: Function, resolver: Function, timeoutMs: number }} deps
 * @returns {Promise<string>}
 */
async function readOneUrl(rawUrl, deps) {
  try {
    const fetched = await fetchReadablePage(rawUrl, deps);
    if (!fetched.ok) return failBlock(rawUrl, fetched.reason);

    let title = "";
    let markdown;
    if (fetched.contentType.startsWith("text/plain")) {
      markdown = fetched.body; // locked: text/plain is used raw
    } else {
      const extracted = htmlToMarkdown(fetched.body, fetched.finalUrl);
      title = extracted.title;
      markdown = extracted.markdown;
    }

    const cleaned = tidyMarkdown(markdown);
    if (!cleaned) return failBlock(rawUrl, REASON_EMPTY);
    return okBlock({
      title,
      url: fetched.finalUrl,
      hostname: hostnameOf(rawUrl),
      markdown: capPage(cleaned),
    });
  } catch {
    return failBlock(rawUrl, REASON_FETCH_FAILED);
  }
}

/* ------------------------------ tool body ------------------------------ */

/**
 * Execute the `read_page` tool: read up to 3 URLs concurrently (results
 * in input order, per-page failures inline, overflow URLs reported as
 * skipped) under the combined output cap. Never throws, never rejects.
 *
 * @param {unknown} args raw tool args (see normalizeUrls for the
 *   tolerated shapes)
 * @param {object} [options]
 * @param {Function} [options.resolver] DNS stub; defaults to
 *   `dns.promises.lookup`
 * @param {Function} [options.fetchImpl] fetch stub; defaults to
 *   `globalThis.fetch`
 * @param {number} [options.timeoutMs] per-page timeout; default
 *   DEFAULT_TIMEOUT_MS
 * @returns {Promise<string>} combined text block for the model
 */
async function executeReadPage(args, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  try {
    const { urls, skipped } = normalizeUrls(args);
    if (!urls.length) return "read_page: no usable URLs were provided.";

    const rawTimeout = Number(opts.timeoutMs);
    const deps = {
      resolver:
        typeof opts.resolver === "function"
          ? opts.resolver
          : (host, lookupOpts) => dnsPromises.lookup(host, lookupOpts),
      fetchImpl:
        typeof opts.fetchImpl === "function" ? opts.fetchImpl : globalThis.fetch,
      timeoutMs:
        Number.isFinite(rawTimeout) && rawTimeout > 0
          ? rawTimeout
          : DEFAULT_TIMEOUT_MS,
    };

    const settled = await Promise.allSettled(
      urls.map((url) => readOneUrl(url, deps)),
    );
    const blocks = settled.map((outcome, i) =>
      outcome.status === "fulfilled"
        ? outcome.value
        : failBlock(urls[i], REASON_FETCH_FAILED),
    );
    return assembleBlocks(
      blocks,
      skipped.map((url) => overflowBlock(url)),
    );
  } catch {
    return "read_page: the page reader hit an unexpected error.";
  }
}

module.exports = Object.freeze({
  READ_PAGE_TOOL,
  executeReadPage,
  normalizeUrls,
  isPublicAddress,
  isBlockedHostname,
  DEFAULT_TIMEOUT_MS,
  MAX_URLS,
  MAX_PAGE_CHARS,
  MAX_TOTAL_CHARS,
  MAX_BYTES,
  MAX_REDIRECTS,
  TRUNCATION_MARKER,
});
