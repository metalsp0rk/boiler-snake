/**
 * Signed, short-lived OAuth state, shared by every web-facing authorize flow
 * (roadmap/web-admin.md §8.3). The payload carries a `purpose` tag so one
 * flow's state can never be replayed into another flow's callback
 * (no cross-flow substitution).
 *
 * Backward compatibility contract (Phase 0a behavior is load-bearing):
 *  - payloads minted WITHOUT a purpose omit the tag and verify as
 *    `cmd_perms` — states issued before this change keep working, and the
 *    command-permissions callback is unaffected;
 *  - `cmd_perms` (or untagged) states still REQUIRE guild + user binding;
 *  - `web_login` states are browser-initiated (no guild/user context at
 *    start), so g/u are optional but a `guild` return target may be signed.
 */

const crypto = require("crypto");
const { getOAuthStateSecret } = require("./config");

const STATE_TTL_MS = 15 * 60 * 1000;

/** Purpose tags (§8.3): callback rejects anything not its own purpose. */
const PURPOSES = Object.freeze({
  CMD_PERMS: "cmd_perms",
  WEB_LOGIN: "web_login",
  // roadmap/fluxer.md § PKCE and state (PR 10): Fluxer web login. NOT
  // interchangeable with web_login (Discord); its single-use guarantee comes
  // from the fluxer_oauth_transactions table, not the in-memory nonce map.
  WEB_LOGIN_FLUXER: "web_login_fluxer",
});

const VALID_PURPOSES = new Set(Object.values(PURPOSES));

/** @type {Map<string, number>} nonce → expiresAt */
const usedNonces = new Map();

function sweepNonces(now = Date.now()) {
  for (const [nonce, exp] of usedNonces) {
    if (exp <= now) usedNonces.delete(nonce);
  }
}

/**
 * @param {object} payload
 * @param {string} [payload.guildId] required for cmd_perms; optional web_login
 *   return target (`/g/:guildId`)
 * @param {string} [payload.next] §8.15-15.13 web_login ONLY: whitelisted
 *   same-origin RETURN PATH (ticket URLs). Signed like everything else —
 *   the callback re-checks the whitelist, so a tampered value is dropped
 *   (the destination can never be attacker-chosen: no open redirect).
 * @param {string} [payload.userId] required for cmd_perms; absent for web_login
 * @param {number} [payload.exp]
 * @param {string} [payload.purpose] one of PURPOSES; untagged ⇒ cmd_perms
 * @param {string} [payload.nonce] caller-supplied 32-hex nonce (roadmap/fluxer.md
 *   § PKCE and state: the Fluxer web login keys its SQLite verifier row by the
 *   nonce INSIDE the signed state). Must match /^[0-9a-f]{32}$/; anything else
 *   throws. Default remains randomBytes(16).hex — existing callers are unchanged.
 * @returns {string} opaque state string
 */
function createOAuthState(payload) {
  const secret = getOAuthStateSecret();
  if (!secret) throw new Error("OAuth state secret not configured");

  const purpose =
    payload.purpose == null ? null : String(payload.purpose);
  if (purpose !== null && !VALID_PURPOSES.has(purpose)) {
    throw new Error(`Unknown OAuth state purpose: ${purpose}`);
  }

  let nonce;
  if (payload.nonce != null) {
    nonce = String(payload.nonce);
    if (!/^[0-9a-f]{32}$/.test(nonce)) {
      throw new Error("createOAuthState: nonce must be a 32-char lowercase hex string");
    }
  } else {
    nonce = crypto.randomBytes(16).toString("hex");
  }
  const exp = payload.exp || Date.now() + STATE_TTL_MS;
  // Undefined/null fields are dropped rather than serialized as null so the
  // minted body stays byte-identical to the pre-purpose format whenever a
  // caller passes the legacy {guildId, userId} shape.
  const body = {};
  if (payload.guildId) body.g = payload.guildId;
  if (payload.userId) body.u = payload.userId;
  if (payload.next) body.nx = String(payload.next);
  body.n = nonce;
  body.e = exp;
  if (purpose) body.p = purpose;
  const data = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

/**
 * @param {string} state
 * @returns {{ guildId: string|null, userId: string|null, next: string|null,
 *   nonce: string|null, exp: number, purpose: string }|null}
 *   `purpose` is the resolved tag (untagged legacy states ⇒ `cmd_perms`);
 *   each callback MUST reject states whose purpose is not its own.
 *   `nonce` (additive, roadmap/fluxer.md § PKCE and state) keys the
 *   `fluxer_oauth_transactions` verifier row for the Fluxer web login;
 *   Discord consumers simply ignore it.
 */
function verifyOAuthState(state) {
  const secret = getOAuthStateSecret();
  if (!secret || !state || typeof state !== "string") return null;

  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let body;
  try {
    body = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!body?.n || !body?.e) return null;
  // Untagged payload = pre-purpose mint (or explicit cmd_perms): the
  // guild+user binding stays mandatory, so the existing flow is unchanged.
  const purpose = body.p == null ? PURPOSES.CMD_PERMS : String(body.p);
  if (!VALID_PURPOSES.has(purpose)) return null;
  if (purpose === PURPOSES.CMD_PERMS && (!body.g || !body.u)) return null;
  const now = Date.now();
  if (Number(body.e) < now) return null;

  // In-memory single-use nonce map (§8.3). EXEMPT: web_login_fluxer — its
  // single use is the fluxer_oauth_transactions table (roadmap/fluxer.md
  // § PKCE and state): marking here would make the Fluxer callback look like
  // a replay, and the map dies on process restart while the signed state
  // survives. Discord purposes (cmd_perms, web_login, legacy) keep byte-
  // identical marking behavior.
  if (purpose !== PURPOSES.WEB_LOGIN_FLUXER) {
    sweepNonces(now);
    if (usedNonces.has(body.n)) return null;
    usedNonces.set(body.n, Number(body.e));
  }

  return {
    guildId: body.g ? String(body.g) : null,
    next: body.nx ? String(body.nx) : null,
    userId: body.u ? String(body.u) : null,
    nonce: String(body.n),
    exp: Number(body.e),
    purpose,
  };
}

/** @private test helper */
function _resetNoncesForTests() {
  usedNonces.clear();
}

module.exports = {
  STATE_TTL_MS,
  PURPOSES,
  createOAuthState,
  verifyOAuthState,
  _resetNoncesForTests,
};
