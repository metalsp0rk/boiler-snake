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
 * @param {string} [payload.userId] required for cmd_perms; absent for web_login
 * @param {number} [payload.exp]
 * @param {string} [payload.purpose] one of PURPOSES; untagged ⇒ cmd_perms
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

  const nonce = crypto.randomBytes(16).toString("hex");
  const exp = payload.exp || Date.now() + STATE_TTL_MS;
  // Undefined/null fields are dropped rather than serialized as null so the
  // minted body stays byte-identical to the pre-purpose format whenever a
  // caller passes the legacy {guildId, userId} shape.
  const body = {};
  if (payload.guildId) body.g = payload.guildId;
  if (payload.userId) body.u = payload.userId;
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
 * @returns {{ guildId: string|null, userId: string|null, exp: number, purpose: string }|null}
 *   `purpose` is the resolved tag (untagged legacy states ⇒ `cmd_perms`);
 *   each callback MUST reject states whose purpose is not its own.
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

  sweepNonces(now);
  if (usedNonces.has(body.n)) return null;
  usedNonces.set(body.n, Number(body.e));

  return {
    guildId: body.g ? String(body.g) : null,
    userId: body.u ? String(body.u) : null,
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
