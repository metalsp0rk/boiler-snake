/**
 * Gork `web_search` tool: SearXNG JSON API client + OpenAI tool schema.
 *
 * Implements the locked web-search spec from roadmap/gork.md §7.5
 * (design decision 10): gork exposes a plain OpenAI-compatible function
 * tool `web_search(query: string)`; the bot executes each call against a
 * SearXNG instance's JSON API (`GET {SEARXNG_URL}/search?q=<query>&format=json`,
 * ~10s timeout). The top 5 results (title, URL, snippet trimmed to ~300
 * chars) are returned as a compact numbered text block the model can read.
 *
 * Any failure — network error, timeout, HTTP error, malformed JSON, no
 * results, or a missing `SEARXNG_URL` — resolves to a
 * "Web search unavailable: <reason>" string. This module never throws, so
 * a broken search can never crash the tool loop (roadmap/gork.md §7.5:
 * "Model receives 'search unavailable' and answers from context alone").
 *
 * Intended usage (trigger.js):
 *
 * ```js
 * const {
 *   WEB_SEARCH_TOOL,
 *   isWebSearchEnabled,
 *   executeWebSearch,
 * } = require("./tools/webSearch");
 *
 * const tools = isWebSearchEnabled(settings) ? [WEB_SEARCH_TOOL] : undefined;
 * const result = await chatWithTools(cfg, {
 *   messages,
 *   tools,
 *   executeTool: (name, args) =>
 *     name === "web_search"
 *       ? executeWebSearch(args.query)
 *       : `unknown tool: ${name}`,
 *   ...
 * });
 * ```
 *
 * Enablement: `isWebSearchEnabled(guildSettings)` is true when a SearXNG
 * base URL is configured AND the guild's `gork_search_enabled` setting is
 * on. The base URL is read from `process.env.SEARXNG_URL` by default; pass
 * `options.baseUrl` to override it (used by tests to avoid env mutation).
 * `gork_search_enabled` defaults to ON when the key is absent from the
 * passed settings object; any stored value other than 0 (e.g. 1) is on.
 *
 * Dependencies are injectable for tests: `options.fetchImpl` (defaults to
 * global `fetch`) and `options.timeoutMs` (defaults to 10s). No new npm
 * dependencies — same raw-fetch pattern as src/core/ai.js.
 */

/** Abort a search request after this many ms (spec: ~10s). */
const SEARCH_TIMEOUT_MS = 10_000;
/** Feed at most this many results back to the model (spec: top 5). */
const MAX_RESULTS = 5;
/** Trim each snippet to this many chars (spec: ~300). */
const SNIPPET_MAX_CHARS = 300;

/**
 * OpenAI-compatible function tool definition for `web_search`.
 * Pass as `tools: [WEB_SEARCH_TOOL]` to the shared AI client (src/core/ai.js).
 * @type {{ type: "function", function: { name: string, description: string, parameters: object } }}
 */
const WEB_SEARCH_TOOL = Object.freeze({
  type: "function",
  function: Object.freeze({
    name: "web_search",
    description:
      "Search the web for up-to-date information using the guild's " +
      "configured SearXNG instance. Returns the top 5 results as a " +
      "numbered list of title, URL, and short snippet. Use when the " +
      "conversation context does not contain the answer.",
    parameters: Object.freeze({
      type: "object",
      properties: Object.freeze({
        query: Object.freeze({
          type: "string",
          description: "The search query",
        }),
      }),
      required: Object.freeze(["query"]),
      additionalProperties: false,
    }),
  }),
});

/**
 * Normalize a SearXNG base URL: trim whitespace, strip trailing slashes.
 * Non-string or empty input yields null (unset).
 * @param {unknown} raw
 * @returns {string|null} normalized base URL, or null when unset
 */
function normalizeBaseUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed || null;
}

/**
 * Read the configured SearXNG base URL from env.
 * @returns {string|null} normalized `SEARXNG_URL`, or null when unset/empty
 */
function getSearchBaseUrl() {
  return normalizeBaseUrl(process.env.SEARXNG_URL);
}

/**
 * Whether the guild's `gork_search_enabled` toggle is on. Absent
 * (undefined/null) values use the spec default: on. Any stored value
 * other than 0 (e.g. the stored 1) counts as on.
 * @param {unknown} gorkSearchEnabled guild setting value (0/1 from the DB)
 * @returns {boolean}
 */
function isSearchToggleOn(gorkSearchEnabled) {
  if (gorkSearchEnabled === undefined || gorkSearchEnabled === null) {
    return true; // spec default: on
  }
  return Number(gorkSearchEnabled) !== 0;
}

/**
 * Whether the `web_search` tool should be offered to the model for this
 * guild: a SearXNG base URL must be configured (env `SEARXNG_URL` by
 * default) AND the guild's `gork_search_enabled` setting must be on
 * (default on when the key is absent).
 *
 * @param {object} [guildSettings] guild settings row (or subset)
 * @param {object} [options]
 * @param {string} [options.baseUrl] base URL override (tests); when
 *   omitted/empty, `process.env.SEARXNG_URL` is read here
 * @returns {boolean}
 */
function isWebSearchEnabled(guildSettings = {}, options = {}) {
  const baseUrl =
    normalizeBaseUrl(options?.baseUrl) || getSearchBaseUrl();
  if (!baseUrl) return false;
  return isSearchToggleOn(guildSettings?.gork_search_enabled);
}

/**
 * Build the failure message the model receives when a search cannot be
 * completed (locked style: roadmap/gork.md §7.5).
 * @param {string} reason short human-readable reason
 * @returns {string}
 */
function unavailable(reason) {
  return `Web search unavailable: ${reason}`;
}

/**
 * Extract the top results from a SearXNG JSON response body. Entries
 * without a non-empty `url` are dropped; the list is capped at
 * MAX_RESULTS. SearXNG carries the snippet in `content` (with `snippet`
 * accepted as a fallback).
 * @param {unknown} data parsed SearXNG JSON response
 * @returns {{ title: string, url: string, snippet: string }[]}
 */
function extractResults(data) {
  const list = Array.isArray(data?.results) ? data.results : [];
  return list
    .filter((r) => r && typeof r.url === "string" && r.url.trim())
    .slice(0, MAX_RESULTS)
    .map((r) => ({
      title: String(r.title ?? "").trim(),
      url: r.url.trim(),
      snippet: String(r.content ?? r.snippet ?? "")
        .trim()
        .slice(0, SNIPPET_MAX_CHARS),
    }));
}

/**
 * Format results as the compact text block fed back to the model:
 * `1. Title` / indented URL / indented snippet, one block per result.
 * @param {{ title: string, url: string, snippet: string }[]} results
 * @returns {string}
 */
function formatResults(results) {
  return results
    .map((r, index) => {
      const lines = [`${index + 1}. ${r.title || r.url}`];
      if (r.url) lines.push(`   ${r.url}`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * One SearXNG search HTTP round trip:
 * `GET {baseUrl}/search?q=<query>&format=json`.
 * Never throws; resolves to a result object like src/core/ai.js
 * `requestCompletion`: `ok:true` → parsed JSON `data`; `ok:false` →
 * `reason` "http" (with `status`) | "parse" (malformed JSON) |
 * "timeout" | "network" (with `error`).
 *
 * @param {string} baseUrl normalized SearXNG base URL (no trailing slash)
 * @param {string} query trimmed search query (will be URL-encoded)
 * @param {object} [options]
 * @param {number} [options.timeoutMs] abort after this many ms (default SEARCH_TIMEOUT_MS)
 * @param {Function} [options.fetchImpl] injectable fetch (tests); defaults to global fetch
 * @returns {Promise<object>}
 */
async function fetchSearch(baseUrl, query, options = {}) {
  // Tolerate null (default params only apply to undefined) — never throw.
  const opts = options && typeof options === "object" ? options : {};
  const rawTimeout = Number(opts.timeoutMs);
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : SEARCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const doFetch =
    typeof opts.fetchImpl === "function" ? opts.fetchImpl : globalThis.fetch;
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`;
  try {
    const res = await doFetch(url, { signal: controller.signal });
    if (!res.ok) {
      return { ok: false, status: res.status, reason: "http" };
    }
    try {
      const data = await res.json();
      return { ok: true, data };
    } catch {
      return { ok: false, reason: "parse", error: "invalid JSON response" };
    }
  } catch (err) {
    return {
      ok: false,
      reason: controller.signal.aborted ? "timeout" : "network",
      error: err?.message || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute the `web_search` tool: run one SearXNG search and return the
 * compact results block (or a "Web search unavailable: <reason>" string
 * on any failure) to be fed back to the model as the tool result.
 *
 * Never throws, never rejects: every failure path resolves to the
 * unavailable message so the AI tool loop always continues.
 *
 * @param {unknown} query search query from the model (string expected)
 * @param {object} [options]
 * @param {string} [options.baseUrl] SearXNG base URL override; when
 *   omitted/empty, `process.env.SEARXNG_URL` is the default
 * @param {number} [options.timeoutMs] request timeout (default 10s)
 * @param {Function} [options.fetchImpl] injectable fetch (tests)
 * @returns {Promise<string>} text block for the model
 */
async function executeWebSearch(query, options = {}) {
  // Tolerate null (default params only apply to undefined) — never throw.
  const opts = options && typeof options === "object" ? options : {};
  const baseUrl = normalizeBaseUrl(opts.baseUrl) || getSearchBaseUrl();
  if (!baseUrl) {
    return unavailable("SEARXNG_URL is not configured");
  }
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) return unavailable("empty query");

  const res = await fetchSearch(baseUrl, q, opts);
  if (!res.ok) {
    const detail =
      ({
        http: `search failed with HTTP ${res.status}`,
        timeout: "search timed out",
        parse: "search returned malformed JSON",
        network: `search failed: ${res.error || "network error"}`,
      })[res.reason] || `search failed: ${res.error || res.reason}`;
    return unavailable(detail);
  }

  const results = extractResults(res.data);
  if (!results.length) return unavailable("no results");
  return formatResults(results);
}

module.exports = Object.freeze({
  WEB_SEARCH_TOOL,
  isWebSearchEnabled,
  executeWebSearch,
  SEARCH_TIMEOUT_MS,
  MAX_RESULTS,
  SNIPPET_MAX_CHARS,
});
