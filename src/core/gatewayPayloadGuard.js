/**
 * Gateway payload guard (2026-10-01 prod incident; extended 2026-10-26 for
 * the #175 reply/snapshot crash class).
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
 * #175 triage found the SAME crash class in the reply/snapshot fields a
 * "gork crashes on reply messages" report would produce (the JS around it
 * is exception-guarded; the CONSTRUCTOR is not):
 * - `message_reference: null` (or undefined / any primitive) — the v14
 *   Message constructor enters its reference block on the KEY
 *   (`'message_reference' in data`) and immediately reads
 *   `data.message_reference.channel_id` → synchronous TypeError.
 * - `message_snapshots` without a usable `message_reference.message_id` —
 *   the snapshots block dereferences `this.reference.channelId` (null
 *   reference → TypeError) and calls `.reduce` on the raw value (non-array
 *   → TypeError).
 * - a non-array `mentions` value (e.g. a bare string) — the mentions loop
 *   ITERATES the string's characters into `users._add` → the same
 *   `'username' in` TypeError as the array-of-strings incident.
 * All three fire inside discord.js' packet handling — before
 * `client.emit(MessageCreate)` and before any pipeline try/catch — and
 * reach only the process net (`uncaughtException` → drain + exit). Real
 * Discord pairs snapshots with a reference, so exposure is gateway
 * proxies/emulators/relays mangling the payload; the symptom is exactly
 * "bot dies right after someone replies to / forwards a message".
 *
 * This guard normalizes the payload shape BEFORE discord.js constructs
 * structures from it: string/number `mentions` entries become minimal
 * `{ id }` user objects (the exact partial shape `User._patch` accepts),
 * unrepairable entries are dropped, and malformed reference/snapshot
 * fields are deleted (the message then hydrates as unreferenced — content
 * and every other field survive). It is installed at the single choke
 * point every MESSAGE_CREATE / MESSAGE_UPDATE passes through (the
 * client's action dispatcher in createClient), so no feature handler
 * needs to defend itself, and well-formed payloads pass through untouched
 * (identity — no copy, no allocation).
 */

/** Whether a value is a plain-ish data object (arrays excluded). */
function isDataObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalize the crash-prone payload fields. Returns the input unchanged
 * (same reference) when the payload is already well-shaped.
 *
 * @param {any} data raw gateway MESSAGE_CREATE / MESSAGE_UPDATE payload
 * @returns {any} sanitized payload
 */
function sanitizeMessagePayload(data) {
  if (!data || typeof data !== "object") return data;
  let out = null; // lazily created copy — well-formed payloads stay identity
  const copy = () => (out ??= { ...data });

  // 1) message_reference: the KEY's presence makes the v14 constructor read
  //    `data.message_reference.channel_id` — a nullish/primitive value
  //    throws synchronously. Drop it; the message hydrates as unreferenced.
  if ("message_reference" in data && !isDataObject(data.message_reference)) {
    delete copy().message_reference;
  }

  // 2) message_snapshots: the constructor reduces the raw value and
  //    dereferences `this.reference.channelId` per snapshot — keep them
  //    only when an ARRAY rides together with a reference object that
  //    carries a message_id; otherwise drop (a forwarded-content gap beats
  //    a dead process).
  if (data.message_snapshots != null) {
    const ref = isDataObject(data.message_reference) ? data.message_reference : null;
    const usableRef = ref != null && ref.message_id != null;
    if (!Array.isArray(data.message_snapshots) || !usableRef) {
      delete copy().message_snapshots;
    }
  }

  // 3) mentions: a non-array value iterates into primitives (a bare string
  //    yields CHARACTERS); inside the array, primitives crash User._patch —
  //    string/number ids salvage as {id} partials, the rest are dropped.
  if (data.mentions != null) {
    if (!Array.isArray(data.mentions)) {
      delete copy().mentions;
    } else if (data.mentions.some((m) => !isDataObject(m))) {
      const c = copy();
      c.mentions = data.mentions
        .filter((m) => isDataObject(m) || typeof m === "string" || typeof m === "number")
        .map((m) => (isDataObject(m) ? m : { id: String(m) }));
    }
  }

  return out ?? data;
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
