/**
 * Server-side OAuth artifacts for web sessions (roadmap/web-admin.md §8.3,
 * §8.1 decision 9).
 *
 * The login callback stores the user's Discord ACCESS TOKEN on the session
 * row so later per-request member/guild calls (guildAccess, subtask 07) can
 * act with the viewer's own authorization. Discord documents AT lifetime as
 * `expires_in` seconds (currently 604800 = 7 d), which matches the session
 * absolute cap — so v1 stores no refresh token and runs no refresh flow:
 * when the AT dies, the session is re-authenticated anyway. Re-verify that
 * assumption before adding a refresh path.
 *
 * Columns (all NULLable — anonymous-era rows and pre-upgrade rows stay
 * valid; addColumnIfMissing keeps this idempotent on re-run):
 *  - access_token_enc  AES-256-GCM envelope (iv+tag+ciphertext, base64) of
 *    the access token; the PLAINTEXT is never stored. Key is derived from
 *    the resolved session secret (src/web/auth/tokens.js).
 *  - token_expires_at  unix ms ceiling from the token response; the panel
 *    treats "past this" as re-auth required (no silent refresh in v1).
 *  - scopes                      space-separated scope string Discord granted.
 *  - guild_snapshot              JSON array snapshot of the bot∩user guild
 *                                intersection taken at login (§8.3: the
 *                                guilds list lives on the session and is
 *                                re-checked per WEB_TIER_CACHE_TTL_MS).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function, addColumnIfMissing: Function }} helpers
 */
function up(db, { tableExists, addColumnIfMissing }) {
  // web_sessions comes from 023; the guard keeps ordering/re-runs safe.
  if (!tableExists("web_sessions")) return;
  addColumnIfMissing("web_sessions", "access_token_enc", "access_token_enc TEXT");
  addColumnIfMissing("web_sessions", "token_expires_at", "token_expires_at INTEGER");
  addColumnIfMissing("web_sessions", "scopes", "scopes TEXT");
  addColumnIfMissing("web_sessions", "guild_snapshot", "guild_snapshot TEXT");
}

module.exports = { id: "025_web_session_tokens", up };
