/**
 * Discord login / logout route logic (roadmap/web-admin.md §8.3 login flow,
 * §8.8 Phase 0b).
 *
 * Flow:
 *  1. GET /auth/login — mint a purpose-tagged signed state (`web_login`) and
 *     302 to Discord's authorize URL (scopes identify guilds
 *     guilds.members.read, prompt configurable, default consent).
 *  2. GET /auth/login/callback — verify state (signature + expiry + single-
 *     use nonce + purpose === 'web_login': a command-permissions state can
 *     never be replayed here and vice-versa), exchange the code (form-
 *     urlencoded + Basic, live docs), fetch /users/@me + /users/@me/guilds,
 *     intersect with the BOT's guilds (the `guilds` scope returns ALL user
 *     guilds — Discord never filters by bot presence), ROTATE the session
 *     id (kills any anonymous/pre-login id), store the encrypted AT +
 *     metadata + guild snapshot on the new row, Set-Cookie the new opaque
 *     id, 302 to '/' (or '/g/:guildId' when a return target was signed in
 *     the state).
 *  3. POST /auth/logout — destroy the row, clear the cookie, 302 '/'.
 *
 * Everything injectable (discord API, bot-guild provider, session policy,
 * token crypto, state) so tests fake Discord entirely offline.
 *
 * Response style: raw `res.writeHead()/res.end()` only, matching the Phase
 * 0a byte-parity convention of this app (no Express res.send framing).
 */

const {
  createOAuthState,
  verifyOAuthState,
  PURPOSES,
} = require("../../features/commandPermissions/oauthState");
const { getWebLoginConfig } = require("../config");
const { createDiscordApi } = require("./discordApi");
const { getBotGuildIds } = require("./botGuilds");
const { encryptAccessToken } = require("./tokens");
const sessionPolicy = require("./sessions");
const { setWebSessionAuth } = require("../../db");

/** Snowflake-shaped guild ids only; anything else is dropped (never echoed). */
const GUILD_TARGET_RE = /^[0-9]{5,20}$/;
/** §8.11/docs: /users/@me/guilds returns ≤200 entries; hard-cap the snapshot. */
const MAX_SNAPSHOT_GUILDS = 200;
const MAX_TAG_LEN = 64;
const MAX_NAME_LEN = 100;

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Minimal auth-page shell (same visual family as the command-permissions
 * callback). Content is static text + escaped values only — never state,
 * code, or token material (§8.7).
 * @param {string} title
 * @param {string} bodyHtml
 * @param {boolean} ok
 * @returns {string}
 */
function authPage(title, bodyHtml, ok) {
  const color = ok ? "#57f287" : "#ed4245";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #313338; color: #dbdee1;
      display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
    .card { background: #2b2d31; border-radius: 8px; padding: 2rem; max-width: 28rem;
      box-shadow: 0 8px 24px rgba(0,0,0,.4); }
    h1 { font-size: 1.25rem; margin: 0 0 0.75rem; color: ${color}; }
    p { margin: 0.5rem 0; line-height: 1.45; }
    a { color: #00a8fc; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    ${bodyHtml}
  </div>
</body>
</html>`;
}

/**
 * Redirect with optional Set-Cookie + no-store/no-referrer (auth pages,
 * §8.7).
 * @param {import("http").ServerResponse} res
 * @param {string} location
 * @param {string} [setCookie]
 */
function respondRedirect(res, location, setCookie) {
  const headers = {
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  res.writeHead(302, headers);
  res.end();
}

/**
 * @param {import("http").ServerResponse} res
 * @param {number} status
 * @param {string} html
 */
function respondHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(html);
}

const INVALID_LINK_HTML = authPage(
  "Login link invalid",
  `<p>This login link is invalid, expired, or already used. Start again —
   <a href="/auth/login">Log in with Discord</a>.</p>`,
  false
);

/**
 * Signed `?guild=` return target from the raw URL (optional, snowflake
 * only). Never trusted beyond re-emitting `/g/:guildId` post-verification —
 * the value is HMAC-bound to the state, so the callback's redirect target
 * can never be attacker-chosen (no open redirect).
 * @param {URL} url
 * @returns {string|null}
 */
function readGuildTarget(url) {
  const raw = url.searchParams.get("guild");
  return raw && GUILD_TARGET_RE.test(raw) ? raw : null;
}

/**
 * Display-name snapshot for the session row (v10: global_name ?? username).
 * @param {{ global_name?: string|null, username?: string|null }} user
 * @returns {string|null}
 */
function readDiscordTag(user) {
  const tag = user?.global_name ?? user?.username ?? null;
  if (typeof tag !== "string") return null;
  const trimmed = tag.trim();
  return trimmed ? trimmed.slice(0, MAX_TAG_LEN) : null;
}

/**
 * bot ∩ user guild intersection + shape trim for the session snapshot
 * (§8.3: "guild must ALSO have the bot"). `owner`/`permissions` are kept:
 * they are ONLY sent by /users/@me/guilds and are the cheapest MANAGE_GUILD
 * gate inputs for guildAccess (subtask 07) — permissions stays a DECIMAL
 * STRING here (BigInt territory; do not Number.parse it).
 *
 * @param {Array<{id?: unknown, name?: unknown, icon?: unknown, owner?: unknown, permissions?: unknown}>} userGuilds
 * @param {Set<string>} botGuildIds
 * @returns {Array<{id: string, name: string|null, icon: string|null, owner: boolean, permissions: string}>}
 */
function buildGuildSnapshot(userGuilds, botGuildIds) {
  return userGuilds
    .filter(
      (g) => g && typeof g.id === "string" && g.id && botGuildIds.has(g.id)
    )
    .slice(0, MAX_SNAPSHOT_GUILDS)
    .map((g) => ({
      id: g.id,
      name:
        typeof g.name === "string" ? g.name.slice(0, MAX_NAME_LEN) : null,
      icon: typeof g.icon === "string" ? g.icon.slice(0, MAX_NAME_LEN) : null,
      owner: g.owner === true,
      permissions:
        typeof g.permissions === "string" && g.permissions ? g.permissions : "0",
    }));
}

/**
 * Build the three login-route handlers with injected dependencies.
 *
 * @param {object} [options]
 * @param {string} [options.apiBase] Discord REST base (tests: fake server)
 * @param {string} [options.oauthBase] authorize base (tests: fake server)
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => string[]|Set<string>|Promise<string[]|Set<string>>} [options.botGuilds]
 *   bot guild ids; defaults to the wired provider (features/web boot)
 * @param {typeof import("./discordApi")["createDiscordApi"]} [options.discordApiFactory]
 * @param {object} [options.stateApi] { createOAuthState, verifyOAuthState, PURPOSES }
 * @param {object} [options.sessionApi] session policy overrides (tests)
 * @param {object} [options.tokenApi] { encryptAccessToken } override
 * @param {{ setWebSessionAuth: Function }} [options.store]
 * @returns {{
 *   startLogin: Function,
 *   handleLoginCallback: Function,
 *   logout: Function,
 * }}
 */
function createLoginHandlers(options = {}) {
  const discord = options.discordApi
    || (options.discordApiFactory || createDiscordApi)({
      apiBase: options.apiBase,
      oauthBase: options.oauthBase,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
  const botGuilds = options.botGuilds || getBotGuildIds;
  const stateApi = options.stateApi || {
    createOAuthState,
    verifyOAuthState,
    PURPOSES,
  };
  const sessions = options.sessionApi || sessionPolicy;
  const tokenApi = options.tokenApi || { encryptAccessToken };
  const store = options.store || { setWebSessionAuth };

  /**
   * GET /auth/login — authorize redirect.
   * @param {import("http").IncomingMessage & { webSession?: object|null }} req
   * @param {import("http").ServerResponse} res
   */
  function startLogin(req, res) {
    // RATE LIMIT: supplied by middleware/rateLimit.js via app.js's
    // app.use("/auth", createAuthRateLimit()) — per-IP + per-user buckets
    // over every /auth/* request (§8.7). Handlers stay limiter-agnostic.
    const cfg = getWebLoginConfig();
    if (!cfg.ready) {
      console.warn(
        `[web] /auth/login: OAuth not configured (missing ${cfg.missing.join(", ")})`
      );
      respondHtml(
        res,
        503,
        authPage("Login unavailable", "<p>Web login is not configured on this bot.</p>", false)
      );
      return;
    }

    const url = new URL(req.url || "/", "http://web.local");
    const state = stateApi.createOAuthState({
      purpose: stateApi.PURPOSES.WEB_LOGIN,
      guildId: readGuildTarget(url) || undefined,
    });
    respondRedirect(
      res,
      discord.buildAuthorizeUrl({
        clientId: cfg.clientId,
        redirectUri: cfg.redirectUri,
        scopes: cfg.scopes,
        state,
        prompt: cfg.prompt,
      })
    );
  }

  /**
   * GET /auth/login/callback — state verify → code exchange → session
   * rotation + encrypted AT + guild snapshot → Set-Cookie + redirect.
   * @param {import("http").IncomingMessage & { webSession?: object|null, user?: object|null }} req
   * @param {import("http").ServerResponse} res
   * @returns {Promise<void>}
   */
  async function handleLoginCallback(req, res) {
    // RATE LIMIT: same /auth/* limiter as startLogin (subtask 08); the
    // per-user slot activates once we publish req.rateLimitUserHint below.
    const url = new URL(req.url || "/", "http://web.local");

    const errorParam = url.searchParams.get("error");
    if (errorParam) {
      // User denied (or Discord errored the redirect) — no session changes.
      respondHtml(
        res,
        400,
        authPage(
          "Login cancelled",
          `<p>Discord reported <code>${escapeHtml(errorParam)}</code>.
           <a href="/auth/login">Try again</a>.</p>`,
          false
        )
      );
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      respondHtml(res, 400, INVALID_LINK_HTML);
      return;
    }

    const verified = stateApi.verifyOAuthState(state);
    if (!verified || verified.purpose !== stateApi.PURPOSES.WEB_LOGIN) {
      // Wrong-purpose replay (e.g. a cmd_perms state pointed here) burns its
      // nonce during verify and is then rejected — no cross-flow
      // substitution in either direction (§8.3).
      console.warn("[web] login callback: state rejected (invalid, expired, reused, or wrong purpose)");
      respondHtml(res, 400, INVALID_LINK_HTML);
      return;
    }

    const cfg = getWebLoginConfig();
    if (!cfg.ready) {
      // Config vanished mid-flight (rotated secret / env reload) — fail closed.
      console.warn("[web] login callback: OAuth config incomplete at exchange time");
      respondHtml(
        res,
        500,
        authPage("Login failed", "<p>The bot could not complete the login. Try again.</p>", false)
      );
      return;
    }

    try {
      const tok = await discord.exchangeCode({
        code,
        redirectUri: cfg.redirectUri, // byte-identical to authorize (docs rule)
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
      });

      const user = await discord.getCurrentUser(tok.accessToken);
      const userId =
        user && typeof user.id === "string" && GUILD_TARGET_RE.test(user.id)
          ? user.id
          : null;
      if (!userId) {
        const err = new Error("discord /users/@me returned no usable user id");
        err.code = "discord_user_shape";
        throw err;
      }
      // Contract with middleware/rateLimit.js userKey(): publish the id now
      // that the exchange revealed it (per-user login bucket, §8.7).
      req.rateLimitUserHint = userId;

      const userGuilds = await discord.getUserGuilds(tok.accessToken);
      const botGuildIds = new Set(await botGuilds());
      const snapshot = buildGuildSnapshot(userGuilds, botGuildIds);

      // §8.3: login ALWAYS rotates — an anonymous (or stale) session id in
      // the cookie is destroyed here, so a pre-login cookie can never be
      // promoted or reused.
      const session = sessions.rotateSession(req.webSession || null, {
        userId,
        discordTag: readDiscordTag(user),
      });

      store.setWebSessionAuth(session.id, {
        accessTokenEnc: tokenApi.encryptAccessToken(tok.accessToken),
        tokenExpiresAt: tok.expiresAt,
        scopes: tok.scopes,
        guildSnapshot: JSON.stringify(snapshot),
      });

      const location = verified.guildId
        ? `/g/${encodeURIComponent(verified.guildId)}`
        : "/";
      respondRedirect(res, location, sessions.buildSessionCookie(session.id));
    } catch (err) {
      // Static log line: codes/messages only — never codes, tokens, or
      // envelope material (§8.7).
      console.error(
        "[web] login callback failed:",
        err?.code || err?.message || "unknown_error"
      );
      respondHtml(
        res,
        500,
        authPage(
          "Login failed",
          `<p>Discord login could not be completed.
           <a href="/auth/login">Try again</a>.</p>`,
          false
        )
      );
    }
  }

  /**
   * POST /auth/logout — destroy row + clear cookie (idempotent for anon).
   * @param {import("http").IncomingMessage & { webSession?: object|null }} req
   * @param {import("http").ServerResponse} res
   */
  function logout(req, res) {
    // CSRF: enforced UPSTREAM by middleware/csrf.js (subtask 08), which
    // auto-gates non-GET requests under /auth/ and /g/ for requests that
    // HAVE a session (double-submit token). Anonymous logouts pass the
    // guard (nothing to protect) and land here as an idempotent no-op.
    if (req.webSession) {
      try {
        sessions.destroySession(req.webSession.id);
      } catch (err) {
        console.warn("[web] logout: session destroy failed:", err?.message || err);
      }
    }
    respondRedirect(res, "/", sessions.buildClearSessionCookie());
  }

  return { startLogin, handleLoginCallback, logout };
}

module.exports = {
  createLoginHandlers,
  // exported for unit tests / subtask 07 guildAccess input contract:
  buildGuildSnapshot,
  readDiscordTag,
  GUILD_TARGET_RE,
  MAX_SNAPSHOT_GUILDS,
};
