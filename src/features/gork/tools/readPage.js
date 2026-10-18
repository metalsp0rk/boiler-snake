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
 * - SSRF: the address policy is the SHARED guard (src/core/ssrfGuard.js —
 *   #273 consolidated the third bespoke implementation into it). The
 *   hostname is resolved through the injectable `resolver` seam and EVERY
 *   resolved address is class-checked by the shared `isDisallowedAddress`
 *   (loopback, RFC1918, CGNAT, link-local, reserved/broadcast/multicast,
 *   IPv6 ::/::1/fc00::/7/fe80::/10/c000::/2, IPv4-mapped IPv6 in every
 *   notation). `localhost` and the `.local`/`.internal`/`.localhost`
 *   suffixes are blocked pre-resolution (read-page hostname policy).
 * #415 (BRG-9): the addresses cleared by validation are PINNED into the
 *   fetch itself (shared guard's defaultGuardedFetch connects to the
 *   validated IP with SNI/Host kept on the name), so validation and
 *   connection share ONE resolution — the DNS-rebinding window between
 *   the check and the socket is closed, per hop.
 * - Fetch uses `redirect: "manual"` with at most 2 redirects, and each
 *   hop's URL is fully re-validated (protocol + host + DNS) before it is
 *   fetched.
 * - content-type must start with `text/html` or `text/plain`; bodies are
 *   HARD-CAPPED at MAX_BYTES: streaming read stops at the budget and the
 *   response body is cancelled, so the download itself is bounded — not
 *   just the visible string (chunked responses included, #435).
 *
 * Like webSearch.js, this module NEVER throws: every per-page failure
 * resolves to an inline `Could not read: <reason>` block (reasons:
 * "blocked address", "redirect limit", "timeout", "http <status>",
 * "unreadable content-type", "fetch failed", "empty content") so the AI
 * tool loop always continues. jsdom/readability/turndown are required
 * lazily inside the extraction path so bot startup stays light.
 *
 * Dependencies are injectable for tests: `options.resolver` (default: the
 * shared guard's resolver), `options.fetchImpl` (default global fetch),
 * `options.timeoutMs` (default DEFAULT_TIMEOUT_MS, per page).
 */

const ssrfGuard = require("../../../core/ssrfGuard");

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

/*
 * #273: the ADDRESS GRAMMAR (literal parsing, blocked ranges, IPv4-mapped
 * unwrapping) is owned by the shared guard, src/core/ssrfGuard.js — the
 * audit counted this module's local copy as the third bespoke
 * implementation ("share it, don't fork it"). What stays here is the
 * read-page POLICY: the pre-resolution hostname block list and the locked
 * inline failure reasons.
 */

/**
 * Whether an IP literal is publicly routable — a thin inversion of the
 * shared `ssrfGuard.isDisallowedAddress` (malformed input fails closed
 * there, so it is "not public" here).
 * @param {unknown} ip
 * @returns {boolean}
 */
function isPublicAddress(ip) {
  const text = typeof ip === "string" ? ip : "";
  return !ssrfGuard.isDisallowedAddress(text);
}

/**
 * Whether a hostname must be blocked without a name-resolution round trip:
 * the literal
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

  if (ssrfGuard.isIpLiteralHost(host)) {
    // IP literal: NO resolution happens for this host at all, so there is
    // nothing to rebind — pin nothing ([]), the transport needs no pin.
    return isPublicAddress(host)
      ? { ok: true, url: parsed, addresses: [] }
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
  // #415: hand the JUST-VALIDATED addresses to the caller so the fetch pins
  // its socket to them — checked resolution == connected resolution.
  return { ok: true, url: parsed, addresses };
}

/* ------------------------------- fetching ------------------------------ */

/** @param {string} contentType lowercased content-type value */
function isReadableContentType(contentType) {
  return contentType.startsWith("text/html") || contentType.startsWith("text/plain");
}

/**
 * #435 (audit F1-2): read AT MOST maxBytes — then cancel the body so the
 * transfer actually stops. The declared-length guard is blind to chunked
 * responses (no Content-Length → `Number(null) === 0` passes), and
 * `res.text()` decodes the WHOLE body before any slice: a prompt-injected
 * URL could pin hundreds of MB of decoded string per chain. Streaming with
 * a hard byte budget + cancel caps REAL bandwidth, not just the visible
 * string. Responses without a stream (older fakes, non-web bodies) keep
 * the text() fallback — its slice stays byte-cap semantics.
 *
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readBodyCapped(res, maxBytes) {
  const stream = res && res.body;
  if (!stream || typeof stream.getReader !== "function") {
    return String(await res.text()).slice(0, maxBytes);
  }
  const reader = stream.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(
          Buffer.isBuffer(value)
            ? value
            : Buffer.from(value.buffer, value.byteOffset, value.byteLength),
        );
        received += value.byteLength || 0;
      }
    }
  } finally {
    // Always stop the transfer — on the cap, on `done`, and on any read
    // error (the caller's catch classifies that one).
    try {
      await reader.cancel();
    } catch {
      /* stream already done/cancelled */
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
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
    let pinnedAddresses = Array.isArray(first.addresses) ? first.addresses : [];

    for (let hops = 0; ; hops += 1) {
      const res = await deps.fetchImpl(
        current.href,
        {
          redirect: "manual",
          signal: controller.signal,
        },
        // #415: the addresses validated for THIS hop. The default transport
        // (ssrfGuard.defaultGuardedFetch) pins the connection to them;
        // injected fakes ignore the extra argument.
        pinnedAddresses,
      );

      const status = Number(res?.status);
      // #475 (F1-8): every early return below (and every redirect follow)
      // drops THIS response unread. An unconsumed undici body keeps its
      // socket checked out of the shared global agent until GC — redirect-
      // heavy and error-heavy sites (404 is the most common) slowly pin the
      // pool and stall every other fetcher in the process, LLM calls
      // included. Cancel on every path that does not read the body.
      const discardBody = (r) => {
        try {
          const p = r?.body?.cancel?.();
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch {
          // body already consumed / fake without cancel — nothing to do
        }
      };
      const location = REDIRECT_STATUSES.has(status)
        ? String(res?.headers?.get?.("location") || "")
        : "";
      if (REDIRECT_STATUSES.has(status)) discardBody(res);
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
        // Re-pin per hop: the redirect target re-resolved, the socket follows
        // the FRESH validated addresses (mid-chain record flips die here).
        pinnedAddresses = Array.isArray(next.addresses) ? next.addresses : [];
        continue;
      }

      if (!res?.ok) {
        discardBody(res); // #475 (F1-8): error statuses leak the same sockets
        return { ok: false, reason: `http ${status}` };
      }

      const contentType = String(
        res?.headers?.get?.("content-type") || "",
      )
        .toLowerCase()
        .trim();
      if (!isReadableContentType(contentType)) {
        discardBody(res); // #475 (F1-8)
        return { ok: false, reason: REASON_CONTENT_TYPE };
      }
      const declared = Number(res?.headers?.get?.("content-length"));
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        discardBody(res); // #475 (F1-8)
        return { ok: false, reason: REASON_FETCH_FAILED };
      }

      // #435: stream-capped read (see readBodyCapped) — replaces the
      // post-buffer slice that only LOOKED like a download limit.
      const body = await readBodyCapped(res, MAX_BYTES);
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

/**
 * Whether a URL is a Discord channel/message link (§7.19 decision 44).
 * `read_page` reads the public web only — Discord links belong to
 * `read_discord` (which has the guild-isolation / asker-parity /
 * ticket-blackout semantics); refusing here saves a doomed HTTP fetch
 * and tells the model where to go.
 * @param {unknown} rawUrl
 * @returns {boolean}
 */
function isDiscordChannelUrl(rawUrl) {
  let host = "";
  let path = "";
  try {
    const parsed = new URL(String(rawUrl).trim());
    host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    path = parsed.pathname || "";
  } catch {
    return false;
  }
  const isDiscordHost = host === "discord.com" || host === "discordapp.com";
  return isDiscordHost && path.startsWith("/channels/");
}

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
    // §7.19 (decision 44): Discord links route to read_discord — refuse
    // pre-fetch so a misroute wastes no HTTP request.
    if (isDiscordChannelUrl(rawUrl)) {
      return failBlock(
        rawUrl,
        "Discord link — use the read_discord tool for discord.com channel/message links",
      );
    }
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
 * @param {Function} [options.resolver] name-resolution stub; defaults to
 *   the shared guard's resolver (`ssrfGuard.defaultResolveHost`)
 * @param {Function} [options.fetchImpl] fetch stub; defaults to the shared
 *   guard's pinning router (`ssrfGuard.defaultGuardedFetch` — name hops pin
 *   the validated IP, IP literals fall through to `globalThis.fetch`)
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
          : ssrfGuard.defaultResolveHost,
      // #415: default is the shared guard's PINNING router — name-based hops
      // fetch the validated IP (no second lookup to rebind into); IP-literal
      // hops delegate to globalThis.fetch inside it (no DNS involved there,
      // so nothing can rebind and the scripted test fakes stay in charge).
      fetchImpl:
        typeof opts.fetchImpl === "function"
          ? opts.fetchImpl
          : ssrfGuard.defaultGuardedFetch,
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
  isDiscordChannelUrl,
  DEFAULT_TIMEOUT_MS,
  MAX_URLS,
  MAX_PAGE_CHARS,
  MAX_TOTAL_CHARS,
  MAX_BYTES,
  MAX_REDIRECTS,
  TRUNCATION_MARKER,
});
