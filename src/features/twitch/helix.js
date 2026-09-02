const { URL } = require("url");

const HELIX_BASE = "https://api.twitch.tv/helix";
const FETCH_TIMEOUT_MS = 15_000;

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
    console.error("[twitch] Token request failed:", err?.name || err?.message || err);
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
 * Generic Helix GET with app token.
 * @param {string} path e.g. "/streams"
 * @param {object} [query]
 * @returns {Promise<object|null>} parsed JSON body, or null on any failure
 */
async function helixGet(path, query = {}) {
  const token = await getAppToken();
  if (!token) return null;

  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(query).filter(([, v]) => v != null && v !== ""),
    ),
  ).toString();
  const url = `${HELIX_BASE}${path}${qs ? `?${qs}` : ""}`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        "Client-Id": process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`[twitch] Helix ${path} failed:`, err?.name || err?.message || err);
    return null;
  }

  if (!res.ok) {
    console.error(`[twitch] Helix ${path} returned ${res.status}`);
    return null;
  }

  return res.json().catch(() => null);
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

/**
 * Fetch current streams for up to 100 broadcaster ids.
 * @param {string[]} broadcasterIds
 * @returns {Promise<Array<object>>} Helix stream objects (id, user_id, user_login, game_name, title, started_at, viewer_count, thumbnail_url)
 */
async function fetchStreams(broadcasterIds) {
  if (!broadcasterIds.length) return [];
  const body = await helixGet("/streams", { user_id: broadcasterIds.join(",") });
  return body?.data || [];
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

module.exports = {
  getAppToken,
  helixGet,
  resolveTwitchUser,
  fetchStreams,
  clearAppTokenCache,
};
