/**
 * Gateway payload guard (2026-10-01 prod incident).
 *
 * Discord's gateway was observed sending MESSAGE_UPDATE payloads whose
 * `mentions` array contained raw snowflake STRINGS instead of user
 * objects. discord.js passes every `mentions` element straight to
 * `client.users._add()`, whose `User._patch` evaluates
 * `'username' in data` — against a string payload that throws an
 * uncaught TypeError inside the gateway dispatch, and an uncaught
 * exception in the websocket data handler takes the whole process down.
 * Prod crash-looped: every respawn reconnected, the next malformed
 * MESSAGE_UPDATE crashed it again, and the Fluxer connection (and every
 * feature) died with it — the "silent failure" after a bot install.
 *
 * This guard normalizes the payload shape BEFORE discord.js constructs
 * structures from it: string entries in `mentions` become minimal
 * `{ id }` user objects — the exact partial shape `User._patch` accepts
 * (it sets `username ??= null`). It is installed at the single choke
 * point every MESSAGE_CREATE / MESSAGE_UPDATE passes through (the
 * client's action dispatcher in createClient), so no feature handler
 * needs to defend itself, and well-formed payloads pass through
 * untouched (identity — no copy, no allocation).
 */

/**
 * Normalize `data.mentions` entries to user objects. Returns the input
 * unchanged (same reference) when the payload is already well-shaped.
 *
 * @param {any} data raw gateway MESSAGE_CREATE / MESSAGE_UPDATE payload
 * @returns {any} sanitized payload
 */
function sanitizeMessagePayload(data) {
  if (!data || typeof data !== "object") return data;
  const { mentions } = data;
  if (!Array.isArray(mentions)) return data;
  if (!mentions.some((m) => typeof m === "string")) return data;
  return {
    ...data,
    mentions: mentions.map((m) => (typeof m === "string" ? { id: m } : m)),
  };
}

/**
 * Wrap the message gateway actions on a client so every dispatch goes
 * through the sanitizer first. Idempotent; returns the client.
 *
 * @param {import("discord.js").Client} client
 * @returns {import("discord.js").Client}
 */
function installGatewayPayloadGuard(client) {
  for (const name of ["MessageCreate", "MessageUpdate"]) {
    // discord.js 14 exposes actions PascalCase; tolerate camelCase too so a
    // future rename can't silently turn the guard into a no-op.
    const action =
      client.actions?.[name] ?? client.actions?.[name.charAt(0).toLowerCase() + name.slice(1)];
    if (!action || typeof action.handle !== "function" || action.__payloadGuarded) continue;
    const original = action.handle.bind(action);
    action.handle = (data) => original(sanitizeMessagePayload(data));
    action.__payloadGuarded = true;
  }
  return client;
}

module.exports = { sanitizeMessagePayload, installGatewayPayloadGuard };
