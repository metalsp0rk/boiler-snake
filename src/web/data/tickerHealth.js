/**
 * In-process ticker-health registry for the guild dashboard (roadmap/
 * web-admin.md §8.6 "Dashboard (… ticker health …)", subtask 14).
 *
 * WHY A REGISTRY: no ticker in this repo exposes its state today — voice,
 * youtube, twitch and the XP-decay loop are plain `setInterval`s with no
 * last-tick timestamp (verified: src/features/voice/index.js,
 * src/features/youtube/ticker.js, src/features/twitch/ticker.js,
 * src/features/xp/index.js). Rather than couple web to bot internals, this
 * module is a tiny name → optional-getter map. A future boot wiring (or a
 * test) registers a getter per ticker; until then every entry reads as
 * `unknown` and the dashboard renders that honestly.
 *
 * Contract per source getter (sync or async, may be absent/throwing —
 * every failure mode degrades to `unknown`, never to a fabricated status):
 *  - `null | undefined`            → unknown ("not wired")
 *  - `number`                      → treated as lastTickAt (epoch ms)
 *  - `{ status?, lastTickAt?, intervalMs?, running?, detail? }`
 *      status ∈ ok|stale|down|unknown wins when present;
 *      otherwise lastTickAt + intervalMs derive ok/stale (age > 2.5× the
 *      tick interval is STALE);
 *      otherwise a boolean `running` maps to ok/down;
 *      anything else → unknown.
 *  - throws                        → unknown with a FIXED detail string
 *      (error text may contain internals; §8.7 generic bodies).
 *
 * No timers live here (getters are read at snapshot time), so there is
 * nothing to unref/cleanup — snapshot reads are pure and cheap.
 *
 * Name SETS can be dynamic too (#217): a SNAPSHOT-TIME PROVIDER
 * (registerTickerHealthProvider) contributes [name, getter] pairs at every
 * snapshot, so a bridge over a live job registry (see schedulerJobHealth)
 * covers entries registered AFTER web boot. Static registrations win
 * collisions; failing providers never break a snapshot.
 */

/** Statuses the dashboard view knows how to render. */
const TICKER_STATUSES = Object.freeze(["ok", "stale", "down", "unknown"]);

/** age > STALE_GRACE_FACTOR × intervalMs ⇒ stale (drift beyond one tick). */
const STALE_GRACE_FACTOR = 2.5;

/** Fixed degrade details — never interpolated with error text. */
const DETAIL_NOT_WIRED = "not wired";
const DETAIL_SOURCE_FAILED = "source failed";
const DETAIL_BAD_SHAPE = "unexpected source result";

/** detail display cap (registry is in-process, but stay bounded anyway). */
const MAX_DETAIL_LEN = 120;

/** name → getter. Registration is explicit; nothing self-registers. */
const sources = new Map();

/**
 * provider name → fn returning [name, getter] pairs, EVALUATED AT SNAPSHOT
 * TIME (#217). Why: `schedulerJobHealth` must cover jobs whose features
 * start AFTER web (src/features/index.js order: web → gork → bridge →
 * linking), and a name enumerated once at web boot can never see them —
 * the live app rendered no bridge-relay / bridge-expiry / bridge-relay-ttl
 * / linking-code-expiry rows. Providers keep the NAME SET live the same way
 * getters already keep the VALUES live.
 */
const providers = new Map();

function normalizeDetail(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_DETAIL_LEN
    ? `${trimmed.slice(0, MAX_DETAIL_LEN - 1)}…`
    : trimmed;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pure classification of one getter result — exported for tests.
 * @param {unknown} result raw getter value
 * @param {number} now clock ms
 * @param {string} name entry name (kept for display + fixed degrade detail)
 */
function classifyTickerResult(result, now, name) {
  const base = { name };

  if (result == null) {
    return { ...base, status: "unknown", detail: DETAIL_NOT_WIRED };
  }

  // Bare number ⇒ lastTickAt.
  const asNumber = finiteNumber(result);
  if (asNumber !== null && typeof result !== "object") {
    return {
      ...base,
      status: "ok",
      lastTickAt: asNumber,
      ageMs: Math.max(0, now - asNumber),
    };
  }

  if (typeof result !== "object") {
    return { ...base, status: "unknown", detail: DETAIL_BAD_SHAPE };
  }

  const entry = { ...base };
  const detail = normalizeDetail(result.detail);
  if (detail) entry.detail = detail;

  const lastTickAt = finiteNumber(result.lastTickAt);
  if (lastTickAt !== null) {
    entry.lastTickAt = lastTickAt;
    entry.ageMs = Math.max(0, now - lastTickAt);
  }

  if (TICKER_STATUSES.includes(result.status)) {
    entry.status = result.status;
    return entry;
  }

  const intervalMs = finiteNumber(result.intervalMs);
  if (intervalMs !== null && intervalMs > 0 && lastTickAt !== null) {
    entry.status =
      entry.ageMs > STALE_GRACE_FACTOR * intervalMs ? "stale" : "ok";
    return entry;
  }

  if (typeof result.running === "boolean") {
    entry.status = result.running ? "ok" : "down";
    return entry;
  }

  entry.status = "unknown";
  if (!entry.detail) entry.detail = DETAIL_NOT_WIRED;
  return entry;
}

/**
 * Register (or replace) one ticker's optional status getter.
 * @param {string} name stable id, e.g. "voice", "youtube", "twitch"
 * @param {(() => unknown) | null} getter null removes the source
 * @returns {() => void} unregister helper
 */
function registerTickerHealthSource(name, getter) {
  const key = String(name || "").trim();
  if (!key) {
    throw new TypeError("registerTickerHealthSource: name is required");
  }
  if (typeof getter !== "function") {
    sources.delete(key);
    return () => {};
  }
  sources.set(key, getter);
  return () => {
    if (sources.get(key) === getter) sources.delete(key);
  };
}

function unregisterTickerHealthSource(name) {
  return sources.delete(String(name || "").trim());
}

/**
 * Register (or replace) a SNAPSHOT-TIME source provider (#217 late-job
 * class). The provider runs on every snapshotTickerHealth()/
 * listTickerHealthNames() call and returns [name, getter] pairs following
 * the exact getter contract above. Static registrations win a name
 * collision; within providers, first-seen wins. A throwing provider is
 * logged with a FIXED framing (error text may carry internals) and
 * skipped; junk results (non-array entries, malformed pairs) are skipped
 * silently — they can only come from wiring bugs, never runtime state.
 * @param {string} name stable provider id (replace-per-name: double boot safe)
 * @param {(() => Array<[string, Function]>)} fn pairs factory
 * @returns {() => void} unregister helper (no-op once replaced)
 */
function registerTickerHealthProvider(name, fn) {
  const key = String(name || "").trim();
  if (!key) {
    throw new TypeError("registerTickerHealthProvider: name is required");
  }
  if (typeof fn !== "function") {
    providers.delete(key);
    return () => {};
  }
  providers.set(key, fn);
  return () => {
    if (providers.get(key) === fn) providers.delete(key);
  };
}

/** One provider → validated [name, getter] pairs ([] on any problem). */
function providerEntries(key, fn, { log }) {
  let raw;
  try {
    raw = fn();
  } catch (err) {
    if (log) {
      // Fixed framing; provider error text never reaches the log (§8.7).
      console.error(`[web] ticker-health provider "${key}" failed on snapshot`);
    }
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const pair of raw) {
    if (
      Array.isArray(pair) &&
      pair.length === 2 &&
      typeof pair[0] === "string" &&
      pair[0].trim() !== "" &&
      typeof pair[1] === "function"
    ) {
      out.push([pair[0].trim(), pair[1]]);
    }
  }
  return out;
}

/**
 * Snapshot every registered source. Never throws; each getter runs inside
 * its own try/catch and degrades to `unknown` on any failure. Awaited
 * because getters may be async (e.g. a cheap lavalink GET).
 * @param {number} [now] clock ms (injected in tests)
 * @returns {Promise<Array<{name: string, status: string, lastTickAt?: number, ageMs?: number, detail?: string}>>}
 */
async function snapshotTickerHealth(now = Date.now()) {
  // Static first, then live provider rows; first-seen name wins.
  const entries = [...sources.entries()];
  const seen = new Set(sources.keys());
  for (const [key, fn] of providers) {
    for (const [name, getter] of providerEntries(key, fn, { log: true })) {
      if (!seen.has(name)) {
        seen.add(name);
        entries.push([name, getter]);
      }
    }
  }
  const results = await Promise.all(
    entries.map(async ([name, get]) => {
      try {
        return classifyTickerResult(await get(), now, name);
      } catch {
        // Fixed string only — getter errors may carry internals (§8.7).
        return { name, status: "unknown", detail: DETAIL_SOURCE_FAILED };
      }
    })
  );
  return results;
}

/** Registered names (for wiring diagnostics / tests) — snapshot-visible:
 *  static sources plus whatever the providers currently yield, deduped. */
function listTickerHealthNames() {
  const names = [...sources.keys()];
  const seen = new Set(names);
  for (const [key, fn] of providers) {
    for (const [name] of providerEntries(key, fn, { log: false })) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  return names;
}

/** Test seam: drop all registered sources AND providers. */
function _clearTickerHealthForTests() {
  sources.clear();
  providers.clear();
}

module.exports = {
  TICKER_STATUSES,
  STALE_GRACE_FACTOR,
  classifyTickerResult,
  registerTickerHealthSource,
  unregisterTickerHealthSource,
  registerTickerHealthProvider,
  listTickerHealthNames,
  snapshotTickerHealth,
  _clearTickerHealthForTests,
};
