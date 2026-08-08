/**
 * Signed, short-lived OAuth state for command-permission authorization.
 */

const crypto = require("crypto");
const { getOAuthStateSecret } = require("./config");

const STATE_TTL_MS = 15 * 60 * 1000;

/** @type {Map<string, number>} nonce → expiresAt */
const usedNonces = new Map();

function sweepNonces(now = Date.now()) {
  for (const [nonce, exp] of usedNonces) {
    if (exp <= now) usedNonces.delete(nonce);
  }
}

/**
 * @param {object} payload
 * @param {string} payload.guildId
 * @param {string} payload.userId
 * @param {number} [payload.exp]
 * @returns {string} opaque state string
 */
function createOAuthState(payload) {
  const secret = getOAuthStateSecret();
  if (!secret) throw new Error("OAuth state secret not configured");

  const nonce = crypto.randomBytes(16).toString("hex");
  const exp = payload.exp || Date.now() + STATE_TTL_MS;
  const body = {
    g: payload.guildId,
    u: payload.userId,
    n: nonce,
    e: exp,
  };
  const data = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

/**
 * @param {string} state
 * @returns {{ guildId: string, userId: string, exp: number }|null}
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

  if (!body?.g || !body?.u || !body?.n || !body?.e) return null;
  const now = Date.now();
  if (Number(body.e) < now) return null;

  sweepNonces(now);
  if (usedNonces.has(body.n)) return null;
  usedNonces.set(body.n, Number(body.e));

  return {
    guildId: String(body.g),
    userId: String(body.u),
    exp: Number(body.e),
  };
}

/** @private test helper */
function _resetNoncesForTests() {
  usedNonces.clear();
}

module.exports = {
  STATE_TTL_MS,
  createOAuthState,
  verifyOAuthState,
  _resetNoncesForTests,
};
