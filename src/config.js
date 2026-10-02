/**
 * Process environment used by the bot.
 * Values are read where needed; this module documents the contract.
 *
 * Required:
 *   DISCORD_TOKEN  — bot token
 *   CLIENT_ID      — application id (slash registration)
 *
 * Optional:
 *   DEV_GUILD_ID   — register commands to one guild instantly
 *   DATA_DIR       — directory for xpbot.sqlite (default: project root)
 *   DB_PATH        — full path to sqlite file (wins over DATA_DIR)
 *   YOUTUBE_API_KEY — YouTube Data API (live detection / channel resolve)
 *   LAVALINK_HOST / LAVALINK_PORT / LAVALINK_PASSWORD — music player node
 *   SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET — Spotify catalog (LavaSrc)
 *   CLIENT_SECRET — Discord app secret (OAuth for /staff syncpermissions)
 *   PUBLIC_HTTP_PORT / TICKET_HTTP_PORT — public HTTP (transcripts + OAuth callback)
 *   PUBLIC_BASE_URL / TICKET_PUBLIC_BASE_URL — public origin for links / OAuth redirect
 *   OAUTH_REDIRECT_URI — override default {PUBLIC_BASE_URL}/oauth/command-permissions/callback
 *   AI_API_KEY / AI_BASE_URL / AI_MODEL — optional ticket archive summarization
 *
 * Fluxer (roadmap/fluxer.md § Environment):
 *
 *   # Discord-only files stay valid.
 *   DISCORD_TOKEN=YOUR_BOT_TOKEN
 *   CLIENT_ID=YOUR_APPLICATION_ID
 *   CLIENT_SECRET=YOUR_CLIENT_SECRET
 *
 *   # JSON array. Official hosted example:
 *   # FLUXER_INSTANCES=[{"instanceKey":"https://fluxer.app","origin":"https://fluxer.app","token":"YOUR_FLUXER_BOT_TOKEN","clientId":"YOUR_FLUXER_OAUTH_CLIENT_ID","clientSecret":"YOUR_FLUXER_OAUTH_CLIENT_SECRET","label":"Fluxer"}]
 *   FLUXER_INSTANCES=
 *
 *   # Prefix. Default "!". Set to "/" only as an explicit opt-in.
 *   FLUXER_COMMAND_PREFIX=!
 *
 *   # Loopback http origins are allowed without this. Any other http
 *   # origin requires it.
 *   # FLUXER_ALLOW_INSECURE=1
 *
 * Bridge (roadmap/bridge.md § Environment + Rollout):
 *
 *   # Kill switch. Read at command time, at enqueue, and at the top of
 *   # every relay tick. UNSET means ON; only an explicit "0" (or "false"
 *   # / "off", case-insensitive) pauses bridging process-wide. Messages
 *   # queued while paused are delivered when it is turned back on.
 *   # BRIDGE_ENABLED=0
 *
 *   # 32-byte hex key for connect-credential hashing (bridge.service).
 *   BRIDGE_TOKEN_KEY=
 *
 * Placeholders only. No real token shapes in docs, tests, or this file.
 *
 * `token` is required and non-empty per entry; it is sent only as
 * `Authorization: Bot <token>` to the discovered api_public and inside the
 * gateway Identify payload. It is NEVER logged (spec § Boot).
 */

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

/**
 * Lowercased host, explicit port kept, trailing slash stripped, path kept
 * only when the operator wrote one (spec § Boot, instanceKey default rule).
 *
 * Throws a specific Error for a non-string, empty, unparseable, or non-URL
 * origin. Scheme is NOT restricted here (that is a policy decision: config
 * restricts to http/https, discovery restricts endpoints per spec).
 *
 * @param {string} origin
 * @returns {string} canonical origin string (may include a path prefix)
 */
function normalizeOriginForKey(origin) {
  const value = typeof origin === "string" ? origin.trim() : "";
  if (!value) {
    throw new Error(
      `Fluxer instance origin must be a non-empty string (got ${
        origin == null ? String(origin) : typeof origin === "string" ? "empty string" : typeof origin
      })`,
    );
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `Fluxer instance origin is not a valid absolute URL: ${JSON.stringify(value)}`,
    );
  }
  if (!url.hostname) {
    throw new Error(
      `Fluxer instance origin has no host: ${JSON.stringify(value)}`,
    );
  }
  const port = url.port ? `:${url.port}` : "";
  // URL normalizes an empty path to "/"; strip trailing slashes so the key
  // is stable and routing prefixes never end in "/".
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}${path}`;
}

/**
 * Loopback host test for the plain-`http:` allowance (spec § Boot: `http:`
 * is rejected unless the host is loopback or FLUXER_ALLOW_INSECURE=1).
 *
 * @param {string} hostname already-lowercased hostname (URL.hostname form;
 *   IPv6 literals arrive bracketed, e.g. "[::1]")
 * @returns {boolean}
 */
function isLoopbackHostname(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "ip6-localhost" ||
    h === "::1" ||
    /^127\./.test(h)
  );
}

/**
 * Parse and validate the FLUXER_INSTANCES JSON array (spec § Boot, rules
 * table). Returns one entry per array element, in order.
 *
 * Throws a specific Error (never a silent drop) for: malformed JSON, a
 * non-array document, a non-object entry, a missing/invalid `origin`, a
 * missing/empty `token`, a duplicate `instanceKey`, an illegal URL scheme
 * (only http/https are accepted), and a plain `http:` origin that is neither
 * loopback nor covered by FLUXER_ALLOW_INSECURE=1.
 *
 * An unset/empty/whitespace-only input yields [] (the "no Fluxer block"
 * case — rule 1 in spec § Boot).
 *
 * @param {string|undefined|null} rawJsonString JSON array text
 * @param {{ allowInsecure?: boolean }} [opts] allowInsecure overrides
 *   process.env.FLUXER_ALLOW_INSECURE === "1" (used by tests)
 * @returns {Array<{ instanceKey: string, origin: string, token: string,
 *   clientId: string|null, clientSecret: string|null, label: string }>}
 */
function parseFluxerInstances(rawJsonString, opts = {}) {
  const raw = rawJsonString == null ? "" : String(rawJsonString);
  if (raw.trim() === "") return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `FLUXER_INSTANCES is not valid JSON: ${err?.message || err}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      "FLUXER_INSTANCES must be a JSON array of Fluxer instance objects",
    );
  }

  const allowInsecure =
    opts.allowInsecure === true || process.env.FLUXER_ALLOW_INSECURE === "1";
  const entries = [];
  const seenKeys = new Set();

  parsed.forEach((entry, index) => {
    const at = `FLUXER_INSTANCES[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${at} must be an object with an "origin" and a "token"`);
    }

    // origin — required absolute http(s) URL (spec: "Absolute http: or
    // https: URL. This is the discovery origin, not a guessed API host.")
    const origin =
      typeof entry.origin === "string" ? entry.origin.trim() : "";
    if (!origin) {
      throw new Error(`${at} is missing a required "origin"`);
    }
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      throw new Error(
        `${at} has an invalid "origin" URL: ${JSON.stringify(origin)}`,
      );
    }
    if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
      throw new Error(
        `${at} origin scheme "${originUrl.protocol}" is not allowed (use http: or https:)`,
      );
    }
    if (originUrl.protocol === "http:") {
      if (!isLoopbackHostname(originUrl.hostname) && !allowInsecure) {
        throw new Error(
          `${at} origin ${JSON.stringify(origin)} uses plain http:; allowed only for loopback hosts or with FLUXER_ALLOW_INSECURE=1`,
        );
      }
    }
    const normalizedOrigin = normalizeOriginForKey(origin);

    // token — required, non-empty. Never logged. Format is not enforced.
    const token =
      typeof entry.token === "string" ? entry.token.trim() : "";
    if (!token) {
      throw new Error(
        `${at} (origin ${JSON.stringify(origin)}) is missing a required non-empty "token"`,
      );
    }

    // instanceKey — optional; defaults to the normalized origin.
    const rawKey =
      typeof entry.instanceKey === "string" ? entry.instanceKey.trim() : "";
    const instanceKey = rawKey !== "" ? rawKey : normalizedOrigin;
    if (seenKeys.has(instanceKey)) {
      throw new Error(`${at} has a duplicate instanceKey ${JSON.stringify(instanceKey)}`);
    }
    seenKeys.add(instanceKey);

    const optionalString = (name) => {
      const v = entry[name];
      if (v === undefined || v === null) return null;
      const s = typeof v === "string" ? v.trim() : "";
      return s === "" ? null : s;
    };

    entries.push({
      instanceKey,
      origin: normalizedOrigin,
      token,
      clientId: optionalString("clientId"),
      clientSecret: optionalString("clientSecret"),
      label: optionalString("label") ?? normalizedOrigin,
    });
  });

  return entries;
}

/**
 * Fluxer command prefix (K1): default "!", overridable with
 * FLUXER_COMMAND_PREFIX (trimmed, 1–8 characters, no whitespace, no `<`
 * or `>`). `/` is valid only as an explicit value — there is no code path
 * that invents one. An unset/whitespace-only value falls back to "!".
 *
 * A present-but-invalid value throws with the specific rule violated;
 * operators learn why at boot, not via a silent fallback.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function getFluxerCommandPrefix(env = process.env) {
  const raw = env.FLUXER_COMMAND_PREFIX;
  if (raw === undefined || raw === null) return "!";
  const value = String(raw).trim();
  if (value === "") return "!";
  if (value.length > 8) {
    throw new Error(
      `FLUXER_COMMAND_PREFIX must be 1-8 characters, got ${value.length}`,
    );
  }
  if (/\s/.test(value)) {
    throw new Error("FLUXER_COMMAND_PREFIX must not contain whitespace");
  }
  if (value.includes("<") || value.includes(">")) {
    throw new Error("FLUXER_COMMAND_PREFIX must not contain '<' or '>'");
  }
  return value;
}

/**
 * Validate required env vars at boot (login still uses process.env.DISCORD_TOKEN).
 *
 * Rules (spec § Boot):
 * 1. FLUXER_INSTANCES unset/empty and DISCORD_TOKEN set: Discord-only,
 *    identical to today. When the Fluxer block is absent the legacy
 *    `requireEnv("DISCORD_TOKEN")` gate (and its exact message) is preserved.
 * 2. A malformed Fluxer block throws at boot even when DISCORD_TOKEN is set
 *    — a broken Fluxer block is never silently ignored.
 * 3. No DISCORD_TOKEN and a configured-but-empty Fluxer list (`[]`): throw
 *    the platform-credential message.
 */
function assertRuntimeEnv() {
  const raw = process.env.FLUXER_INSTANCES;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  let instances = [];
  if (trimmed !== "") {
    // Rule 2: throws on malformed JSON / missing origin / missing token /
    // duplicate instanceKey / illegal URL — even with DISCORD_TOKEN present.
    // A configured-but-empty list ("[]") is rule 1/3: zero Fluxer endpoints.
    instances = parseFluxerInstances(raw);
  }
  // Rules 1 + 3: the process must have at least one platform endpoint.
  // Spec § Boot rule 3 is explicit: no DISCORD_TOKEN and zero valid Fluxer
  // instances → the platform-credential message (there is no legacy
  // "DISCORD_TOKEN required" special case in the spec).
  if (!process.env.DISCORD_TOKEN && instances.length === 0) {
    throw new Error(
      "Missing a platform credential: set DISCORD_TOKEN or FLUXER_INSTANCES",
    );
  }
}

module.exports = {
  requireEnv,
  assertRuntimeEnv,
  parseFluxerInstances,
  normalizeOriginForKey,
  getFluxerCommandPrefix,
};
