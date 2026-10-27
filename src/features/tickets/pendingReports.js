/**
 * Pending-report snapshot store (ticket reports #745 — locked decision 3).
 *
 * A context-menu invoke carries the target message/user in full, but the modal
 * submit that follows is a DIFFERENT interaction holding nothing but its
 * customId. So the invoke handler snapshots what it saw here and the modal
 * handler reads it back by token — the token rides inside the modal customId
 * (`MODAL_REPORT_MESSAGE_PREFIX` / `MODAL_REPORT_USER_PREFIX` + token, see
 * ./constants.js).
 *
 * Contract:
 * - **Process-local Map, no DB, no timers.** Timestamp comparison only. A bot
 *   restart empties the store, which is exactly the "report expired, run the
 *   command again" path the modal handlers own (error rule 3) — there is no
 *   retry loop and no durability claim here.
 * - **One-shot `take`.** Every successful take removes the entry, and so does
 *   an expired one, so a replayed modal submit (double-click, discord.js
 *   retry) can never open a second ticket from one snapshot. Unknown,
 *   malformed, expired, and already-consumed tokens all collapse to `null`.
 * - **TTL runs from capture time** (`capturedAt + PENDING_REPORT_TTL_MS`), so
 *   touching an entry never extends it. Expiry is inclusive
 *   (`expiresAt <= now`), matching the gork cooldown gate's window semantics.
 * - **Metadata only — never bytes.** Snapshots keep URLs and text
 *   (decision 3: attachment bytes are fetched at execution time, after the
 *   evidence post, decision 4). Every field is re-picked into fresh plain
 *   objects, so the Map retains no caller object — no discord.js
 *   Message/Attachment instance, no Buffer, no getter that could throw later.
 * - **A rejected `put` returns `null`** (error rule 6: the service reports
 *   failure, the handler replies). Nothing here throws, logs-and-rethrows, or
 *   replies to Discord.
 * - Expired entries die on the next `put`/`take` (lazy sweep), which is also
 *   the ONLY sweeper — a `setInterval` here would be a detached-async hazard
 *   (AGENTS.md error rule 1). Size stays bounded because one entry exists per
 *   staff-issued report inside a 10-minute window.
 *
 * Clock seam: `createPendingReportStore({ now })` for fully fake-clock tests
 * (same shape as gork/summarizeCooldown.js). The process-wide singleton runs on
 * `Date.now`, and every entry point additionally accepts `{ now }` — epoch ms
 * or a `() => ms` function — so handler tests (subtasks 06/08) can force
 * expiry without waiting for a wall clock.
 */

const crypto = require("node:crypto");

/** How long a pending report survives between invoke and modal submit. */
const PENDING_REPORT_TTL_MS = 10 * 60 * 1000;

/** Token entropy: 16 random bytes → 32 lowercase hex chars. */
const TOKEN_BYTES = 16;

/** Mint retries if a candidate token ever collided (2^-128 odds; belt-and-braces). */
const TOKEN_COLLISION_RETRIES = 8;

/** `kind` values mirror the `ticket_reports.kind` CHECK (migration 066). */
const REPORT_KINDS = Object.freeze({
  MESSAGE: "message",
  USER: "user",
});

const VALID_REPORT_KINDS = new Set(Object.values(REPORT_KINDS));

/**
 * Tolerant id coercion (string|number|bigint → string). Empty strings and
 * `0`/`0n` carry no identity — same rule as the gork cooldown gate's keys.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function toId(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return value ? String(value) : null;
  }
  return null;
}

/**
 * Tolerant text coercion for labels and content. Non-primitives are dropped
 * rather than stringified — "[object Object]" never belongs in a transcript,
 * and a thrown getter must never reach the store.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function toText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

/**
 * Metadata text: like `toText`, but empty/whitespace-only values become null so
 * a stored snapshot never carries an empty label. (`content` is handled
 * separately: "" is a real value there — an attachment-only message.)
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function toNonEmptyText(value) {
  const text = toText(value);
  return text && text.trim() !== "" ? text : null;
}

/**
 * Never-throwing id context for the failure logs (error rule 2 wants
 * reproducer ids, and the catch path must not be able to throw).
 *
 * @param {unknown} snapshot
 * @returns {string}
 */
function idHint(snapshot) {
  try {
    return `guild=${toId(snapshot?.guildId) ?? "?"} reporter=${
      toId(snapshot?.reporterUserId) ?? "?"
    }`;
  } catch {
    return "guild=? reporter=?";
  }
}

/**
 * Attachment metadata → the five decision-3 keys, rebuilt field by field so no
 * caller object (and certainly no byte payload) survives in the store. `href`
 * and `content_type` are accepted aliases, mirroring assets.js
 * `parseAttachmentList`. A bare string becomes a URL-only entry, same as there.
 * Anything that is neither addressable nor identifiable is dropped.
 *
 * @param {unknown} value
 * @returns {{ id: string|null, name: string|null, url: string|null,
 *   size: number|null, contentType: string|null }[]}
 */
function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === "string") {
      const bareUrl = toNonEmptyText(item);
      if (bareUrl) {
        out.push({ id: null, name: null, url: bareUrl, size: null, contentType: null });
      }
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const url = toNonEmptyText(item.url) || toNonEmptyText(item.href);
    const id = toId(item.id);
    // Nothing addressable and nothing identifiable (Buffer, array, embed stub)
    // is not attachment metadata — drop it rather than store a foreign object.
    if (!url && !id) continue;
    const size = Number(item.size);
    out.push({
      id,
      name: toNonEmptyText(item.name),
      url,
      size: Number.isFinite(size) && size > 0 ? Math.floor(size) : null,
      contentType: toNonEmptyText(item.contentType) || toNonEmptyText(item.content_type),
    });
  }
  return out;
}

/**
 * Text-metadata arrays (original embed URLs, sticker names — decision 15: v1
 * is text only, sticker bytes are a v1.5 stretch). Objects are reduced to
 * their most identifying primitive (`name` → `url` → `id`); anything left
 * non-primitive is dropped, which is what keeps this field safe to archive.
 * A non-array yields `[]` — the store never invents metadata from a scalar.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeTextList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const direct = toNonEmptyText(item);
    if (direct) {
      out.push(direct);
      continue;
    }
    if (item && typeof item === "object") {
      const named =
        toNonEmptyText(item.name) || toNonEmptyText(item.url) || toNonEmptyText(item.id);
      if (named) out.push(named);
    }
  }
  return out;
}

/**
 * Resolve the clock for one call: an explicit override (epoch ms or a
 * `() => ms` function) wins over the instance clock, which defaults to
 * `Date.now`. A missing or unparseable override falls back — a garbage clock
 * must never make a live token look expired.
 *
 * @param {unknown} value `opts.now`
 * @param {() => number} fallback instance clock
 * @returns {number} epoch ms
 */
function resolveNow(value, fallback) {
  if (value == null) return fallback();
  if (typeof value === "function") {
    const ms = Number(value());
    return Number.isFinite(ms) ? ms : fallback();
  }
  // A number is honored as-is (epoch ms); anything else — string, object, NaN —
  // is not a clock, so the instance clock answers rather than a coerced 0.
  return typeof value === "number" && Number.isFinite(value) ? value : fallback();
}

/**
 * The invoke-time snapshot, rebuilt into fresh plain values (see the header's
 * "metadata only" clause). Field set is exactly locked decision 3.
 *
 * @param {object} snapshot raw fields from the invoke handler
 * @param {number} capturedAt epoch ms the snapshot was taken
 * @returns {object} stored snapshot
 */
function buildSnapshot(snapshot, capturedAt) {
  return {
    kind: typeof snapshot.kind === "string" ? snapshot.kind : null,
    guildId: toId(snapshot.guildId),
    reporterUserId: toId(snapshot.reporterUserId),
    messageId: toId(snapshot.messageId),
    channelId: toId(snapshot.channelId),
    channelName: toNonEmptyText(snapshot.channelName),
    authorId: toId(snapshot.authorId),
    // Empty string, not null: an attachment-only message has no text, and the
    // evidence builder gets one string type to handle.
    content: toText(snapshot.content) ?? "",
    attachments: normalizeAttachments(snapshot.attachments),
    embedUrls: normalizeTextList(snapshot.embedUrls),
    stickers: normalizeTextList(snapshot.stickers),
    // Reports name their subject explicitly (message variant: the author,
    // user variant: the reported member) — the store never infers it.
    subjectUserId: toId(snapshot.subjectUserId),
    capturedAt,
  };
}

/**
 * Create an independent pending-report store. Production code uses the
 * module-level singleton wrappers below; tests create fresh instances with a
 * fake clock.
 *
 * @param {object} [options]
 * @param {() => number} [options.now=Date.now] clock returning epoch ms
 * @returns {{
 *   put: (snapshot: object, opts?: { now?: number|(() => number) }) => string|null,
 *   take: (token: unknown, opts?: { now?: number|(() => number) }) => object|null,
 *   sweep: (opts?: { now?: number|(() => number) }) => number,
 *   size: () => number,
 *   reset: () => void,
 * }}
 */
function createPendingReportStore(options = {}) {
  const clock = typeof options.now === "function" ? options.now : Date.now;

  /** @type {Map<string, { snapshot: object, expiresAt: number }>} token → snapshot + expiry ts */
  const pending = new Map();

  /**
   * Drop every entry whose TTL has run out. Lazy — this runs on `put` and
   * `take` and is never scheduled.
   *
   * @param {{ now?: number|(() => number) }} [opts] clock override (tests)
   * @returns {number} how many entries were dropped
   */
  function sweep(opts = {}) {
    const now = resolveNow(opts?.now, clock);
    let dropped = 0;
    for (const [token, entry] of pending) {
      if (entry.expiresAt <= now) {
        pending.delete(token);
        dropped += 1;
      }
    }
    return dropped;
  }

  /**
   * Store an invoke-time snapshot and mint its one-time token.
   *
   * @param {object} snapshot decision-3 fields; `kind` ('message'|'user'),
   *   `guildId` and `reporterUserId` are required, `capturedAt` defaults to the
   *   clock at put
   * @param {{ now?: number|(() => number) }} [opts] clock override (tests)
   * @returns {string|null} lowercase hex token for the modal customId, or null
   *   when the snapshot is incomplete/unusable (never throws)
   */
  function put(snapshot, opts = {}) {
    try {
      const now = resolveNow(opts?.now, clock);
      sweep({ now });

      const kind = typeof snapshot?.kind === "string" ? snapshot.kind : null;
      const guildId = toId(snapshot?.guildId);
      const reporterUserId = toId(snapshot?.reporterUserId);
      if (!VALID_REPORT_KINDS.has(kind) || !guildId || !reporterUserId) {
        return null; // error rule 6: the handler turns null into a specific reply
      }

      const stamped = Number(snapshot.capturedAt);
      // Only a real epoch-ms stamp is respected: a missing, empty, garbage,
      // negative or zero stamp falls back to the clock at put (epoch 0 would
      // read as instantly expired).
      const capturedAt =
        snapshot.capturedAt == null || !Number.isFinite(stamped) || stamped <= 0 ? now : stamped;

      let token = null;
      for (let attempt = 0; attempt < TOKEN_COLLISION_RETRIES && token === null; attempt += 1) {
        const candidate = crypto.randomBytes(TOKEN_BYTES).toString("hex");
        if (!pending.has(candidate)) token = candidate;
      }
      if (token === null) return null;

      pending.set(token, {
        snapshot: buildSnapshot(snapshot, capturedAt),
        expiresAt: capturedAt + PENDING_REPORT_TTL_MS,
      });
      return token;
    } catch (err) {
      // Never a silent drop (error rule 2) and never a throw into the handler
      // (error rule 6).
      console.error(
        `[tickets] pending report put failed (${idHint(snapshot)}):`,
        err?.message || err,
      );
      return null;
    }
  }

  /**
   * Consume a token. One-shot: the entry is removed before the expiry check,
   * so neither a replay nor an expired token can be read twice.
   *
   * @param {unknown} token the token from the modal customId (anything typed;
   *   non-strings are simply unknown tokens)
   * @param {{ now?: number|(() => number) }} [opts] clock override (tests)
   * @returns {object|null} the stored snapshot, or null when the token is
   *   unknown, malformed, expired, or already consumed
   */
  function take(token, opts = {}) {
    try {
      const now = resolveNow(opts?.now, clock);
      sweep({ now });

      const key = typeof token === "string" ? token.trim() : "";
      if (key === "") return null;

      const entry = pending.get(key);
      if (!entry) return null;
      pending.delete(key);
      if (entry.expiresAt <= now) return null;
      return entry.snapshot;
    } catch (err) {
      // The token itself stays out of the log: it is a one-shot capability for
      // a flow that can delete a member's message.
      console.error("[tickets] pending report take failed:", err?.message || err);
      return null;
    }
  }

  /**
   * Entries currently held (live + not-yet-swept). Test helper — production
   * code has no reason to count its own pending reports.
   *
   * @returns {number}
   */
  function size() {
    return pending.size;
  }

  /**
   * Clear all in-memory state. Test helper; production relies on
   * process-lifetime state (a restart clearing it is accepted, decision 3).
   */
  function reset() {
    pending.clear();
  }

  return { put, take, sweep, size, reset };
}

/** Process-wide store used by the report invoke + modal handlers. */
const defaultStore = createPendingReportStore();

/**
 * Singleton wrapper — see the store's `put`.
 *
 * @param {object} snapshot
 * @param {{ now?: number|(() => number) }} [opts]
 * @returns {string|null}
 */
function putReport(snapshot, opts = {}) {
  return defaultStore.put(snapshot, opts);
}

/**
 * Singleton wrapper — see the store's `take`.
 *
 * @param {unknown} token
 * @param {{ now?: number|(() => number) }} [opts]
 * @returns {object|null}
 */
function takeReport(token, opts = {}) {
  return defaultStore.take(token, opts);
}

/**
 * Singleton wrapper — drop expired entries now instead of on the next put/take.
 *
 * @param {{ now?: number|(() => number) }} [opts]
 * @returns {number} dropped entries
 */
function sweepPendingReports(opts = {}) {
  return defaultStore.sweep(opts);
}

/** TEST SEAM: how many entries the process-wide store currently holds. */
function pendingReportCountForTests() {
  return defaultStore.size();
}

/** TEST SEAM: clear the process-wide store (fresh tokens, no leftovers). */
function resetPendingReportsForTests() {
  defaultStore.reset();
}

module.exports = {
  PENDING_REPORT_TTL_MS,
  TOKEN_BYTES,
  TOKEN_COLLISION_RETRIES,
  REPORT_KINDS,
  createPendingReportStore,
  putReport,
  // Short aliases: handlers read naturally as `pendingReports.put(...)` /
  // `pendingReports.take(token)` — both spellings are the same functions.
  put: putReport,
  takeReport,
  take: takeReport,
  sweepPendingReports,
  pendingReportCountForTests,
  resetPendingReportsForTests,
};
