const { URL } = require("url");

const HELIX_BASE = "https://api.twitch.tv/helix";
const FETCH_TIMEOUT_MS = 15_000;

const THUMBNAIL_WIDTH = 640;
const THUMBNAIL_HEIGHT = 360;

/**
 * Expand the `{width}`/`{height}` template placeholders that Helix embeds in
 * stream thumbnail URLs (e.g. `live_user_teampgp-{width}x{height}.jpg`).
 * Discord rejects URLs containing braces with 400 "Invalid Form Body", so
 * the template MUST be expanded before the URL reaches an embed.
 *
 * @param {string} url raw Helix thumbnail_url (or any URL)
 * @param {number} [width]
 * @param {number} [height]
 * @returns {string|null} expanded URL, or null when empty/still templated
 */
function expandThumbnailUrl(url, width = THUMBNAIL_WIDTH, height = THUMBNAIL_HEIGHT) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  const expanded = raw
    .replace(/\{width\}/g, String(width))
    .replace(/\{height\}/g, String(height));
  return /[{}]/.test(expanded) ? null : expanded;
}

/**
 * One-line error description for logging.
 *
 * Node's global fetch wraps every network-level failure (DNS lookup failure,
 * TLS error, socket reset) in `TypeError: fetch failed` and buries the real
 * reason in `err.cause`. Logging only `err.name`/`err.message` therefore
 * shows a contentless "TypeError", so the cause is included when present.
 *
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  if (!err) return String(err);
  const name = err.name || "Error";
  const message = err.message || String(err);
  const ownCode = err.code && !message.includes(err.code) ? ` (${err.code})` : "";
  let text = `${name}${ownCode}: ${message}`;
  const cause = err.cause;
  if (cause) {
    let causeText = cause.message || "";
    if (cause.code && !causeText.includes(cause.code)) {
      causeText = `${cause.code} ${causeText}`.trim();
    }
    text += ` | cause: ${causeText || String(cause)}`;
  }
  return text;
}

/**
 * Fetch a Helix app access token (Client Credentials grant).
 * Caches the token until ~60s before expiry.
 * @returns {Promise<string|null>}
 */
async function getAppToken() {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const cached = getAppTokenCache();
  if (cached) return cached.token;

  let res;
  try {
    res = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.error("[twitch] Token request failed:", describeError(err));
    return null;
  }

  if (!res.ok) {
    console.error(
      `[twitch] Token request failed: ${res.status}`,
    );
    return null;
  }

  const data = await res.json().catch(() => null);
  if (!data?.access_token) return null;

  const expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  setAppTokenCache(data.access_token, expiresAt);
  return data.access_token;
}

/**
 * Build the full Helix URL for a path + query object.
 * @param {string} path
 * @param {object} query
 * @returns {string}
 */
function helixUrl(path, query) {
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(query).filter(([, v]) => v != null && v !== ""),
    ),
  ).toString();
  return `${HELIX_BASE}${path}${qs ? `?${qs}` : ""}`;
}

/**
 * One authenticated Helix request. Returns the raw response, or null when
 * the request never completed (network error). `body` (an object) is sent as
 * JSON; method defaults to GET.
 * @param {string} path
 * @param {string} url
 * @param {string} token
 * @param {{ method?: string, body?: object }} [opts]
 * @returns {Promise<Response|null>}
 */
async function requestHelix(path, url, token, opts = {}) {
  const { method = "GET", body } = opts;
  const headers = {
    "Client-Id": process.env.TWITCH_CLIENT_ID,
    Authorization: `Bearer ${token}`,
  };
  if (body != null) headers["Content-Type"] = "application/json";
  try {
    return await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`[twitch] Helix ${method} ${path} failed:`, describeError(err));
    return null;
  }
}

/**
 * Helix GET with app token + one-shot 401 token refresh. A 401 (expired /
 * revoked app token, e.g. after a client-secret rotation) drops the cached
 * token and retries once with a fresh one instead of staying broken until the
 * cache expiry.
 * @param {string} path e.g. "/streams"
 * @param {object} [query]
 * @returns {Promise<object|null>} parsed JSON body, or null on any failure
 */
async function helixGet(path, query = {}) {
  let token = await getAppToken();
  if (!token) return null;

  const url = helixUrl(path, query);
  let res = await requestHelix(path, url, token);
  if (!res) return null;

  if (res.status === 401) {
    console.warn(
      `[twitch] Helix ${path} returned 401; refreshing app token and retrying`,
    );
    clearAppTokenCache();
    token = await getAppToken();
    if (!token) return null;
    res = await requestHelix(path, url, token);
    if (!res) return null;
  }

  if (!res.ok) {
    console.error(`[twitch] Helix ${path} returned ${res.status}`);
    return null;
  }

  return res.json().catch(() => null);
}

/**
 * Helix request that PRESERVES the HTTP status (EventSub create/delete need
 * to tell 202/204 apart from 409 conflict / 422 quota / 429 rate-limit, which
 * the status-swallowing helixGet cannot do). 401 refreshes once like helixGet.
 *
 * @param {string} method HTTP verb (POST/DELETE/…)
 * @param {string} path
 * @param {{ query?: object, body?: object }} [opts]
 * @returns {Promise<{ status: number, body: object|null }|null>}
 *   null = the request never completed (network/timeout); otherwise the
 *   status code + parsed body (body null for 204/unparseable).
 */
async function helixRequest(method, path, { query = {}, body } = {}) {
  let token = await getAppToken();
  if (!token) return null;

  const url = helixUrl(path, query);
  let res = await requestHelix(path, url, token, { method, body });
  if (!res) return null;

  if (res.status === 401) {
    console.warn(
      `[twitch] Helix ${method} ${path} returned 401; refreshing app token and retrying`,
    );
    clearAppTokenCache();
    token = await getAppToken();
    if (!token) return null;
    res = await requestHelix(path, url, token, { method, body });
    if (!res) return null;
  }

  const parsed = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body: parsed };
}

/**
 * Resolve a login (or user id) to a Twitch user.
 * @param {string} loginOrId
 * @returns {Promise<{id:string,login:string,display_name:string,profile_image_url:string}|null>}
 */
async function resolveTwitchUser(loginOrId) {
  const login = String(loginOrId || "").trim();
  if (!login) return null;

  const isNumericId = /^\d+$/.test(login);
  const body = await helixGet(
    "/users",
    isNumericId ? { id: login } : { login },
  );
  const user = body?.data?.[0];
  if (!user) return null;

  return {
    id: user.id,
    login: user.login,
    display_name: user.display_name,
    profile_image_url: user.profile_image_url || "",
  };
}

const STREAMS_PAGE_SIZE = 100; // Helix max `first`; default is only 20.
const STREAMS_MAX_PAGES = 5; // safety cap against a runaway cursor

/**
 * Fetch current live streams for the given broadcaster ids, paging through
 * /streams (`first=100` + cursor) so large live counts are never truncated.
 *
 * Distinguishes "confirmed nobody is live" (`[]`) from "lookup failed"
 * (`null`): callers MUST treat null as unknown state, never as offline.
 *
 * @param {string[]} broadcasterIds
 * @returns {Promise<Array<object>|null>} Helix stream objects (id, user_id,
 *   user_login, game_name, title, started_at, viewer_count, thumbnail_url),
 *   or null when the lookup could not be completed.
 */
async function fetchStreams(broadcasterIds) {
  const ids = [...new Set((broadcasterIds || []).filter(Boolean))];
  if (!ids.length) return [];

  const streams = [];
  let cursor = null;
  for (let page = 0; page < STREAMS_MAX_PAGES; page += 1) {
    const query = { user_id: ids.join(","), first: STREAMS_PAGE_SIZE };
    if (cursor) query.cursor = cursor;
    const body = await helixGet("/streams", query);
    // helixGet returns null on any failure; a missing/non-array `data`
    // also means the response was unusable. Fail loud, not silent.
    if (!body || !Array.isArray(body.data)) return null;
    streams.push(...body.data);
    cursor = body.pagination?.cursor || null;
    if (!cursor) return streams;
  }
  console.warn(
    `[twitch] /streams pagination hit the ${STREAMS_MAX_PAGES}-page cap; returning partial results`,
  );
  return streams;
}

// ---- EventSub webhook subscription management (app access token) ----

/**
 * Create a webhook EventSub subscription for one broadcaster.
 * @param {{ type: string, version?: string, condition: object,
 *   callback: string, secret: string }} opts
 *   condition is e.g. { broadcaster_user_id } ; callback must be HTTPS:443.
 * @returns {Promise<{ ok: boolean, conflict?: boolean, status: number,
 *   subscription?: object, error?: string }>}
 *   ok=true on 202/200 (webhook is verification-pending until Twitch's
 *   challenge round-trip completes). conflict=true on 409 (already exists —
 *   treat as success). error carries a Twitch/HTTP reason otherwise.
 */
async function createEventsubSubscription({
  type,
  version = "1",
  condition,
  callback,
  secret,
}) {
  const res = await helixRequest("POST", "/eventsub/subscriptions", {
    body: {
      type,
      version,
      condition,
      transport: { method: "webhook", callback, secret },
    },
  });
  if (!res) return { ok: false, status: 0, error: "network error" };
  const sub = res.body?.data?.[0] ?? undefined;
  if (res.status === 409) {
    return { ok: true, conflict: true, status: 409, subscription: sub };
  }
  if (res.status >= 200 && res.status < 300) {
    return { ok: true, status: res.status, subscription: sub };
  }
  const reason = res.body?.message || res.body?.error || `HTTP ${res.status}`;
  return { ok: false, status: res.status, error: reason, subscription: sub };
}

/**
 * Delete an EventSub subscription by its Twitch subscription id.
 * @returns {Promise<{ ok: boolean, status: number, gone?: boolean }>}
 *   gone=true on 404 (already deleted elsewhere — treat as success).
 */
async function deleteEventsubSubscription(subscriptionId) {
  const id = String(subscriptionId || "").trim();
  if (!id) return { ok: false, status: 0, error: "no id" };
  const res = await helixRequest("DELETE", "/eventsub/subscriptions", {
    query: { id },
  });
  if (!res) return { ok: false, status: 0 };
  if (res.status === 404) return { ok: true, status: 404, gone: true };
  return { ok: res.status >= 200 && res.status < 300, status: res.status };
}

/**
 * List current EventSub subscriptions (paged) so the reconciler can prune
 * orphans that exist on Twitch but are no longer wanted. A single failed
 * page aborts with what was collected so far (best-effort reconcile).
 * @param {{ status?: string, type?: string }} [filter]
 * @returns {Promise<Array<object>|null>}
 */
async function listEventsubSubscriptions(filter = {}) {
  const subs = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const query = { ...filter, first: "100" };
    if (cursor) query.cursor = cursor;
    const body = await helixGet("/eventsub/subscriptions", query);
    if (!body || !Array.isArray(body.data)) return subs.length ? subs : null;
    subs.push(...body.data);
    cursor = body.pagination?.cursor || null;
    if (!cursor) return subs;
  }
  return subs;
}

// ---- Clips + VODs (Helix polling — no EventSub topic exists) ----

/**
 * Clips for a broadcaster, newest-creation first is NOT guaranteed (Helix
 * returns them in descending view order), so callers filter by created_at
 * watermark, never by position. `startedAt`/`endedAt` are RFC3339 strings
 * bounding the clip creation time (this bounds the result set so the
 * view-order top-N still covers the whole window).
 *
 * @param {string} broadcasterId
 * @param {{ startedAt?: string, endedAt?: string, first?: number }} [opts]
 * @returns {Promise<Array<object>|null>} null = lookup failed (unknown),
 *   [] = confirmed no clips in the window.
 */
async function fetchClips(broadcasterId, opts = {}) {
  if (!broadcasterId) return [];
  const body = await helixGet("/clips", {
    broadcaster_id: broadcasterId,
    started_at: opts.startedAt || undefined,
    ended_at: opts.endedAt || undefined,
    first: opts.first || 100,
  });
  if (!body || !Array.isArray(body.data)) return null;
  return body.data;
}

/**
 * Archive VODs for a broadcaster (Get Videos uses `user_id=` for the
 * broadcaster id, unlike Get Clips' `broadcaster_id=` — Helix quirk).
 * Returns newest-created first (default sort=time) so a created_at watermark
 * can stop at the first known video.
 *
 * @param {string} broadcasterId
 * @param {{ first?: number }} [opts]
 * @returns {Promise<Array<object>|null>} null = lookup failed, [] = none.
 */
async function fetchArchives(broadcasterId, opts = {}) {
  if (!broadcasterId) return [];
  const body = await helixGet("/videos", {
    user_id: broadcasterId,
    type: "archive",
    sort: "time",
    first: opts.first || 20,
  });
  if (!body || !Array.isArray(body.data)) return null;
  return body.data;
}

// ---- token cache (module-level, overridable for tests) ----

let tokenCache = { token: null, expiresAt: 0 };

function getAppTokenCache() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache;
  }
  return null;
}

function setAppTokenCache(token, expiresAt) {
  tokenCache = { token, expiresAt };
}

function clearAppTokenCache() {
  tokenCache = { token: null, expiresAt: 0 };
}

/**
 * RFC3339 → epoch ms (tolerant of Twitch's nanosecond timestamps: Date.parse
 * handles the truncation). null for empty/unparseable input.
 * @param {string|number|null|undefined} value
 * @returns {number|null}
 */
function parseTwitchTimestamp(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

module.exports = {
  describeError,
  expandThumbnailUrl,
  parseTwitchTimestamp,
  getAppToken,
  helixGet,
  helixRequest,
  resolveTwitchUser,
  fetchStreams,
  createEventsubSubscription,
  deleteEventsubSubscription,
  listEventsubSubscriptions,
  fetchClips,
  fetchArchives,
  clearAppTokenCache,
};
