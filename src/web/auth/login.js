/**
 * Discord login / logout route logic (roadmap/web-admin.md §8.3 login flow,
 * §8.8 Phase 0b).
 *
 * Flow:
 *  1. GET /auth/login — the PUBLIC sign-in landing (200): explains the
 *     console and what signing in grants; OAuth never fires from a bare
 *     GET (user-feedback fix: visitors used to bounce straight into
 *     Discord's consent screen with zero context). Only
 *     GET /auth/login?continue=1 mints a purpose-tagged signed state
 *     (`web_login`) and 302s to Discord's authorize URL (scopes identify
 *     guilds guilds.members.read, prompt configurable, default consent).
 *     ?guild= / ?next= return targets ride the landing → continue link →
 *     state unchanged (same whitelists as before).
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
 *  3. POST /auth/logout — destroy the row, clear the cookie, 302 to the
 *     signed-out landing ('/auth/login?signedout=1').
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
  STATE_TTL_MS,
  PURPOSES,
} = require("../../features/commandPermissions/oauthState");
const { getWebLoginConfig, getHttpConfig } = require("../config");
const {
  renderSignInPage,
  buildContinueHref,
} = require("../views/landing");
const { createDiscordApi } = require("./discordApi");
const { getBotGuildIds } = require("./botGuilds");
const { encryptAccessToken } = require("./tokens");
const sessionPolicy = require("./sessions");
const { setWebSessionAuth } = require("../../db");
// Fluxer web login (roadmap/fluxer.md § PKCE and state / PR 10) — additive:
// every Discord function below is untouched. The transactions repo opens the
// DB facade (src/db), which runs migrations on load; requiring it AFTER
// ../../db above keeps the migration-first ordering for standalone consumers.
const {
  createOAuthTransaction,
  consumeOAuthTransaction,
} = require("../../db/repositories/fluxerOAuthTransactions");
const { createFluxerApi, fluxerInstanceSlug } = require("./fluxerApi");
const { getCommunityByExternal } = require("../../platform/community");
const crypto = require("crypto");

/** Snowflake-shaped guild ids only; anything else is dropped (never echoed). */
const { URL_ID_RE: GUILD_TARGET_RE } = require("../shared/snowflake");
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
 * Post-logout destination: the sign-in landing with the signed-out banner.
 * A fixed constant path (never derived from the request) — no open redirect,
 * and no bounce back into OAuth the way '/' used to immediately re-trigger.
 * Shared by every clean-logout responder (routes/sessions.js,
 * routes/system.js keep byte-parity with POST /auth/logout).
 */
const SIGNED_OUT_TARGET = "/auth/login?signedout=1";

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
 * §8.15-15.13 ticket return paths. Participants (people with access to
 * ONE ticket, no console role) arrive on /t/{token}, bounce to login, and
 * must land back ON THAT URL — "/" is the staff home and a dead end for
 * them. The whitelist is a FIXED shape (never a prefix rule): the archive
 * index or one transcript URL; no /g/ paths (a participant hitting one
 * would 404 — the point of the trip is the ticket, not the console).
 * Minted from the ticket gate's own request path, so the value is never
 * attacker-chosen; the callback re-verifies it against this same regex.
 */
const TICKET_NEXT_RE =
  /^\/t(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?(?:\/raw)?$/i;

/** @param {URL} url @returns {string|null} */
function readNextTarget(url) {
  const raw = url.searchParams.get("next");
  return raw && TICKET_NEXT_RE.test(raw) ? raw : null;
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
 * @param {() => Array<{ instanceKey: string, slug?: string, label?: string,
 *   clientId: string|null, clientSecret: string|null }>} [options.getFluxerWebInstances]
 *   Fluxer instance list for the landing page's per-instance buttons
 *   (roadmap/fluxer.md § Authorize URL: one button per instance with OAuth
 *   credentials); absent/empty → Discord-only landing (today's behavior).
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
  const getFluxerWebInstances = options.getFluxerWebInstances || null;

  /**
   * GET /auth/login — public sign-in landing; GET /auth/login?continue=1 —
   * the authorize redirect. The landing fires NO OAuth: it explains the
   * console and hands out one whitelisted continue link, so "what am I
   * signing in for" is answered before Discord ever sees the visitor
   * (user-feedback fix — the old behavior bounced straight to the consent
   * screen, and logout snapped right back into it).
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
    // Whitelisted return targets (snowflake / ticket-path regexes only).
    // The landing renders enum context flags — never the raw values — and
    // re-encodes the validated pair into its single continue href, so the
    // state below receives exactly what it used to.
    const guildTarget = readGuildTarget(url);
    const nextTarget = readNextTarget(url);

    if (url.searchParams.get("continue") !== "1") {
      // One landing button per Fluxer instance with OAuth credentials
      // (roadmap/fluxer.md § Authorize URL: "For each configured instance
      // that has clientId and clientSecret, the home page shows one button").
      // A broken provider must never take the public landing down — a
      // credential-less Fluxer block degrades to the Discord-only page.
      let fluxerLoginLinks = [];
      if (getFluxerWebInstances) {
        try {
          fluxerLoginLinks = (getFluxerWebInstances() || [])
            .filter(
              (inst) => inst && inst.instanceKey && inst.clientId && inst.clientSecret
            )
            .map((inst) => ({
              slug:
                typeof inst.slug === "string" && inst.slug
                  ? inst.slug
                  : fluxerInstanceSlug(inst.instanceKey),
              label: inst.label || inst.instanceKey,
            }));
        } catch (err) {
          console.warn(
            "[web] /auth/login: Fluxer instance list failed:",
            err?.message || err
          );
        }
      }
      respondHtml(
        res,
        200,
        String(
          renderSignInPage({
            notice: url.searchParams.get("signedout") === "1" ? "signedout" : null,
            context: nextTarget ? "ticket" : guildTarget ? "guild" : null,
            continueHref: buildContinueHref({
              guild: guildTarget,
              next: nextTarget,
            }),
            fluxerLoginLinks,
          })
        )
      );
      return;
    }

    const state = stateApi.createOAuthState({
      purpose: stateApi.PURPOSES.WEB_LOGIN,
      guildId: guildTarget || undefined,
      next: nextTarget || undefined,
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

      // Destination priority (§8.15-15.13): signed ticket next — RE-
      // checked against the whitelist here (defense in depth: a forged or
      // tampered state can never name a non-ticket path) — then the signed
      // guild return target, then home. `logged-in=1` lets the transcript
      // acknowledge the sign-in exactly once.
      const nextPath =
        verified.next && TICKET_NEXT_RE.test(verified.next)
          ? verified.next
          : null;
      const location = nextPath
        ? `${nextPath}${nextPath.includes("?") ? "&" : "?"}logged-in=1`
        : verified.guildId
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
    respondRedirect(res, SIGNED_OUT_TARGET, sessions.buildClearSessionCookie());
  }

  return { startLogin, handleLoginCallback, logout };
}

// ---------------------------------------------------------------------------
// Fluxer web login (roadmap/fluxer.md § Authorize URL, § PKCE and state,
// PR 10). ADDITIVE: every Discord function above is byte-identical, uses the
// `web_session` cookie, and never enters this section; the Fluxer flow reads
// and writes ONLY `web_session_fx` (K11).
// ---------------------------------------------------------------------------

/** Route-slug shape: the 16-hex SHA-256 prefix of a normalized instanceKey. */
const FLUXER_SLUG_RE = /^[0-9a-f]{16}$/;
/**
 * Fluxer OAuth scopes (spec § Authorize URL): `identify` + `guilds` ONLY.
 * Never `guilds.members.read` (not in the registry — fails the grant), never
 * email/connections/bot.
 */
const FLUXER_SCOPES = Object.freeze(["identify", "guilds"]);
/** Transaction ceiling independent of state expiry: min(state exp, +10 min). */
const FLUXER_TX_LIFETIME_MS = 10 * 60 * 1000;
/** Cap for the OAuth error code echoed on the failure page (defense in depth). */
const MAX_ERROR_CODE_LEN = 64;

/**
 * Redirect URI for one Fluxer instance, derived from the SAME public base URL
 * the Discord flow uses (`getHttpConfig().publicBaseUrl`), so authorize and
 * exchange can rebuild it byte-identically (docs rule, getLoginRedirectUri
 * precedent — this is the fluxer-specific twin).
 * @param {string} slug 16-hex instance slug
 * @param {string} publicBaseUrl
 * @returns {string}
 */
function buildFluxerRedirectUri(slug, publicBaseUrl) {
  return `${String(publicBaseUrl).replace(/\/+$/, "")}/auth/fluxer/${slug}/callback`;
}

/**
 * Safe single-token identifier for failure pages: machine error CODES only
 * (`invalid_grant`, `fluxer_token_shape`, …). Never `error_description`,
 * tokens, state, codes, or verifier material (§8.7; spec: "render the page
 * showing ONLY the error code").
 * @param {unknown} err
 * @returns {string|null}
 */
function fluxerErrorToken(err) {
  const raw = typeof err?.oauthError === "string" ? err.oauthError
    : typeof err?.code === "string" ? err.code
      : null;
  if (!raw) return null;
  return raw.slice(0, MAX_ERROR_CODE_LEN);
}

/**
 * Build the three Fluxer login-route handlers with injected dependencies.
 * Mirrors {@link createLoginHandlers}' injection pattern so tests fake a
 * Fluxer instance entirely offline; production wires the getters from
 * features/web (C12).
 *
 * @param {object} [options]
 * @param {() => Array<{ instanceKey: string, slug?: string, label?: string,
 *   clientId: string|null, clientSecret: string|null, apiBase?: string|null }>} [options.fluxerInstances]
 *   configured instances; slug is computed here when the provider omits it
 * @param {(communityId: number) => { fetchGuild: Function }|null} [options.getCommunityClient]
 *   outbound client for a community (visibility confirmation of guild rows);
 *   default: no clients (id-only snapshot rows — the sanctioned fallback)
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(apiBase: string) => object} [options.apiFactory]
 * @param {object} [options.stateApi] { createOAuthState, verifyOAuthState, PURPOSES }
 * @param {object} [options.sessionApi] session policy (tests) — must expose
 *   rotateSession/destroySession/buildFluxerSessionCookie/buildClearFluxerSessionCookie
 * @param {object} [options.tokenApi] { encryptAccessToken } override
 * @param {{ setWebSessionAuth: Function, createOAuthTransaction: Function,
 *   consumeOAuthTransaction: Function }} [options.store]
 * @returns {{
 *   startFluxerLogin: Function,
 *   handleFluxerLoginCallback: Function,
 *   fluxerLogout: Function,
 * }}
 */
function createFluxerLoginHandlers(options = {}) {
  const fluxerInstances = options.fluxerInstances || (() => []);
  const getCommunityClient = options.getCommunityClient || (() => null);
  const apiFactory =
    options.apiFactory
    || ((apiBase) =>
      createFluxerApi({ apiBase, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs }));
  const stateApi = options.stateApi || {
    createOAuthState,
    verifyOAuthState,
    PURPOSES,
  };
  const sessions = options.sessionApi || sessionPolicy;
  const tokenApi = options.tokenApi || { encryptAccessToken };
  const store = options.store || {
    setWebSessionAuth,
    createOAuthTransaction,
    consumeOAuthTransaction,
  };

  /**
   * Resolve a login URL slug to its configured instance. Prefers a provider
   * slug (features/web precomputes them), falls back to deriving it — so the
   * route works with the plain parseFluxerInstances shape too.
   * @param {string} slug
   * @returns {object|null}
   */
  function findFluxerInstance(slug) {
    let instances;
    try {
      instances = fluxerInstances() || [];
    } catch (err) {
      console.warn(
        "[web] fluxer login: instance list failed:",
        err?.message || err
      );
      return null;
    }
    for (const inst of instances) {
      if (!inst || !inst.instanceKey) continue;
      const instSlug =
        typeof inst.slug === "string" && inst.slug
          ? inst.slug
          : fluxerInstanceSlug(inst.instanceKey);
      if (instSlug === slug) return inst;
    }
    return null;
  }

  /**
   * GET /auth/fluxer/:slug/login — mint the PKCE pair + signed state, write
   * the SQLite verifier row BEFORE the 302 (spec: the row lands first), and
   * redirect to this instance's authorize URL. `?guild=` / `?next=` ride the
   * state exactly like the Discord flow (same whitelists).
   * @param {import("http").IncomingMessage & { params?: { slug?: string } }} req
   * @param {import("http").ServerResponse} res
   */
  function startFluxerLogin(req, res) {
    // RATE LIMIT: same /auth/* limiter as the Discord routes (prefix mount in
    // app.js) — handlers stay limiter-agnostic.
    try {
      const slug =
        typeof req.params?.slug === "string" ? req.params.slug : "";
      const instance = FLUXER_SLUG_RE.test(slug) ? findFluxerInstance(slug) : null;
      if (!instance) {
        // Unknown slug: the link was never minted by this deployment. 404 —
        // there is nothing to "log in" to.
        respondHtml(
          res,
          404,
          authPage("Unknown login", "<p>This login link is not configured.</p>", false)
        );
        return;
      }

      const publicBaseUrl = getHttpConfig().publicBaseUrl;
      const missing = [];
      if (!instance.clientId) missing.push("clientId");
      if (!instance.clientSecret) missing.push("clientSecret");
      if (!instance.apiBase) missing.push("apiBase (discovery)");
      if (!publicBaseUrl) missing.push("PUBLIC_BASE_URL");
      if (missing.length > 0) {
        // Names only — never values (§8.7, startLogin's 503 pattern).
        console.warn(
          `[web] fluxer login: instance ${instance.instanceKey} not configured (missing ${missing.join(", ")})`
        );
        respondHtml(
          res,
          503,
          authPage(
            "Login unavailable",
            `<p>Fluxer login for <code>${escapeHtml(String(instance.instanceKey))}</code>
             is not configured on this bot (missing: ${escapeHtml(missing.join(", "))}).</p>`,
            false
          )
        );
        return;
      }

      const url = new URL(req.url || "/", "http://web.local");
      const guildTarget = readGuildTarget(url);
      const nextTarget = readNextTarget(url);

      // PKCE (spec § PKCE and state): 32 random bytes base64url ⇒ exactly 43
      // URL-safe chars, no padding; S256 is the only method. The verifier is
      // NEVER put in the URL, the state, a log, or `usedNonces`.
      const codeVerifier = crypto.randomBytes(32).toString("base64url");
      const codeChallenge = crypto
        .createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");
      // The nonce keys the verifier row INSIDE the signed state (C1).
      const nonce = crypto.randomBytes(16).toString("hex");
      const state = stateApi.createOAuthState({
        purpose: stateApi.PURPOSES.WEB_LOGIN_FLUXER,
        nonce,
        guildId: guildTarget || undefined,
        next: nextTarget || undefined,
      });
      // Our own mint sets the expiry: createOAuthState defaults to now+TTL.
      const stateExp = Date.now() + STATE_TTL_MS;

      // Write the transaction row BEFORE the 302 (spec § PKCE and state).
      store.createOAuthTransaction({
        nonce,
        codeVerifier,
        instanceKey: instance.instanceKey,
        expiresAt: Math.min(stateExp, Date.now() + FLUXER_TX_LIFETIME_MS),
      });

      const api = apiFactory(instance.apiBase);
      respondRedirect(
        res,
        api.buildAuthorizeUrl({
          clientId: instance.clientId,
          redirectUri: buildFluxerRedirectUri(slug, publicBaseUrl),
          scopes: FLUXER_SCOPES,
          state,
          prompt: "consent",
          codeChallenge,
        })
      );
    } catch (err) {
      // Log the CODE/message only — codes, state, and tokens never (spec).
      console.error(
        "[web] fluxer login failed:",
        err?.code || err?.message || "unknown_error"
      );
      respondHtml(
        res,
        500,
        authPage(
          "Login failed",
          "<p>Fluxer login could not be started. <a href=\"/auth/login\">Try again</a>.</p>",
          false
        )
      );
    }
  }

  /**
   * GET /auth/fluxer/:slug/callback — verify state (purpose
   * `web_login_fluxer`), CONSUME the transaction row (DELETE…RETURNING —
   * single use), exchange the code with the stored verifier, read identity +
   * guilds, ROTATE the Fluxer session, store the encrypted token pair +
   * snapshot, Set-Cookie `web_session_fx`, redirect.
   * @param {import("http").IncomingMessage & { params?: { slug?: string }, fluxerSession?: object|null }} req
   * @param {import("http").ServerResponse} res
   * @returns {Promise<void>}
   */
  async function handleFluxerLoginCallback(req, res) {
    try {
      const slug =
        typeof req.params?.slug === "string" ? req.params.slug : "";
      if (!FLUXER_SLUG_RE.test(slug)) {
        respondHtml(res, 400, INVALID_LINK_HTML);
        return;
      }

      const url = new URL(req.url || "/", "http://web.local");
      // Same shape guards as the Discord callback: missing pieces are 400,
      // never echoed.
      const errorParam = url.searchParams.get("error");
      if (errorParam) {
        // User denied (or the instance errored the redirect) — no session
        // changes. The OAuth error code is a safe token to echo.
        const shown = fluxerErrorToken({ oauthError: errorParam });
        respondHtml(
          res,
          400,
          authPage(
            "Login cancelled",
            `<p>Fluxer reported <code>${escapeHtml(shown || "an error")}</code>.
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
      if (!verified || verified.purpose !== stateApi.PURPOSES.WEB_LOGIN_FLUXER) {
        // Wrong-purpose replay (a Discord web_login or cmd_perms state pointed
        // here) is rejected — the purposes are not interchangeable (spec).
        console.warn(
          "[web] fluxer login callback: state rejected (invalid, expired, reused, or wrong purpose)"
        );
        respondHtml(res, 400, INVALID_LINK_HTML);
        return;
      }

      const instance = findFluxerInstance(slug);
      if (!instance || !instance.clientId || !instance.clientSecret || !instance.apiBase) {
        // The link was minted when the instance WAS configured; config
        // vanishing mid-flight fails closed (no exchange is possible).
        console.warn("[web] fluxer login callback: instance not configured at exchange time");
        respondHtml(res, 400, INVALID_LINK_HTML);
        return;
      }

      const publicBaseUrl = getHttpConfig().publicBaseUrl;
      if (!publicBaseUrl) {
        // Config vanished mid-flight (env reload) — exchange cannot be
        // byte-identical; fail closed like the Discord callback's 500.
        console.warn("[web] fluxer login callback: PUBLIC_BASE_URL unset at exchange time");
        respondHtml(
          res,
          500,
          authPage("Login failed", "<p>The bot could not complete the login. Try again.</p>", false)
        );
        return;
      }

      // CONSUME: single use enforced by the DELETE…RETURNING (runs on success
      // AND on every later failure — a failed exchange can never be retried
      // with the same code, and a replayed state finds zero rows).
      const tx = store.consumeOAuthTransaction(verified.nonce, Date.now());
      if (!tx) {
        console.warn("[web] fluxer login callback: login link expired or already used");
        respondHtml(res, 400, INVALID_LINK_HTML);
        return;
      }
      if (tx.instanceKey !== instance.instanceKey) {
        // A state minted for instance A cannot complete on instance B's URL.
        console.warn("[web] fluxer login callback: transaction instance mismatch");
        respondHtml(res, 400, INVALID_LINK_HTML);
        return;
      }

      const api = apiFactory(instance.apiBase);
      const tok = await api.exchangeCode({
        code,
        // Rebuilt from the same rule the authorize used — byte-identical.
        redirectUri: buildFluxerRedirectUri(slug, publicBaseUrl),
        clientId: instance.clientId,
        clientSecret: instance.clientSecret,
        codeVerifier: tx.codeVerifier,
      });

      const user = await api.getUserInfo(tok.accessToken);
      // Same id-shape guard as the Discord callback: `sub` must look like a
      // platform id (GUILD_TARGET_RE's digit class) before it becomes a key.
      const userId =
        user && typeof user.sub === "string" && GUILD_TARGET_RE.test(user.sub)
          ? user.sub
          : null;
      if (!userId) {
        const err = new Error("fluxer /oauth2/userinfo returned no usable user id");
        err.code = "fluxer_user_shape";
        throw err;
      }
      // Contract with middleware/rateLimit.js userKey(): publish the id now
      // that the exchange revealed it (per-user login bucket, §8.7).
      req.rateLimitUserHint = userId;

      // Guild snapshot (spec § Guild intersection): keep ONLY rows that map
      // to a communities row for THIS instance, then confirm bot visibility
      // via the outbound client (null drop; throw → keep + warn; no client →
      // keep id-only). Cap 200 via buildGuildSnapshot.
      const userGuilds = await api.listCurrentUserGuilds(tok.accessToken);
      const kept = [];
      for (const guildRow of userGuilds) {
        const gid =
          guildRow && typeof guildRow.id === "string" && guildRow.id
            ? guildRow.id
            : null;
        if (!gid) continue;
        let cid = null;
        try {
          cid = getCommunityByExternal("fluxer", instance.instanceKey, gid);
        } catch (err) {
          // Malformed external id (e.g. empty string past the guard) — the
          // row cannot key a community; drop it.
          console.warn(
            `[web] fluxer login: community lookup failed for guild ${escapeHtml(String(gid).slice(0, 32))}: ${err?.message || err}`
          );
          continue;
        }
        if (cid == null) continue; // not a community this bot serves on this instance
        let outbound = null;
        try {
          outbound = getCommunityClient(cid) || null;
        } catch (err) {
          console.warn(
            `[web] fluxer login: outbound client lookup failed for community ${cid}: ${err?.message || err}`
          );
        }
        if (outbound && typeof outbound.fetchGuild === "function") {
          try {
            const visible = await outbound.fetchGuild(gid);
            if (!visible) continue; // bot no longer sees the guild
          } catch (err) {
            // Fetch hiccup keeps the row (same fail-open-on-read stance as
            // the Discord degraded path); tier math re-checks live later.
            console.warn(
              `[web] fluxer guild visibility check failed: ${err?.message || err}`
            );
          }
        }
        kept.push(guildRow);
        if (kept.length >= MAX_SNAPSHOT_GUILDS) break;
      }
      // Identity set = the kept rows themselves (the communities table is the
      // bot's guild list for this instance).
      const snapshot = buildGuildSnapshot(
        kept,
        new Set(kept.map((g) => String(g.id)))
      );

      // §8.3 (shared with Fluxer, spec § Session columns): login ALWAYS
      // rotates the Fluxer session — a pre-login fluxer cookie is destroyed.
      // The Discord `web_session` row is NEVER touched (K11).
      const session = sessions.rotateSession(req.fluxerSession || null, {
        userId,
        discordTag: null,
        platform: "fluxer",
        instanceKey: instance.instanceKey,
        refreshExpiresAt: tok.refreshExpiresAt,
      });

      store.setWebSessionAuth(session.id, {
        accessTokenEnc: tokenApi.encryptAccessToken(tok.accessToken),
        tokenExpiresAt: tok.expiresAt,
        scopes: tok.scopes,
        guildSnapshot: JSON.stringify(snapshot),
        // Refresh pair rides along (spec § Token exchange and refresh); the
        // envelope is the same AES-256-GCM scheme — plaintext is never written.
        refreshTokenEnc: tok.refreshToken
          ? tokenApi.encryptAccessToken(tok.refreshToken)
          : null,
        refreshExpiresAt: tok.refreshExpiresAt,
      });

      // Destination priority mirrors the Discord callback exactly (§8.15):
      // signed ticket next (re-whitelisted), then the signed guild target,
      // then home. `logged-in=1` acknowledges the sign-in exactly once.
      const nextPath =
        verified.next && TICKET_NEXT_RE.test(verified.next)
          ? verified.next
          : null;
      const location = nextPath
        ? `${nextPath}${nextPath.includes("?") ? "&" : "?"}logged-in=1`
        : verified.guildId
          ? `/g/${encodeURIComponent(verified.guildId)}?logged-in=1`
          : "/";
      respondRedirect(res, location, sessions.buildFluxerSessionCookie(session.id));
    } catch (err) {
      // Static log line + page: CODES only — never codes, tokens, verifier,
      // state, or envelope material (§8.7; spec: show ONLY the error code).
      console.error(
        "[web] fluxer login failed:",
        err?.code || err?.message || "unknown_error"
      );
      const shown = fluxerErrorToken(err);
      respondHtml(
        res,
        500,
        authPage(
          "Login failed",
          `<p>Fluxer login could not be completed.
           ${shown ? `<p>Fluxer reported <code>${escapeHtml(shown)}</code>.</p>` : ""}
           <a href="/auth/login">Try again</a></p>`,
          false
        )
      );
    }
  }

  /**
   * POST /auth/fluxer/logout — destroy the FLUXER session row + clear
   * `web_session_fx`. Never reads, writes, or clears `web_session` (K11).
   * @param {import("http").IncomingMessage & { fluxerSession?: object|null }} req
   * @param {import("http").ServerResponse} res
   */
  function fluxerLogout(req, res) {
    // CSRF: enforced UPSTREAM by middleware/csrf.js (/auth scope), same as
    // the Discord logout; anonymous logouts are idempotent no-ops.
    if (req.fluxerSession) {
      try {
        sessions.destroySession(req.fluxerSession.id);
      } catch (err) {
        console.warn(
          "[web] fluxer logout: session destroy failed:",
          err?.message || err
        );
      }
    }
    respondRedirect(res, SIGNED_OUT_TARGET, sessions.buildClearFluxerSessionCookie());
  }

  return { startFluxerLogin, handleFluxerLoginCallback, fluxerLogout };
}

module.exports = {
  createLoginHandlers,
  // exported for unit tests / subtask 07 guildAccess input contract:
  buildGuildSnapshot,
  readDiscordTag,
  GUILD_TARGET_RE,
  MAX_SNAPSHOT_GUILDS,
  // clean-logout destination (sessions.js / system.js parity + tests):
  SIGNED_OUT_TARGET,
  // Fluxer web login (roadmap/fluxer.md PR 10; routes/auth.js + tests):
  createFluxerLoginHandlers,
  buildFluxerRedirectUri,
  FLUXER_SLUG_RE,
  FLUXER_SCOPES,
};
