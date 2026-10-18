/**
 * #385 (FLX-4): the short-TTL cache behind the Fluxer permission fan-out.
 *
 * resolveFluxerPermissions used to run guild + roles + channel (+ member)
 * GETs on EVERY prefix command — even lines the command-channel or API gate
 * would have refused seconds later. Roles/guild/channel structures change
 * rarely; a few seconds of staleness is exactly what the spec's permission
 * model can tolerate and what removes ~all of the per-message REST.
 *
 * Design notes:
 *  - keyed by the outbound OBJECT (a WeakMap), not just instanceKey: two
 *    adapters for one instance string never share entries, and a fresh
 *    fake in a test never inherits a production entry — while production
 *    (one long-lived outbound per Fluxer handle, client.js) hits every
 *    single time;
 *  - SUCCESSES ONLY. A failure (or the adapter's failure-shaped null/[])
 *    is never stored: the next call retries it honestly. Transient errors
 *    must not be nailed to the community for the rest of the TTL;
 *  - TTL: FLUXER_PERMISSION_CACHE_MS, default 5000, 0 disables (every call
 *    hits the network — the pre-#385 behavior). A garbage value falls back
 *    to the default with one specific complaint per process.
 */

const DEFAULT_TTL_MS = 5000;

/** @type {WeakMap<object, Map<string, { value: unknown, expiresAt: number }>>} */
const stores = new WeakMap();

let complained = false;

/** Current TTL in ms, re-read per op so tests (and ops) can flip the knob. */
function ttlMs() {
  const raw = process.env.FLUXER_PERMISSION_CACHE_MS;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    if (!complained) {
      complained = true;
      console.error(
        `[fluxer] FLUXER_PERMISSION_CACHE_MS "${raw}" is not a number >= 0 — using the ${DEFAULT_TTL_MS}ms default`,
      );
    }
  }
  return DEFAULT_TTL_MS;
}

function storeFor(outbound) {
  let store = stores.get(outbound);
  if (!store) {
    store = new Map();
    stores.set(outbound, store);
  }
  return store;
}

/**
 * Cached read. `undefined` means miss (a stored NULL is still a value —
 * callers only store meaningful results anyway).
 *
 * @param {object} outbound the adapter object making the fetch
 * @param {string} keyPartCacheKey kind + ids, e.g. "roles:42"
 * @returns {{ value: unknown } | undefined} the hit wrapper (undefined = miss)
 */
function read(outbound, keyPart) {
  if (!outbound || ttlMs() === 0) return undefined;
  const store = stores.get(outbound);
  if (!store) return undefined;
  const entry = store.get(keyPart);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    store.delete(keyPart);
    return undefined;
  }
  return { value: entry.value };
}

/**
 * Store one SUCCESS for the TTL window. Callers are responsible for the
 * success judgement (never cache the adapter's failure-shaped null/[]).
 *
 * @param {object} outbound
 * @param {string} keyPart
 * @param {unknown} value
 */
function store(outbound, keyPart, value) {
  const ttl = ttlMs();
  if (!outbound || ttl === 0) return;
  storeFor(outbound).set(keyPart, { value, expiresAt: Date.now() + ttl });
}

/**
 * Drop one community's channel entry (after the BOT edited that channel —
 * the write is authoritative, the cache is not).
 *
 * @param {object} outbound
 * @param {number|string} communityId
 * @param {string} channelId
 */
function invalidateChannel(outbound, communityId, channelId) {
  const store = stores.get(outbound);
  if (store) store.delete(`channel:${communityId}:${String(channelId)}`);
}

/** Drop everything for one outbound (test seam + blunt ops). */
function clear(outbound) {
  if (outbound) stores.delete(outbound);
}

module.exports = { read, store, invalidateChannel, clear, DEFAULT_TTL_MS };
